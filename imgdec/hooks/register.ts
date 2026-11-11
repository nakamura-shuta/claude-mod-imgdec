import type { CommandRunResult, EngineInterface, Register } from 'claude-code'
import { DIR_PREFIX, imageExtension, isReducedCopy, mentionsDir, mentionsOf, tokensOf, withoutMarks, withoutReplaced } from './text'

// ── Settings ──

/**
 * What the mod does to an attached image. Kept whole in `$.store` under
 * SETTINGS_KEY and set by `/imgdec on|off`, `/imgdec max <px>` and
 * `/imgdec mode <mode>`; `isTrimOn` has no command yet.
 */
type Settings = {
  isOn: boolean
  /**
   * How a reduced image reaches the model. `read`: the model is told to Read
   * the file (one more request). `resend`: the submit is cancelled, the prompt
   * box gets an `@` mention of the file, and the person presses Enter again
   * (the engine attaches the file itself, no Read).
   */
  mode: Mode
  /** Longest edge, in pixels, an image may keep; larger ones are downscaled to it. */
  maxEdge: number
  /** Trim the plain margin first (needs ImageMagick). */
  isTrimOn: boolean
}

type Mode = 'read' | 'resend'

const DEFAULTS: Settings = { isOn: true, mode: 'read', maxEdge: 1024, isTrimOn: true }
const SETTINGS_KEY = 'settings'
const USAGE = 'Usage: /imgdec [on|off|max <px>|mode read|resend]'
// What `/imgdec max` takes: under it text is lost, over it the engine has resized already.
const MIN_MAX_EDGE = 256
const MAX_MAX_EDGE = 2000

/** The stored settings, each field falling back to its default when absent or of the wrong kind. */
async function readSettings($: EngineInterface): Promise<Settings> {
  const stored = await $.store.get(SETTINGS_KEY)
  const held = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}

  return {
    isOn: typeof held.isOn === 'boolean' ? held.isOn : DEFAULTS.isOn,
    mode: held.mode === 'read' || held.mode === 'resend' ? held.mode : DEFAULTS.mode,
    maxEdge:
      typeof held.maxEdge === 'number' && held.maxEdge >= MIN_MAX_EDGE && held.maxEdge <= MAX_MAX_EDGE
        ? held.maxEdge
        : DEFAULTS.maxEdge,
    isTrimOn: typeof held.isTrimOn === 'boolean' ? held.isTrimOn : DEFAULTS.isTrimOn,
  }
}

// ── Tools (macOS and Linux) ──

/**
 * The commands this machine has for images, found once per load of the module.
 * ImageMagick does everything (size, resize, trim) on macOS and Linux alike;
 * without it, macOS's own `sips` still reads a size and resizes (no trim).
 */
type Tools = {
  /** ImageMagick's argv prefixes: `magick` / `magick identify` (7), or `convert` / `identify` (6). */
  magick?: { convert: readonly string[]; identify: readonly string[] }
  hasSips: boolean
}

let tools: Tools | undefined

/** Whether `argv` runs here and exits 0; with `mark`, only when its output holds it. */
async function runs($: EngineInterface, argv: readonly string[], mark?: string): Promise<boolean> {
  try {
    const ran = await $.process.run(argv)

    return ran.exitCode === 0 && (mark === undefined || ran.stdout.includes(mark))
  } catch {
    return false
  }
}

async function findTools($: EngineInterface): Promise<Tools> {
  if (tools === undefined) {
    const magick = (await runs($, ['magick', '-version']))
      ? { convert: ['magick'], identify: ['magick', 'identify'] }
      : // ImageMagick 6 (many Linux distributions). The mark keeps out another `convert`.
        (await runs($, ['convert', '-version'], 'ImageMagick'))
        ? { convert: ['convert'], identify: ['identify'] }
        : undefined

    tools = { magick, hasSips: await runs($, ['sips', '--version']) }
  }

  return tools
}

// ── Where reduced images go ──

// A folder of its own per prompt, made by `mktemp -d` (mode 700, a name
// nobody can take first) in the per-user temporary folder. The files are kept
// for a while in case the model reads them again; folders older than
// KEEP_DAYS are removed the next time a prompt carries an image.
const KEEP_DAYS = 1

async function tmpOf($: EngineInterface): Promise<string> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '').replace(/\/+$/, '')

  return tmp === '' ? '/tmp' : tmp
}

/**
 * Makes this prompt's own folder and returns its path, the old folders
 * removed first unless `isQuick` (an `@` mention keeps the prompt waiting).
 */
async function makeDir($: EngineInterface, isQuick = false): Promise<string> {
  const tmp = await tmpOf($)

  if (!isQuick) {
    // Before the new one is made, so it cannot be among them.
    await $.process.run([
      'find', tmp, '-maxdepth', '1', '-type', 'd', '-name', `${DIR_PREFIX}*`,
      '-mtime', `+${KEEP_DAYS}`, '-exec', 'rm', '-rf', '{}', '+',
    ])
  }

  const made = await $.process.run(['mktemp', '-d', `${tmp}/${DIR_PREFIX}XXXXXX`])
  const dir = made.stdout.trim()

  if (made.exitCode !== 0 || dir === '') {
    throw new Error('mktemp failed')
  }

  return dir
}

// ── Reducing one image ──

// Trimming the plain margin (ImageMagick only) keeps the text at its size, so
// it runs before any downscale. A trim is kept only when it is worth it (the
// area falls to this share or less) and leaves a real picture (no edge under
// MIN_EDGE: a blank image trims to almost nothing).
const TRIM_FUZZ = '2%'
const TRIM_WORTH = 0.85
const MIN_EDGE = 32

// GIF is left alone: a resize would flatten an animation.
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

/** The size of the image at `path`, by macOS's `sips`. */
async function sizeOf($: EngineInterface, path: string): Promise<Size | undefined> {
  const read = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])

  return sizeIn(read.stdout, /pixelWidth: (\d+)[\s\S]*pixelHeight: (\d+)/)
}

/** Downscales the image at `path`, in place, by `sips`; false when it fails. */
async function resize($: EngineInterface, path: string, maxEdge: number): Promise<boolean> {
  return (await $.process.run(['sips', '-Z', String(maxEdge), path])).exitCode === 0
}

// With ImageMagick an image is read twice and written once, whatever is done
// to it. PNG is written with light compression: the token cost is the
// pixels', not the file's, and the prompt waits on this.
const FAST_PNG = ['-define', 'png:compression-level=1', '-define', 'png:compression-filter=0']

// A copy the engine attaches for an `@` mention has to be a small file: it
// attaches nothing for one over 262,144 bytes (seen on Claude Code 2.1.322). Such a
// copy is written as JPEG, and again at a lower quality when still over the cap.
const MENTION_MAX_BYTES = 200_000
const JPEG = ['-background', 'white', '-flatten', '-quality', '85']
const JPEG_SMALLER = ['-quality', '60']

/** The size of the file at `path` in bytes; undefined when it cannot be read. */
async function bytesOf($: EngineInterface, path: string): Promise<number | undefined> {
  const counted = await $.process.run(['wc', '-c', path])
  const bytes = Number(/^\s*(\d+)/.exec(counted.stdout)?.[1])

  return counted.exitCode === 0 && bytes > 0 ? bytes : undefined
}

/** `text` as a size, read from where two numbers stand `<width><between><height>`. */
function sizeIn(text: string, pattern: RegExp): Size | undefined {
  const found = pattern.exec(text)
  const width = Number(found?.[1])
  const height = Number(found?.[2])

  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * Reduces the image file at `path` (margin trimmed, then downscaled if still
 * large). Undefined, and the file removed, when there is nothing to gain or a
 * step fails.
 *
 * `isMentioned`: the copy is for the engine to attach as an `@` mention, so it
 * is written beside `path` as a small JPEG (ImageMagick only), and `path` is
 * removed; else it is reduced in place, in its own format.
 */
async function shrink(
  $: EngineInterface,
  settings: Settings,
  path: string,
  isMentioned = false,
): Promise<Reduced | undefined> {
  const { magick } = await findTools($)
  const steps: string[] = []
  const out = isMentioned ? path.replace(/\.\w+$/, '-s.jpg') : path
  let before: Size | undefined
  let after: Size | undefined

  if (magick !== undefined) {
    // The size, and the box a trim would leave (`%@`: 1546x737+63+102), without writing anything.
    const probed = await $.process.run([...magick.convert, path, '-fuzz', TRIM_FUZZ, '-format', '%w %h %@', 'info:'])
    const box = /(\d+x\d+[+-]\d+[+-]\d+)\s*$/.exec(probed.stdout)?.[1]
    const trimmed = box === undefined ? undefined : sizeIn(box, /^(\d+)x(\d+)/)

    before = probed.exitCode === 0 ? sizeIn(probed.stdout, /^(\d+) (\d+)/) : undefined

    const isTrimWorthIt =
      settings.isTrimOn &&
      before !== undefined &&
      trimmed !== undefined &&
      Math.min(trimmed.width, trimmed.height) >= MIN_EDGE &&
      trimmed.width * trimmed.height <= before.width * before.height * TRIM_WORTH
    const kept = isTrimWorthIt ? trimmed : before
    const change: string[] = []

    if (isTrimWorthIt && box !== undefined) {
      change.push('-crop', box, '+repage')
      steps.push('trim')
    }

    if (kept !== undefined && Math.max(kept.width, kept.height) > settings.maxEdge) {
      change.push('-resize', `${settings.maxEdge}x${settings.maxEdge}>`)
      steps.push('resize')
    }

    if (before !== undefined && steps.length > 0) {
      const written = await $.process.run([
        ...magick.convert, path, ...change, ...(isMentioned ? JPEG : FAST_PNG),
        '-format', '%w %h', '-write', 'info:', out,
      ])

      after = written.exitCode === 0 ? sizeIn(written.stdout, /^(\d+) (\d+)/) : undefined

      if (after !== undefined && isMentioned && ((await bytesOf($, out)) ?? Infinity) > MENTION_MAX_BYTES) {
        await $.process.run([...magick.convert, out, ...JPEG_SMALLER, out])

        if (((await bytesOf($, out)) ?? Infinity) > MENTION_MAX_BYTES) {
          after = undefined
        }
      }
    }
  } else if (!isMentioned) {
    // macOS without ImageMagick: `sips` resizes, and there is no trim.
    before = await sizeOf($, path)

    if (before !== undefined && Math.max(before.width, before.height) > settings.maxEdge) {
      after = (await resize($, path, settings.maxEdge)) ? await sizeOf($, path) : undefined
      steps.push('resize')
    }
  }

  // Nothing gained (small already, no margin), or a step failed.
  if (before === undefined || after === undefined || steps.length === 0) {
    await $.process.run(['rm', '-f', path, out])

    return undefined
  }

  if (out !== path) {
    await $.process.run(['rm', '-f', path])
  }

  const tokens = `~${tokensOf(before).toLocaleString('en-US')} → ${tokensOf(after).toLocaleString('en-US')} tokens`

  return {
    path: out,
    summary: `${before.width}×${before.height} → ${after.width}×${after.height} (${steps.join(' + ')}, ${tokens})`,
  }
}

/**
 * Saves a smaller copy of one attached image and returns its path, or
 * undefined when there is nothing to gain or anything fails (the attachment
 * then stays in the prompt untouched).
 */
async function reduce(
  $: EngineInterface,
  settings: Settings,
  dir: string,
  id: string,
  index: number,
  isMentioned: boolean,
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

    const path = `${dir}/${index}.${extension}`
    // Through sh for the redirect: `--decode` is the one spelling macOS and GNU share.
    const decoded = await $.process.run(['sh', '-c', 'base64 --decode > "$1"', 'sh', path], { stdin: base64 })

    return decoded.exitCode === 0 ? await shrink($, settings, path, isMentioned) : undefined
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

  const max = /^max\s+(\d+)(?:px)?$/.exec(arg)

  if (max !== null) {
    const maxEdge = Number(max[1])

    if (maxEdge < MIN_MAX_EDGE || maxEdge > MAX_MAX_EDGE) {
      return { text: `Max edge must be ${MIN_MAX_EDGE}-${MAX_MAX_EDGE}px. Now: ${settings.maxEdge}px.` }
    }

    await $.store.set(SETTINGS_KEY, { ...settings, maxEdge })

    return { text: `Max edge: ${maxEdge}px. Larger images are downscaled to it.` }
  }

  const mode = /^mode\s+(read|resend)$/.exec(arg)

  if (mode !== null) {
    await $.store.set(SETTINGS_KEY, { ...settings, mode: mode[1] })

    return {
      text:
        mode[1] === 'resend'
          ? 'Mode: resend. A prompt with an image is held once: press Enter again to send the reduced copy.'
          : 'Mode: read. Claude reads the reduced copy from a file (one extra request).',
    }
  }

  if (arg !== '') {
    return { text: USAGE }
  }

  const found = await findTools($)
  const toolNote = found.magick ? 'ImageMagick' : found.hasSips ? 'sips' : 'none (install ImageMagick)'
  const trimNote = !settings.isTrimOn ? 'off' : found.magick ? 'on' : 'unavailable (needs ImageMagick)'
  const lines = [
    settings.isOn ? 'ON' : 'OFF',
    `- Mode: ${settings.mode}`,
    `- Max edge: ${settings.maxEdge}px`,
    `- Trim margins: ${trimNote}`,
    `- Image tool: ${toolNote}`,
    `- Saved to: ${await tmpOf($)}/${DIR_PREFIX}*/`,
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

const MENTIONED_NOTE =
  'The image named with @ in this prompt is attached in reduced form: the attached file is a reduced copy of it. Use the attached copy; do not read the original file.'

const RESENT_NOTE =
  'The image(s) the user attached were reduced; the @ file(s) of this prompt are the reduced copies. Use them; do not read the original files.'

/** Takes one prompt's entry out of `pending` when the prompt did not enter. */
function forget(pending: boolean[][], replaced: boolean[]): void {
  const at = pending.indexOf(replaced)

  if (at !== -1) {
    pending.splice(at, 1)
  }
}

export const register: Register = on => {
  // One entry per submitted prompt still to be stored: for each of its images
  // in order, whether the inline block is replaced by a reduced file.
  const pending: boolean[][] = []
  // `resend` mode: the folder whose files the prompt box was last given as `@`
  // mentions, and which images of that prompt they stand for.
  let refilled: { dir: string; replaced: boolean[] } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'imgdec',
      description:
        'Reduce attached images before Claude reads them (on|off, max <px>, mode read|resend; no argument shows the status)',
      argumentHint: 'on|off|max <px>|mode read|resend',
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

    // The second Enter of `resend`: the engine has attached the `@` files, and
    // the originals are still on the prompt. Their blocks and `[Image #N]`
    // marks are taken out; an image added since is sent as it is.
    if (refilled !== undefined && mentionsDir(e.text, refilled.dir)) {
      const { replaced } = refilled
      const text = withoutMarks(e.text, replaced)

      refilled = undefined
      pending.push(replaced)

      const entered = await next({ ...e, text, context: [...(e.context ?? []), RESENT_NOTE] })

      if (entered.drop !== undefined) {
        forget(pending, replaced)
      }

      return entered
    }

    const settings = await readSettings($)

    if (!settings.isOn) {
      return next(e)
    }

    const found = await findTools($)

    if (found.magick === undefined && !found.hasSips) {
      return next(e)
    }

    // A copy for `resend` is one the engine attaches as an `@` mention; that needs ImageMagick.
    const isResend = settings.mode === 'resend' && found.magick !== undefined
    const dir = await makeDir($)
    const replaced: boolean[] = []
    const reduced: Reduced[] = []

    for (const [index, image] of images.entries()) {
      const one = image.id === undefined ? undefined : await reduce($, settings, dir, image.id, index, isResend)

      replaced.push(one !== undefined)

      if (one !== undefined) {
        reduced.push(one)
      }
    }

    if (reduced.length === 0) {
      return next(e)
    }

    last = { at: await $.clock.now(), images: reduced }
    // A line in the transcript (not sent to the model): it stays, where a toast is easy to miss.
    $.ui.log(reduced.map(one => one.summary).join(' / '))

    if (isResend) {
      // The engine expands an `@` mention only in a prompt the person submits,
      // so this one is cancelled; the engine puts its draft back in the box.
      const filled = await $.prompt.fill({ text: mentionsOf(reduced.map(one => one.path)), mode: 'append' })

      if (filled.isFilled) {
        refilled = { dir, replaced }

        return { drop: 'Image reduced. Press Enter again to send it.' }
      }
    }

    const note =
      `${reduced.length} image(s) the user attached to this prompt were reduced ` +
      `(margin trimmed, at most ${settings.maxEdge}px) and saved as files; the inline copies were removed. ` +
      `Read each file to view the image, and do not read the original image file:\n${reduced.map(one => one.path).join('\n')}`

    pending.push(replaced)

    const entered = await next({ ...e, context: [...(e.context ?? []), note] })

    if (entered.drop !== undefined) {
      forget(pending, replaced)
    }

    return entered
  })

  // An image named with `@`: the engine attaches the file itself (no Read), so
  // a reduced copy is read in its place. In both modes.
  on('prompt.mention', async ($, e, next) => {
    const extension = imageExtension(e.path)

    // Not an image, or a reduced copy already (the second Enter of `resend`).
    if (extension === undefined || isReducedCopy(e.path)) {
      return next(e)
    }

    let one: Reduced | undefined

    try {
      const settings = await readSettings($)

      if (settings.isOn && (await findTools($)).magick !== undefined) {
        const path = `${await makeDir($, true)}/0.${extension}`
        const copied = await $.process.run(['cp', e.path, path])

        one = copied.exitCode === 0 ? await shrink($, settings, path, true) : undefined
      }
    } catch {
      one = undefined
    }

    if (one === undefined) {
      return next(e)
    }

    const attached = await next({ ...e, path: one.path })

    if (attached.deny !== undefined || attached.type === null) {
      return attached
    }

    last = { at: await $.clock.now(), images: [one] }
    $.ui.log(one.summary)

    // Without it the model reads the path the prompt names, at full size.
    // No paths in it: both are in the prompt already, and a long path costs more than the note.
    const note = MENTIONED_NOTE

    return { ...attached, context: [...(attached.context ?? []), note] }
  })

  on('session.append', { door: 'prompt' }, ($, e, next) => {
    const replaced = pending[0]

    if (replaced === undefined || !e.message.content.some(b => b.type === 'image')) {
      return next(e)
    }

    pending.shift()

    return next({ ...e, message: { ...e.message, content: withoutReplaced(e.message.content, replaced) } })
  })
}
