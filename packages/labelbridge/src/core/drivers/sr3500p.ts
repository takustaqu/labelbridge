// SR3500P（USB）。ESC/P2 の ESC ( G / ESC ( v / ESC . の形式（docs/protocol.md §2）。
// crates/labelbridge/src/sr3500p.rs と同じバイト列を作る。
//
//   [ESC { D }（濃度 0 以外）] / ESC ( G 01 00 01
//   ESC ( C <ページ長> / [ESC ( v <余白>] / (ESC ( v 1 + ESC . 00 14 14 01 n data) × 行 / FF
//   ESC @
// 1 ジョブ = 1 枚。カットはジョブ終了でしか起きず、ESC @ の後のデータは SOFT_RESET を挟むまで無視される
// ので、複数枚は flows/print.ts が「SOFT_RESET → ジョブ」を繰り返す。
// 行はラベルの末尾から送る。1 行の中は dot 0 = ラベル上端。
// ステータスは ESC { Q 00 00 } に対する 64 バイトのテキスト（@BDC ST\r\nST:xx;ER:xx;…;TW:xx;… 0xFF）。

import { ESC, FF, concat, escParen, frame, u16le } from '../bytes'
import { packColumn, type MonoImage } from '../image'
import { checkCut, printableDots, tapeCodeToMm, type LabelJob, type PrinterStatus } from '../models'

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
  checkCut('SR3500P', job.cut ?? 'full')
  const dots = printableDots('SR3500P', job.tapeMm)
  if (image.height > dots) throw new Error(`画像の高さ ${image.height} が印字可能幅 ${dots} を超えています`)
  const margin = job.marginDots ?? 0
  const lines = image.width
  const page = lines + 2 * margin
  if (page > 0xffff) throw new Error(`ラベルが長すぎます（${page} 行。上限 65535）`)
  const vh = 3600 / SR3500P_DPI
  const density = Math.max(-5, Math.min(5, job.density ?? 0))

  const parts: ArrayLike<number>[] = []
  if (density !== 0) parts.push(frame(0x44, [density + 5]))
  parts.push(escParen(0x47, [0x01]))
  parts.push(escParen(0x43, u16le(page)))
  if (margin > 0) parts.push(escParen(0x76, u16le(margin)))
  for (let x = lines - 1; x >= 0; x--) {
    parts.push(escParen(0x76, u16le(1)), [ESC, 0x2e, 0x00, vh, vh, 0x01, ...u16le(dots)], packColumn(image, x, dots, false))
  }
  parts.push([FF])
  parts.push([ESC, 0x40])
  return concat(parts)
}

const PREFIX = Array.from('@BDC ST\r\n', (c) => c.charCodeAt(0))

/** バッファから最初のステータスフレームを取り出す。ST・ER のどちらかが欠けたフレームは採らない。 */
export function parseSr3500pStatus(buf: Uint8Array): { status: PrinterStatus; consumed: number } | null {
  for (let i = 0; i + SR3500P_STATUS_LEN <= buf.length; i++) {
    if (!PREFIX.every((b, k) => buf[i + k] === b)) continue
    const raw = buf.slice(i, i + SR3500P_STATUS_LEN)
    const text = String.fromCharCode(...raw.subarray(PREFIX.length))
    const field = (key: string): number | null => {
      const m = new RegExp(`${key}:([0-9A-Fa-f]{2})`).exec(text)
      return m ? parseInt(m[1]!, 16) : null
    }
    const state = field('ST')
    const error = field('ER')
    // ST か ER がないフレームは壊れているとみなして飛ばす（Rust の BadStatus 相当）
    if (state === null || error === null) continue
    const tw = field('TW')
    return {
      status: { state, error, tapeMm: tw === null ? null : tapeCodeToMm(tw), raw },
      consumed: i + SR3500P_STATUS_LEN,
    }
  }
  return null
}
