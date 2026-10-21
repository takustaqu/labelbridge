// デモページの表示言語（英語が既定、日本語に切り替えられる）。
// HTML の data-i18n="key" の要素と、main.ts の t('key') が使う。

export type Lang = 'en' | 'ja'

const en = {
  title: 'labelbridge — print labels from the browser',
  headline: 'Print labels dot by dot, straight from the browser.',
  intro:
    'Connect a label printer over USB (WebUSB) or Bluetooth (Web Serial), read the tape, and print text or images where one pixel is exactly one dot — no vendor drivers. Works in Chromium-based desktop browsers.',
  previewTitle: 'Preview',
  logTitle: 'Log',
  printer: 'Printer',
  connectUsb: 'Connect over USB',
  connectSerial: 'Connect over Bluetooth',
  refresh: 'Read status again',
  manual: 'Preview without a printer:',
  manualNone: '(use the connected printer)',
  model: 'Model',
  status: 'Status',
  tape: 'Tape width',
  dots: 'Printable dots',
  dpi: 'Resolution',
  label: 'Label',
  text: 'Text',
  imageFile: 'Image file',
  fontPx: 'Font size (dots)',
  pad: 'Side padding (dots)',
  imageNote: 'Images taller than the printable dots are rejected (never scaled down).',
  threshold: 'Threshold',
  previewNote: 'Shown at 3×: one cell is one dot. The tape color is only for the preview.',
  print: 'Print',
  copies: 'Copies',
  density: 'Density',
  cut: 'Cut',
  margin: 'Margin before/after (dots)',
  printButton: 'Print',
  cutFull: 'Full cut',
  cutHalf: 'Half cut',
  cutNone: 'No cut',
  connUsb: 'USB',
  connSerial: 'serial',
  none: 'none',
  dotsUnit: 'dots',
  estimated: ' (estimated)',
  oneDot: '1 dot',
  manualModel: 'set by hand',
  notConnected: 'Not connected',
  connected: 'Connected to {0}',
  noWebUsb: 'This browser does not support WebUSB',
  noWebSerial: 'This browser does not support Web Serial',
  needArea: 'Connect a printer (or pick a model above) to read the printable dots and build a preview',
  pickImage: 'Choose an image file',
  statusText: 'state: {0} / error: {1} / tape: {2}',
  states: { 0: 'idle', 1: 'feeding', 2: 'printing', 3: 'receiving data', 4: 'feed done', 5: 'print done' } as Record<number, string>,
  errors: { 0: 'none', 1: 'cutter error', 6: 'no tape cartridge', 0x21: 'cover open', 0x42: 'tape end', 0x45: 'missing parameter' } as Record<
    number,
    string
  >,
  libNote: 'Progress messages below come from the library and are in Japanese.',
}

type Dict = typeof en

const ja: Dict = {
  title: 'labelbridge — ブラウザから印刷するサンプル',
  headline: 'ブラウザから、1 ドット単位でラベルを印刷。',
  intro:
    'ラベルプリンターに USB（WebUSB）か Bluetooth（Web Serial）でつなぎ、テープを読み取って、テキストや画像を 1 画素 = 1 ドットで印刷します。純正ドライバーは要りません。Chromium 系のデスクトップ版ブラウザで動きます。',
  previewTitle: 'プレビュー',
  logTitle: 'ログ',
  printer: 'プリンター',
  connectUsb: 'USB で接続',
  connectSerial: 'Bluetooth で接続',
  refresh: '状態を読み直す',
  manual: 'プリンターなしでプレビューだけ見る:',
  manualNone: '（接続したプリンターの値を使う）',
  model: '機種',
  status: '状態',
  tape: 'テープ幅',
  dots: '印字可能ドット数',
  dpi: '解像度',
  label: 'ラベル',
  text: 'テキスト',
  imageFile: '画像ファイル',
  fontPx: '文字サイズ（ドット）',
  pad: '左右の余白（ドット）',
  imageNote: '高さが印字可能ドット数を超える画像はエラーになります（縮小しません）',
  threshold: '二値化のしきい値',
  previewNote: '3 倍に拡大して表示しています（1 マス = 1 ドット）。テープの色はプレビュー用です。',
  print: '印刷',
  copies: '枚数',
  density: '濃度',
  cut: 'カット',
  margin: '前後の余白（ドット）',
  printButton: '印刷',
  cutFull: 'フルカット',
  cutHalf: 'ハーフカット',
  cutNone: 'カットしない',
  connUsb: 'USB',
  connSerial: 'シリアル',
  none: 'なし',
  dotsUnit: 'ドット',
  estimated: ' ※推定値',
  oneDot: '1 ドット',
  manualModel: '手で指定',
  notConnected: '未接続',
  connected: '{0} に接続しました',
  noWebUsb: 'このブラウザは WebUSB に対応していません',
  noWebSerial: 'このブラウザは Web Serial に対応していません',
  needArea: 'プリンターにつないで（または上で機種を選んで）印字可能ドット数を読むと、プレビューを作ります',
  pickImage: '画像ファイルを選んでください',
  statusText: '状態: {0} / エラー: {1} / テープ: {2}',
  states: { 0: '待機', 1: '送り中', 2: '印字中', 3: 'データ受信中', 4: '送り終了', 5: '印字終了' },
  errors: { 0: 'なし', 1: 'カッターエラー', 6: 'テープカートリッジなし', 0x21: 'カバーオープン', 0x42: 'テープエンド', 0x45: 'パラメータ不足' },
  libNote: '',
}

const dicts: Record<Lang, Dict> = { en, ja }
type TextKey = { [K in keyof Dict]: Dict[K] extends string ? K : never }[keyof Dict]

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('labelbridge-demo-lang')
    if (saved === 'en' || saved === 'ja') return saved
  } catch {
    // localStorage が使えない環境でも既定の言語で動く
  }
  return 'en'
}

let lang: Lang = initialLang()

export const currentLang = () => lang
export const dict = () => dicts[lang]

export function t(key: TextKey, ...args: (string | number)[]): string {
  return dicts[lang][key].replace(/\{(\d)\}/g, (_, i: string) => String(args[Number(i)] ?? ''))
}

/** data-i18n の要素の文字を、現在の言語に差し替える。 */
export function applyStatic() {
  document.documentElement.lang = lang
  document.title = t('title')
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as TextKey)
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang))
  }
}

export function setLang(next: Lang) {
  lang = next
  try {
    localStorage.setItem('labelbridge-demo-lang', next)
  } catch {
    // 保存できなくても切り替え自体はできる
  }
  applyStatic()
}
