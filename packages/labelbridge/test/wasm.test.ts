// Rust（wasm）を本体にした部分の確認。バイト列の一致は fixtures.test.ts。
import { describe, expect, it } from 'vitest'
import { MODELS, MODEL_IDS, UnsupportedCutError, encodeSr3500p, encodeSr5900p, parseSr3500pStatus, printArea, tapeCodeToMm } from '../src/core'
import { wasmCall } from '../src/core/wasm'

const img = (width: number, height: number) => ({ width, height, bits: new Uint8Array(width * height) })

describe('wasm', () => {
  it('能力表は Rust のものと同じ機種をそろえる', () => {
    const ids = wasmCall<{ id: string }[]>({ op: 'models' }).json.map((m) => m.id)
    expect([...ids].sort()).toEqual([...MODEL_IDS].sort())
    expect(Object.keys(MODELS)).toEqual(MODEL_IDS)
    expect(MODELS.SR3500P.usb).toEqual({ vendorId: 0x0d8a, productId: 0x0102 })
    expect(MODELS.SR5900P.usb).toBeUndefined()
    expect(MODELS['SR-R2500P'].printableDots).toEqual({ 4: 22, 6: 36, 9: 54, 12: 72, 18: 108 })
    expect(printArea('SR5900P', 12)).toMatchObject({ printableDots: 144, verified: true })
  })

  it('テープ幅コード', () => {
    expect([0x01, 0x03, 0x53, 0x0b, 0x99].map(tapeCodeToMm)).toEqual([6, 12, 12, 4, null])
  })

  it('失敗はこれまでの例外になる', () => {
    expect(() => encodeSr3500p(img(10, 72), { tapeMm: 12, cut: 'half' })).toThrow(UnsupportedCutError)
    expect(() => encodeSr3500p(img(10, 73), { tapeMm: 12 })).toThrow('画像の高さ 73 が印字可能幅 72 を超えています')
    expect(() => encodeSr5900p(img(10, 72), { tapeMm: 13 })).toThrow('SR5900P は 13mm テープに対応していません')
    expect(() => encodeSr3500p(img(70000, 72), { tapeMm: 12 })).toThrow(/ラベルが長すぎます/)
  })

  it('端数の設定は丸めて渡す', () => {
    expect(encodeSr3500p(img(4, 72), { tapeMm: 12, density: 1.6, marginDots: 2.4 })).toEqual(encodeSr3500p(img(4, 72), { tapeMm: 12, density: 2, marginDots: 2 }))
  })

  it('壊れたステータスを飛ばして次を読む', () => {
    const frame = (text: string) => {
      const b = new Uint8Array(64).fill(0xff)
      b.set(new TextEncoder().encode(text))
      return b
    }
    const buf = new Uint8Array([0x78, ...frame('@BDC ST\r\nST:00;'), ...frame('@BDC ST\r\nST:02;ER:00;TW:03;')])
    const hit = parseSr3500pStatus(buf)!
    expect(hit.status).toMatchObject({ state: 2, error: 0, tapeMm: 12 })
    expect(hit.consumed).toBe(129)
    expect(hit.status.raw.length).toBe(64)
  })
})
