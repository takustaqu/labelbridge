// Direct Sockets 版の LAN 経路を、TCPSocket / UDPSocket の偽物（メモリ上の偽 SR5900P）で確かめる。

import { afterEach, beforeEach, expect, it } from 'vitest'
import { TPRT, encodeSr5900p, printSr5900p, tprtRequest, type Clock } from '../src/core'
import { DirectSocketsTprtControl, directSocketsSupported, openDirectSocketsData, readSr5900pDirect } from '../src/web/direct-sockets'

const fastClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms / 50)) }

type Msg = { data: Uint8Array }
const g = globalThis as Record<string, unknown>
let seen: number[] = []
let received: Uint8Array[] = []
let printing = 0
let udpRemote = ''

/** UDP: 送られた TPRT 要求に、偽 SR5900P として応答する。 */
class FakeUDPSocket {
  opened: Promise<{ readable: ReadableStream<Msg>; writable: WritableStream<Msg> }>
  closed = Promise.resolve()
  constructor(opts: { remoteAddress: string; remotePort: number }) {
    udpRemote = `${opts.remoteAddress}:${opts.remotePort}`
    let ctl!: ReadableStreamDefaultController<Msg>
    const readable = new ReadableStream<Msg>({ start: (c) => void (ctl = c) })
    const writable = new WritableStream<Msg>({
      write: ({ data }) => {
        const req = data as Uint8Array
        const cmd = new DataView(req.buffer, req.byteOffset).getUint32(16)
        seen.push(cmd)
        const body =
          cmd === TPRT.STATUS
            ? [0x14, printing-- > 0 ? 2 : 0, 0, 0x03, ...new Array(16).fill(0)]
            : cmd === TPRT.START
              ? [2, 0, 0]
              : cmd === TPRT.STOP
                ? [3, 0, 0]
                : [0x10]
        if (cmd === TPRT.NOTIFY_2) printing = 1
        const res = tprtRequest(cmd, body.length)
        res.set([0x74, 0x70, 0x72, 0x74]) // "tprt"
        ctl.enqueue({ data: Uint8Array.from([...res, ...body]) })
      },
    })
    this.opened = Promise.resolve({ readable, writable })
  }
  async close() {}
}

/** TCP: 受け取ったバイト列を記録する。 */
class FakeTCPSocket {
  opened: Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>
  closed = Promise.resolve()
  constructor() {
    const readable = new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    const writable = new WritableStream<Uint8Array>({ write: (b) => void received.push(b) })
    this.opened = Promise.resolve({ readable, writable })
  }
  async close() {}
}

beforeEach(() => {
  seen = []
  received = []
  printing = 0
  g.UDPSocket = FakeUDPSocket
  g.TCPSocket = FakeTCPSocket
})
afterEach(() => {
  delete g.UDPSocket
  delete g.TCPSocket
})

it('reports whether Direct Sockets is available', () => {
  expect(directSocketsSupported()).toBe(true)
  delete g.TCPSocket
  expect(directSocketsSupported()).toBe(false)
})

it('reads the tape over UDP', async () => {
  const { status, area } = await readSr5900pDirect('192.0.2.10')
  expect(udpRemote).toBe('192.0.2.10:9100')
  expect(status).toMatchObject({ state: 0, error: 0, tapeMm: 12 })
  expect(area?.printableDots).toBe(144)
})

it('prints through the same flow as Node (UDP control + TCP data)', async () => {
  const image = { width: 4, height: 144, bits: new Uint8Array(4 * 144) }
  const job = encodeSr5900p(image, { tapeMm: 12 })
  const ctrl = new DirectSocketsTprtControl('192.0.2.10')
  try {
    await printSr5900p(ctrl, () => openDirectSocketsData('192.0.2.10'), job, 12, { clock: fastClock })
  } finally {
    await ctrl.close()
  }
  const sent = Uint8Array.from(received.flatMap((b) => [...b]))
  expect(sent).toEqual(job)
  expect(seen).toEqual([1, 2, 0x0101, 0x0100, 1, 1, 3])
})
