// 印刷手順が使うチャネルの抽象。実装は @labelbridge/web（WebUSB / Web Serial）と @labelbridge/node（UDP / TCP）。

import type { PrinterStatus } from '../models'

export class TimeoutError extends Error {
  constructor(message = 'タイムアウトしました') {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** 双方向のバイト列（Bluetooth SPP、USB bulk など）。 */
export interface ByteChannel {
  write(bytes: Uint8Array): Promise<void>
  /** 1 バイト以上届くまで待つ。timeoutMs を過ぎたら TimeoutError。 */
  read(timeoutMs: number): Promise<Uint8Array>
}

/** USB プリンタークラスの制御転送も使えるチャネル。 */
export interface UsbPrinterChannel extends ByteChannel {
  /** クラス要求 SOFT_RESET（bRequest 2） */
  softReset(): Promise<void>
  /** クラス要求 GET_PORT_STATUS（0x10 = Selected, 0x08 = No Error, 0x20 = Paper Empty） */
  portStatus(): Promise<number>
}

/** TPRT（UDP 9100）の要求・応答。応答のデータ部を返す。 */
export interface TprtControl {
  request(cmd: number, timeoutMs?: number): Promise<Uint8Array>
}

/** TCP 9100 のデータ経路（書き込みのみ）。 */
export interface DataSink {
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}

export type ProgressKind = 'info' | 'ok' | 'error'
export type Progress = (message: string, kind?: ProgressKind) => void

/** テストで時間を差し替えられるようにする。 */
export interface Clock {
  sleep(ms: number): Promise<void>
  now(): number
}

export const realClock: Clock = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
}

export class PrinterError extends Error {
  constructor(
    message: string,
    readonly status?: PrinterStatus,
  ) {
    super(message)
    this.name = 'PrinterError'
  }
}

/**
 * ストリームからステータスフレームを切り出す。届いたバイトはため込み、
 * parse が見つけた最初のフレームを返して、その分を捨てる。
 */
export class FrameReader {
  private buf = new Uint8Array(0)

  constructor(
    private readonly ch: ByteChannel,
    private readonly parse: (b: Uint8Array) => { status: PrinterStatus; consumed: number } | null,
    private readonly clock: Clock = realClock,
  ) {}

  /** ため込んだ分を捨てる（古い応答を読まないように）。 */
  discard(): void {
    this.buf = new Uint8Array(0)
  }

  async next(timeoutMs: number): Promise<PrinterStatus> {
    const deadline = this.clock.now() + timeoutMs
    for (;;) {
      const hit = this.parse(this.buf)
      if (hit) {
        this.buf = this.buf.slice(hit.consumed)
        return hit.status
      }
      const left = deadline - this.clock.now()
      if (left <= 0) throw new TimeoutError('ステータスの応答がありません')
      const chunk = await this.ch.read(left)
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf)
      next.set(chunk, this.buf.length)
      this.buf = next
    }
  }
}
