// Bluetooth（Web Serial / RFCOMM）の切断・復帰を調べるための診断ページ。
// ライブラリのチャネルは使わず、Web Serial を直接呼んで、各操作の結果とエラーをそのまま記録する。

import { SRR2500P_STATUS_LEN, SRR2500P_STATUS_ONCE, parseSrR2500pStatus } from '@takustaqu/labelbridge'
import { SPP_UUID } from '@takustaqu/labelbridge/web'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const logEl = $('log')
const t0 = performance.now()

function log(msg: string, kind: 'info' | 'ok' | 'error' = 'info') {
  const line = document.createElement('div')
  line.className = kind
  line.textContent = `${((performance.now() - t0) / 1000).toFixed(2).padStart(7)}s  ${msg}`
  logEl.append(line)
  logEl.scrollTop = logEl.scrollHeight
}

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

let port: SerialPort | null = null
let portNo = 0
const ids = new WeakMap<SerialPort, number>()
const idOf = (p: SerialPort) => {
  if (!ids.has(p)) ids.set(p, ++portNo)
  return `port#${ids.get(p)}`
}

function describe(p: SerialPort | null): string {
  if (!p) return 'no port'
  const info = p.getInfo() as SerialPortInfo & { bluetoothServiceClassId?: string }
  const connected = 'connected' in p ? String((p as SerialPort & { connected: boolean }).connected) : 'n/a'
  return `${idOf(p)} service=${info.bluetoothServiceClassId ?? '-'} connected=${connected} readable=${!!p.readable} writable=${!!p.writable}`
}

// ---- environment ----
{
  const uaData = (navigator as Navigator & { userAgentData?: { platform: string; brands: { brand: string; version: string }[] } }).userAgentData
  const brands = uaData?.brands.map((b) => `${b.brand} ${b.version}`).join(', ') ?? navigator.userAgent
  $('env').textContent = `platform=${uaData?.platform ?? navigator.platform} · ${brands} · webSerial=${'serial' in navigator}`
  log(`env: ${$('env').textContent}`)
}

// ---- events ----
if ('serial' in navigator) {
  navigator.serial.addEventListener('connect', (e) => {
    const p = e.target as SerialPort
    log(`event navigator.serial connect: ${describe(p)}`, 'ok')
    if ($<HTMLInputElement>('auto').checked) void autoRecover(p)
  })
  navigator.serial.addEventListener('disconnect', (e) => {
    log(`event navigator.serial disconnect: ${describe(e.target as SerialPort)}`, 'error')
  })
}

function watch(p: SerialPort) {
  p.addEventListener('connect', () => log(`event port connect: ${describe(p)}`, 'ok'))
  p.addEventListener('disconnect', () => log(`event port disconnect: ${describe(p)}`, 'error'))
}

// ---- steps ----
// 1 度に 1 つの操作だけを走らせる（終わる前に次を押すと結果が混ざるため、実行中はボタンを無効にする）
let busy = false
function setBusy(name: string | null) {
  busy = name !== null
  $('busy').textContent = name ? `running: ${name} … (wait for "ok" / "failed")` : 'idle'
  for (const b of document.querySelectorAll<HTMLButtonElement>('.buttons button')) {
    if (b.id !== 'state' && b.id !== 'copy') b.disabled = busy
  }
}

async function step<T>(name: string, fn: () => Promise<T>, nested = false): Promise<T | undefined> {
  const s = performance.now()
  log(`> ${name} …`)
  if (!nested) setBusy(name)
  try {
    const r = await fn()
    log(`  ${name} ok (${Math.round(performance.now() - s)} ms)${r === undefined ? '' : `: ${String(r)}`}`, 'ok')
    return r
  } catch (e) {
    log(`  ${name} failed (${Math.round(performance.now() - s)} ms): ${errText(e)}`, 'error')
    return undefined
  } finally {
    log(`  state: ${describe(port)}`)
    if (!nested) setBusy(null)
  }
}

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms))])

async function openPort() {
  if (!port) throw new Error('no port chosen')
  await timeout(port.open({ baudRate: 9600 }), 15000, 'open')
}

async function closePort() {
  if (!port) throw new Error('no port chosen')
  await port.close()
}

async function readStatus(): Promise<string> {
  if (!port?.readable || !port.writable) throw new Error('port is not open')
  const w = port.writable.getWriter()
  try {
    await timeout(w.write(SRR2500P_STATUS_ONCE), 5000, 'write')
  } finally {
    w.releaseLock()
  }
  const r = port.readable.getReader()
  const buf: number[] = []
  try {
    const deadline = performance.now() + 5000
    while (buf.length < 400) {
      const left = deadline - performance.now()
      if (left <= 0) throw new Error(`no status within 5 s (got ${buf.length} bytes)`)
      const { value, done } = await timeout(r.read(), left, 'read')
      if (done) throw new Error('stream ended')
      buf.push(...value)
      const hit = parseSrR2500pStatus(Uint8Array.from(buf))
      if (hit) {
        const s = hit.status
        return `ST=${s.state.toString(16)} ER=${s.error.toString(16)} tape=${s.tapeMm ?? 'none'}mm (${SRR2500P_STATUS_LEN} bytes)`
      }
    }
    throw new Error('no status frame')
  } finally {
    await r.cancel().catch(() => undefined)
    r.releaseLock()
  }
}

async function autoRecover(p: SerialPort) {
  if (port !== p) {
    port = p
    watch(p)
  }
  await step('auto open', openPort)
  await step('auto status', readStatus)
  if (!$<HTMLInputElement>('keep').checked) await step('auto close', closePort)
}

async function withOptionalClose(name: string, fn: () => Promise<unknown>) {
  await step(name, fn)
  if (!$<HTMLInputElement>('keep').checked && port?.readable) await step('close', closePort)
}

$('pick').addEventListener('click', () =>
  step('requestPort', async () => {
    const p = await navigator.serial.requestPort({
      filters: [{ bluetoothServiceClassId: SPP_UUID }],
      allowedBluetoothServiceClassIds: [SPP_UUID],
    })
    if (p !== port) watch(p)
    port = p
    return describe(p)
  }),
)
$('getports').addEventListener('click', () =>
  step('getPorts', async () => {
    const ports = await navigator.serial.getPorts()
    const list = ports.map(describe).join(' | ')
    const spp = ports.find((p) => (p.getInfo() as { bluetoothServiceClassId?: string }).bluetoothServiceClassId === SPP_UUID)
    if (spp && spp !== port) {
      watch(spp)
      port = spp
    }
    return `${ports.length} port(s): ${list}`
  }),
)
$('open').addEventListener('click', () => step('open', openPort))
// ライブラリの open と同じく、リンク確立待ちで失敗したら 1.5 秒おいて 3 回まで試す
$('open3').addEventListener('click', () =>
  step('open ×3', async () => {
    for (let i = 1; i <= 3; i++) {
      const ok = await step(`open attempt ${i}`, openPort, true)
      if (ok !== undefined || port?.readable) return `opened on attempt ${i}`
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new Error('all 3 attempts failed')
  }),
)
$('status').addEventListener('click', () => withOptionalClose('status', readStatus))
$('close').addEventListener('click', () => step('close', closePort))
$('forget').addEventListener('click', () =>
  step('forget', async () => {
    if (!port) throw new Error('no port chosen')
    await port.forget()
    port = null
  }),
)
$('state').addEventListener('click', () => log(`state: ${describe(port)}`))
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(logEl.innerText)
  log('log copied to clipboard', 'ok')
})
