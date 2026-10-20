// SR-R2500P（Bluetooth Classic SPP）。commandLevel 5 の手順（docs/protocol.md §3）。
// crates/labelbridge/src/srr2500p.rs と同じバイト列を作る。
// 行はラベルの先頭から送る。1 行の中は dot 0 = ラベル下端。

import { concat, frame, u16le, u32le } from '../bytes'
import { packColumn, type MonoImage } from '../image'
import { checkCut, printableDots, tapeCodeToMm, type LabelJob, type PrinterStatus } from '../models'

export const SRR2500P_DPI = 180
export const SRR2500P_STATUS_ONCE = frame(0x49, [0x00, 0x00])
export const SRR2500P_STATUS_AUTO = frame(0x49, [0x05, 0x00])
export const SRR2500P_STATUS_LEN = 92
export const SRR2500P_BAND_LINES = 1024
const PREFIX = [0x40, 0x42, 0x44, 0x43, 0x20, 0x53, 0x54, 0x32] // "@BDC ST2"

/** 共通の `LabelJob`。cut は 'full' / 'none'（'half' は `UnsupportedCutError`）。 */
export type SrR2500pJob = LabelJob

export interface SrR2500pParts {
  environment: Uint8Array
  pageEnvironment: Uint8Array
  bands: Uint8Array[]
  copies: number
  end: Uint8Array
}

export function srR2500pParts(image: MonoImage, job: SrR2500pJob): SrR2500pParts {
  const cut = job.cut ?? 'full'
  checkCut('SR-R2500P', cut)
  const dots = printableDots('SR-R2500P', job.tapeMm)
  if (image.height > dots) throw new Error(`画像の高さ ${image.height} が印字可能幅 ${dots} を超えています`)
  const density = Math.max(-5, Math.min(5, job.density ?? 0))
  const environment = concat([
    frame(0x40),
    frame(0x7b, [0x00, 0x00, 0x53, 0x54]),
    frame(0x43, cut === 'none' ? [0, 0, 0, 0] : [1, 1, 1, 1]),
    frame(0x44, [density + 5]),
    frame(0x47),
  ])
  const lines = image.width
  const pageEnvironment = concat([frame(0x4c, u32le(lines)), frame(0x54, u16le(job.marginDots ?? 0))])
  const head = [0x1b, 0x2e, 0x00, 0x00, 0x00, 0x01, ...u16le(dots)]
  const bands: Uint8Array[] = []
  for (let start = 0; start < lines; start += SRR2500P_BAND_LINES) {
    const parts: ArrayLike<number>[] = []
    for (let x = start; x < Math.min(lines, start + SRR2500P_BAND_LINES); x++) {
      parts.push(head, packColumn(image, x, dots, true))
    }
    bands.push(concat(parts))
  }
  return { environment, pageEnvironment, bands, copies: Math.max(1, job.copies ?? 1), end: frame(0x40) }
}

/** ステータス 92 バイト: "@BDC ST2\r\nP\0;"（13）+ 本体 78 + 1。本体 [1]=ST [2]=ER [3]=TW。 */
export function parseSrR2500pStatus(buf: Uint8Array): { status: PrinterStatus; consumed: number } | null {
  for (let i = 0; i + SRR2500P_STATUS_LEN <= buf.length; i++) {
    if (!PREFIX.every((b, k) => buf[i + k] === b)) continue
    const raw = buf.slice(i, i + SRR2500P_STATUS_LEN)
    const body = raw.subarray(13, 13 + 78)
    return {
      status: { state: body[1]!, error: body[2]!, tapeMm: tapeCodeToMm(body[3]!), raw },
      consumed: i + SRR2500P_STATUS_LEN,
    }
  }
  return null
}
