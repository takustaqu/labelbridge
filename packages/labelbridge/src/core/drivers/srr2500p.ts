// SR-R2500P（Bluetooth Classic SPP）。commandLevel 5 の手順（docs/protocol.md §3）。
// バイト列は crates/labelbridge/src/srr2500p.rs が作る（wasm）。
// 行はラベルの先頭から送る。1 行の中は dot 0 = ラベル下端。

import { frame } from '../bytes'
import type { MonoImage } from '../image'
import type { LabelJob, PrinterStatus } from '../models'
import { rustEncode, rustFindStatus } from './rust'

export const SRR2500P_DPI = 180
export const SRR2500P_STATUS_ONCE = frame(0x49, [0x00, 0x00])
export const SRR2500P_STATUS_AUTO = frame(0x49, [0x05, 0x00])
export const SRR2500P_STATUS_LEN = 92
export const SRR2500P_BAND_LINES = 1024

/** 共通の `LabelJob`。cut は 'full' / 'none'（'half' は `UnsupportedCutError`）。 */
export interface SrR2500pJob extends LabelJob {
  /**
   * ジョブの先頭の空白（印字ヘッドからカッターまで）の扱い。
   * 'full'（既定）は切り落とす（短い切れ端が 1 枚出る）。'none' は切り落とさず、最初のラベルにつけたまま出す。
   * この機種にハーフカットは無い（C の 1 バイト目の 2 はフルカットと同じになる）
   */
  leadingCut?: 'full' | 'none'
}

/** ラベル 1 枚ぶん: ページ環境 → bands → FF */
export interface SrR2500pPage {
  pageEnvironment: Uint8Array
  bands: Uint8Array[]
}

export interface SrR2500pParts {
  environment: Uint8Array
  /** 順に送る。各ページは copies ぶん続けて繰り返す */
  pages: SrR2500pPage[]
  copies: number
  end: Uint8Array
}

export function srR2500pParts(image: MonoImage, job: SrR2500pJob): SrR2500pParts {
  return srR2500pPagesParts([image], job)
}

/**
 * 何枚かのラベルを 1 回のジョブにする（先頭の空白の扱いがジョブの最初の 1 回で済む）。
 * C（カット）の 4 バイトは [ジョブの先頭, ラベルの間, ジョブの最後, ?]。
 */
export function srR2500pPagesParts(images: MonoImage[], job: SrR2500pJob): SrR2500pParts {
  if (!images.length) throw new Error('印刷するラベルがありません')
  type Parts = { environment: number; pages: { pageEnvironment: number; bands: number[] }[]; copies: number; end: number }
  const { json, blobs } = rustEncode<Parts>('SR-R2500P', images, job)
  return {
    environment: blobs[json.environment]!,
    pages: json.pages.map((p) => ({ pageEnvironment: blobs[p.pageEnvironment]!, bands: p.bands.map((i) => blobs[i]!) })),
    copies: json.copies,
    end: blobs[json.end]!,
  }
}

/** ステータス 92 バイト: "@BDC ST2\r\nP\0;"（13）+ 本体 78 + 1。本体 [1]=ST [2]=ER [3]=TW。 */
export function parseSrR2500pStatus(buf: Uint8Array): { status: PrinterStatus; consumed: number } | null {
  return rustFindStatus('SR-R2500P', buf)
}
