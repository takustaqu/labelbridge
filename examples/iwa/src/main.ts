// Isolated Web App のサンプル: Direct Sockets で LAN 接続のラベルプリンターに印刷する。
//
//   1. IP アドレスかホスト名を入れて、装着テープと印字可能ドット数を読む（UDP 9100）
//   2. その高さぴったりの 1bpp 画像にテキストを描く
//   3. 1 画素 = 1 ドットで印刷する（UDP 9100 で制御、TCP 9100 でデータ）
//
// IWA の CSP（Trusted Types など）の中で動くよう、innerHTML や data: URL は使わない。

import { threshold, type CutMode, type MonoImage, type PrintArea } from '@takustaqu/labelbridge'
import { directSocketsSupported, printImageSr5900pDirect, readSr5900pDirect } from '@takustaqu/labelbridge/web'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  support: $('support'),
  host: $<HTMLInputElement>('host'),
  read: $<HTMLButtonElement>('read'),
  status: $('status'),
  tape: $('tape'),
  dots: $('dots'),
  text: $<HTMLInputElement>('text'),
  fontPx: $<HTMLInputElement>('font-px'),
  cut: $<HTMLSelectElement>('cut'),
  print: $<HTMLButtonElement>('print'),
  preview: $<HTMLCanvasElement>('preview'),
  size: $('size'),
  log: $('log'),
}

let area: PrintArea | null = null
let image: MonoImage | null = null

function log(message: string, kind: 'info' | 'ok' | 'error' = 'info') {
  const line = document.createElement('div')
  line.className = kind
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`
  ui.log.append(line)
  ui.log.scrollTop = ui.log.scrollHeight
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---- Direct Sockets が使えるか ----
const supported = directSocketsSupported()
ui.support.textContent = supported ? 'Direct Sockets: available' : 'Direct Sockets: not available'
if (!supported) {
  log('Direct Sockets is not available. Open this page as an Isolated Web App in Chrome (see examples/iwa/README.md).', 'error')
  ui.read.disabled = true
}

// ---- ホスト名は次回も使う ----
try {
  ui.host.value = localStorage.getItem('labelbridge-iwa-host') ?? ''
} catch {
  // 保存できない環境でも動く
}

// ---- 1. 読み取り ----
ui.read.addEventListener('click', async () => {
  const host = ui.host.value.trim()
  if (!host) return log('Enter the printer IP address or host name', 'error')
  try {
    localStorage.setItem('labelbridge-iwa-host', host)
  } catch {
    // 無視
  }
  ui.read.disabled = true
  try {
    log(`Reading ${host} …`)
    const r = await readSr5900pDirect(host)
    ui.status.textContent = `ST ${r.status.state.toString(16)} / ER ${r.status.error.toString(16)}`
    ui.tape.textContent = r.status.tapeMm ? `${r.status.tapeMm} mm` : 'none'
    area = r.area
    ui.dots.textContent = area ? `${area.printableDots} (${area.dpi} dpi)` : '—'
    log(area ? `Tape ${area.tapeMm} mm → ${area.printableDots} dots per line` : 'No tape loaded', area ? 'ok' : 'error')
    rebuild()
  } catch (e) {
    log(errText(e), 'error')
  } finally {
    ui.read.disabled = !supported
  }
})

// ---- 2. ラベル ----
function rebuild() {
  image = null
  ui.print.disabled = true
  if (!area) return
  const dots = area.printableDots
  const fontPx = Math.min(Number(ui.fontPx.value) || 96, dots * 2)
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const font = `${fontPx}px sans-serif`
  ctx.font = font
  const pad = Math.round(dots / 4)
  c.width = Math.max(1, Math.ceil(ctx.measureText(ui.text.value).width) + pad * 2)
  c.height = dots
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#000'
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.fillText(ui.text.value, pad, dots / 2)
  image = threshold(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height)

  // プレビュー: 1 ドット = 2 画素
  const scale = 2
  const p = ui.preview
  p.width = image.width * scale
  p.height = image.height * scale
  p.style.imageRendering = 'pixelated'
  const pc = p.getContext('2d')!
  pc.fillStyle = '#fff'
  pc.fillRect(0, 0, p.width, p.height)
  pc.fillStyle = '#000'
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) if (image.bits[y * image.width + x]) pc.fillRect(x * scale, y * scale, scale, scale)
  ui.size.textContent = `${image.width} × ${image.height} dots (${(image.width * area.dotMm).toFixed(1)} × ${(image.height * area.dotMm).toFixed(1)} mm)`
  ui.print.disabled = false
}
for (const el of [ui.text, ui.fontPx]) el.addEventListener('input', rebuild)

// ---- 3. 印刷 ----
ui.print.addEventListener('click', async () => {
  if (!area || !image) return
  ui.print.disabled = true
  try {
    await printImageSr5900pDirect(ui.host.value.trim(), image, area.tapeMm, { cut: ui.cut.value as CutMode }, log)
  } catch (e) {
    log(errText(e), 'error')
  } finally {
    ui.print.disabled = false
  }
})
