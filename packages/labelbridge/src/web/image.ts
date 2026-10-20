// ブラウザでの画像 ⇄ MonoImage の変換（ドットバイドット用）。

import { threshold, type MonoImage } from '../core'

/**
 * 画像（PNG、canvas、ImageBitmap など）を 1 画素 = 1 ドットで MonoImage にする。
 * 画像の向き: 幅 = ラベル長（送り方向）、高さ = テープ幅方向（上端 = 0）。
 * 高さが印字可能ドット数を超えるとエラーにする（拡大縮小はしない）。足りない分は下を白で埋める。
 */
export async function imageFromBitmap(source: ImageBitmapSource, printableDots: number, level = 128): Promise<MonoImage> {
  const bmp = await createImageBitmap(source)
  if (bmp.height > printableDots) {
    throw new Error(`画像の高さ ${bmp.height} が印字可能ドット数 ${printableDots} を超えています`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = printableDots
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bmp, 0, 0)
  return threshold(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, printableDots, level)
}

/** 確認用に PNG の data URL にする（scale 倍、1 ドット = scale 画素）。 */
export function imageToDataUrl(m: MonoImage, scale = 3): string {
  const canvas = document.createElement('canvas')
  canvas.width = m.width * scale
  canvas.height = m.height * scale
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000'
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) if (m.bits[y * m.width + x]) ctx.fillRect(x * scale, y * scale, scale, scale)
  return canvas.toDataURL('image/png')
}
