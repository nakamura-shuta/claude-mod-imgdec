import { expect, test } from 'claude-code/testing'

// A machine made of a table of image sizes: every call the mod makes on `$`
// is answered here in place of the engine, the commands it runs included.

type Size = { width: number; height: number }
type On = (event: string, hook: (...args: never[]) => unknown) => void

type Machine = {
  /** Path → size of every image file there is. */
  files: Map<string, Size>
  /** Every command the mod ran, in order. */
  ran: string[][]
  logs: string[]
  /** What the mod stored last under `settings`. */
  stored: { value?: unknown }
  /** Paths the engine was asked to read for an `@` mention. */
  mentioned: string[]
  /** Prompts that entered: what arrived at the bottom of `prompt.submit`. */
  entered: { text: string; context?: readonly string[] }[]
  /** What `resend` put in the prompt box. */
  filled: { text: string; mode?: string }[]
}

type Setup = {
  files?: Record<string, Size>
  settings?: unknown
  hasMagick?: boolean
  hasSips?: boolean
  /** The size a trim leaves; absent, a trim changes nothing. */
  trimTo?: Size
  /** The size of an attached image, as `$.prompt.media` would give its bytes. */
  attached?: Size
  /** What the engine answers an `@` mention with. */
  mention?: unknown
  isFilled?: boolean
}

const TMP = '/tmp/t'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
const failed = { value: { exitCode: 1, stdout: '', stderr: '' } }

function machine(on: unknown, setup: Setup = {}): Machine {
  const hook = on as On
  const m: Machine = {
    files: new Map(Object.entries(setup.files ?? {})),
    ran: [],
    logs: [],
    stored: {},
    mentioned: [],
    entered: [],
    filled: [],
  }
  const hasMagick = setup.hasMagick ?? true
  let made = 0

  hook('process.run', ((_: unknown, e: { argv: string[] }) => {
    const argv = e.argv
    const [a, b] = argv
    m.ran.push(argv)

    if (a === 'magick' && b === '-version') return hasMagick ? ok('ImageMagick 7') : failed
    if (a === 'convert') return failed
    if (a === 'sips' && b === '--version') return setup.hasSips ? ok() : failed
    if (a === 'find') return ok()
    if (a === 'mktemp') return ok(`${argv[2]!.replace('XXXXXX', `TEST0${++made}`)}\n`)

    if (a === 'cp') {
      const size = m.files.get(argv[1]!)
      if (size === undefined) return failed
      m.files.set(argv[2]!, size)
      return ok()
    }

    if (a === 'rm') {
      m.files.delete(argv[2]!)
      return ok()
    }

    if (a === 'mv') {
      m.files.set(argv[3]!, m.files.get(argv[2]!)!)
      m.files.delete(argv[2]!)
      return ok()
    }

    if (a === 'sh') {
      if (setup.attached === undefined) return failed
      m.files.set(argv[4]!, setup.attached)
      return ok()
    }

    if (a === 'magick' && b === 'identify') {
      const size = m.files.get(argv[4]!)
      return size === undefined ? failed : ok(`${size.width} ${size.height}`)
    }

    if (a === 'magick' && argv.includes('-trim')) {
      m.files.set(argv[argv.length - 1]!, setup.trimTo ?? m.files.get(b!)!)
      return ok()
    }

    if (a === 'magick' && argv[2] === '-resize') {
      const size = m.files.get(b!)!
      const max = Number(/^(\d+)x/.exec(argv[3]!)![1])
      const scale = Math.min(1, max / Math.max(size.width, size.height))
      m.files.set(argv[4]!, { width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
      return ok()
    }

    return failed
  }) as never)

  hook('env.get', (() => ({ value: `${TMP}/` })) as never)
  hook('clock.now', (() => ({ value: 1 })) as never)
  hook('store.get', (() => ({ value: setup.settings })) as never)
  hook('store.set', ((_: unknown, e: { value: unknown }) => {
    m.stored.value = e.value
    return { value: undefined }
  }) as never)
  hook('ui.log', ((_: unknown, e: unknown) => {
    m.logs.push(JSON.stringify(e))
    return { value: undefined }
  }) as never)
  hook('prompt.fill', ((_: unknown, e: { text: string; mode?: string }) => {
    m.filled.push({ text: e.text, mode: e.mode })
    return { isFilled: setup.isFilled ?? true }
  }) as never)
  hook('prompt.mention', ((_: unknown, e: { path: string }) => {
    m.mentioned.push(e.path)
    return setup.mention ?? { type: 'file' }
  }) as never)
  hook('prompt.submit', ((_: unknown, e: { text: string; context?: readonly string[] }) => {
    m.entered.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  }) as never)

  return m
}

const LARGE = { width: 2400, height: 1500 }
const SMALL = { width: 800, height: 600 }
const COPY = `${TMP}/claude-imgdec.TEST01/0.png`

// ── `@` mentions ──

test('a large image named with @ is read as a reduced copy', async ($, on) => {
  const m = machine(on, { files: { '/pics/shot.png': LARGE } })

  const result = await $.prompt.mention({ mention: '/pics/shot.png', path: '/pics/shot.png' })

  expect(m.mentioned).toEqual([COPY])
  expect(m.files.get(COPY)).toEqual({ width: 1024, height: 640 })
  expect(m.files.get('/pics/shot.png')).toEqual(LARGE)
  expect(result.type).toBe('file')
  expect(result.context?.length).toBe(1)
  expect(result.context?.[0]).toContain('/pics/shot.png')
  expect(result.context?.[0]).toContain(COPY)
  expect(m.logs.join()).toContain('2400×1500 → 1024×640 (resize, ~4,644 → 851 tokens)')
})

test('a path with spaces and Japanese reaches cp as one argument, and keeps its extension', async ($, on) => {
  const path = '/Users/me/Desktop/スクリーンショット 2026-11-11 16.30.00.JPEG'
  const m = machine(on, { files: { [path]: LARGE } })

  await $.prompt.mention({ mention: path, path })

  const copy = `${TMP}/claude-imgdec.TEST01/0.jpeg`
  expect(m.ran.find(argv => argv[0] === 'cp')).toEqual(['cp', path, copy])
  expect(m.mentioned).toEqual([copy])
})

test('the max edge the person set is the one used', async ($, on) => {
  const m = machine(on, { files: { '/pics/shot.png': LARGE }, settings: { maxEdge: 1280 } })

  await $.prompt.mention({ mention: '/pics/shot.png', path: '/pics/shot.png' })

  expect(m.files.get(COPY)).toEqual({ width: 1280, height: 800 })
})

test('a margin worth trimming is trimmed, and no resize follows when it then fits', async ($, on) => {
  const m = machine(on, { files: { '/pics/shot.png': { width: 1600, height: 1000 } }, trimTo: { width: 801, height: 421 } })

  await $.prompt.mention({ mention: '/pics/shot.png', path: '/pics/shot.png' })

  expect(m.files.get(COPY)).toEqual({ width: 801, height: 421 })
  expect(m.ran.some(argv => argv.includes('-resize'))).toBe(false)
  expect(m.logs.join()).toContain('(trim, ')
})

test('a small image with no margin is read as it is, and its copy removed', async ($, on) => {
  const m = machine(on, { files: { '/pics/small.png': SMALL } })

  const result = await $.prompt.mention({ mention: '/pics/small.png', path: '/pics/small.png' })

  expect(m.mentioned).toEqual(['/pics/small.png'])
  expect(m.files.has(COPY)).toBe(false)
  expect(result.context).toBeUndefined()
  expect(m.logs).toEqual([])
})

test('a file that is not an image is left alone, with no command run for it', async ($, on) => {
  const m = machine(on, { files: {} })

  for (const path of ['/src/main.ts', '/pics/anim.gif', '/docs/a.pdf', '/pics/shot.png.txt']) {
    await $.prompt.mention({ mention: path, path })
  }

  expect(m.mentioned).toEqual(['/src/main.ts', '/pics/anim.gif', '/docs/a.pdf', '/pics/shot.png.txt'])
  expect(m.ran.filter(argv => argv[0] === 'cp' || argv[0] === 'mktemp')).toEqual([])
})

test('a reduced copy named with @ (the second Enter of resend) is not reduced again', async ($, on) => {
  const copy = `${TMP}/claude-imgdec.B4MO9t/0.jpg`
  const m = machine(on, { files: { [copy]: LARGE } })

  await $.prompt.mention({ mention: copy, path: copy })

  expect(m.mentioned).toEqual([copy])
  expect(m.ran.filter(argv => argv[0] === 'cp')).toEqual([])
})

test('OFF: an image named with @ is read as it is', async ($, on) => {
  const m = machine(on, { files: { '/pics/shot.png': LARGE }, settings: { isOn: false } })

  await $.prompt.mention({ mention: '/pics/shot.png', path: '/pics/shot.png' })

  expect(m.mentioned).toEqual(['/pics/shot.png'])
})

test('a file that is not there is left to the engine', async ($, on) => {
  const m = machine(on, { files: {} })

  await $.prompt.mention({ mention: '/pics/gone.png', path: '/pics/gone.png' })

  expect(m.mentioned).toEqual(['/pics/gone.png'])
})

test('when the engine attaches nothing, no note is added', async ($, on) => {
  const m = machine(on, { files: { '/pics/shot.png': LARGE }, mention: { type: null } })

  const result = await $.prompt.mention({ mention: '/pics/shot.png', path: '/pics/shot.png' })

  expect(result.type).toBeNull()
  expect(result.context).toBeUndefined()
  expect(m.logs).toEqual([])
})

// ── Submitted prompts ──

const IMAGE = { type: 'image', id: 'a1', mediaType: 'image/png' } as const
// The engine's own fields (`origin`, `wait`) are left for it to set.
const prompt = (text: string, attachments?: readonly unknown[]) => ({ text, attachments }) as never

test('a prompt with no image enters untouched', async ($, on) => {
  const m = machine(on)

  await $.prompt.submit(prompt('hello'))

  expect(m.entered).toEqual([{ text: 'hello', context: undefined }])
  expect(m.ran.filter(argv => argv[0] === 'mktemp')).toEqual([])
})

test('OFF: a prompt with an image enters untouched', async ($, on) => {
  const m = machine(on, { settings: { isOn: false }, attached: LARGE })

  await $.prompt.submit(prompt('[Image #1] hi', [IMAGE]))

  expect(m.entered).toEqual([{ text: '[Image #1] hi', context: undefined }])
  expect(m.ran.filter(argv => argv[0] === 'mktemp')).toEqual([])
})

test('no image tool on the machine: a prompt with an image enters untouched', async ($, on) => {
  const m = machine(on, { hasMagick: false, hasSips: false, attached: LARGE })

  await $.prompt.submit(prompt('[Image #1] hi', [IMAGE]))

  expect(m.entered).toEqual([{ text: '[Image #1] hi', context: undefined }])
})

// ── /imgdec ──

const run = (args: string) => ({ command: 'imgdec', args }) as never

test('/imgdec mode resend and mode read are stored, the other settings kept', async ($, on) => {
  const m = machine(on, { settings: { isOn: true, maxEdge: 1280, isTrimOn: true } })

  await $.command.run(run('mode resend'))
  expect(m.stored.value).toEqual({ isOn: true, mode: 'resend', maxEdge: 1280, isTrimOn: true })

  await $.command.run(run('MODE READ'))
  expect(m.stored.value).toEqual({ isOn: true, mode: 'read', maxEdge: 1280, isTrimOn: true })
})

test('/imgdec mode with anything else changes nothing', async ($, on) => {
  const m = machine(on)

  for (const args of ['mode', 'mode fast', 'mode resend now']) {
    const result = (await $.command.run(run(args))) as { text?: string }
    expect(result.text).toContain('Usage: /imgdec')
  }

  expect(m.stored.value).toBeUndefined()
})

test('/imgdec max keeps to 256-2000', async ($, on) => {
  const m = machine(on)

  await $.command.run(run('max 255'))
  await $.command.run(run('max 2001'))
  expect(m.stored.value).toBeUndefined()

  await $.command.run(run('max 1568px'))
  expect(m.stored.value).toEqual({ isOn: true, mode: 'read', maxEdge: 1568, isTrimOn: true })
})

test('a stored value of the wrong kind falls back to its default', async ($, on) => {
  const m = machine(on, { settings: { isOn: 'yes', mode: 'fast', maxEdge: 99999, isTrimOn: 1 } })

  await $.command.run(run('off'))

  expect(m.stored.value).toEqual({ isOn: false, mode: 'read', maxEdge: 1024, isTrimOn: true })
})

test('/imgdec shows the mode and the max edge', async ($, on) => {
  machine(on, { settings: { mode: 'resend', maxEdge: 1280 } })

  const result = (await $.command.run(run(''))) as { text?: string }

  expect(result.text).toContain('- Mode: resend')
  expect(result.text).toContain('- Max edge: 1280px')
})
