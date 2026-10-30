// LAN のラベルプリンターを mDNS（`_pdl-datastream._tcp`）で探す、最小限の実装（docs/protocol.md §4）。
// 問い合わせを送り（取りこぼしに備えて 1 秒後にもう一度）、届いた応答の PTR / SRV / TXT / A を集める。

import { createSocket } from 'node:dgram'
import { MODELS, type ModelId } from '../core'

const SERVICE = '_pdl-datastream._tcp.local'
const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353

/** mDNS で見つかったプリンター */
export interface DiscoveredPrinter {
  /** サービス名（プリンター自身の名前。例: "KING JIM TEPRA PRO SR5900P"）。同じ機種が何台あっても見分けられる */
  name: string
  /** ホスト名（例: "SR5900P1A2B3C.local"） */
  host: string
  port: number
  /** IPv4 アドレス */
  addresses: string[]
  /** TXT の `usb_MDL` やサービス名から分かった機種。対応していない機器は null */
  model: ModelId | null
  txt: Record<string, string>
}

/** mDNS の応答から集めたレコード */
export interface MdnsRecords {
  ptr: Set<string>
  srv: Map<string, { host: string; port: number }>
  txt: Map<string, Record<string, string>>
  a: Map<string, Set<string>>
}

export const emptyMdnsRecords = (): MdnsRecords => ({ ptr: new Set(), srv: new Map(), txt: new Map(), a: new Map() })

function encodeName(name: string): Uint8Array {
  const out: number[] = []
  for (const label of name.split('.').filter(Boolean)) {
    const b = new TextEncoder().encode(label)
    out.push(b.length, ...b)
  }
  out.push(0)
  return Uint8Array.from(out)
}

/** PTR の問い合わせ */
export function mdnsQuery(name = SERVICE): Uint8Array {
  const header = new Uint8Array(12)
  header[5] = 1 // QDCOUNT
  return Uint8Array.from([...header, ...encodeName(name), 0x00, 0x0c, 0x00, 0x01]) // PTR, IN
}

const u16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const utf8 = new TextDecoder()

function readName(buf: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = []
  let pos = offset
  let next = -1
  for (let jumps = 0; pos < buf.length && jumps < 16; ) {
    const len = buf[pos]!
    if (len === 0) {
      pos++
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = pos + 2
      pos = ((len & 0x3f) << 8) | buf[pos + 1]!
      jumps++
      continue
    }
    labels.push(utf8.decode(buf.subarray(pos + 1, pos + 1 + len)))
    pos += 1 + len
  }
  return { name: labels.join('.'), next: next >= 0 ? next : pos }
}

function readTxt(buf: Uint8Array, start: number, end: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (let p = start; p < end; ) {
    const len = buf[p]!
    const s = utf8.decode(buf.subarray(p + 1, p + 1 + len))
    const eq = s.indexOf('=')
    if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1)
    p += 1 + len
  }
  return out
}

/** mDNS の応答 1 つを読み、records に足す（壊れた応答は読めたところまで） */
export function parseMdnsResponse(buf: Uint8Array, records: MdnsRecords) {
  if (buf.length < 12) return
  const qd = u16(buf, 4)
  const total = u16(buf, 6) + u16(buf, 8) + u16(buf, 10)
  let pos = 12
  for (let i = 0; i < qd; i++) pos = readName(buf, pos).next + 4
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    const { name, next } = readName(buf, pos)
    pos = next
    const type = u16(buf, pos)
    const rdlen = u16(buf, pos + 8)
    const rdata = pos + 10
    if (rdata + rdlen > buf.length) return
    if (type === 12) records.ptr.add(readName(buf, rdata).name)
    else if (type === 33) records.srv.set(name, { port: u16(buf, rdata + 4), host: readName(buf, rdata + 6).name })
    else if (type === 16) records.txt.set(name, readTxt(buf, rdata, rdata + rdlen))
    else if (type === 1 && rdlen === 4) {
      if (!records.a.has(name)) records.a.set(name, new Set())
      records.a.get(name)!.add(Array.from(buf.subarray(rdata, rdata + 4)).join('.'))
    }
    pos = rdata + rdlen
  }
}

/** TXT の usb_MDL（例: "TEPRA PRO SR5900P"）か、サービス名から機種を当てる */
function modelOf(name: string, txt: Record<string, string>): ModelId | null {
  const hay = `${txt.usb_MDL ?? ''} ${txt.ty ?? ''} ${name}`.toUpperCase()
  return (Object.keys(MODELS) as ModelId[]).find((id) => hay.includes(id)) ?? null
}

/** 集めたレコードを、プリンターの一覧にする（SRV が無いものは除く） */
export function collectMdns(records: MdnsRecords): DiscoveredPrinter[] {
  const out: DiscoveredPrinter[] = []
  for (const instance of records.ptr) {
    const srv = records.srv.get(instance)
    if (!srv) continue
    const name = instance.replace(`.${SERVICE}`, '')
    const txt = records.txt.get(instance) ?? {}
    out.push({ name, host: srv.host, port: srv.port, addresses: [...(records.a.get(srv.host) ?? [])], model: modelOf(name, txt), txt })
  }
  return out
}

/** 探す。enough を渡すと、それが true を返した時点で待つのをやめる */
function browse(timeoutMs: number, enough?: (found: DiscoveredPrinter[]) => boolean): Promise<DiscoveredPrinter[]> {
  return new Promise((resolve) => {
    const records = emptyMdnsRecords()
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    const timers: NodeJS.Timeout[] = []
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      timers.forEach(clearTimeout)
      try {
        sock.close()
      } catch {
        // すでに閉じている
      }
      resolve(collectMdns(records))
    }
    const send = () => sock.send(mdnsQuery(), MDNS_PORT, MDNS_ADDR, (e) => e && done())
    sock.on('error', done)
    sock.on('message', (msg) => {
      parseMdnsResponse(new Uint8Array(msg), records)
      if (enough?.(collectMdns(records))) done()
    })
    sock.bind(0, () => {
      send()
      timers.push(setTimeout(send, 1000), setTimeout(done, timeoutMs))
    })
  })
}

/**
 * LAN のプリンターを探す（`_pdl-datastream._tcp` を出している機器すべて。対応機種かは `model` を見る）。
 * 同じネットワークに複数台あっても、`name`（プリンター自身の名前）で見分けられる。
 */
export function discoverLanPrinters(timeoutMs = 2500): Promise<DiscoveredPrinter[]> {
  return browse(timeoutMs)
}

/**
 * サービス名でプリンターを探す。アドレスまで分かった時点で返す（見つからなければ null）。
 * IP アドレスは DHCP で変わることがあるので、保存しておくなら名前の方がよい。
 */
export async function findLanPrinter(name: string, timeoutMs = 3000): Promise<DiscoveredPrinter | null> {
  const match = (d: DiscoveredPrinter) => d.name === name
  const found = await browse(timeoutMs, (all) => all.some((d) => match(d) && d.addresses.length > 0))
  return found.find(match) ?? null
}
