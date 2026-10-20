// ブラウザからラベルを印刷するサンプル。
//
//   1. プリンターにつなぎ、装着テープと印字可能ドット数を読む
//   2. その高さ（ドット数）ぴったりの 1bpp 画像を作る（テキストを描くか、画像ファイルを読む）
//   3. 1 画素 = 1 ドットで印刷する
//
// ライブラリの使い方は docs/typescript.md を参照。

import {
  MODELS,
  describeStatus,
  printArea,
  printAreas,
  type CutMode,
  type JobOptions,
  type ModelId,
  type MonoImage,
  type PrintArea,
  type PrinterStatus,
} from '@labelbridge/core'
import { imageFromBitmap, imageToDataUrl, requestPrinter, webSerialSupported, webUsbSupported, type WebPrinter } from '@labelbridge/web'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const ui = {
  connectUsb: $<HTMLButtonElement>('connect-usb'),
  connectSerial: $<HTMLButtonElement>('connect-serial'),
  refresh: $<HTMLButtonElement>('refresh'),
  manualModel: $<HTMLSelectElement>('manual-model'),
  manualTape: $<HTMLSelectElement>('manual-tape'),
  model: $('info-model'),
  status: $('info-status'),
  tape: $('info-tape'),
  dots: $('info-dots'),
  dpi: $('info-dpi'),
  sourceText: $('source-text'),
  sourceImage: $('source-image'),
  text: $<HTMLInputElement>('text'),
  fontPx: $<HTMLInputElement>('font-px'),
  pad: $<HTMLInputElement>('pad'),
  file: $<HTMLInputElement>('file'),
  threshold: $<HTMLInputElement>('threshold'),
  thresholdValue: $('threshold-value'),
  preview: $<HTMLImageElement>('preview'),
  previewSize: $('preview-size'),
  copies: $<HTMLInputElement>('copies'),
  density: $<HTMLInputElement>('density'),
  cut: $<HTMLSelectElement>('cut'),
  margin: $<HTMLInputElement>('margin'),
  print: $<HTMLButtonElement>('print'),
  log: $('log'),
}

let printer: WebPrinter | null = null
let area: PrintArea | null = null
let image: MonoImage | null = null

function log(message: string, kind: 'info' | 'ok' | 'error' = 'info') {
  const line = document.createElement('div')
  line.className = kind
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`
  ui.log.append(line)
  ui.log.scrollTop = ui.log.scrollHeight
}

// ---- 1. プリンター ----

async function readPrinter() {
  if (!printer) return
  const r = await printer.read()
  showPrinter(r.status, r.area)
  area = r.area
  await rebuildImage()
}

const CUT_LABELS: Record<CutMode, string> = { full: 'フルカット', half: 'ハーフカット', none: 'カットしない' }

/** カットの選択肢を能力表（MODELS[model].fullCut / halfCut）から作る。 */
function showCutModes(model: ModelId | null) {
  const caps = model ? MODELS[model] : null
  const modes: CutMode[] = caps ? [...(caps.fullCut ? ['full' as const] : []), ...(caps.halfCut ? ['half' as const] : []), 'none'] : ['full']
  const keep = ui.cut.value
  ui.cut.replaceChildren(
    ...modes.map((m) => {
      const o = document.createElement('option')
      o.value = m
      o.textContent = CUT_LABELS[m]
      return o
    }),
  )
  ui.cut.value = modes.includes(keep as CutMode) ? keep : modes[0]!
}

function showPrinter(status: PrinterStatus, a: PrintArea | null) {
  ui.model.textContent = printer ? `${printer.model}（${printer.connection === 'usb' ? 'USB' : 'シリアル'}）` : '—'
  ui.status.textContent = describeStatus(status)
  ui.tape.textContent = status.tapeMm ? `${status.tapeMm} mm` : 'なし'
  showArea(a)
}

function showArea(a: PrintArea | null) {
  if (a) {
    ui.dots.textContent = `${a.printableDots} ドット（${a.printableMm.toFixed(1)} mm）${a.verified ? '' : ' ※推定値'}`
    ui.dpi.textContent = `${a.dpi} dpi（1 ドット = ${a.dotMm.toFixed(3)} mm）`
  } else {
    ui.dots.textContent = '—'
    ui.dpi.textContent = '—'
  }
}

// 接続方式だけ選ぶ。機種は USB の product ID や能力表からライブラリが決める。
async function connect(connection: 'usb' | 'serial') {
  try {
    if (connection === 'usb' && !webUsbSupported()) throw new Error('このブラウザは WebUSB に対応していません')
    if (connection === 'serial' && !webSerialSupported()) throw new Error('このブラウザは Web Serial に対応していません')
    printer = await requestPrinter(connection)
    log(`${printer.model} に接続しました`)
    showCutModes(printer.model)
    ui.manualModel.value = ''
    useManualArea()
    await readPrinter()
    ui.refresh.disabled = false
  } catch (e) {
    log(String(e instanceof Error ? e.message : e), 'error')
  }
}

ui.connectUsb.addEventListener('click', () => connect('usb'))
ui.connectSerial.addEventListener('click', () => connect('serial'))
ui.refresh.addEventListener('click', () => readPrinter().catch((e) => log(String(e), 'error')))

// プリンターなしで印字範囲だけ指定する（能力表 printAreas / printArea から引く）。印刷には接続が要る。
function useManualArea() {
  const model = ui.manualModel.value as ModelId | ''
  if (!model) {
    ui.manualTape.disabled = true
    ui.manualTape.replaceChildren()
    return
  }
  const tapes = printAreas(model)
  if (!tapes.some((t) => String(t.tapeMm) === ui.manualTape.value)) {
    ui.manualTape.replaceChildren(
      ...tapes.map((t) => {
        const o = document.createElement('option')
        o.value = String(t.tapeMm)
        o.textContent = `${t.tapeMm} mm → ${t.printableDots} ドット${t.verified ? '' : '（推定）'}`
        return o
      }),
    )
    ui.manualTape.value = tapes.some((t) => t.tapeMm === 12) ? '12' : (ui.manualTape.options[0]?.value ?? '')
  }
  ui.manualTape.disabled = false
  area = printArea(model, Number(ui.manualTape.value))
  ui.model.textContent = `${model}（手で指定）`
  ui.status.textContent = '未接続'
  ui.tape.textContent = `${area.tapeMm} mm`
  showArea(area)
  void rebuildImage()
}
for (const id of Object.keys(MODELS)) {
  const o = document.createElement('option')
  o.value = o.textContent = id
  ui.manualModel.append(o)
}
ui.manualModel.addEventListener('change', useManualArea)
ui.manualTape.addEventListener('change', useManualArea)

// ---- 2. ラベル ----

/** テキストを、高さ = 印字可能ドット数のキャンバスに描く（1 画素 = 1 ドット）。 */
function drawText(text: string, dots: number, fontPx: number, pad: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `${fontPx}px sans-serif`
  ctx.font = font
  const width = Math.max(1, Math.ceil(ctx.measureText(text).width) + pad * 2)
  canvas.width = width
  canvas.height = dots
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, dots)
  ctx.fillStyle = '#000'
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, dots / 2)
  return canvas
}

function sourceKind(): 'text' | 'image' {
  return (document.querySelector<HTMLInputElement>('input[name=source]:checked')?.value ?? 'text') as 'text' | 'image'
}

async function rebuildImage() {
  image = null
  ui.print.disabled = true
  if (!area) {
    ui.previewSize.textContent = 'プリンターにつないで印字可能ドット数を読むと、プレビューを作ります'
    ui.preview.removeAttribute('src')
    return
  }
  try {
    const level = Number(ui.threshold.value)
    const source: ImageBitmapSource | null =
      sourceKind() === 'text'
        ? drawText(ui.text.value, area.printableDots, Number(ui.fontPx.value), Number(ui.pad.value))
        : (ui.file.files?.[0] ?? null)
    if (!source) {
      ui.previewSize.textContent = '画像ファイルを選んでください'
      ui.preview.removeAttribute('src')
      return
    }
    image = await imageFromBitmap(source, area.printableDots, level)
    ui.preview.src = imageToDataUrl(image, 3)
    ui.previewSize.textContent = `${image.width} × ${image.height} ドット（${(image.width * area.dotMm).toFixed(1)} × ${(image.height * area.dotMm).toFixed(1)} mm）`
    ui.print.disabled = printer === null
  } catch (e) {
    ui.preview.removeAttribute('src')
    ui.previewSize.textContent = String(e instanceof Error ? e.message : e)
  }
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=source]')) {
  radio.addEventListener('change', () => {
    ui.sourceText.hidden = sourceKind() !== 'text'
    ui.sourceImage.hidden = sourceKind() !== 'image'
    void rebuildImage()
  })
}
for (const el of [ui.text, ui.fontPx, ui.pad, ui.file]) el.addEventListener('input', () => void rebuildImage())
ui.threshold.addEventListener('input', () => {
  ui.thresholdValue.textContent = ui.threshold.value
  void rebuildImage()
})

// ---- 3. 印刷 ----

ui.print.addEventListener('click', async () => {
  if (!printer || !area || !image) return
  const opts: JobOptions = {
    copies: Number(ui.copies.value),
    density: Number(ui.density.value),
    cut: ui.cut.value as CutMode,
    marginDots: Number(ui.margin.value),
  }
  ui.print.disabled = true
  try {
    await printer.print(image, area.tapeMm, opts, log)
  } catch (e) {
    log(String(e instanceof Error ? e.message : e), 'error')
  } finally {
    ui.print.disabled = false
  }
})

showCutModes(null)
void rebuildImage()
