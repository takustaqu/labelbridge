// WebUSB の USB プリンタークラス（7/1/2）チャネル。SR3500P で使う。
// - macOS はこのインターフェースにカーネルドライバを付けないので、そのまま claim できる。
// - Windows は OS のプリンタードライバが掴むため、WinUSB への差し替えが要る。Linux は usblp を外す必要がある。

import { USB_VENDOR_ID, TimeoutError, type UsbPrinterChannel } from '../core'
import { withTimeout } from './timeout'

export function webUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator
}

/** 対応機種（USB）を選ばせる（ユーザー操作の中で呼ぶ）。 */
export function requestUsbPrinter(productId?: number): Promise<USBDevice> {
  return navigator.usb.requestDevice({ filters: [{ vendorId: USB_VENDOR_ID, ...(productId ? { productId } : {}) }] })
}

export class WebUsbPrinterChannel implements UsbPrinterChannel {
  private iface = 0
  private epOut = 0
  private epIn = 0
  private packet = 64
  private inflight: Promise<USBInTransferResult> | null = null
  private opened = false

  constructor(readonly device: USBDevice) {}

  async open(): Promise<void> {
    const d = this.device
    await d.open()
    if (!d.configuration) await d.selectConfiguration(d.configurations[0]!.configurationValue)
    const alt = d.configuration!.interfaces
      .map((i) => i.alternates.find((a) => a.interfaceClass === 7) && i)
      .find(Boolean)
    if (!alt) throw new Error('プリンタークラスのインターフェースが見つかりません')
    this.iface = alt.interfaceNumber
    const eps = alt.alternate.endpoints
    const out = eps.find((e) => e.direction === 'out' && e.type === 'bulk')
    const inn = eps.find((e) => e.direction === 'in' && e.type === 'bulk')
    if (!out || !inn) throw new Error('bulk エンドポイントが見つかりません')
    this.epOut = out.endpointNumber
    this.epIn = inn.endpointNumber
    this.packet = inn.packetSize
    try {
      await d.claimInterface(this.iface)
    } catch (e) {
      throw new Error(
        `インターフェースを確保できません（${e}）。他のアプリ（labelbridge コマンド、別のタブ）が使っていないか、` +
          'Windows では WinUSB ドライバになっているかを確認してください。',
      )
    }
    this.opened = true
  }

  async softReset(): Promise<void> {
    await this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x02, value: 0, index: this.iface })
  }

  async portStatus(): Promise<number> {
    const r = await this.device.controlTransferIn(
      { requestType: 'class', recipient: 'interface', request: 0x01, value: 0, index: this.iface },
      1,
    )
    return r.data?.getUint8(0) ?? 0
  }

  async write(bytes: Uint8Array): Promise<void> {
    const r = await withTimeout(this.device.transferOut(this.epOut, bytes as Uint8Array<ArrayBuffer>), 30000, '送信が 30 秒で終わりませんでした')
    if (r.status !== 'ok') throw new Error(`送信に失敗しました（${r.status}）`)
  }

  /**
   * transferIn は取り消せないので、待ちきれなかった要求は次の read で引き継ぐ。
   * 要求長はパケット長ちょうどにする。SR3500P のステータスは 64 バイト = パケット長ちょうどで
   * 終端の短いパケットが来ないため、それより長く要求すると Chrome の WebUSB は返ってこない（実機）。
   */
  async read(timeoutMs: number): Promise<Uint8Array> {
    this.inflight ??= this.device.transferIn(this.epIn, this.packet)
    let r: USBInTransferResult
    try {
      r = await withTimeout(this.inflight, timeoutMs, '応答がありません')
    } catch (e) {
      if (e instanceof TimeoutError) throw e
      this.inflight = null
      throw e
    }
    this.inflight = null
    if (r.status === 'stall') await this.device.clearHalt('in', this.epIn)
    const data = r.data ? new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) : new Uint8Array(0)
    if (!data.length) throw new TimeoutError()
    return data.slice()
  }

  async close(): Promise<void> {
    if (!this.opened) return
    this.opened = false
    await this.device.releaseInterface(this.iface).catch(() => undefined)
    await this.device.close().catch(() => undefined)
  }
}
