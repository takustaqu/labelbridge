// SR5900P（LAN）。制御は UDP 9100 の TPRT パケット、データは TCP 9100（docs/protocol.md §4）。
// crates/labelbridge/src/sr5900p.rs・labelbridge-transport/src/tprt.rs と同じバイト列を作る。
// 行はラベルの末尾から送る。1 行の中は dot 0 = ラベル上端。

import { FF, concat, frame, u16le, u32be, u32le } from '../bytes'
import { packColumn, type MonoImage } from '../image'
import { checkCut, printableDots, tapeCodeToMm, type JobOptions, type LabelJob, type PrinterStatus } from '../models'

export const SR5900P_DPI = 360
export const TPRT_PORT = 9100
export const TPRT = { STATUS: 1, START: 2, STOP: 3, NOTIFY_1: 0x0101, NOTIFY_2: 0x0100 } as const
const HEADER_LEN = 32

/**
 * カット位置の校正値（ドット）。既定値は実機（9mm）で合わせたもの（docs/protocol.md §4）。
 * 本体はカットを次のラベルのデータの始まり（最後はデータの終わり）に入れ、ジョブの先頭と 1 枚目の後ろには
 * 自分で空白（ヘッド〜カッター間）を入れる。
 */
export interface Sr5900pCalibration {
  /** 本体がジョブの先頭と 1 枚目の後ろに入れる空白。余白をこれより小さくすると、先頭に空のページを入れる */
  headGapDots: number
  /** 2 枚目以降の前に足す空白 = 余白 + leadAdjustDots */
  leadAdjustDots: number
  /** 2 枚目以降（1 枚だけのときはその 1 枚）の後ろに足す空白 = 余白 + tailAdjustDots */
  tailAdjustDots: number
  /** 先頭に空のページを入れたとき、最初のラベルの後ろにさらに足す空白 */
  firstTailAdjustDots: number
}

export const SR5900P_DEFAULT_CALIBRATION: Sr5900pCalibration = { headGapDots: 33, leadAdjustDots: 10, tailAdjustDots: -2, firstTailAdjustDots: 7 }

/**
 * 共通の `LabelJob`。cut は 'full' / 'half' / 'none'。
 * `marginDots` は各ラベルの前後に見える余白（既定は `headGapDots`）。`calibration` でカット位置を合わせる。
 */
export interface Sr5900pJob extends LabelJob {
  calibration?: Partial<Sr5900pCalibration>
}

/** SR5900P の印刷オプション（共通の `JobOptions` ＋ 校正値） */
export interface Sr5900pOptions extends JobOptions {
  calibration?: Partial<Sr5900pCalibration>
}

/** ジョブの並べ方。dummy なら先頭に空のページを入れる。pads は各ラベルの [前, 後ろ] に足す空白（ドット）。 */
export function sr5900pLayout(
  count: number,
  cut: 'full' | 'half' | 'none',
  marginDots?: number,
  calibration: Partial<Sr5900pCalibration> = {},
): { dummy: boolean; pads: [number, number][] } {
  const c = { ...SR5900P_DEFAULT_CALIBRATION, ...calibration }
  const m = Math.max(0, Math.round(marginDots ?? c.headGapDots))
  const pos = (v: number) => Math.max(0, Math.round(v))
  // カットしないときは、指定の余白をそのまま前後に足すだけ
  if (cut === 'none') return { dummy: false, pads: Array.from({ length: count }, () => [pos(marginDots ?? 0), pos(marginDots ?? 0)]) }
  const later: [number, number] = [pos(m + c.leadAdjustDots), pos(m + c.tailAdjustDots)]
  // 本体の空白より狭い余白は、先頭に空のページを入れて、本物のラベルを全部「2 枚目以降」にする
  if (m < c.headGapDots)
    return { dummy: true, pads: Array.from({ length: count }, (_, i) => (i === 0 ? [later[0], pos(later[1] + c.firstTailAdjustDots)] : later)) }
  const extra = pos(m - c.headGapDots)
  if (count === 1) return { dummy: false, pads: [[extra, later[1]]] }
  return { dummy: false, pads: Array.from({ length: count }, (_, i) => (i === 0 ? [extra, extra] : later)) }
}

/** 空のページの行数 */
const SR5900P_DUMMY_LINES = 8

/**
 * カット位置の校正ラベル（3 枚。外周の枠と、何枚目かが分かる k 個の黒い四角）。
 * `encodeSr5900pPages(sr5900pCalibrationLabels(tapeMm), { tapeMm, cut: 'half', calibration })` で 3 枚つなぎに印刷し、
 * カットと枠の間の余白を見て `Sr5900pCalibration` を合わせる（標準の余白と、`marginDots` を狭くした場合の両方で）。
 */
export function sr5900pCalibrationLabels(tapeMm: number, widthDots = 200): MonoImage[] {
  const dots = printableDots('SR5900P', tapeMm)
  return [1, 2, 3].map((k) => {
    const bits = new Uint8Array(widthDots * dots)
    for (let x = 0; x < widthDots; x++)
      for (let y = 0; y < dots; y++) {
        const frame = x < 4 || x >= widthDots - 4 || y < 4 || y >= dots - 4
        const block = x >= 20 && (x - 20) % 40 < 20 && Math.floor((x - 20) / 40) < k && y > dots * 0.3 && y < dots * 0.7
        if (frame || block) bits[y * widthDots + x] = 1
      }
    return { width: widthDots, height: dots, bits }
  })
}

/** 1 枚（`copies` 枚）のジョブ。`encodeSr5900pPages([image], job)` と同じ。 */
export function encodeSr5900p(image: MonoImage, job: Sr5900pJob): Uint8Array {
  return encodeSr5900pPages([image], job)
}

/**
 * 複数のラベルを 1 ジョブにする。ラベルごとに `L T H s` + 行 + `0C` を続け、最後に `@`（docs/protocol.md §4）。
 * `copies` は、images を並べたものを繰り返す。ラベルの間のカットは `cut`（'half' ならハーフカットでつながる）。
 */
export function encodeSr5900pPages(images: MonoImage[], job: Sr5900pJob): Uint8Array {
  const mode = job.cut ?? 'full'
  checkCut('SR5900P', mode)
  if (images.length === 0) throw new Error('ラベルがありません')
  const dots = printableDots('SR5900P', job.tapeMm)
  for (const image of images)
    if (image.height > dots) throw new Error(`画像の高さ ${image.height} が印字可能幅 ${dots} を超えています`)
  // [先頭, ラベルの間, ?, 末尾]。'half' はラベルの間だけハーフカット（実機で確認した値）
  const cut = { full: [1, 1, 1, 1], half: [1, 2, 1, 1], none: [0, 0, 0, 0] }[mode]
  const density = Math.max(-5, Math.min(5, job.density ?? 0))
  const head = [0x1b, 0x2e, 0x00, 0x00, 0x00, 0x01, ...u16le(dots)]
  const parts: ArrayLike<number>[] = [frame(0x40), frame(0x7b, [0x00, 0x00, 0x53, 0x54]), frame(0x43, cut), frame(0x44, [density + 5]), frame(0x47)]
  const pages = Array.from({ length: Math.max(1, job.copies ?? 1) }, () => images).flat()
  const { dummy, pads } = sr5900pLayout(pages.length, mode, job.marginDots, job.calibration)
  const blank = new Uint8Array(Math.ceil(dots / 8))
  const page = (lead: number, lines: number, tail: number, column: (x: number) => Uint8Array) => {
    // T（先頭の送り）は 0。42 だとジョブの先頭で短い片が切り落とされる
    parts.push(frame(0x4c, u32le(lead + lines + tail + 4)), frame(0x54, u16le(0)), frame(0x48, [0x05]), frame(0x73, [0x00]))
    // ラベルの末尾から送る（先に送った行が先に印字される）
    for (let k = 0; k < lead; k++) parts.push(head, blank)
    for (let x = lines - 1; x >= 0; x--) parts.push(head, column(x))
    for (let k = 0; k < tail; k++) parts.push(head, blank)
    parts.push([FF])
  }
  if (dummy) page(0, SR5900P_DUMMY_LINES, 0, () => blank)
  pages.forEach((image, i) => page(pads[i]![0], image.width, pads[i]![1], (x) => packColumn(image, x, dots, false)))
  parts.push(frame(0x40))
  return concat(parts)
}

/** TPRT 要求ヘッダ（32 バイト、BE）。 */
export function tprtRequest(cmd: number, dataSize = 0): Uint8Array {
  return concat([[0x54, 0x50, 0x52, 0x54], u32be(0), u32be(1), u32be(0x20), u32be(cmd), u32be(dataSize), u32be(0), u32be(0)])
}

/** TPRT 応答（"tprt"）を解釈する。 */
export function parseTprtResponse(buf: Uint8Array): { cmd: number; data: Uint8Array } | null {
  if (buf.length < HEADER_LEN || String.fromCharCode(...buf.subarray(0, 4)) !== 'tprt') return null
  const cmd = ((buf[16]! << 24) | (buf[17]! << 16) | (buf[18]! << 8) | buf[19]!) >>> 0
  return { cmd, data: buf.slice(HEADER_LEN) }
}

/** UDP ステータスのデータ部 20 バイト: [0]=0x14, [1]=ST, [2]=ER, [3]=TW。 */
export function parseSr5900pStatus(data: Uint8Array): PrinterStatus {
  if (data.length < 20 || data[0] !== 0x14) throw new Error(`SR5900P のステータスではありません（${data.length} バイト）`)
  return { state: data[1]!, error: data[2]!, tapeMm: tapeCodeToMm(data[3]!), raw: data.slice(0, 20) }
}
