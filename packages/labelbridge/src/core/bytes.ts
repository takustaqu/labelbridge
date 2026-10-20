// バイト列の組み立て。対応機種のコマンド（ESC { … } など。docs/protocol.md §1）。

export const ESC = 0x1b
export const FF = 0x0c

export const u16le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
export const u32le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
export const u32be = (v: number): number[] => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]

export function concat(parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** `ESC { len cmd params… ck }`。len = cmd から `}` までのバイト数、ck = Σ(cmd, params) & 0xFF。 */
export function frame(cmd: number, params: ArrayLike<number> = []): Uint8Array {
  const ps = Array.from(params)
  const ck = ps.reduce((a, b) => a + b, cmd) & 0xff
  return Uint8Array.from([ESC, 0x7b, ps.length + 3, cmd, ...ps, ck, 0x7d])
}

/** `ESC ( c nL nH data…`（拡張コマンド）。 */
export function escParen(cmd: number, data: ArrayLike<number>): Uint8Array {
  return Uint8Array.from([ESC, 0x28, cmd, ...u16le(data.length), ...Array.from(data)])
}

export const toHex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')
