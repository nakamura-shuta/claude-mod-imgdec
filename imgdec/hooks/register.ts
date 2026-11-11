import type { EngineInterface, Register } from 'claude-code'

// Longest edge, in pixels, an attached image may keep. Larger ones are
// downscaled to this; smaller ones are left attached as they are.
const MAX_EDGE = 1024
const DIR = '/tmp/claude-imgdec'

// GIF is left alone: sips would flatten an animation to one frame.
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * Saves a downscaled copy of one attached image and returns its path, or
 * undefined when the image is small enough already or anything fails (the
 * attachment then stays in the prompt untouched).
 */
async function shrink(
  $: EngineInterface,
  id: string,
  index: number,
): Promise<string | undefined> {
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

    if (decoded.exitCode !== 0) {
      return undefined
    }

    const size = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
    const width = Number(/pixelWidth: (\d+)/.exec(size.stdout)?.[1])
    const height = Number(/pixelHeight: (\d+)/.exec(size.stdout)?.[1])

    // Also true when the size could not be read (NaN): leave the image alone.
    if (!(Math.max(width, height) > MAX_EDGE)) {
      await $.process.run(['rm', '-f', path])

      return undefined
    }

    const resized = await $.process.run(['sips', '-Z', String(MAX_EDGE), path])

    if (resized.exitCode !== 0) {
      await $.process.run(['rm', '-f', path])

      return undefined
    }

    return path
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

    for (const [index, image] of images.entries()) {
      const path = image.id === undefined ? undefined : await shrink($, image.id, index)

      replaced.push(path !== undefined)

      if (path !== undefined) {
        paths.push(path)
      }
    }

    if (paths.length === 0) {
      return next(e)
    }

    const note =
      `${paths.length} image(s) the user attached to this prompt were downscaled ` +
      `to at most ${MAX_EDGE}px and saved as files; the inline copies were removed. ` +
      `Read each file to view the image:\n${paths.join('\n')}`

    pending.push(replaced)
    $.ui.toast(`imgdec: ${paths.length} image(s) → ≤${MAX_EDGE}px`)

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
