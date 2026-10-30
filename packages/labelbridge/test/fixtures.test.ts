// Rust 版（crates/labelbridge）と同じバイト列になることを確かめる。
// fixtures は `cargo run -p labelbridge --example fixtures -- packages/labelbridge/test/fixtures` で作る。

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { concat, encodeSr3500p, encodeSr5900p, encodeSr5900pPages, flattenSrR2500pPages, srR2500pParts, toHex, type MonoImage } from '../src/core'

/** crates/labelbridge/examples/fixtures.rs の pattern() と同じ式。 */
function pattern(width: number, height: number): MonoImage {
  const bits = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) bits[y * width + x] = (x * 7 + y * 3) % 11 < 4 || (x < 3 && y < 5) ? 1 : 0
  return { width, height, bits }
}

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))

function expectSame(actual: Uint8Array, expected: Uint8Array) {
  const i = actual.findIndex((b, k) => b !== expected[k])
  if (i >= 0 || actual.length !== expected.length) {
    const at = i >= 0 ? i : Math.min(actual.length, expected.length)
    throw new Error(
      `differs at ${at} (len ${actual.length} vs ${expected.length})\n` +
        `ts:   ${toHex(actual.subarray(at, at + 16))}\nrust: ${toHex(expected.subarray(at, at + 16))}`,
    )
  }
}

describe('TS encoders match the Rust drivers byte for byte', () => {
  it('SR3500P', () => {
    expectSame(encodeSr3500p(pattern(50, 72), { tapeMm: 12 }), fixture('sr3500p-12mm.bin'))
  })

  it('SR5900P', () => {
    expectSame(encodeSr5900p(pattern(50, 144), { tapeMm: 12, cut: 'full' }), fixture('sr5900p-12mm.bin'))
  })

  it('SR-R2500P', () => {
    const p = srR2500pParts(pattern(50, 72), { tapeMm: 12 })
    expectSame(concat([p.environment, p.pageEnvironment, ...p.bands, p.end]), fixture('srr2500p-12mm.bin'))
  })

  it('with options (density, margin, copies, no cut)', () => {
    expectSame(
      encodeSr3500p(pattern(50, 72), { tapeMm: 12, density: 2, marginDots: 10 }),
      fixture('sr3500p-12mm-opts.bin'),
    )
    expectSame(
      encodeSr5900p(pattern(50, 144), { tapeMm: 12, cut: 'none', copies: 2, density: -1 }),
      fixture('sr5900p-12mm-opts.bin'),
    )
    expectSame(
      encodeSr5900p(pattern(50, 144), { tapeMm: 12, cut: 'half', copies: 2, marginDots: 5 }),
      fixture('sr5900p-12mm-margin.bin'),
    )
    expectSame(encodeSr5900pPages([pattern(50, 144), pattern(30, 144)], { tapeMm: 12, cut: 'half' }), fixture('sr5900p-12mm-pages.bin'))
    expectSame(encodeSr5900p(pattern(50, 144), { tapeMm: 12, leadingCut: 'half' }), fixture('sr5900p-12mm-leadhalf.bin'))
    const p = srR2500pParts(pattern(50, 72), { tapeMm: 12, cut: 'none', copies: 2, density: 3, marginDots: 5 })
    expectSame(flattenSrR2500pPages(p), fixture('srr2500p-12mm-opts.bin'))
  })

  it('pattern sanity', () => {
    expect(pattern(2, 2).bits.length).toBe(4)
  })
})
