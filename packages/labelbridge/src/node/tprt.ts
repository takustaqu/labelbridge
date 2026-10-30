// SR5900P の LAN 経路（Node）。制御は UDP 9100 の TPRT、データは TCP 9100。

import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { connect, type Socket } from 'node:net'
import {
  TPRT_PORT,
  TimeoutError,
  parseTprtResponse,
  tprtRequest,
  type DataSink,
  type TprtControl,
} from '../core'

/** UDP の制御チャネル。応答は "tprt" ヘッダのうち、送った cmd と一致するものだけを採る。 */
export class TprtUdpControl implements TprtControl {
  private socket: UdpSocket
  private waiters: { cmd: number; resolve: (d: Uint8Array) => void; reject: (e: Error) => void }[] = []

  constructor(
    readonly host: string,
    readonly port = TPRT_PORT,
  ) {
    this.socket = createSocket('udp4')
    // ICMP 到達不能などは 'error' で来る。待っている要求をすべて失敗させる（未処理だとプロセスが落ちる）
    this.socket.on('error', (e) => {
      const waiting = this.waiters.splice(0)
      for (const w of waiting) w.reject(e)
    })
    this.socket.on('message', (msg) => {
      const r = parseTprtResponse(new Uint8Array(msg))
      if (!r) return
      const i = this.waiters.findIndex((w) => w.cmd === r.cmd)
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(r.data)
    })
  }

  request(cmd: number, timeoutMs = 3000): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const waiter = {
        cmd,
        resolve: (d: Uint8Array) => {
          clearTimeout(timer)
          resolve(d)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(new TimeoutError(`TPRT cmd ${cmd} の応答がありません（${this.host}）`))
      }, timeoutMs)
      this.waiters.push(waiter)
      this.socket.send(tprtRequest(cmd), this.port, this.host, (err) => {
        if (err) {
          clearTimeout(timer)
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(err)
        }
      })
    })
  }

  close(): Promise<void> {
    return new Promise((r) => this.socket.close(() => r()))
  }
}

/**
 * TCP 9100 のデータ経路（印刷開始(2) の後にだけ開く）。
 * IPv4 でつなぐ: mDNS の `.local` 名は IPv6 のリンクローカルが先に返ることがあり、それに向かうと TCP 9100 につながらない
 * （UDP の制御は udp4 のソケットなので、もともと IPv4 で引く）。
 */
export function openTcpData(host: string, port = TPRT_PORT, timeoutMs = 5000): Promise<DataSink> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect({ host, port, noDelay: true, family: 4 })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new TimeoutError(`TCP ${host}:${port} に接続できません`))
    }, timeoutMs)
    sock.once('error', (e) => (clearTimeout(timer), reject(e)))
    sock.once('connect', () => {
      clearTimeout(timer)
      // 接続後のエラーは write のコールバックに届く。未処理の 'error' でプロセスが落ちないようにする
      sock.on('error', () => undefined)
      resolve({
        write: (b) => new Promise((res, rej) => sock.write(b, (e) => (e ? rej(e) : res()))),
        close: () => new Promise((res) => sock.end(() => res())),
      })
    })
  })
}
