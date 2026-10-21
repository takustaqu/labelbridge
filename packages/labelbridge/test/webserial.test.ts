// Web Serial チャネルの、切断後の片付けと再試行（実機で確かめた Chrome の挙動を模した偽ポートで試す）。

import { describe, expect, it } from 'vitest'
import { WebSerialChannel } from '../src/web/webserial'

/**
 * Chrome の SerialPort を模す。
 * - open は、開いていれば InvalidStateError（"already open"）
 * - failFirstOpen なら、最初の open だけ NetworkError（リンク確立待ち）
 * - drop() はリンク切断: disconnect イベントを出し、読み取りを失敗させるが、ポートは開いたまま（半開き）残す
 */
class FakePort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  opens = 0
  closes = 0
  written: Uint8Array[] = []
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null

  constructor(private failFirstOpen = false) {
    super()
  }

  async open(): Promise<void> {
    if (this.readable || this.writable) {
      const e = new Error('The port is already open.')
      e.name = 'InvalidStateError'
      throw e
    }
    this.opens++
    if (this.failFirstOpen && this.opens === 1) {
      const e = new Error('Failed to open serial port.')
      e.name = 'NetworkError'
      throw e
    }
    this.readable = new ReadableStream({ start: (c) => void (this.controller = c) })
    this.writable = new WritableStream({ write: (chunk) => void this.written.push(chunk) })
  }

  async close(): Promise<void> {
    this.closes++
    if (this.readable && !this.readable.locked) await this.readable.cancel().catch(() => undefined)
    this.readable = null
    this.writable = null
  }

  push(bytes: number[]) {
    this.controller?.enqueue(Uint8Array.from(bytes))
  }

  drop() {
    const e = new Error('The device has been lost.')
    e.name = 'NetworkError'
    this.controller?.error(e)
    this.dispatchEvent(new Event('disconnect'))
  }
}

const asPort = (p: FakePort) => p as unknown as SerialPort

describe('WebSerialChannel', () => {
  it('retries the first open that fails while the link comes up', async () => {
    const port = new FakePort(true)
    const ch = new WebSerialChannel(asPort(port))
    await ch.open(3, 0)
    expect(port.opens).toBe(2)
    expect(port.readable).not.toBeNull()
    await ch.close()
    expect(port.readable).toBeNull()
  })

  it('closes a half-open port left by a dropped link before opening', async () => {
    const port = new FakePort()
    await port.open() // 前の接続の残り（半開き）
    const ch = new WebSerialChannel(asPort(port))
    await ch.open(3, 0)
    expect(port.closes).toBe(1)
    expect(port.opens).toBe(2)
    await ch.close()
  })

  it('fails pending reads on disconnect and leaves the port closed, so it can be opened again', async () => {
    const port = new FakePort()
    const ch = new WebSerialChannel(asPort(port))
    await ch.open(3, 0)
    port.push([1, 2])
    expect([...(await ch.read(100))]).toEqual([1, 2])

    const waiting = ch.read(5000)
    port.drop()
    await expect(waiting).rejects.toThrow('Bluetooth のリンクが切れました')
    await new Promise((r) => setTimeout(r, 0))
    expect(port.readable).toBeNull()
    expect(port.writable).toBeNull()

    // 電源を入れ直した後: 同じポートを、そのまま開き直せる
    const again = new WebSerialChannel(asPort(port))
    await again.open(3, 0)
    await again.write(Uint8Array.of(9))
    expect(port.written.at(-1)).toEqual(Uint8Array.of(9))
    await again.close()
  })
})
