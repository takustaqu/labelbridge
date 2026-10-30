// 機種ごとの印刷手順。チャネルの開閉は呼び出し側が行う。

import { concat } from '../bytes'
import {
  SR3500P_STATUS_REQUEST,
  parseSr3500pStatus,
} from '../drivers/sr3500p'
import {
  SRR2500P_STATUS_AUTO,
  SRR2500P_STATUS_ONCE,
  parseSrR2500pStatus,
  type SrR2500pParts,
} from '../drivers/srr2500p'
import { TPRT, parseSr5900pStatus } from '../drivers/sr5900p'
import { ERROR_NAMES, describeStatus, type PrinterStatus } from '../models'
import {
  FrameReader,
  PrinterError,
  TimeoutError,
  realClock,
  type ByteChannel,
  type Clock,
  type DataSink,
  type Progress,
  type TprtControl,
  type UsbPrinterChannel,
} from './channel'

const silent: Progress = () => {}

/** 印刷手順の共通オプション。 */
export interface FlowOptions {
  /** 進み具合の報告。既定は何もしない */
  progress?: Progress
  /** テスト用の時計。既定は `realClock` */
  clock?: Clock
}

export interface Sr3500pFlowOptions extends FlowOptions {
  /** 枚数。1 枚ごとに「SOFT_RESET → ジョブ」を繰り返す（既定 1） */
  copies?: number
}

function check(s: PrinterStatus, tapeMm?: number): void {
  if (s.error !== 0) throw new PrinterError(`プリンターエラー: ${ERROR_NAMES[s.error] ?? `0x${s.error.toString(16)}`}`, s)
  if (tapeMm !== undefined && s.tapeMm !== tapeMm) {
    throw new PrinterError(`テープ幅が違います（ジョブ ${tapeMm}mm、装着 ${s.tapeMm ?? 'なし'}）`, s)
  }
}

/** 状態が変わったときだけ報告する。 */
function reporter(progress: Progress) {
  let last = ''
  return (s: PrinterStatus) => {
    const line = describeStatus(s)
    if (line !== last) progress(line)
    last = line
  }
}

// ---- ステータスだけを読む（印字しない） ----

/** SR3500P: ESC{Q 00 00} を送り 64 バイトのテキストを読む。 */
export async function readStatusSr3500p(ch: ByteChannel, clock: Clock = realClock): Promise<PrinterStatus> {
  const reader = new FrameReader(ch, parseSr3500pStatus, clock)
  await ch.write(SR3500P_STATUS_REQUEST)
  return reader.next(3000)
}

/** SR-R2500P: ESC{I 00 00} を送り 92 バイトを読む。 */
export async function readStatusSrR2500p(ch: ByteChannel, clock: Clock = realClock): Promise<PrinterStatus> {
  const reader = new FrameReader(ch, parseSrR2500pStatus, clock)
  await ch.write(SRR2500P_STATUS_ONCE)
  return reader.next(5000)
}

/** SR5900P: TPRT の状態要求(1)。 */
export async function readStatusSr5900p(ctrl: TprtControl): Promise<PrinterStatus> {
  return parseSr5900pStatus(await ctrl.request(TPRT.STATUS))
}

// ---- SR3500P（USB） ----

/**
 * 1 枚ごとに SOFT_RESET → Selected 待ち → ステータス確認 → 送信 → 完了待ちを行い、copies 枚ぶん繰り返す。
 * SOFT_RESET を省くと 2 回目以降のジョブが無視され、1 ジョブに複数ページを入れても間でカットされない（実機確認）。
 */
export async function printSr3500p(
  ch: UsbPrinterChannel,
  job: Uint8Array,
  tapeMm: number,
  { progress = silent, clock = realClock, copies = 1 }: Sr3500pFlowOptions = {},
): Promise<void> {
  const total = Math.max(1, copies)
  for (let n = 1; n <= total; n++) {
    if (total > 1) progress(`${n}/${total} 枚目`)
    await printOneSr3500p(ch, job, tapeMm, progress, clock)
  }
}

async function printOneSr3500p(ch: UsbPrinterChannel, job: Uint8Array, tapeMm: number, progress: Progress, clock: Clock): Promise<void> {
  const report = reporter(progress)
  await ch.softReset()
  let selected = false
  for (let i = 0; i < 10 && !selected; i++) {
    selected = ((await ch.portStatus()) & 0x10) !== 0
    if (!selected) await clock.sleep(1000)
  }
  if (!selected) throw new PrinterError('ソフトリセット後にプリンターが準備完了になりません')

  const reader = new FrameReader(ch, parseSr3500pStatus, clock)
  const query = async () => {
    reader.discard()
    await ch.write(SR3500P_STATUS_REQUEST)
    return reader.next(2000)
  }
  const first = await query()
  report(first)
  check(first, tapeMm)
  if (first.state !== 0) throw new PrinterError('プリンターが処理中です', first)

  await ch.write(job)
  progress(`データを送信しました（${job.length} バイト）`)
  await waitDone(query, report, clock)
  progress('印刷が完了しました', 'ok')
}

/** 印字中（state ≠ 0）を見てから待機に戻るまで待つ。印字が始まらないまま 8 秒経ったら終わる。 */
async function waitDone(query: () => Promise<PrinterStatus>, report: (s: PrinterStatus) => void, clock: Clock) {
  const started = clock.now()
  let seenBusy = false
  while (clock.now() - started < 60000) {
    await clock.sleep(200)
    let s: PrinterStatus
    try {
      s = await query()
    } catch (e) {
      if (e instanceof TimeoutError) continue
      throw e
    }
    report(s)
    check(s)
    if (s.state !== 0) seenBusy = true
    else if (seenBusy || clock.now() - started > 8000) return
  }
  throw new PrinterError('印刷が 60 秒以内に終わりませんでした')
}

// ---- SR-R2500P（Bluetooth SPP） ----

/**
 * commandLevel 5 の手順。枚数は `parts.copies`（エンコード時の `copies`）。ESC{!}（リセット）は送らない（macOS で BT リンクが切れたため）。
 * 終了時は必ず自動通知を OFF に戻す（省くと次の接続でステータスが取れない）。
 */
export async function printSrR2500p(
  ch: ByteChannel,
  parts: SrR2500pParts,
  tapeMm: number,
  { progress = silent, clock = realClock }: FlowOptions = {},
): Promise<void> {
  const report = reporter(progress)
  const reader = new FrameReader(ch, parseSrR2500pStatus, clock)
  const wait = async (ms: number) => {
    const s = await reader.next(ms)
    report(s)
    check(s)
    return s
  }
  try {
    await ch.write(SRR2500P_STATUS_AUTO)
    check(await wait(15000), tapeMm)
    progress('ジョブ設定を送信しています…')
    await ch.write(parts.environment)
    await ch.write(SRR2500P_STATUS_AUTO)
    await wait(15000)
    for (let c = 0; c < parts.copies; c++) {
      await ch.write(parts.pageEnvironment)
      for (const [i, band] of parts.bands.entries()) {
        await ch.write(band)
        progress(`データ送信 ${i + 1}/${parts.bands.length}（${c + 1}/${parts.copies} 枚目）`)
        try {
          await wait(60000)
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e
        }
      }
      await ch.write(Uint8Array.of(0x0c))
    }
    await ch.write(parts.end)
    progress('印字の完了を待っています…')
    const started = clock.now()
    let seenBusy = false
    for (;;) {
      const s = await wait(60000)
      if (s.state !== 0) seenBusy = true
      if (s.state === 0 && (seenBusy || clock.now() - started > 8000)) break
    }
    progress('印刷が完了しました', 'ok')
  } finally {
    try {
      await ch.write(SRR2500P_STATUS_ONCE)
      await reader.next(2000)
    } catch {
      /* 応答がなくても続ける */
    }
  }
}

/** SR-R2500P のジョブ部品を、ステータス待ちを含めずに連結する（確認用）。 */
export function flattenSrR2500p(parts: SrR2500pParts): Uint8Array {
  const pages = Array.from({ length: parts.copies }, () => [parts.pageEnvironment, ...parts.bands, Uint8Array.of(0x0c)]).flat()
  return concat([SRR2500P_STATUS_AUTO, parts.environment, SRR2500P_STATUS_AUTO, ...pages, parts.end, SRR2500P_STATUS_ONCE])
}

/** ジョブ環境 + 部数ぶんのページ（FF なし） + 終了。Rust 側 fixture との照合用。 */
export function flattenSrR2500pPages(parts: SrR2500pParts): Uint8Array {
  const pages = Array.from({ length: parts.copies }, () => [parts.pageEnvironment, ...parts.bands]).flat()
  return concat([parts.environment, ...pages, parts.end])
}

// ---- SR5900P（LAN） ----

/**
 * hikalium/sr5900p と同じ手順: 状態 → 開始 → 0.5 秒 → TCP 接続 → 0.5 秒 → 通知 → 0.5 秒 → 送信
 * → 0.5 秒ごとに状態 → 終了。枚数はジョブのバイト列に入っている（`encodeSr5900p` の `copies`、
 * または `encodeSr5900pPages`）。開始した後は失敗しても必ず終了(3) を送る。
 */
export async function printSr5900p(
  ctrl: TprtControl,
  openData: () => Promise<DataSink>,
  job: Uint8Array,
  tapeMm: number,
  { progress = silent, clock = realClock }: FlowOptions = {},
): Promise<void> {
  const report = reporter(progress)
  const status = async () => {
    const s = parseSr5900pStatus(await ctrl.request(TPRT.STATUS))
    report(s)
    return s
  }
  const first = await status()
  check(first, tapeMm)
  if (first.state !== 0) throw new PrinterError('プリンターが処理中です', first)

  const started = await ctrl.request(TPRT.START)
  if (started[0] !== 2) throw new PrinterError(`印刷開始の応答が想定外です（${Array.from(started).join(',')}）`)
  try {
    await clock.sleep(500)
    const data = await openData()
    try {
      await clock.sleep(500)
      await ctrl.request(TPRT.NOTIFY_1)
      const n = await ctrl.request(TPRT.NOTIFY_2)
      if (n[0] !== 0x10 && n[0] !== 0x00) throw new PrinterError(`送信通知の応答が想定外です（${n[0]}）`)
      await clock.sleep(500)
      await data.write(job)
      progress(`データを送信しました（${job.length} バイト）`)
    } finally {
      await data.close()
    }
    // 印字中（state ≠ 0）を見てから待機に戻るまで待つ。印字が始まらないまま 8 秒経ったら終わる。
    // 印字中は状態の問い合わせに答えないことがある（UDP なので抜けることもある）。
    // 応答のない時間が 30 秒を超えるまでは問い合わせ直す
    const t0 = clock.now()
    let seenBusy = false
    let lastReply = clock.now()
    for (;;) {
      await clock.sleep(500)
      let s: PrinterStatus
      try {
        s = await status()
        lastReply = clock.now()
      } catch (e) {
        if (!(e instanceof TimeoutError) || clock.now() - lastReply > 30000) throw e
        // 応答が無いあいだは印字中とみなす
        seenBusy = true
        continue
      }
      check(s)
      if (s.state !== 0) seenBusy = true
      else if (seenBusy || clock.now() - t0 > 8000) break
      if (clock.now() - t0 > 120000) throw new PrinterError('印刷が 120 秒以内に終わりませんでした')
    }
    progress('印刷が完了しました', 'ok')
  } finally {
    await ctrl.request(TPRT.STOP).catch(() => undefined)
  }
}
