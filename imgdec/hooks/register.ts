import type { EngineInterface, Register } from 'claude-code'

// Longest edge, in pixels, an attached image may keep. Larger ones are
// downscaled to this; smaller ones are left attached as they are.
const MAX_EDGE = 1024
const DIR = '/tmp/claude-imgdec'

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

type Shrunk = {
  path: string
  /** The size before and after, for the notice: `2000×1333 → 1024×682`. */
  sizes: string
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
async function shrink(
  $: EngineInterface,
  id: string,
  index: number,
): Promise<Shrunk | undefined> {
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

    const path = `${DIR}/${await $.clock.now()}-${index}.${extension}`

    await $.process.run(['mkdir', '-p', DIR])

    const decoded = await $.process.run(['base64', '-D', '-o', path], { stdin: base64 })
    const before = decoded.exitCode === 0 ? await sizeOf($, path) : undefined
    let after = before === undefined ? undefined : ((await trim($, path, before)) ?? before)

    if (after !== undefined && Math.max(after.width, after.height) > MAX_EDGE) {
      const resized = await $.process.run(['sips', '-Z', String(MAX_EDGE), path])

      after = resized.exitCode === 0 ? await sizeOf($, path) : undefined
    }

    // Nothing gained (small already, no margin), or a step failed.
    if (before === undefined || after === undefined || after === before) {
      await $.process.run(['rm', '-f', path])

      return undefined
    }

    return { path, sizes: `${before.width}×${before.height} → ${after.width}×${after.height}` }
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  // One entry per submitted prompt still to be stored: for each of its images
  // in order, whether the inline block is replaced by a downscaled file.
  const pending: boolean[][] = []

  on('prompt.submit', async ($, e, next) => {
    const images = (e.attachments ?? []).filter(a => a.type === 'image')

    if (e.command !== undefined || images.length === 0) {
      return next(e)
    }

    const replaced: boolean[] = []
    const paths: string[] = []
    const sizes: string[] = []

    for (const [index, image] of images.entries()) {
      const shrunk = image.id === undefined ? undefined : await shrink($, image.id, index)

      replaced.push(shrunk !== undefined)

      if (shrunk !== undefined) {
        paths.push(shrunk.path)
        sizes.push(shrunk.sizes)
      }
    }

    if (paths.length === 0) {
      return next(e)
    }

    const note =
      `${paths.length} image(s) the user attached to this prompt were reduced ` +
      `(margin trimmed, at most ${MAX_EDGE}px) and saved as files; the inline copies were removed. ` +
      `Read each file to view the image:\n${paths.join('\n')}`

    pending.push(replaced)
    // A line in the transcript (not sent to the model): it stays, where a toast is easy to miss.
    $.ui.log(`${sizes.join(', ')}`)

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
