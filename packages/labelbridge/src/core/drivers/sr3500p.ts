// SR3500P（USB）。ESC/P2 の ESC ( G / ESC ( v / ESC . の形式（docs/protocol.md §2）。
// バイト列は crates/labelbridge/src/sr3500p.rs が作る（wasm）。
//
//   [ESC { D }（濃度 0 以外）] / ESC ( G 01 00 01
//   ESC ( C <ページ長> / [ESC ( v <余白>] / (ESC ( v 1 + ESC . 00 14 14 01 n data) × 行 / FF
//   ESC @
// 1 ジョブ = 1 枚。カットはジョブ終了でしか起きず、ESC @ の後のデータは SOFT_RESET を挟むまで無視される
// ので、複数枚は flows/print.ts が「SOFT_RESET → ジョブ」を繰り返す。
// 行はラベルの末尾から送る。1 行の中は dot 0 = ラベル上端。
// ステータスは ESC { Q 00 00 } に対する 64 バイトのテキスト（@BDC ST\r\nST:xx;ER:xx;…;TW:xx;… 0xFF）。

import { frame } from '../bytes'
import type { MonoImage } from '../image'
import type { LabelJob, PrinterStatus } from '../models'
import { rustEncode, rustFindStatus } from './rust'

export const SR3500P_DPI = 180
export const SR3500P_STATUS_REQUEST = frame(0x51, [0x00, 0x00])
export const SR3500P_STATUS_LEN = 64

/** 共通の `LabelJob`。`copies` は使わない（flows の `printSr3500p` の `copies` で繰り返す）。 */
export type Sr3500pJob = LabelJob

/**
 * 1 枚ぶんのジョブを作る。`cut` は 'full' / 'none' を受け付けるが、プリンターはジョブ終了で必ずカットするので
 * バイト列は変わらない（'half' は `UnsupportedCutError`）。`copies` は無視する。
 */
export function encodeSr3500p(image: MonoImage, job: Sr3500pJob): Uint8Array {
  const r = rustEncode<{ bytes: number }>('SR3500P', [image], job)
  return r.blobs[r.json.bytes]!
}

/** バッファから最初のステータスフレームを取り出す。ST・ER のどちらかが欠けたフレームは採らない。 */
export function parseSr3500pStatus(buf: Uint8Array): { status: PrinterStatus; consumed: number } | null {
  return rustFindStatus('SR3500P', buf)
}
