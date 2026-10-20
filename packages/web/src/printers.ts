// ブラウザから各機種へ印刷・状態取得する高水準 API。

import {
  encodeSr3500p,
  modelForUsb,
  modelsFor,
  printArea,
  printSr3500p,
  printSrR2500p,
  readStatusSr3500p,
  readStatusSrR2500p,
  srR2500pParts,
  type JobOptions,
  type ModelId,
  type MonoImage,
  type PrintArea,
  type PrinterStatus,
  type Progress,
} from '@labelbridge/core'
import { WebSerialChannel, requestSppPort } from './webserial'
import { WebUsbPrinterChannel, requestUsbPrinter } from './webusb'

export type { CutMode, JobOptions } from '@labelbridge/core'

async function withChannel<C extends { open(): Promise<void>; close(): Promise<void> }, T>(ch: C, fn: (ch: C) => Promise<T>) {
  await ch.open()
  try {
    return await fn(ch)
  } finally {
    await ch.close()
  }
}

/** 装着テープと、そのテープでの印字範囲（ドット数）を読む。 */
export async function readSr3500p(device: USBDevice): Promise<{ status: PrinterStatus; area: PrintArea | null }> {
  const status = await withChannel(new WebUsbPrinterChannel(device), (ch) => readStatusSr3500p(ch))
  return { status, area: status.tapeMm ? printArea('SR3500P', status.tapeMm) : null }
}

export async function readSrR2500p(port: SerialPort): Promise<{ status: PrinterStatus; area: PrintArea | null }> {
  const status = await withChannel(new WebSerialChannel(port), (ch) => readStatusSrR2500p(ch))
  return { status, area: status.tapeMm ? printArea('SR-R2500P', status.tapeMm) : null }
}

/**
 * SR3500P に 1 画素 = 1 ドットで印刷する。`opts.copies` 枚ぶん「SOFT_RESET → ジョブ」を繰り返す。
 * `opts.cut` は 'full' / 'none'（どちらでも毎枚カットされる）。'half' はエラー。
 */
export async function printImageSr3500p(
  device: USBDevice,
  image: MonoImage,
  tapeMm: number,
  opts: JobOptions = {},
  progress?: Progress,
): Promise<void> {
  const job = encodeSr3500p(image, { ...opts, tapeMm })
  await withChannel(new WebUsbPrinterChannel(device), (ch) => printSr3500p(ch, job, tapeMm, { copies: opts.copies, progress }))
}

/** SR-R2500P に 1 画素 = 1 ドットで印刷する。`opts.cut` は 'full' / 'none'。 */
export async function printImageSrR2500p(
  port: SerialPort,
  image: MonoImage,
  tapeMm: number,
  opts: JobOptions = {},
  progress?: Progress,
): Promise<void> {
  const parts = srR2500pParts(image, { ...opts, tapeMm })
  await withChannel(new WebSerialChannel(port), (ch) => printSrR2500p(ch, parts, tapeMm, { progress }))
}

// ---- 接続方式だけ選び、機種はライブラリが決める ----

export interface PrinterInfo {
  status: PrinterStatus
  /** 装着テープでの印字範囲。テープなしなら null */
  area: PrintArea | null
}

/** 機種に依らない操作。`requestPrinter` / `usbPrinter` / `serialPrinter` で作る。 */
export interface WebPrinter {
  readonly model: ModelId
  readonly connection: 'usb' | 'serial'
  /** 装着テープと印字範囲を読む（印字しない） */
  read(): Promise<PrinterInfo>
  /**
   * 1 画素 = 1 ドットで印刷する。image.height は印字可能ドット数以下。
   * `opts.cut` は `MODELS[model].fullCut` / `halfCut` にあるものだけ（ほかは `UnsupportedCutError`）。
   */
  print(image: MonoImage, tapeMm: number, opts?: JobOptions, progress?: Progress): Promise<void>
}

/** USB 機器から機種を決めて WebPrinter にする。対応外の product ID なら投げる。 */
export function usbPrinter(device: USBDevice): WebPrinter {
  const model = modelForUsb(device.vendorId, device.productId)
  if (!model) throw new Error(`対応していない USB 機器です（${device.vendorId.toString(16)}:${device.productId.toString(16)}）`)
  return {
    model,
    connection: 'usb',
    read: () => readSr3500p(device),
    print: (image, tapeMm, opts, progress) => printImageSr3500p(device, image, tapeMm, opts, progress),
  }
}

/** シリアル（Bluetooth SPP）ポートを WebPrinter にする。機種は能力表の Bluetooth 対応機種から決める。 */
export function serialPrinter(port: SerialPort): WebPrinter {
  const [model, ...rest] = modelsFor('bluetooth')
  if (!model || rest.length) throw new Error('シリアル接続の機種を一意に決められません。機種別の API を使ってください')
  return {
    model,
    connection: 'serial',
    read: () => readSrR2500p(port),
    print: (image, tapeMm, opts, progress) => printImageSrR2500p(port, image, tapeMm, opts, progress),
  }
}

/** 接続方式を選んでプリンターを選ばせる（ユーザー操作の中で呼ぶ）。 */
export async function requestPrinter(connection: 'usb' | 'serial'): Promise<WebPrinter> {
  return connection === 'usb' ? usbPrinter(await requestUsbPrinter()) : serialPrinter(await requestSppPort())
}
