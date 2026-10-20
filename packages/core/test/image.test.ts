import { expect, it } from 'vitest'
import { packColumn, threshold, toAscii } from '../src'

it('thresholds RGBA by luminance and treats transparency as white', () => {
  const rgba = Uint8ClampedArray.from([
    0, 0, 0, 255, // 黒
    255, 255, 255, 255, // 白
    100, 100, 100, 255, // 濃い灰 → 黒
    0, 0, 0, 0, // 透明 → 白
  ])
  expect([...threshold(rgba, 4, 1).bits]).toEqual([1, 0, 1, 0])
})

it('packs a column top-first or bottom-first', () => {
  // 1 列 × 10 行、上端（y=0）が黒
  const m = { width: 1, height: 10, bits: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }
  expect(toAscii(m)).toBe('#\n.\n.\n.\n.\n.\n.\n.\n.\n.\n')
  expect([...packColumn(m, 0, 16, false)]).toEqual([0x80, 0x00]) // dot 0 = 上端
  expect([...packColumn(m, 0, 16, true)]).toEqual([0x00, 0x01]) // dot 15 = 上端（下端始まり。画像が狭くても印字範囲の上端に来る）
})
