// ドライバが Rust（wasm）を呼ぶための薄い層。数値を整数にそろえて渡し、失敗をこのライブラリの例外にする。

import type { MonoImage } from '../image'
import { UnsupportedCutError, type CutMode, type ModelId, type PrinterStatus } from '../models'
import { WasmCallError, wasmCall, type WasmReply } from '../wasm'

/** Rust に渡すジョブ（機種ごとの設定も含む） */
export interface RustJob {
  tapeMm: number
  cut?: CutMode
  copies?: number
  density?: number
  marginDots?: number
  leadingCut?: string
  calibration?: Record<string, number | undefined>
}

const int = (v: number | undefined, lo: number, hi: number) => (v === undefined || !Number.isFinite(v) ? undefined : Math.min(hi, Math.max(lo, Math.round(v))))

/** Rust の失敗を、これまでと同じ例外にする */
function rethrow(e: unknown, model: ModelId): never {
  if (!(e instanceof WasmCallError)) throw e
  const j = e.json as Record<string, unknown> & { error: string }
  switch (j.error) {
    case 'unsupportedCut':
      throw new UnsupportedCutError(model, j.cut as CutMode)
    case 'tooWide':
      throw new Error(`画像の高さ ${j.got} が印字可能幅 ${j.max} を超えています`)
    case 'unsupportedTape':
      throw new Error(`${model} は ${j.tapeMm}mm テープに対応していません`)
    case 'tooLong':
      throw new Error(`ラベルが長すぎます（${j.lines} 行。上限 ${j.max}）`)
    case 'noLabels':
      throw new Error('ラベルがありません')
    default:
      throw e
  }
}

/** ラベル画像を Rust のエンコーダに渡す */
export function rustEncode<T>(model: ModelId, images: MonoImage[], job: RustJob): WasmReply<T> {
  const data = new Uint8Array(images.reduce((n, m) => n + m.width * m.height, 0))
  let at = 0
  for (const m of images) {
    data.set(m.bits.subarray(0, m.width * m.height), at)
    at += m.width * m.height
  }
  const calibration = job.calibration && Object.fromEntries(Object.entries(job.calibration).map(([k, v]) => [k, int(v, -1e6, 1e6)]))
  const wire = {
    tapeMm: job.tapeMm,
    cut: job.cut,
    copies: int(Math.floor(job.copies ?? 1), 1, 0xffff),
    density: int(job.density, -5, 5),
    marginDots: int(job.marginDots, 0, 0xffffffff),
    leadingCut: job.leadingCut,
    calibration,
  }
  try {
    return wasmCall<T>({ op: 'encode', model, job: wire, images: images.map((m) => ({ width: m.width, height: m.height })) }, data)
  } catch (e) {
    rethrow(e, model)
  }
}

/** バッファの中の最初の完全なステータスフレーム（壊れたものは飛ばす） */
export function rustFindStatus(model: ModelId, buf: Uint8Array): { status: PrinterStatus; consumed: number } | null {
  const r = wasmCall<{ status: { state: number; error: number; tapeMm: number | null }; start: number; end: number } | null>({ op: 'findStatus', model }, buf).json
  if (!r) return null
  return { status: { ...r.status, raw: buf.slice(r.start, r.end) }, consumed: r.end }
}

/** SR5900P のジョブの並べ方 */
export function rustLayout(count: number, cut: CutMode, marginDots: number | undefined, calibration: Record<string, number | undefined>) {
  const c = Object.fromEntries(Object.entries(calibration).map(([k, v]) => [k, int(v, -1e6, 1e6)]))
  return wasmCall<{ dummy: boolean; pads: [number, number][] }>({ op: 'layout', count, cut, marginDots: int(marginDots, 0, 0xffffffff), calibration: c }).json
}
