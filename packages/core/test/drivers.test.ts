import { describe, expect, it } from 'vitest'
import {
  escParen,
  frame,
  parseSr3500pStatus,
  parseSr5900pStatus,
  parseSrR2500pStatus,
  parseTprtResponse,
  printArea,
  printAreas,
  encodeSr3500p,
  encodeSr5900p,
  srR2500pParts,
  UnsupportedCutError,
  tprtRequest,
  TPRT,
} from '../src'

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

describe('frames', () => {
  it('ESC { } and ESC ( ) commands', () => {
    expect([...frame(0x40)]).toEqual([0x1b, 0x7b, 0x03, 0x40, 0x40, 0x7d])
    expect([...frame(0x43, [1, 1, 1, 1])]).toEqual([0x1b, 0x7b, 0x07, 0x43, 0x01, 0x01, 0x01, 0x01, 0x47, 0x7d])
    expect([...escParen(0x47, [1])]).toEqual([0x1b, 0x28, 0x47, 0x01, 0x00, 0x01])
  })

  it('SR3500P job: graphics mode, page length, rows, FF, ESC @', () => {
    const job = encodeSr3500p({ width: 2, height: 72, bits: new Uint8Array(144) }, { tapeMm: 12 })
    expect([...job.subarray(0, 13)]).toEqual([0x1b, 0x28, 0x47, 0x01, 0x00, 0x01, 0x1b, 0x28, 0x43, 0x02, 0x00, 0x02, 0x00])
    expect([...job.subarray(13, 28)]).toEqual([0x1b, 0x28, 0x76, 0x02, 0x00, 0x01, 0x00, 0x1b, 0x2e, 0x00, 0x14, 0x14, 0x01, 72, 0x00])
    expect([...job.subarray(-3)]).toEqual([0x0c, 0x1b, 0x40])

    const dense = encodeSr3500p({ width: 2, height: 72, bits: new Uint8Array(144) }, { tapeMm: 12, density: 2, marginDots: 10 })
    expect([...dense.subarray(0, 27)]).toEqual([...frame(0x44, [7]), 0x1b, 0x28, 0x47, 0x01, 0x00, 0x01, ...escParen(0x43, [22, 0]), ...escParen(0x76, [10, 0])])
  })
})

describe('status parsers', () => {
  it('SR3500P text status (captured)', () => {
    const f = new Uint8Array(64)
    f.set(bytes('@BDC ST\r\nST:00;ER:21;WR:00;RV:00;TW:03;TR:00;CT:03;OP:00;EI:80;'))
    f[63] = 0xff
    const hit = parseSr3500pStatus(Uint8Array.from([0, 0, ...f]))
    expect(hit?.consumed).toBe(66)
    expect(hit?.status).toMatchObject({ state: 0, error: 0x21, tapeMm: 12 })
    expect(parseSr3500pStatus(f.subarray(0, 40))).toBeNull()
  })

  it('SR3500P status without ST or ER is not a frame', () => {
    const make = (text: string) => {
      const f = new Uint8Array(64)
      f.set(bytes(`@BDC ST\r\n${text}`))
      return f
    }
    expect(parseSr3500pStatus(make('ST:00;WR:00;TW:03;'))).toBeNull()
    expect(parseSr3500pStatus(make('ER:00;WR:00;TW:03;'))).toBeNull()
    // 壊れたフレームの後ろに正しいフレームがあれば、そちらを採る
    const good = make('ST:02;ER:00;TW:03;')
    const hit = parseSr3500pStatus(Uint8Array.from([...make('ER:00;'), ...good]))
    expect(hit?.status).toMatchObject({ state: 2, error: 0, tapeMm: 12 })
    expect(hit?.consumed).toBe(128)
    // TW がなければテープ幅は不明
    expect(parseSr3500pStatus(make('ST:00;ER:00;'))?.status.tapeMm).toBeNull()
  })

  it('SR-R2500P binary status (captured)', () => {
    const f = new Uint8Array(92)
    f.set([0x40, 0x42, 0x44, 0x43, 0x20, 0x53, 0x54, 0x32, 0x0d, 0x0a, 0x50, 0x00, 0x3b, 0x4e, 0x02, 0x00, 0x54])
    f[91] = 0x8c
    expect(parseSrR2500pStatus(f)?.status).toMatchObject({ state: 2, error: 0, tapeMm: 18 })
  })

  it('SR5900P UDP status and TPRT framing', () => {
    const data = new Uint8Array(20)
    data.set([0x14, 0x00, 0x42, 0x04])
    expect(parseSr5900pStatus(data)).toMatchObject({ state: 0, error: 0x42, tapeMm: 18 })
    expect(() => parseSr5900pStatus(new Uint8Array(4))).toThrow()

    const req = tprtRequest(TPRT.NOTIFY_1)
    expect(String.fromCharCode(...req.subarray(0, 4))).toBe('TPRT')
    expect([...req.subarray(4, 20)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0x20, 0, 0, 1, 1])
    const res = tprtRequest(TPRT.START, 3)
    res.set(bytes('tprt'))
    expect(parseTprtResponse(Uint8Array.from([...res, 2, 0, 0]))).toEqual({ cmd: 2, data: Uint8Array.from([2, 0, 0]) })
    expect(parseTprtResponse(req)).toBeNull()
  })
})

describe('cut modes follow the capability table', () => {
  const img = (h: number) => ({ width: 2, height: h, bits: new Uint8Array(2 * h) })

  it('half cut only on SR5900P', () => {
    expect(() => encodeSr3500p(img(72), { tapeMm: 12, cut: 'half' })).toThrow(UnsupportedCutError)
    expect(() => srR2500pParts(img(72), { tapeMm: 12, cut: 'half' })).toThrow(UnsupportedCutError)
    expect(() => encodeSr5900p(img(144), { tapeMm: 12, cut: 'half' })).not.toThrow()
  })

  it('SR3500P accepts full / none and ignores them (the printer always cuts)', () => {
    const base = encodeSr3500p(img(72), { tapeMm: 12 })
    expect(encodeSr3500p(img(72), { tapeMm: 12, cut: 'none' })).toEqual(base)
    expect(encodeSr3500p(img(72), { tapeMm: 12, cut: 'full', copies: 3 })).toEqual(base)
  })

  it('SR5900P rejects a margin', () => {
    expect(() => encodeSr5900p(img(144), { tapeMm: 12, marginDots: 4 })).toThrow()
    expect(() => encodeSr5900p(img(144), { tapeMm: 12, marginDots: 0 })).not.toThrow()
  })
})

describe('print area (dot-by-dot)', () => {
  it('12mm on each model', () => {
    expect(printArea('SR3500P', 12)).toMatchObject({ dpi: 180, printableDots: 72, verified: true })
    expect(printArea('SR-R2500P', 12)).toMatchObject({ printableDots: 72, verified: true })
    const a = printArea('SR5900P', 12)
    expect(a).toMatchObject({ dpi: 360, printableDots: 144, verified: true })
    expect(a.printableMm).toBeCloseTo(10.16, 2)
    expect(a.dotMm).toBeCloseTo(0.0706, 4)
  })

  it('lists supported tapes and marks unverified ones', () => {
    expect(printAreas('SR-R2500P').map((a) => a.tapeMm)).toEqual([4, 6, 9, 12, 18])
    expect(printArea('SR5900P', 36)).toMatchObject({ printableDots: 368, verified: false })
    expect(() => printArea('SR-R2500P', 24)).toThrow()
  })
})
