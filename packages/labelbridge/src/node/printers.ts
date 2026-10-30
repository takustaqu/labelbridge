// Node から SR5900P へ印刷・状態取得する高水準 API。

import {
  printArea,
  encodeSr5900pPages,
  printSr5900p,
  readStatusSr5900p,
  type JobOptions,
  type Sr5900pOptions,
  type MonoImage,
  type PrintArea,
  type PrinterStatus,
  type Progress,
} from '../core'
import { TprtUdpControl, openTcpData } from './tprt'

export type { CutMode, JobOptions } from '../core'

/** 装着テープと、そのテープでの印字範囲（ドット数）を読む。 */
export async function readSr5900p(host: string): Promise<{ status: PrinterStatus; area: PrintArea | null }> {
  const ctrl = new TprtUdpControl(host)
  try {
    const status = await readStatusSr5900p(ctrl)
    return { status, area: status.tapeMm ? printArea('SR5900P', status.tapeMm) : null }
  } finally {
    await ctrl.close()
  }
}

/**
 * SR5900P に 1 画素 = 1 ドットで印刷する。`opts.cut` は 'full' / 'half' / 'none'。
 * `opts.marginDots` は未対応（0 より大きいとエラー）。
 */
export async function printImageSr5900p(
  host: string,
  image: MonoImage,
  tapeMm: number,
  opts: Sr5900pOptions = {},
  progress?: Progress,
): Promise<void> {
  return printImagesSr5900p(host, [image], tapeMm, opts, progress)
}

/**
 * 複数のラベルを 1 ジョブで印刷する（ジョブの先頭の送りは 1 回だけ）。ラベルの間は `opts.cut`
 * （'half' ならハーフカットでつながる）。`opts.copies` は全体を繰り返す。
 */
export async function printImagesSr5900p(
  host: string,
  images: MonoImage[],
  tapeMm: number,
  opts: Sr5900pOptions = {},
  progress?: Progress,
): Promise<void> {
  const job = encodeSr5900pPages(images, { ...opts, tapeMm })
  const ctrl = new TprtUdpControl(host)
  try {
    await printSr5900p(ctrl, () => openTcpData(host), job, tapeMm, { progress })
  } finally {
    await ctrl.close()
  }
}
