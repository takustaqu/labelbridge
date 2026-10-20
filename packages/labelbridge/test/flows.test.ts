// 印刷手順をモックの機器で確かめる（時間は偽の時計で進める）。

import { describe, expect, it } from 'vitest'
import {
  PrinterError,
  TimeoutError,
  TPRT,
  frame,
  printSr3500p,
  printSr5900p,
  printSrR2500p,
  readStatusSrR2500p,
  srR2500pParts,
  type ByteChannel,
  type Clock,
  type DataSink,
  type TprtControl,
  type UsbPrinterChannel,
} from '../src/core'

function fakeClock(): Clock {
  let t = 0
  return { now: () => t, sleep: async (ms) => void (t += ms) }
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

/** 書き込みを記録し、要求に応じた応答をキューから返すチャネル。 */
class FakeChannel implements ByteChannel {
  written: Uint8Array[] = []
  queue: Uint8Array[] = []
  constructor(private readonly respond: (b: Uint8Array, self: FakeChannel) => void) {}
  async write(b: Uint8Array) {
    this.written.push(b)
    this.respond(b, this)
  }
  async read(_ms: number) {
    const next = this.queue.shift()
    if (!next) throw new TimeoutError()
    return next
  }
}

function r2500Status(state: number, error = 0, tw = 0x03): Uint8Array {
  const f = new Uint8Array(92)
  f.set([0x40, 0x42, 0x44, 0x43, 0x20, 0x53, 0x54, 0x32, 0x0d, 0x0a, 0x50, 0x00, 0x3b, 0x4e, state, error, tw])
  return f
}

describe('SR-R2500P flow', () => {
  const image = { width: 3, height: 72, bits: new Uint8Array(3 * 72) }
  const parts = srR2500pParts(image, { tapeMm: 12 })

  it('sends environment, page, bands and end, then turns auto status off', async () => {
    let printed = false
    const ch = new FakeChannel((b, self) => {
      if (eq(b, frame(0x49, [5, 0]))) self.queue.push(r2500Status(0))
      if (eq(b, parts.bands[0]!)) self.queue.push(r2500Status(2))
      if (eq(b, parts.end)) {
        printed = true
        self.queue.push(r2500Status(5), r2500Status(0))
      }
      if (eq(b, frame(0x49, [0, 0]))) self.queue.push(r2500Status(0))
    })
    const log: string[] = []
    await printSrR2500p(ch, parts, 12, { progress: (m) => log.push(m), clock: fakeClock() })
    expect(printed).toBe(true)
    expect(log.at(-1)).toBe('印刷が完了しました')
    expect(ch.written.at(-1)).toEqual(frame(0x49, [0, 0]))
  })

  it('rejects a tape mismatch before sending the job and still cleans up', async () => {
    const ch = new FakeChannel((b, self) => {
      if (eq(b, frame(0x49, [5, 0])) || eq(b, frame(0x49, [0, 0]))) self.queue.push(r2500Status(0, 0, 0x04))
    })
    await expect(printSrR2500p(ch, parts, 12, { clock: fakeClock() })).rejects.toThrow(/テープ幅/)
    expect(ch.written.some((b) => eq(b, parts.environment))).toBe(false)
    expect(ch.written.at(-1)).toEqual(frame(0x49, [0, 0]))
  })

  it('reads a single status', async () => {
    const ch = new FakeChannel((_b, self) => self.queue.push(r2500Status(0, 0, 0x01)))
    expect((await readStatusSrR2500p(ch, fakeClock())).tapeMm).toBe(6)
  })
})

describe('SR3500P flow', () => {
  function sr3500pStatus(st: string): Uint8Array {
    const f = new Uint8Array(64)
    f.set(Uint8Array.from(`@BDC ST\r\nST:${st};ER:00;WR:00;RV:00;TW:03;TR:00;CT:03;OP:00;EI:00;`, (c) => c.charCodeAt(0)))
    return f
  }

  it('soft-resets, waits for selected, sends the job and waits until idle', async () => {
    const calls: string[] = []
    let states = ['00', '00', '03', '00']
    const ch = Object.assign(
      new FakeChannel((b, self) => {
        if (eq(b, frame(0x51, [0, 0]))) self.queue.push(sr3500pStatus(states.shift() ?? '00'))
      }),
      {
        softReset: async () => void calls.push('reset'),
        portStatus: async () => (calls.push('port'), 0x18),
      },
    ) satisfies UsbPrinterChannel
    const job = Uint8Array.of(1, 2, 3)
    await printSr3500p(ch, job, 12, { clock: fakeClock() })
    expect(calls).toEqual(['reset', 'port'])
    expect(ch.written.some((b) => b.length === 55 && b.every((x) => x === 0))).toBe(false)
    expect(ch.written.some((b) => eq(b, job))).toBe(true)
    expect(states).toEqual([])
  })

  it('repeats reset → job for each copy', async () => {
    const calls: string[] = []
    const ch = Object.assign(
      new FakeChannel((b, self) => {
        if (eq(b, frame(0x51, [0, 0]))) self.queue.push(sr3500pStatus('00'))
      }),
      {
        softReset: async () => void calls.push('reset'),
        portStatus: async () => 0x18,
      },
    ) satisfies UsbPrinterChannel
    const job = Uint8Array.of(1, 2, 3)
    await printSr3500p(ch, job, 12, { clock: fakeClock(), copies: 3 })
    expect(calls).toEqual(['reset', 'reset', 'reset'])
    expect(ch.written.filter((b) => eq(b, job)).length).toBe(3)
  })
})

describe('SR5900P flow', () => {
  function status(st: number, er = 0) {
    const d = new Uint8Array(20)
    d.set([0x14, st, er, 0x03])
    return d
  }

  it('follows start → tcp → notify → send → poll → stop', async () => {
    const seq: string[] = []
    let polls = [status(0), status(2), status(0)]
    const ctrl: TprtControl = {
      request: async (cmd) => {
        seq.push(`udp:${cmd}`)
        if (cmd === TPRT.STATUS) return polls.shift() ?? status(0)
        if (cmd === TPRT.START) return Uint8Array.of(2, 0, 0)
        if (cmd === TPRT.STOP) return Uint8Array.of(3, 0, 0)
        if (cmd === TPRT.NOTIFY_2) return Uint8Array.of(0x10)
        return new Uint8Array(0)
      },
    }
    const sink: DataSink = {
      write: async (b) => void seq.push(`tcp:${b.length}`),
      close: async () => void seq.push('tcp:close'),
    }
    await printSr5900p(ctrl, async () => (seq.push('tcp:open'), sink), new Uint8Array(10), 12, { clock: fakeClock() })
    expect(seq).toEqual([
      'udp:1', 'udp:2', 'tcp:open', 'udp:257', 'udp:256', 'tcp:10', 'tcp:close', 'udp:1', 'udp:1', 'udp:3',
    ])
    expect(polls).toEqual([])
  })

  it('sends stop even when the printer reports an error mid-print', async () => {
    const seq: number[] = []
    const polls = [status(0), status(0, 0x42)]
    const ctrl: TprtControl = {
      request: async (cmd) => {
        seq.push(cmd)
        if (cmd === TPRT.STATUS) return polls.shift() ?? status(0)
        if (cmd === TPRT.START) return Uint8Array.of(2, 0, 0)
        return Uint8Array.of(0x10)
      },
    }
    const sink: DataSink = { write: async () => {}, close: async () => {} }
    await expect(printSr5900p(ctrl, async () => sink, new Uint8Array(1), 12, { clock: fakeClock() })).rejects.toThrow(
      PrinterError,
    )
    expect(seq.at(-1)).toBe(TPRT.STOP)
  })
})
