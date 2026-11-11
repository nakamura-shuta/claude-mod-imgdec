// Path and text handling that needs no engine: what register.ts decides from
// a path or a prompt's text, kept apart so it is tested alone.

/** The start of every folder of reduced images: `<tmp>/claude-imgdec.XXXXXX`. */
export const DIR_PREFIX = 'claude-imgdec.'

type Size = { width: number; height: number }

/** Claude's image cost: one token per 28×28 px patch, a partial patch counting whole. */
export function tokensOf(size: Size): number {
  return Math.ceil(size.width / 28) * Math.ceil(size.height / 28)
}

/**
 * The lower-case extension of an image this mod reduces (`png`, `jpg`,
 * `jpeg`, `webp`), or undefined for any other path. GIF is left alone: a
 * resize would flatten an animation.
 */
export function imageExtension(path: string): string | undefined {
  return /\.(png|jpe?g|webp)$/i.exec(path)?.[1]?.toLowerCase()
}

/** Whether `path` is inside a folder of reduced images, so already reduced. */
export function isReducedCopy(path: string): boolean {
  return path.includes(`/${DIR_PREFIX}`)
}

/** What `resend` adds to the prompt box: an `@` mention of each file, set off by spaces. */
export function mentionsOf(paths: readonly string[]): string {
  return ` ${paths.map(path => `@${path}`).join(' ')} `
}

/** Whether a prompt's text mentions a file of `dir` with `@`: the second Enter of `resend`. */
export function mentionsDir(text: string, dir: string): boolean {
  return text.includes(`@${dir}/`)
}

/**
 * `text` without the `[Image #N]` marks of the images that were replaced:
 * the k-th mark goes when `replaced[k]` is true. A mark past the list (an
 * image added since) stays.
 */
export function withoutMarks(text: string, replaced: readonly boolean[]): string {
  let mark = 0

  return text
    .replace(/\[Image #\d+\]/g, found => (replaced[mark++] === true ? '' : found))
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * A stored prompt's blocks without the images that were replaced: the k-th
 * image block goes when `replaced[k]` is true. Every other block, and an
 * image past the list (one added since), stays in place.
 */
export function withoutReplaced<Block extends { type: string }>(
  blocks: readonly Block[],
  replaced: readonly boolean[],
): Block[] {
  let image = 0

  return blocks.filter(block => block.type !== 'image' || replaced[image++] !== true)
}
