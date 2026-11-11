import type { CommandRunResult, EngineInterface, Register } from 'claude-code'

// ── Settings ──

/**
 * What the mod does to an attached image. Kept whole in `$.store` under
 * SETTINGS_KEY; only `isOn` has a command today (`/imgdec on|off`), the rest
 * are here so a later command can set them.
 */
type Settings = {
  isOn: boolean
  /** Longest edge, in pixels, an image may keep; larger ones are downscaled to it. */
  maxEdge: number
  /** Trim the plain margin first (needs ImageMagick). */
  isTrimOn: boolean
}

const DEFAULTS: Settings = { isOn: true, maxEdge: 1024, isTrimOn: true }
const SETTINGS_KEY = 'settings'
const USAGE = 'Usage: /imgdec [on|off]'

/** The stored settings, each field falling back to its default when absent or of the wrong kind. */
async function readSettings($: EngineInterface): Promise<Settings> {
  const stored = await $.store.get(SETTINGS_KEY)
  const held = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}

  return {
    isOn: typeof held.isOn === 'boolean' ? held.isOn : DEFAULTS.isOn,
    maxEdge: typeof held.maxEdge === 'number' && held.maxEdge >= 64 ? held.maxEdge : DEFAULTS.maxEdge,
    isTrimOn: typeof held.isTrimOn === 'boolean' ? held.isTrimOn : DEFAULTS.isTrimOn,
  }
}

// ── Reducing one image ──

// Reduced images are throwaway: the per-user temporary folder (macOS: under
// /var/folders, readable by this user alone), in a folder of our own kept at
// 700 with files at 600, and emptied of anything older than a day.
const DIR_NAME = 'claude-imgdec'
const KEEP_DAYS = 1

async function dirOf($: EngineInterface): Promise<string> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '').replace(/\/+$/, '')

  return `${tmp === '' ? '/tmp' : tmp}/${DIR_NAME}`
}

/** Makes the folder (700) and removes what earlier prompts left more than KEEP_DAYS ago. */
async function prepareDir($: EngineInterface): Promise<string> {
  const dir = await dirOf($)

  await $.process.run(['mkdir', '-p', dir])
  await $.process.run(['chmod', '700', dir])
  await $.process.run(['find', dir, '-type', 'f', '-mtime', `+${KEEP_DAYS}`, '-delete'])

  return dir
}

// Trimming the plain margin (ImageMagick, when installed) keeps the text at
// its size, so it runs before any downscale. A trim is kept only when it is
// worth it (the area falls to this share or less) and leaves a real picture
// (no edge under MIN_EDGE: a blank image trims to almost nothing).
const TRIM_FUZZ = '2%'
const TRIM_WORTH = 0.85
const MIN_EDGE = 32

// GIF is left alone: sips would flatten an animation to one frame.
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

type Size = { width: number; height: number }

type Reduced = {
  path: string
  /** What was done, for the person: `2000×1333 → 1024×682 (resize, ~3,456 → 925 tokens)`. */
  summary: string
}

/** Claude's image cost: one token per 28×28 px patch, a partial patch counting whole. */
function tokensOf(size: Size): number {
  return Math.ceil(size.width / 28) * Math.ceil(size.height / 28)
}

// Whether `magick` runs here; asked once per load of the module.
let hasMagick: boolean | undefined

async function canTrim($: EngineInterface): Promise<boolean> {
  if (hasMagick === undefined) {
    try {
      hasMagick = (await $.process.run(['magick', '-version'])).exitCode === 0
    } catch {
      hasMagick = false
    }
  }

  return hasMagick
}

async function sizeOf($: EngineInterface, path: string): Promise<Size | undefined> {
  const read = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
  const width = Number(/pixelWidth: (\d+)/.exec(read.stdout)?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(read.stdout)?.[1])

  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * Trims the plain margin around the image at `path`, in place, and returns
 * the new size; undefined when there is no ImageMagick, the trim fails, or it
 * is not worth keeping (the file is then as it was).
 */
async function trim($: EngineInterface, path: string, before: Size): Promise<Size | undefined> {
  if (!(await canTrim($))) {
    return undefined
  }

  const trimmedPath = path.replace(/(\.\w+)$/, '-trim$1')
  const ran = await $.process.run(['magick', path, '-fuzz', TRIM_FUZZ, '-trim', '+repage', trimmedPath])
  const after = ran.exitCode === 0 ? await sizeOf($, trimmedPath) : undefined
  const isWorthIt =
    after !== undefined &&
    Math.min(after.width, after.height) >= MIN_EDGE &&
    after.width * after.height <= before.width * before.height * TRIM_WORTH

  if (!isWorthIt) {
    await $.process.run(['rm', '-f', trimmedPath])

    return undefined
  }

  await $.process.run(['mv', '-f', trimmedPath, path])

  return after
}

/**
 * Saves a smaller copy of one attached image (margin trimmed, then downscaled
 * if still large) and returns its path, or undefined when there is nothing to
 * gain or anything fails (the attachment then stays in the prompt untouched).
 */
async function reduce(
  $: EngineInterface,
  settings: Settings,
  dir: string,
  id: string,
  index: number,
): Promise<Reduced | undefined> {
  try {
    let base64 = ''
    let mediaType = ''
    let offset: number | undefined

    do {
      const slice = await $.prompt.media(offset === undefined ? { id } : { id, offset })

      if (slice.base64 === undefined) {
        return undefined
      }

      base64 += slice.base64
      mediaType = slice.mediaType
      offset = slice.next
    } while (offset !== undefined)

    const extension = EXTENSION[mediaType]

    if (extension === undefined) {
      return undefined
    }

    const path = `${dir}/${await $.clock.now()}-${index}.${extension}`
    const decoded = await $.process.run(['base64', '-D', '-o', path], { stdin: base64 })
    const before = decoded.exitCode === 0 ? await sizeOf($, path) : undefined
    const steps: string[] = []
    let after = before

    if (after !== undefined && before !== undefined && settings.isTrimOn) {
      const trimmed = await trim($, path, before)

      if (trimmed !== undefined) {
        after = trimmed
        steps.push('trim')
      }
    }

    if (after !== undefined && Math.max(after.width, after.height) > settings.maxEdge) {
      const resized = await $.process.run(['sips', '-Z', String(settings.maxEdge), path])

      after = resized.exitCode === 0 ? await sizeOf($, path) : undefined
      steps.push('resize')
    }

    // Nothing gained (small already, no margin), or a step failed.
    if (before === undefined || after === undefined || steps.length === 0) {
      await $.process.run(['rm', '-f', path])

      return undefined
    }

    await $.process.run(['chmod', '600', path])

    const tokens = `~${tokensOf(before).toLocaleString('en-US')} → ${tokensOf(after).toLocaleString('en-US')} tokens`

    return {
      path,
      summary: `${before.width}×${before.height} → ${after.width}×${after.height} (${steps.join(' + ')}, ${tokens})`,
    }
  } catch {
    return undefined
  }
}

// ── /imgdec ──

/** The last prompt whose images were reduced, for `/imgdec`; this load of the module only. */
let last: { at: number; images: Reduced[] } | undefined

async function runImgdec($: EngineInterface, args: string): Promise<CommandRunResult> {
  const arg = args.trim().toLowerCase()
  const settings = await readSettings($)

  if (arg === 'on' || arg === 'off') {
    await $.store.set(SETTINGS_KEY, { ...settings, isOn: arg === 'on' })

    return {
      text:
        arg === 'on'
          ? 'ON. Attached images are reduced before Claude reads them.'
          : 'OFF. Attached images are sent as they are.',
    }
  }

  if (arg !== '') {
    return { text: USAGE }
  }

  const trimNote = !settings.isTrimOn
    ? 'off'
    : (await canTrim($))
      ? 'on'
      : 'unavailable (ImageMagick not found: brew install imagemagick)'
  const lines = [
    settings.isOn ? 'ON' : 'OFF',
    `- Max edge: ${settings.maxEdge}px`,
    `- Trim margins: ${trimNote}`,
    `- Saved to: ${await dirOf($)}/`,
  ]

  if (last === undefined) {
    lines.push('- Last result: none yet')
  } else {
    lines.push('- Last result:')

    for (const image of last.images) {
      lines.push(`  - ${image.summary} ${image.path}`)
    }
  }

  lines.push(USAGE)

  return { text: lines.join('\n') }
}

// ── Hooks ──

export const register: Register = on => {
  // One entry per submitted prompt still to be stored: for each of its images
  // in order, whether the inline block is replaced by a reduced file.
  const pending: boolean[][] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'imgdec',
      description: 'Reduce attached images before Claude reads them (on|off; no argument shows the status)',
      argumentHint: 'on|off',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'imgdec' }, async ($, e) => runImgdec($, e.args))

  on('prompt.submit', async ($, e, next) => {
    const images = (e.attachments ?? []).filter(a => a.type === 'image')

    if (e.command !== undefined || images.length === 0) {
      return next(e)
    }

    const settings = await readSettings($)

    if (!settings.isOn) {
      return next(e)
    }

    const dir = await prepareDir($)
    const replaced: boolean[] = []
    const reduced: Reduced[] = []

    for (const [index, image] of images.entries()) {
      const one = image.id === undefined ? undefined : await reduce($, settings, dir, image.id, index)

      replaced.push(one !== undefined)

      if (one !== undefined) {
        reduced.push(one)
      }
    }

    if (reduced.length === 0) {
      return next(e)
    }

    const note =
      `${reduced.length} image(s) the user attached to this prompt were reduced ` +
      `(margin trimmed, at most ${settings.maxEdge}px) and saved as files; the inline copies were removed. ` +
      `Read each file to view the image:\n${reduced.map(one => one.path).join('\n')}`

    pending.push(replaced)
    last = { at: await $.clock.now(), images: reduced }
    // A line in the transcript (not sent to the model): it stays, where a toast is easy to miss.
    $.ui.log(reduced.map(one => one.summary).join(' / '))

    const entered = await next({ ...e, context: [...(e.context ?? []), note] })

    if (entered.drop !== undefined) {
      const at = pending.indexOf(replaced)

      if (at !== -1) {
        pending.splice(at, 1)
      }
    }

    return entered
  })

  on('session.append', { door: 'prompt' }, ($, e, next) => {
    const replaced = pending[0]

    if (replaced === undefined || !e.message.content.some(b => b.type === 'image')) {
      return next(e)
    }

    pending.shift()

    let index = 0
    const content = e.message.content.filter(
      block => block.type !== 'image' || replaced[index++] !== true,
    )

    return next({ ...e, message: { ...e.message, content } })
  })
}
