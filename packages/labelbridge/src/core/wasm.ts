// Rust（crates/labelbridge-wasm）を呼ぶ低い層。エンコーダ・ステータス解釈・能力表の本体は Rust にある。
// wasm は wasm.gen.ts に埋め込んであり、最初の呼び出しで同期的に読み込む（ブラウザ・Node・Electron で同じ）。

import { WASM_BASE64 } from './wasm.gen'

interface Exports {
  memory: WebAssembly.Memory
  lb_alloc(n: number): number
  lb_free(p: number, n: number): void
  lb_call(req: number, reqLen: number, data: number, dataLen: number): number
  lb_out_ptr(): number
  lb_out_len(): number
}

/** Rust 側が返した失敗（`json.error` が種類） */
export class WasmCallError extends Error {
  constructor(readonly json: { error: string; [k: string]: unknown }) {
    super(`labelbridge (wasm): ${json.error}${typeof json.message === 'string' ? `: ${json.message}` : ''}`)
    this.name = 'WasmCallError'
  }
}

export interface WasmReply<T> {
  json: T
  /** JSON から番号で指すバイト列 */
  blobs: Uint8Array[]
}

let instance: Exports | null = null

function exports(): Exports {
  if (instance) return instance
  const bin = atob(WASM_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as unknown as Exports
  return instance
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** 要求（JSON にする）と付属のバイト列を渡して呼ぶ。失敗は `WasmCallError` */
export function wasmCall<T = unknown>(req: object, data: Uint8Array = new Uint8Array(0)): WasmReply<T> {
  const w = exports()
  const r = enc.encode(JSON.stringify(req))
  const rp = w.lb_alloc(r.length)
  const dp = w.lb_alloc(data.length)
  try {
    new Uint8Array(w.memory.buffer, rp, r.length).set(r)
    new Uint8Array(w.memory.buffer, dp, data.length).set(data)
    const code = w.lb_call(rp, r.length, dp, data.length)
    // 呼び出しの中でメモリが伸びると buffer が変わるので、ここで取り直す
    const out = new Uint8Array(w.memory.buffer, w.lb_out_ptr(), w.lb_out_len()).slice()
    const v = new DataView(out.buffer)
    const jsonLen = v.getUint32(0, true)
    const json = JSON.parse(dec.decode(out.subarray(4, 4 + jsonLen)))
    if (code !== 0) throw new WasmCallError(json)
    let at = 4 + jsonLen
    const count = v.getUint32(at, true)
    at += 4
    const blobs: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      const len = v.getUint32(at, true)
      blobs.push(out.subarray(at + 4, at + 4 + len))
      at += 4 + len
    }
    return { json, blobs }
  } finally {
    w.lb_free(rp, r.length)
    w.lb_free(dp, data.length)
  }
}
