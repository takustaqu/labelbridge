// ローカルの偽 SR5900P（UDP + TCP）に対して、印刷手順が通ることを確かめる。

import { createSocket } from 'node:dgram'
import { createServer, type AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { TPRT, encodeSr5900p, printSr5900p, tprtRequest, type Clock } from '../src/core'
import { TprtUdpControl, openTcpData } from '../src/node'

const fastClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms / 50)) }
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

it('prints through a fake SR5900P over UDP and TCP', async () => {
  const received: Buffer[] = []
  const tcp = createServer((s) => s.on('data', (d: Buffer) => received.push(d)))
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
  cleanup.push(() => tcp.close())
  const tcpPort = (tcp.address() as AddressInfo).port

  const udp = createSocket('udp4')
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r))
  cleanup.push(() => udp.close())
  const seen: number[] = []
  let printing = 0
  udp.on('message', (msg, from) => {
    const cmd = msg.readUInt32BE(16)
    seen.push(cmd)
    const data =
      cmd === TPRT.STATUS
        ? Buffer.from([0x14, printing-- > 0 ? 2 : 0, 0, 0x03, ...new Array(16).fill(0)])
        : cmd === TPRT.START
          ? Buffer.from([2, 0, 0])
          : cmd === TPRT.STOP
            ? Buffer.from([3, 0, 0])
            : Buffer.from([0x10])
    if (cmd === TPRT.NOTIFY_2) printing = 1
    const res = Buffer.from(tprtRequest(cmd, data.length))
    res.write('tprt', 0)
    udp.send(Buffer.concat([res, data]), from.port, from.address)
  })

  const image = { width: 4, height: 144, bits: new Uint8Array(4 * 144) }
  const job = encodeSr5900p(image, { tapeMm: 12 })
  const ctrl = new TprtUdpControl('127.0.0.1', (udp.address() as AddressInfo).port)
  try {
    await printSr5900p(ctrl, () => openTcpData('127.0.0.1', tcpPort), job, 12, { clock: fastClock })
  } finally {
    await ctrl.close()
  }
  await new Promise((r) => setTimeout(r, 50))
  expect(Buffer.concat(received).equals(Buffer.from(job))).toBe(true)
  expect(seen).toEqual([1, 2, 0x0101, 0x0100, 1, 1, 3])
})

it('times out when nobody answers', async () => {
  const ctrl = new TprtUdpControl('127.0.0.1', 9)
  await expect(ctrl.request(TPRT.STATUS, 200)).rejects.toThrow(/応答がありません/)
  await ctrl.close()
})
