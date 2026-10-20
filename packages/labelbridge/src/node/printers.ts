// Node から SR5900P へ印刷・状態取得する高水準 API。

import {
  encodeSr5900p,
  printArea,
  printSr5900p,
  readStatusSr5900p,
  type JobOptions,
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
  opts: JobOptions = {},
  progress?: Progress,
): Promise<void> {
  const job = encodeSr5900p(image, { ...opts, tapeMm })
  const ctrl = new TprtUdpControl(host)
  try {
    await printSr5900p(ctrl, () => openTcpData(host), job, tapeMm, { progress })
  } finally {
    await ctrl.close()
  }
}
