// Web Serial（Bluetooth Classic SPP を含む）の ByteChannel。SR-R2500P で使う。
// - Chromium 系（デスクトップ版 Chrome 117 以降）。SPP は allowedBluetoothServiceClassIds に SPP_UUID が要る。
// - 開いたまま止まるとブラウザを終了するまで SPP が解放されないので、open は 15 秒、送信は 30 秒で打ち切る。
//   使い終わったら必ず close する（docs/protocol.md §3（接続））。

import { TimeoutError, type ByteChannel } from '@labelbridge/core'
import { sleep, withTimeout } from './timeout'

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb'

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

/** SPP の機器を選ばせる（ユーザー操作の中で呼ぶ）。 */
export function requestSppPort(): Promise<SerialPort> {
  return navigator.serial.requestPort({
    filters: [{ bluetoothServiceClassId: SPP_UUID }],
    allowedBluetoothServiceClassIds: [SPP_UUID],
  })
}

export class WebSerialChannel implements ByteChannel {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private pending: Uint8Array[] = []
  private wake: (() => void) | null = null
  private failed: string | null = null
  private loop: Promise<void> | null = null
  private opened = false

  constructor(readonly port: SerialPort) {}

  /** 最初の open はリンク確立待ちで失敗しやすいので、少し待って再試行する。 */
  async open(attempts = 3, retryDelayMs = 1500): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        // RFCOMM では baudRate は使われないが、Web Serial の open には必須
        await withTimeout(this.port.open({ baudRate: 9600 }), 15000, 'ポートを開けません（15 秒でタイムアウト）')
        break
      } catch (e) {
        // タイムアウト後に open が遅れて成功していることがある。その場合はそのまま使う
        if (this.port.readable) break
        if (i >= attempts) {
          throw new Error(
            `プリンターに接続できません（${e instanceof Error ? e.message : e}）。` +
              'プリンターの電源が入っているか、他の端末やアプリ（スマートフォンの純正アプリ、labelbridge コマンド）が接続していないかを確認してください。' +
              'それでも繋がらない場合はブラウザを再起動してください（macOS の Chromium は、Bluetooth のリンクが一度切れると再起動まで開けなくなることがあります）。',
          )
        }
        await sleep(retryDelayMs)
      }
    }
    this.opened = true
    this.failed = null
    this.reader = this.port.readable!.getReader()
    this.loop = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader!.read()
          if (done) break
          if (value?.length) {
            this.pending.push(value)
            this.wake?.()
          }
        }
      } catch (e) {
        this.failed = String(e)
      } finally {
        this.failed ??= '切断されました'
        this.wake?.()
      }
    })()
  }

  async write(bytes: Uint8Array): Promise<void> {
    const w = this.port.writable!.getWriter()
    try {
      await withTimeout(w.write(bytes), 30000, '送信が 30 秒で終わりませんでした')
    } finally {
      w.releaseLock()
    }
  }

  async read(timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const chunk = this.pending.shift()
      if (chunk) return chunk
      if (this.failed) throw new Error(this.failed)
      const left = deadline - Date.now()
      if (left <= 0) throw new TimeoutError()
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left)
        this.wake = () => (clearTimeout(t), resolve())
      })
    }
  }

  async close(): Promise<void> {
    if (!this.opened) return
    this.opened = false
    await this.reader?.cancel().catch(() => undefined)
    await this.loop
    this.reader?.releaseLock()
    this.reader = null
    await this.port.close()
  }
}

