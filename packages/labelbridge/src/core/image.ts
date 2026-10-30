// 1bpp のラベル画像。座標はドキュメントと同じ向き:
//   x = テープ送り方向（ラベル長）、y = テープ幅方向（上端が 0）。
// 高さは印字可能ドット数。プリンターへ送るときの行の順序・ビットの向きは各ドライバが決める。

export interface MonoImage {
  /** ラベル長（ドット） */
  width: number
  /** 印字可能幅（ドット） */
  height: number
  /** 行優先、1 = 黒 */
  bits: Uint8Array
}

export function blankImage(width: number, height: number): MonoImage {
  return { width, height, bits: new Uint8Array(width * height) }
}

export const pixel = (m: MonoImage, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < m.width && y < m.height && m.bits[y * m.width + x] === 1

/**
 * 90° 回す。'cw' は時計回り、'ccw' は反時計回り。
 * 縦向きに作ったラベル（x = テープの幅方向、y = 長さ方向、上がラベルの始まり）は 'ccw' で印刷用の向きになる:
 * 画像の上がテープの先頭に、画像の右がテープの上端に来る（印刷したテープは、先頭を上にすれば画像のとおりに読める）。
 */
export function rotateImage(m: MonoImage, dir: 'cw' | 'ccw'): MonoImage {
  const out = blankImage(m.height, m.width)
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) {
      if (!m.bits[y * m.width + x]) continue
      const [nx, ny] = dir === 'cw' ? [m.height - 1 - y, x] : [y, m.width - 1 - x]
      out.bits[ny * out.width + nx] = 1
    }
  return out
}

/** RGBA を輝度で二値化する。透明は白。 */
export function threshold(rgba: ArrayLike<number>, width: number, height: number, level = 128): MonoImage {
  const bits = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!, rgba[i * 4 + 3]!]
    const y = a < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b
    bits[i] = y < level ? 1 : 0
  }
  return { width, height, bits }
}

/**
 * ラベルの x 列をラスタ 1 行（MSB first）に詰める。
 * `bottomFirst` なら dot 0 = ラベル下端、そうでなければ dot 0 = 上端。
 * どちらでも画像の 1 行目はラベル上端（印字可能範囲の端）に来る。
 */
export function packColumn(m: MonoImage, x: number, dots: number, bottomFirst: boolean): Uint8Array {
  const row = new Uint8Array(Math.ceil(dots / 8))
  const h = Math.min(m.height, dots)
  for (let y = 0; y < h; y++) {
    if (m.bits[y * m.width + x]) {
      const d = bottomFirst ? dots - 1 - y : y
      row[d >> 3]! |= 0x80 >> (d & 7)
    }
  }
  return row
}

/** 確認用の ASCII 表示。 */
export function toAscii(m: MonoImage): string {
  let s = ''
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) s += m.bits[y * m.width + x] ? '#' : '.'
    s += '\n'
  }
  return s
}
