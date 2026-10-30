// 機種ごとの能力。値の根拠と確度は crates/labelbridge/src/models.rs と docs/protocol.md。

export type ModelId = 'SR3500P' | 'SR-R2500P' | 'SR5900P'
export type Connection = 'usb' | 'bluetooth' | 'lan'

export interface Model {
  id: ModelId
  dpi: number
  /** テープ幅 mm → 1 行の印字可能ドット数 */
  printableDots: Readonly<Record<number, number>>
  /** 印字可能ドット数を実機で確認したテープ幅 */
  verifiedTapes: readonly number[]
  connections: readonly Connection[]
  /** フルカット（Rust の `full_cut`） */
  fullCut: boolean
  /** ハーフカット（Rust の `half_cut`） */
  halfCut: boolean
  usb?: { vendorId: number; productId: number }
}

export const USB_VENDOR_ID = 0x0d8a

export const MODELS: Readonly<Record<ModelId, Model>> = {
  SR3500P: {
    id: 'SR3500P',
    dpi: 180,
    printableDots: { 4: 22, 6: 36, 9: 54, 12: 72, 18: 108, 24: 128 },
    verifiedTapes: [12],
    connections: ['usb'],
    fullCut: true,
    halfCut: false,
    usb: { vendorId: USB_VENDOR_ID, productId: 0x0102 },
  },
  'SR-R2500P': {
    id: 'SR-R2500P',
    dpi: 180,
    printableDots: { 4: 22, 6: 36, 9: 54, 12: 72, 18: 108 },
    verifiedTapes: [12],
    connections: ['bluetooth'],
    fullCut: true,
    halfCut: false,
  },
  SR5900P: {
    id: 'SR5900P',
    dpi: 360,
    printableDots: { 4: 40, 6: 72, 9: 104, 12: 144, 18: 216, 24: 288, 36: 368 },
    verifiedTapes: [12],
    connections: ['lan'],
    fullCut: true,
    halfCut: true,
  },
}

/** カットの指定（Rust の `Cut`）。'none' はどの機種でも受け付ける。 */
export type CutMode = 'full' | 'half' | 'none'

/**
 * 印刷ジョブの指定。3 機種共通（Rust の `RasterJob` ＋ ドライバ側の設定）。
 * 機種ごとの扱い:
 * - `cut`: 能力表（`MODELS[model].fullCut` / `halfCut`）にない指定は `UnsupportedCutError`。
 *   SR3500P はジョブ終了で必ずカットするので、'full' / 'none' は受け付けるがバイト列には影響しない。
 * - `copies`: SR-R2500P / SR5900P はジョブの中で繰り返す（SR5900P はラベルごとのページとして）。SR3500P のエンコーダは使わない
 *   （1 ジョブ = 1 枚。枚数は `printSr3500p` の `copies` が「SOFT_RESET → ジョブ」を繰り返す）。
 * - `marginDots`: 前後の空白（ドット）。SR3500P / SR-R2500P は足す空白、SR5900P は各ラベルの前後に見える余白
 *   （既定は本体の空白の幅。それより小さくすると先頭に空のページが入る。`sr5900pLayout`）。
 */
export interface JobOptions {
  /** 既定 'full' */
  cut?: CutMode
  /** 既定 1 */
  copies?: number
  /** -5..5（範囲外は丸める）。既定 0 */
  density?: number
  /** 既定 0 */
  marginDots?: number
}

/** エンコーダに渡すジョブ。`tapeMm` は装着テープの幅（mm）。 */
export interface LabelJob extends JobOptions {
  tapeMm: number
}

/** 機種が対応しないカット指定（Rust の `DriverError::UnsupportedCut`）。 */
export class UnsupportedCutError extends Error {
  constructor(
    readonly model: ModelId,
    readonly cut: CutMode,
  ) {
    super(`${model} はカット指定 '${cut}' に対応していません`)
    this.name = 'UnsupportedCutError'
  }
}

/** カット指定を能力表と照らし合わせる。対応しなければ `UnsupportedCutError`。 */
export function checkCut(model: ModelId, cut: CutMode): void {
  const m = MODELS[model]
  const ok = cut === 'full' ? m.fullCut : cut === 'half' ? m.halfCut : cut === 'none'
  if (!ok) throw new UnsupportedCutError(model, cut)
}

/** USB の VID:PID から機種を引く（このライブラリが USB で扱える機種だけ）。 */
export function modelForUsb(vendorId: number, productId: number): ModelId | null {
  for (const m of Object.values(MODELS)) if (m.usb?.vendorId === vendorId && m.usb.productId === productId) return m.id
  return null
}

/** その接続方式で扱える機種。 */
export function modelsFor(connection: Connection): ModelId[] {
  return Object.values(MODELS)
    .filter((m) => m.connections.includes(connection))
    .map((m) => m.id)
}

export function printableDots(model: ModelId, tapeMm: number): number {
  const d = MODELS[model].printableDots[tapeMm]
  if (!d) throw new Error(`${model} は ${tapeMm}mm テープに対応していません`)
  return d
}

/**
 * ドットバイドットで描くための印字範囲。
 *
 * ラベル画像（MonoImage）の高さを `printableDots` にすれば、1 画素 = 1 ドットでそのまま印字される
 * （エンコーダは拡大縮小しない）。横方向（送り方向）は 1 画素 = 1 行 = 25.4 / dpi mm。
 */
export interface PrintArea {
  model: ModelId
  tapeMm: number
  dpi: number
  /** 1 ドットの大きさ（mm） */
  dotMm: number
  /** 1 行の印字可能ドット数（= ラベル画像の高さ） */
  printableDots: number
  /** 印字可能幅（mm） */
  printableMm: number
  /** テープ幅をドットに換算した値（参考） */
  tapeDots: number
  /** printableDots を実機で確かめたか（false は参考資料の表などからの推定） */
  verified: boolean
}

export function printArea(model: ModelId, tapeMm: number): PrintArea {
  const m = MODELS[model]
  const dots = printableDots(model, tapeMm)
  const k = m.dpi / 25.4
  return {
    model,
    tapeMm,
    dpi: m.dpi,
    dotMm: 25.4 / m.dpi,
    printableDots: dots,
    printableMm: dots / k,
    tapeDots: tapeMm * k,
    verified: m.verifiedTapes.includes(tapeMm),
  }
}

/** 機種が対応するテープ幅ごとの印字範囲。 */
export function printAreas(model: ModelId): PrintArea[] {
  return Object.keys(MODELS[model].printableDots).map((t) => printArea(model, Number(t)))
}

/** ステータスのテープ幅コード → mm（docs/protocol.md §1。0x5x は別名） */
export function tapeCodeToMm(code: number): number | null {
  const c = code >= 0x51 && code <= 0x5b ? code & 0x0f : code
  return ({ 0x01: 6, 0x02: 9, 0x03: 12, 0x04: 18, 0x05: 24, 0x06: 36, 0x07: 50, 0x0b: 4 } as Record<number, number>)[c] ?? null
}

/** 共通のステータス表現。 */
export interface PrinterStatus {
  /** 0 待機 / 1 送り中 / 2 印字中 / 3 データ受信中 / 4 送り終了 / 5 印字終了 */
  state: number
  /** 0 = エラーなし */
  error: number
  tapeMm: number | null
  raw: Uint8Array
}

export const STATE_NAMES: Readonly<Record<number, string>> = {
  0x00: '待機',
  0x01: '送り中',
  0x02: '印字中',
  0x03: 'データ受信中',
  0x04: '送り終了',
  0x05: '印字終了',
}

export const ERROR_NAMES: Readonly<Record<number, string>> = {
  0x00: 'なし',
  0x01: 'カッターエラー',
  0x06: 'テープカートリッジなし',
  0x15: 'ヘッド過熱',
  0x21: 'カバーオープン',
  0x22: '電圧低下',
  0x42: 'テープエンド',
  0x45: 'パラメータ不足',
}

export function describeStatus(s: PrinterStatus): string {
  const st = STATE_NAMES[s.state] ?? `0x${s.state.toString(16)}`
  const er = ERROR_NAMES[s.error] ?? `0x${s.error.toString(16)}`
  return `状態: ${st} / エラー: ${er} / テープ: ${s.tapeMm ? `${s.tapeMm}mm` : 'なし'}`
}
