# TypeScript API（@labelbridge/core*）

Web アプリ・Electron アプリなどからラベルプリンターを使うためのパッケージ。npm で公開している（ソースは pnpm ワークスペースの `packages/`）。

```bash
npm install @labelbridge/web
```

| パッケージ | 動く場所 | 内容 |
|---|---|---|
| `@labelbridge/core` | どこでも（DOM・Node 非依存） | 1bpp 画像、機種の能力と印字範囲、3 機種のジョブ生成・ステータス解釈、印刷手順 |
| `@labelbridge/web` | ブラウザ | WebUSB（SR3500P）、Web Serial（SR-R2500P）、画像との変換、高水準 API |
| `@labelbridge/node` | Node / Electron のメインプロセス | UDP/TCP 9100（SR5900P）と、その高水準 API |

npm のパッケージは ESM と型定義（`dist/`）。ワークスペース内では、`exports` が TypeScript のソース（`src/index.ts`）を直接指すので、ビルドせずにテストやサンプルから使える（公開時だけ pnpm の `publishConfig` で `dist/` に差し替わる）。

| 機種 | 接続 | ブラウザ | Node / Electron | 実機確認（12mm） |
|---|---|---|---|---|
| SR3500P | USB | `@labelbridge/web`（WebUSB） | —（Rust の `labelbridge-transport` を使う） | 印字・カット・QR |
| SR-R2500P | Bluetooth SPP | `@labelbridge/web`（Web Serial） | — | 印字・カット・QR |
| SR5900P | LAN | 不可（UDP を使うため） | `@labelbridge/node` | 印字・カット・QR |

## まず試す: 接続方式だけ選ぶ

機種名を書かずに使うには、`@labelbridge/web` の `requestPrinter` を使う。USB は product ID から、シリアル（Bluetooth SPP）は能力表から、ライブラリが機種を決める。

```ts
import { requestPrinter } from '@labelbridge/web'

const printer = await requestPrinter('usb') // or 'serial'。ユーザー操作の中で
const { status, area } = await printer.read() // 装着テープと印字範囲（印字しない）
await printer.print(image, area!.tapeMm, { copies: 1, cut: 'full' }, console.log)
// printer.model → 'SR3500P' など
```

`print` の第 3 引数は、3 機種共通の `JobOptions`（下の「ジョブの指定」）。

以下は、機種ごとの API を直接使う場合。

## ドットバイドットで印刷する

エンコーダは画像を拡大縮小しない。**ラベル画像の高さを、装着テープの印字可能ドット数ぴったりにすれば、1 画素 = 1 ドットで印字される**。

画像の向きは全機種共通で、x = テープ送り方向（ラベル長）、y = テープ幅方向（上端が 0）。行の送り順やビットの向きなど機種ごとの違いは、ドライバが吸収する。

### 1. 装着テープと印字範囲を読む

```ts
import { readSr3500p, requestUsbPrinter } from '@labelbridge/web'

const device = await requestUsbPrinter(0x0102) // ユーザー操作の中で
const { status, area } = await readSr3500p(device) // 印字はしない
// status.tapeMm      → 12
// area.printableDots → 72   （1 行のドット数 = 画像の高さ）
// area.dpi           → 180  （横方向は 1 画素 = 25.4 / 180 mm）
// area.verified      → true （false なら参考資料の表などからの推定値）
```

SR-R2500P は `readSrR2500p(port)`（`@labelbridge/web`）、SR5900P は `readSr5900p(host)`（`@labelbridge/node`）を使う。プリンターに繋がずに値だけ知りたいときは、`printArea(model, tapeMm)` / `printAreas(model)`（`@labelbridge/core`）で引ける。

`PrintArea` の各フィールド:

| フィールド | 意味 |
|---|---|
| `printableDots` | 1 行の印字可能ドット数。ラベル画像の高さにする |
| `printableMm` | 印字可能幅（mm） |
| `dpi` / `dotMm` | 解像度と、1 ドットの大きさ |
| `tapeDots` | テープ幅をドットに換算した値（参考） |
| `verified` | 印字可能ドット数を実機で確かめたか |

### 2. 画像を作って送る

```ts
import { blankImage } from '@labelbridge/core'
import { imageFromBitmap, printImageSr3500p } from '@labelbridge/web'

// 自分で描く場合
const img = blankImage(300, area.printableDots) // 幅 300 行 × 高さ 72 ドット
img.bits[y * img.width + x] = 1 // 1 = 黒

// PNG などから作る場合（高さが印字可能ドット数を超えるとエラー。拡大縮小はしない）
const img2 = await imageFromBitmap(file, area.printableDots)

await printImageSr3500p(device, img, area.tapeMm, { copies: 1 }, (msg) => console.log(msg))
```

3 機種とも同じ形で呼ぶ: `(接続先, image, tapeMm, opts?: JobOptions, progress?)`。

| 機種 | 印刷する関数 | パッケージ |
|---|---|---|
| SR3500P | `printImageSr3500p(device, image, tapeMm, opts, progress)` | `@labelbridge/web` |
| SR-R2500P | `printImageSrR2500p(port, image, tapeMm, opts, progress)` | `@labelbridge/web` |
| SR5900P | `printImageSr5900p(host, image, tapeMm, opts, progress)` | `@labelbridge/node` |

### ジョブの指定（`JobOptions`）

`@labelbridge/core` の `JobOptions`（`@labelbridge/web` / `@labelbridge/node` からも型を再エクスポート）。エンコーダには、これに `tapeMm` を足した `LabelJob` を渡す。

| フィールド | 既定 | 意味 |
|---|---|---|
| `cut?: CutMode` | `'full'` | `'full'` / `'half'` / `'none'` |
| `copies?` | `1` | 枚数 |
| `density?` | `0` | 濃度 -5..5（範囲外は丸める） |
| `marginDots?` | `0` | ラベル前後の空白（ドット） |

機種ごとの扱い:

| 機種 | `cut` | `copies` | `marginDots` |
|---|---|---|---|
| SR3500P | `'full'` / `'none'`。プリンターがジョブ終了で必ずカットするので、どちらでもバイト列は同じ | エンコーダは使わない。`printSr3500p` が 1 枚ごとに SOFT_RESET → ジョブを繰り返す | 対応 |
| SR-R2500P | `'full'` / `'none'` | ジョブの中で繰り返す | 対応 |
| SR5900P | `'full'` / `'half'` / `'none'` | ジョブの中で繰り返す | 未対応（0 より大きいとエラー） |

対応するカットは能力表 `MODELS[model].fullCut` / `halfCut` にある（Rust の `full_cut` / `half_cut`）。能力表にないカット（SR3500P・SR-R2500P の `'half'`）を渡すと、エンコーダが `UnsupportedCutError`（Rust の `DriverError::UnsupportedCut`）を投げる。`checkCut(model, cut)` で事前に確かめられる。

## 下位の API（@labelbridge/core）

| 用途 | API |
|---|---|
| ジョブのバイト列を作る | `encodeSr3500p(image, job)` / `srR2500pParts(image, job)` / `encodeSr5900p(image, job)`（`job` は 3 機種共通の `LabelJob`） |
| ステータスを解釈する | `parseSr3500pStatus` / `parseSrR2500pStatus` / `parseSr5900pStatus` |
| 印刷手順 | `printSr3500p(ch, job, tapeMm, { copies?, progress?, clock? })` / `printSrR2500p(ch, parts, tapeMm, { progress?, clock? })` / `printSr5900p(ctrl, openData, job, tapeMm, { progress?, clock? })` |

印刷手順の最後の引数は `FlowOptions`（`progress` と、テスト用の `clock`）。SR3500P だけは 1 ジョブ = 1 枚なので、`Sr3500pFlowOptions` に `copies` がある。SR-R2500P / SR5900P の枚数は、エンコード時の `copies` でジョブに入る。

`parseSr3500pStatus` は、`ST` と `ER` の両方があるフレームだけを採る（どちらかが欠けたフレームは飛ばす）。

印刷手順は、抽象チャネルに対して書いてある。

| チャネル | 必要な操作 | 実装 |
|---|---|---|
| `ByteChannel` | `write` / `read` | WebUSB・Web Serial |
| `UsbPrinterChannel` | `ByteChannel` ＋ `softReset` / `portStatus` | WebUSB |
| `TprtControl` | UDP の要求・応答 | `@labelbridge/node` |
| `DataSink` | TCP への書き込み | `@labelbridge/node` |

ほかの環境（Node の libusb、Electron の IPC 越しなど）も、このインターフェースを実装すれば同じ手順で印刷できる。

## Rust 版との一致

`@labelbridge/core` の 3 つのエンコーダは、Rust の `labelbridge` と同じバイト列を出す。`packages/core/test/fixtures.test.ts` が、Rust で作った fixture と 1 バイトずつ照合している。Rust 側を変えたら、fixture を作り直す:

```bash
cargo run -p labelbridge --example fixtures -- packages/core/test/fixtures
```

## サンプル

`examples/web` に、接続 → 印字範囲の取得 → 画像作成 → 印刷までを一通り行うサンプルがある（素の TypeScript + Vite）。

```bash
pnpm --filter labelbridge-example-web dev
```

## 開発

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm typecheck
```


## 利用側での組み込み例

ラベルのレイアウト（テンプレートや SVG 描画など）は、利用側の責務です。利用側では、このパッケージから印字範囲を受け取り、その高さのビットマップを作って渡してください。

```ts
import { printArea } from '@labelbridge/core'
import { printImageSrR2500p, readSrR2500p, requestSppPort } from '@labelbridge/web'

const port = await requestSppPort()
const { area } = await readSrR2500p(port) // 装着テープの印字範囲
const image = myRenderer(area!.printableDots, area!.dpi) // 利用側でビットマップを作る
await printImageSrR2500p(port, image, area!.tapeMm)
```
