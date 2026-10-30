// Direct Sockets（TCPSocket / UDPSocket）で LAN 接続の機種と話す。
// - 使えるのは Chrome の Isolated Web App（IWA）の中だけ。普通のページや GitHub Pages では使えない。
// - LAN（プライベート IP）の機器に届くには、IWA の manifest の permissions_policy に
//   "direct-sockets" に加えて "direct-sockets-private" と "local-network" が要る（examples/iwa）。
// - 手順は Node 版（../node/tprt.ts）と同じ: 制御は UDP 9100 の TPRT、データは TCP 9100。

import {
  TPRT_PORT,
  TimeoutError,
  parseTprtResponse,
  printArea,
  encodeSr5900pPages,
  printSr5900p,
  readStatusSr5900p,
  tprtRequest,
  type DataSink,
  type JobOptions,
  type Sr5900pOptions,
  type MonoImage,
  type PrintArea,
  type PrinterStatus,
  type Progress,
  type TprtControl,
} from '../core'

// TypeScript の DOM 型にはまだ無いので、使う範囲だけ宣言する（WICG Direct Sockets）
interface SocketOpenInfo<R, W> {
  readable: ReadableStream<R>
  writable: WritableStream<W>
  remoteAddress: string
  remotePort: number
  localAddress: string
  localPort: number
}
interface UdpMessage {
  data: BufferSource | Uint8Array
  remoteAddress?: string
  remotePort?: number
}
interface DirectTcpSocket {
  readonly opened: Promise<SocketOpenInfo<Uint8Array, BufferSource>>
  readonly closed: Promise<void>
  close(): Promise<void>
}
interface DirectUdpSocket {
  readonly opened: Promise<SocketOpenInfo<UdpMessage, UdpMessage>>
  readonly closed: Promise<void>
  close(): Promise<void>
}
type TcpSocketCtor = new (remoteAddress: string, remotePort: number, options?: { noDelay?: boolean }) => DirectTcpSocket
type UdpSocketCtor = new (options: { remoteAddress: string; remotePort: number }) => DirectUdpSocket

const g = globalThis as unknown as { TCPSocket?: TcpSocketCtor; UDPSocket?: UdpSocketCtor }

/** Direct Sockets が使えるか（Isolated Web App の中で、権限があるときだけ true）。 */
export function directSocketsSupported(): boolean {
  return typeof g.TCPSocket === 'function' && typeof g.UDPSocket === 'function'
}

function requireDirectSockets(): { TCPSocket: TcpSocketCtor; UDPSocket: UdpSocketCtor } {
  if (!g.TCPSocket || !g.UDPSocket) {
    throw new Error('Direct Sockets が使えません（Chrome の Isolated Web App の中でだけ動きます）')
  }
  return { TCPSocket: g.TCPSocket, UDPSocket: g.UDPSocket }
}

const withTimeout = <T>(p: Promise<T>, ms: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(message)), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    )
  })

/** UDP 9100 の制御チャネル（接続型 UDPSocket）。応答は "tprt" ヘッダのうち、送った cmd と一致するものだけを採る。 */
export class DirectSocketsTprtControl implements TprtControl {
  private socket: DirectUdpSocket | null = null
  private writer: WritableStreamDefaultWriter<UdpMessage> | null = null
  private reader: ReadableStreamDefaultReader<UdpMessage> | null = null
  private waiters: { cmd: number; resolve: (d: Uint8Array) => void; reject: (e: unknown) => void }[] = []
  private loop: Promise<void> | null = null

  constructor(
    readonly host: string,
    readonly port = TPRT_PORT,
  ) {}

  private async ensureOpen() {
    if (this.writer) return
    const { UDPSocket } = requireDirectSockets()
    this.socket = new UDPSocket({ remoteAddress: this.host, remotePort: this.port })
    const { readable, writable } = await withTimeout(this.socket.opened, 5000, `UDP ${this.host}:${this.port} を開けません`)
    this.writer = writable.getWriter()
    this.reader = readable.getReader()
    this.loop = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader!.read()
          if (done) break
          const r = parseTprtResponse(new Uint8Array(value.data as Uint8Array))
          if (!r) continue
          const i = this.waiters.findIndex((w) => w.cmd === r.cmd)
          if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(r.data)
        }
      } catch (e) {
        for (const w of this.waiters.splice(0)) w.reject(e)
      }
    })()
  }

  async request(cmd: number, timeoutMs = 3000): Promise<Uint8Array> {
    await this.ensureOpen()
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter = {
        cmd,
        resolve: (d: Uint8Array) => (clearTimeout(timer), resolve(d)),
        reject: (e: unknown) => (clearTimeout(timer), reject(e)),
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(new TimeoutError(`TPRT cmd ${cmd} の応答がありません（${this.host}）`))
      }, timeoutMs)
      this.waiters.push(waiter)
      this.writer!.write({ data: tprtRequest(cmd) }).catch((e) => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        waiter.reject(e)
      })
    })
  }

  async close(): Promise<void> {
    if (!this.socket) return
    await this.reader?.cancel().catch(() => undefined)
    await this.loop
    try {
      this.reader?.releaseLock()
      this.writer?.releaseLock()
    } catch {
      // ロックが外れていなくても、socket.close の失敗として無視する
    }
    await this.socket.close().catch(() => undefined)
    this.socket = null
    this.reader = null
    this.writer = null
  }
}

/** TCP 9100 のデータ経路（印刷開始(2) の後にだけ開く）。 */
export async function openDirectSocketsData(host: string, port = TPRT_PORT, timeoutMs = 5000): Promise<DataSink> {
  const { TCPSocket } = requireDirectSockets()
  const socket = new TCPSocket(host, port, { noDelay: true })
  const { readable, writable } = await withTimeout(socket.opened, timeoutMs, `TCP ${host}:${port} に接続できません`)
  // プリンターは TCP では何も返さないが、読まずにおくとバッファが詰まることがあるので捨てる
  const drain = readable.pipeTo(new WritableStream()).catch(() => undefined)
  const writer = writable.getWriter()
  return {
    write: (b) => writer.write(b as Uint8Array<ArrayBuffer>),
    close: async () => {
      await writer.close().catch(() => undefined)
      writer.releaseLock()
      await drain
      await socket.close().catch(() => undefined)
    },
  }
}

/** 装着テープと、そのテープでの印字範囲（ドット数）を読む（Direct Sockets 版）。 */
export async function readSr5900pDirect(host: string): Promise<{ status: PrinterStatus; area: PrintArea | null }> {
  const ctrl = new DirectSocketsTprtControl(host)
  try {
    const status = await readStatusSr5900p(ctrl)
    return { status, area: status.tapeMm ? printArea('SR5900P', status.tapeMm) : null }
  } finally {
    await ctrl.close()
  }
}

/** 1 画素 = 1 ドットで印刷する（Direct Sockets 版）。引数は Node 版の printImageSr5900p と同じ。 */
export async function printImageSr5900pDirect(
  host: string,
  image: MonoImage,
  tapeMm: number,
  opts: Sr5900pOptions = {},
  progress?: Progress,
): Promise<void> {
  return printImagesSr5900pDirect(host, [image], tapeMm, opts, progress)
}

/**
 * 複数のラベルを 1 ジョブで印刷する（ジョブの先頭の送りは 1 回だけ）。ラベルの間は `opts.cut`
 * （'half' ならハーフカットでつながる）。`opts.copies` は全体を繰り返す。
 */
export async function printImagesSr5900pDirect(
  host: string,
  images: MonoImage[],
  tapeMm: number,
  opts: Sr5900pOptions = {},
  progress?: Progress,
): Promise<void> {
  const job = encodeSr5900pPages(images, { ...opts, tapeMm })
  const ctrl = new DirectSocketsTprtControl(host)
  try {
    await printSr5900p(ctrl, () => openDirectSocketsData(host), job, tapeMm, { progress })
  } finally {
    await ctrl.close()
  }
}
