import { expect, test } from 'claude-code/testing'
import { imageExtension, isReducedCopy, mentionsDir, mentionsOf, tokensOf, withoutMarks, withoutReplaced } from './text'

const DIR = '/var/folders/1n/abc/T/claude-imgdec.B4MO9t'

test('tokensOf counts 28px patches, a partial patch whole', async () => {
  expect(tokensOf({ width: 28, height: 28 })).toBe(1)
  expect(tokensOf({ width: 29, height: 28 })).toBe(2)
  expect(tokensOf({ width: 2000, height: 1333 })).toBe(3456)
  expect(tokensOf({ width: 1024, height: 682 })).toBe(925)
  expect(tokensOf({ width: 1024, height: 575 })).toBe(777)
})

test('imageExtension takes png, jpg, jpeg and webp in any case', async () => {
  expect(imageExtension('/a/b.png')).toBe('png')
  expect(imageExtension('/a/b.PNG')).toBe('png')
  expect(imageExtension('/a/b.jpg')).toBe('jpg')
  expect(imageExtension('/a/b.JPEG')).toBe('jpeg')
  expect(imageExtension('/a/b.webp')).toBe('webp')
})

test('imageExtension keeps a path with spaces, Japanese or several dots', async () => {
  expect(imageExtension('/Users/me/Desktop/スクリーンショット 2026-11-11 16.30.00.png')).toBe('png')
  expect(imageExtension('/a/archive.tar.v2.jpg')).toBe('jpg')
})

test('imageExtension leaves out everything else', async () => {
  expect(imageExtension('/a/b.gif')).toBeUndefined()
  expect(imageExtension('/a/b.pdf')).toBeUndefined()
  expect(imageExtension('/a/b.png.txt')).toBeUndefined()
  expect(imageExtension('/a/png')).toBeUndefined()
  expect(imageExtension('/a/b.pngx')).toBeUndefined()
  expect(imageExtension('')).toBeUndefined()
})

test('isReducedCopy knows a file of a reduced folder, and only that', async () => {
  expect(isReducedCopy(`${DIR}/0.jpg`)).toBe(true)
  expect(isReducedCopy('/tmp/claude-imgdec.x1/3.png')).toBe(true)
  expect(isReducedCopy('/Users/me/claude-imgdec/0.png')).toBe(false)
  expect(isReducedCopy('/Users/me/my-claude-imgdec.notes/0.png')).toBe(false)
  expect(isReducedCopy('/Users/me/Desktop/shot.png')).toBe(false)
})

test('mentionsOf sets each file off with spaces', async () => {
  expect(mentionsOf([`${DIR}/0.jpg`])).toBe(` @${DIR}/0.jpg `)
  expect(mentionsOf([`${DIR}/0.jpg`, `${DIR}/2.png`])).toBe(` @${DIR}/0.jpg @${DIR}/2.png `)
})

test('mentionsDir finds the mention wherever it stands', async () => {
  expect(mentionsDir(`@${DIR}/0.jpg [Image #38]\nwhat is this?`, DIR)).toBe(true)
  expect(mentionsDir(`[Image #38]\nwhat is this? @${DIR}/0.jpg `, DIR)).toBe(true)
})

test('mentionsDir is false for another folder, a bare path, or no mention', async () => {
  expect(mentionsDir('@/var/folders/1n/abc/T/claude-imgdec.OTHER1/0.jpg hi', DIR)).toBe(false)
  expect(mentionsDir(`see ${DIR}/0.jpg`, DIR)).toBe(false)
  expect(mentionsDir(`@${DIR}x/0.jpg`, DIR)).toBe(false)
  expect(mentionsDir('[Image #1] hi', DIR)).toBe(false)
  expect(mentionsDir('', DIR)).toBe(false)
})

test('withoutMarks drops the mark of a replaced image', async () => {
  expect(withoutMarks(`@${DIR}/0.jpg [Image #38]\n何が写ってる？`, [true])).toBe(`@${DIR}/0.jpg\n何が写ってる？`)
  expect(withoutMarks('[Image #1] what is this?', [true])).toBe('what is this?')
})

test('withoutMarks keeps the mark of an image that was not replaced', async () => {
  expect(withoutMarks('[Image #1] [Image #2] compare', [true, false])).toBe('[Image #2] compare')
  expect(withoutMarks('[Image #1] [Image #2] compare', [false, true])).toBe('[Image #1]  compare')
  expect(withoutMarks('[Image #1] [Image #2]', [false, false])).toBe('[Image #1] [Image #2]')
})

test('withoutMarks keeps a mark past the list (an image added since)', async () => {
  expect(withoutMarks('[Image #5] [Image #6] both', [true])).toBe('[Image #6] both')
})

test('withoutMarks leaves text with no mark, and other brackets, alone', async () => {
  expect(withoutMarks('no image here', [true])).toBe('no image here')
  expect(withoutMarks('[Image] [Image #x] [image #1]', [true])).toBe('[Image] [Image #x] [image #1]')
  expect(withoutMarks('', [true])).toBe('')
})

const text = (words: string) => ({ type: 'text', text: words })
const image = (name: string) => ({ type: 'image', name })

test('withoutReplaced drops the replaced images and keeps the order of the rest', async () => {
  const blocks = [text('a'), image('one'), text('b'), image('two'), image('three')]

  expect(withoutReplaced(blocks, [true, false, true])).toEqual([text('a'), text('b'), image('two')])
  expect(withoutReplaced(blocks, [false, true, false])).toEqual([text('a'), image('one'), text('b'), image('three')])
  expect(withoutReplaced(blocks, [true, true, true])).toEqual([text('a'), text('b')])
})

test('withoutReplaced keeps an image past the list (one added since)', async () => {
  expect(withoutReplaced([image('one'), image('new')], [true])).toEqual([image('new')])
})

test('withoutReplaced changes nothing when nothing was replaced or there is no image', async () => {
  expect(withoutReplaced([text('a'), image('one')], [false])).toEqual([text('a'), image('one')])
  expect(withoutReplaced([text('a')], [true])).toEqual([text('a')])
  expect(withoutReplaced([], [true])).toEqual([])
})
