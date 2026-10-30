import { describe, expect, it } from 'vitest'
import { collectMdns, emptyMdnsRecords, mdnsQuery, parseMdnsResponse } from '../src/node/mdns'

const enc = new TextEncoder()
const name = (s: string) => [...s.split('.').flatMap((l) => [l.length, ...enc.encode(l)]), 0]
const u16 = (v: number) => [v >> 8, v & 0xff]
const rr = (owner: number[], type: number, rdata: number[]) => [...owner, ...u16(type), 0x80, 0x01, 0, 0, 0x11, 0x94, ...u16(rdata.length), ...rdata]

/** PTR → SRV → TXT → A の応答（サービス名の 2 回目以降は圧縮ポインタで指す） */
function response(instance: string, host: string, mdl: string, ip: number[]) {
  const header = [0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0]
  const service = name('_pdl-datastream._tcp.local')
  const ptrOwnerAt = header.length
  const ptrRdataAt = ptrOwnerAt + service.length + 10
  const instanceName = [instance.length, ...enc.encode(instance), 0xc0, ptrOwnerAt]
  const ptr = rr(service, 12, instanceName)
  const pointerToInstance = [0xc0, ptrRdataAt]
  const srv = rr(pointerToInstance, 33, [0, 0, 0, 0, ...u16(9100), ...name(host)])
  const txtEntry = enc.encode(`usb_MDL=${mdl}`)
  const txt = rr(pointerToInstance, 16, [txtEntry.length, ...txtEntry])
  const a = rr(name(host), 1, ip)
  return Uint8Array.from([...header, ...ptr, ...srv, ...txt, ...a])
}

describe('mDNS', () => {
  it('builds a PTR query for _pdl-datastream._tcp.local', () => {
    const q = mdnsQuery()
    expect(q[5]).toBe(1)
    expect(Array.from(q.subarray(12))).toEqual([...name('_pdl-datastream._tcp.local'), 0, 12, 0, 1])
  })

  it('collects name, host, port, IPv4 and model from PTR/SRV/TXT/A records', () => {
    const records = emptyMdnsRecords()
    parseMdnsResponse(response('KING JIM TEPRA PRO SR5900P #2', 'SR5900P0A1B2C.local', 'TEPRA PRO SR5900P', [192, 0, 2, 10]), records)
    parseMdnsResponse(response('Some Laser Printer', 'laser.local', 'Generic Laser 1000', [192, 0, 2, 30]), records)
    const found = collectMdns(records)
    expect(found).toEqual([
      {
        name: 'KING JIM TEPRA PRO SR5900P #2',
        host: 'SR5900P0A1B2C.local',
        port: 9100,
        addresses: ['192.0.2.10'],
        model: 'SR5900P',
        txt: { usb_MDL: 'TEPRA PRO SR5900P' },
      },
      expect.objectContaining({ name: 'Some Laser Printer', model: null }),
    ])
  })

  it('ignores truncated packets', () => {
    const records = emptyMdnsRecords()
    const full = response('X', 'x.local', 'TEPRA PRO SR5900P', [10, 0, 0, 1])
    parseMdnsResponse(full.subarray(0, full.length - 3), records)
    expect(collectMdns(records)[0]?.addresses ?? []).toEqual([])
  })
})
