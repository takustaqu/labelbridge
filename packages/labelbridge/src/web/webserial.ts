// Web Serial（Bluetooth Classic SPP を含む）の ByteChannel。Bluetooth 接続の機種で使う。
// - Chromium 系（デスクトップ版 Chrome 117 以降、Android 版 Chrome 137 以降）。SPP は allowedBluetoothServiceClassIds に SPP_UUID が要る。
// - 開いたまま止まると SPP が解放されないので、open は 15 秒、送信は 30 秒で打ち切る。使い終わったら必ず close する。
// - Bluetooth のリンクが切れても、Chrome はポートを閉じず「半開き」のまま残す（readable / writable が残り、
//   次の open が「すでに開いている」で失敗する）。open の前と disconnect イベントの時点で、こちらから閉じて片付ける。
// - リンクが張られていない状態からの最初の open は、リンク確立待ちで約 10 秒後に失敗し、直後の再試行で開ける。
//   （いずれも docs/protocol.md §3（接続）。macOS の Chromium で実機確認）

import { TimeoutError, type ByteChannel } from '../core'
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

/** 半開きで残ったポートを閉じる（失敗しても投げない）。 */
export async function releaseSerialPort(port: SerialPort): Promise<void> {
  if (!port.readable && !port.writable) return
  await port.close().catch(() => undefined)
}

const isAlreadyOpen = (e: unknown) => e instanceof Error && e.name === 'InvalidStateError'

export class WebSerialChannel implements ByteChannel {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private pending: Uint8Array[] = []
  private wake: (() => void) | null = null
  private failed: string | null = null
  private loop: Promise<void> | null = null
  private opened = false
  private readonly onDisconnect = () => {
    // リンクが切れた。待っている読み取りをすぐ失敗させ、ポートを閉じて半開きを残さない
    this.failed = 'Bluetooth のリンクが切れました'
    this.wake?.()
    void this.close()
  }

  constructor(readonly port: SerialPort) {}

  /**
   * ポートを開く。半開きで残っていれば先に閉じる。
   * リンクが張られていない状態からの最初の open は失敗しやすいので、少し待って再試行する。
   */
  async open(attempts = 3, retryDelayMs = 500): Promise<void> {
    await releaseSerialPort(this.port)
    for (let i = 1; ; i++) {
      try {
        // RFCOMM では baudRate は使われないが、Web Serial の open には必須
        await withTimeout(this.port.open({ baudRate: 9600 }), 15000, 'ポートを開けません（15 秒でタイムアウト）')
        break
      } catch (e) {
        // タイムアウト後に open が遅れて成功していることがある。その場合はそのまま使う
        if (this.port.readable && !isAlreadyOpen(e)) break
        // 「すでに開いている」なら、残っているポートを閉じてから開き直す
        if (isAlreadyOpen(e)) await releaseSerialPort(this.port)
        if (i >= attempts) {
          throw new Error(
            `プリンターに接続できません（${e instanceof Error ? e.message : e}）。` +
              'プリンターの電源が入っているか、他の端末やアプリ（スマートフォンの純正アプリ、labelbridge コマンド）が接続していないかを確認して、もう一度試してください。',
          )
        }
        await sleep(retryDelayMs)
      }
    }
    this.opened = true
    this.failed = null
    this.pending = []
    this.port.addEventListener('disconnect', this.onDisconnect)
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
        this.failed ??= String(e)
      } finally {
        this.failed ??= '切断されました'
        this.wake?.()
      }
    })()
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.failed) throw new Error(this.failed)
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

  /** 閉じる。切断後の半開きの状態からでも閉じられるよう、途中の失敗は無視する。 */
  async close(): Promise<void> {
    if (!this.opened) return
    this.opened = false
    this.port.removeEventListener('disconnect', this.onDisconnect)
    await this.reader?.cancel().catch(() => undefined)
    await this.loop
    try {
      this.reader?.releaseLock()
    } catch {
      // 読み取り中のまま切れた場合など。ロックはポートを閉じれば外れる
    }
    this.reader = null
    await releaseSerialPort(this.port)
  }
}
