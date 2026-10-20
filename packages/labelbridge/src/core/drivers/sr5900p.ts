// SR5900P（LAN）。制御は UDP 9100 の TPRT パケット、データは TCP 9100（docs/protocol.md §4）。
// crates/labelbridge/src/sr5900p.rs・labelbridge-transport/src/tprt.rs と同じバイト列を作る。
// 行はラベルの末尾から送る。1 行の中は dot 0 = ラベル上端。

import { FF, concat, frame, u16le, u32be, u32le } from '../bytes'
import { packColumn, type MonoImage } from '../image'
import { checkCut, printableDots, tapeCodeToMm, type LabelJob, type PrinterStatus } from '../models'

export const SR5900P_DPI = 360
export const TPRT_PORT = 9100
export const TPRT = { STATUS: 1, START: 2, STOP: 3, NOTIFY_1: 0x0101, NOTIFY_2: 0x0100 } as const
const HEADER_LEN = 32

/** 共通の `LabelJob`。cut は 'full' / 'half' / 'none'。marginDots は未対応（0 より大きいとエラー）。 */
export type Sr5900pJob = LabelJob

export function encodeSr5900p(image: MonoImage, job: Sr5900pJob): Uint8Array {
  const mode = job.cut ?? 'full'
  checkCut('SR5900P', mode)
  if ((job.marginDots ?? 0) > 0) throw new Error('SR5900P は marginDots に対応していません')
  const dots = printableDots('SR5900P', job.tapeMm)
  if (image.height > dots) throw new Error(`画像の高さ ${image.height} が印字可能幅 ${dots} を超えています`)
  const cut = { full: [1, 1, 1, 1], half: [2, 2, 1, 1], none: [0, 0, 0, 0] }[mode]
  const density = Math.max(-5, Math.min(5, job.density ?? 0))
  const lines = image.width
  const head = [0x1b, 0x2e, 0x00, 0x00, 0x00, 0x01, ...u16le(dots)]
  const parts: ArrayLike<number>[] = []
  for (let c = 0; c < Math.max(1, job.copies ?? 1); c++) {
    parts.push(
      frame(0x40),
      frame(0x7b, [0x00, 0x00, 0x53, 0x54]),
      frame(0x43, cut),
      frame(0x44, [density + 5]),
      frame(0x47),
      frame(0x4c, u32le(lines + 4)),
      frame(0x54, u16le(42)),
      frame(0x48, [0x05]),
      frame(0x73, [0x00]),
    )
    for (let x = lines - 1; x >= 0; x--) parts.push(head, packColumn(image, x, dots, false))
    parts.push([FF], frame(0x40))
  }
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
