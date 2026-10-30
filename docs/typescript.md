# TypeScript API（@takustaqu/labelbridge）

Web アプリ・Electron アプリなどからラベルプリンターを使うためのパッケージ `@takustaqu/labelbridge`。npm で公開している（ソースは `packages/labelbridge`）。動く場所ごとに import 先が分かれている。

```bash
npm install @takustaqu/labelbridge
```

| import 先 | 動く場所 | 内容 |
|---|---|---|
| `@takustaqu/labelbridge` | どこでも（DOM・Node 非依存） | 1bpp 画像、機種の能力と印字範囲、3 機種のジョブ生成・ステータス解釈、印刷手順 |
| `@takustaqu/labelbridge/web` | ブラウザ | WebUSB（SR3500P）、Web Serial（SR-R2500P）、画像との変換、高水準 API |
| `@takustaqu/labelbridge/node` | Node / Electron のメインプロセス | UDP/TCP 9100（SR5900P）と、その高水準 API、mDNS でのプリンター探し |

npm のパッケージは ESM と型定義（`dist/`。import 先ごとに `index` / `web` / `node`）。ワークスペース内では、`exports` が TypeScript のソース（`src/index.ts`）を直接指すので、ビルドせずにテストやサンプルから使える（公開時だけ pnpm の `publishConfig` で `dist/` に差し替わる）。

| 機種 | 接続 | ブラウザ | Node / Electron | 実機確認（12mm） |
|---|---|---|---|---|
| SR3500P | USB | `@takustaqu/labelbridge/web`（WebUSB） | —（Rust の `labelbridge-transport` を使う） | 印字・カット・QR |
| SR-R2500P | Bluetooth SPP | `@takustaqu/labelbridge/web`（Web Serial） | — | 印字・カット・QR |
| SR5900P | LAN | 通常は不可（UDP を使うため）。Isolated Web App の Direct Sockets なら `printImageSr5900pDirect`（実験的・実機未確認） | `@takustaqu/labelbridge/node` | 印字・カット・ハーフカットでの連続・QR（9mm） |

## まず試す: 接続方式だけ選ぶ

機種名を書かずに使うには、`@takustaqu/labelbridge/web` の `requestPrinter` を使う。USB は product ID から、シリアル（Bluetooth SPP）は能力表から、ライブラリが機種を決める。

```ts
import { requestPrinter } from '@takustaqu/labelbridge/web'

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
import { readSr3500p, requestUsbPrinter } from '@takustaqu/labelbridge/web'

const device = await requestUsbPrinter(0x0102) // ユーザー操作の中で
const { status, area } = await readSr3500p(device) // 印字はしない
// status.tapeMm      → 12
// area.printableDots → 72   （1 行のドット数 = 画像の高さ）
// area.dpi           → 180  （横方向は 1 画素 = 25.4 / 180 mm）
// area.verified      → true （false なら参考資料の表などからの推定値）
```

SR-R2500P は `readSrR2500p(port)`（`@takustaqu/labelbridge/web`）、SR5900P は `readSr5900p(host)`（`@takustaqu/labelbridge/node`）を使う。プリンターに繋がずに値だけ知りたいときは、`printArea(model, tapeMm)` / `printAreas(model)`（`@takustaqu/labelbridge`）で引ける。

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
import { blankImage } from '@takustaqu/labelbridge'
import { imageFromBitmap, printImageSr3500p } from '@takustaqu/labelbridge/web'

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
| SR3500P | `printImageSr3500p(device, image, tapeMm, opts, progress)` | `@takustaqu/labelbridge/web` |
| SR-R2500P | `printImageSrR2500p(port, image, tapeMm, opts, progress)` | `@takustaqu/labelbridge/web` |
| SR5900P | `printImageSr5900p(host, image, tapeMm, opts, progress)` | `@takustaqu/labelbridge/node` |

### ジョブの指定（`JobOptions`）

`@takustaqu/labelbridge` の `JobOptions`（`@takustaqu/labelbridge/web` / `@takustaqu/labelbridge/node` からも型を再エクスポート）。エンコーダには、これに `tapeMm` を足した `LabelJob` を渡す。

| フィールド | 既定 | 意味 |
|---|---|---|
| `cut?: CutMode` | `'full'` | `'full'` / `'half'` / `'none'` |
| `copies?` | `1` | 枚数 |
| `density?` | `0` | 濃度 -5..5（範囲外は丸める） |
| `marginDots?` | `0`（SR5900P は本体の空白の幅） | ラベル前後の空白（ドット）。SR5900P は各ラベルの前後に見える余白 |

機種ごとの扱い:

| 機種 | `cut` | `copies` | `marginDots` |
|---|---|---|---|
| SR3500P | `'full'` / `'none'`。プリンターがジョブ終了で必ずカットするので、どちらでもバイト列は同じ | エンコーダは使わない。`printSr3500p` が 1 枚ごとに SOFT_RESET → ジョブを繰り返す | 対応 |
| SR-R2500P | `'full'` / `'none'` | ジョブの中で繰り返す | 対応 |
| SR5900P | `'full'` / `'half'` / `'none'`。`'half'` はラベルの間をハーフカットし、最後はフルカット | ジョブの中で、ラベルごとのページとして繰り返す（ジョブそのものを繰り返すと印字されない） | 各ラベルの前後に見える余白。既定は本体が入れる空白の幅（約 33 ドット）。それより狭くすると、ジョブの先頭に空白のつまみが付く（下の「LAN のプリンターで使えること」） |

対応するカットは能力表 `MODELS[model].fullCut` / `halfCut` にある（Rust の `full_cut` / `half_cut`）。能力表にないカット（SR3500P・SR-R2500P の `'half'`）を渡すと、エンコーダが `UnsupportedCutError`（Rust の `DriverError::UnsupportedCut`）を投げる。`checkCut(model, cut)` で事前に確かめられる。

## LAN のプリンターで使えること（SR5900P、`@takustaqu/labelbridge/node`）

### 名前で探す・つなぐ

mDNS（`_pdl-datastream._tcp`）で探す。`name` はプリンター自身の名前で、同じ機種が何台あっても見分けられる。IP アドレスは DHCP で変わることがあるので、保存しておくなら名前の方がよい。

```ts
import { discoverLanPrinters, findLanPrinter, printImageSr5900p } from '@takustaqu/labelbridge/node'

const all = await discoverLanPrinters() // 2.5 秒ほど待って、見つかったものを返す
const printers = all.filter((d) => d.model === 'SR5900P') // ほかのネットワークプリンターも返るので、機種で絞る
// → [{ name: 'KING JIM TEPRA PRO SR5900P', host: 'SR5900P….local', port: 9100, addresses: ['192.168.…'], model: 'SR5900P', txt: {…} }]

const p = await findLanPrinter('KING JIM TEPRA PRO SR5900P') // 名前で引き直す（見つからなければ null）
if (p) await printImageSr5900p(p.addresses[0] ?? p.host, image, 12)
```

`.local` のホスト名もそのまま渡せる（TCP は IPv4 でつなぐ。IPv6 のリンクローカルに向かうとつながらないため）。

### 複数枚を 1 ジョブで

`printImagesSr5900p(host, images, tapeMm, opts)` は、違うラベルを 1 つのジョブに並べて送る。ジョブの先頭の送りが 1 回で済み、`cut: 'half'` なら台紙でつながったまま出る。`opts.copies` は全体を繰り返す。

```ts
await printImagesSr5900p(host, [label1, label2, label3], 9, { cut: 'half' })
```

### 余白とカット位置の校正

本体は、ジョブの先頭と 1 枚目の後ろにだけ、自分で空白（約 33 ドット ≒ 2.3 mm、ヘッドからカッターまで）を入れ、ラベルの間のカットは次のラベルのデータの始まりに入れる。ライブラリはこれに合わせて、2 枚目以降の前後に空白を足し、各ラベルの前後の余白をそろえる（`sr5900pLayout`）。

- `marginDots` で、各ラベルの前後に見える余白を指定できる。本体の空白より狭くすると、ジョブの先頭に空のページを 1 枚入れ、本物のラベルを全部「2 枚目以降」として扱う（先頭に約 5 mm の空白のつまみが付く）。
- カット位置は機体やテープで少し違うことがある。`calibration`（`Sr5900pCalibration`。既定値は `SR5900P_DEFAULT_CALIBRATION`）で直せる。

```ts
import { sr5900pCalibrationLabels } from '@takustaqu/labelbridge'

// 校正ラベル（黒い四角 1・2・3 個）を 3 枚つなぎで出し、カットと枠の間の余白を見る
await printImagesSr5900p(host, sr5900pCalibrationLabels(9), 9, { cut: 'half', calibration: { leadAdjustDots: 10 } })
```

| `Sr5900pCalibration` | 既定 | 意味 |
|---|---|---|
| `headGapDots` | 33 | 本体がジョブの先頭と 1 枚目の後ろに入れる空白 |
| `leadAdjustDots` | 10 | 2 枚目以降の前に足す空白 = 余白 + この値 |
| `tailAdjustDots` | -2 | 2 枚目以降（1 枚だけのときはその 1 枚）の後ろに足す空白 = 余白 + この値 |
| `firstTailAdjustDots` | 7 | 余白が狭い（空のページを入れる）とき、最初のラベルの後ろにさらに足す空白 |

既定値は 9mm テープで合わせたもの（docs/protocol.md §4）。

### 縦向きのラベル

テープを縦に貼るラベルは、縦長の画像（x = テープの幅方向、y = 長さ方向、上がラベルの始まり）で作り、`rotateImage(image, 'ccw')`（`@takustaqu/labelbridge`）で印刷の向きにしてから送る。印刷したテープは、先頭を上にすれば画像のとおりに読める。

### 印刷中の状態の問い合わせ

印刷中は、本体が状態の問い合わせ（UDP）に答えないことがある。`printSr5900p` は、応答の無い時間が 30 秒を超えるまで問い合わせ直す。

## 下位の API（@takustaqu/labelbridge）

| 用途 | API |
|---|---|
| ジョブのバイト列を作る | `encodeSr3500p(image, job)` / `srR2500pParts(image, job)` / `encodeSr5900p(image, job)` / `encodeSr5900pPages(images, job)`（`job` は 3 機種共通の `LabelJob`。SR5900P は `calibration` も渡せる） |
| SR5900P の並べ方 | `sr5900pLayout(count, cut, marginDots?, calibration?)`（空のページを入れるかと、各ラベルの前後に足す空白） |
| 画像を回す | `rotateImage(image, 'cw' \| 'ccw')` |
| ステータスを解釈する | `parseSr3500pStatus` / `parseSrR2500pStatus` / `parseSr5900pStatus` |
| 印刷手順 | `printSr3500p(ch, job, tapeMm, { copies?, progress?, clock? })` / `printSrR2500p(ch, parts, tapeMm, { progress?, clock? })` / `printSr5900p(ctrl, openData, job, tapeMm, { progress?, clock? })` |

印刷手順の最後の引数は `FlowOptions`（`progress` と、テスト用の `clock`）。SR3500P だけは 1 ジョブ = 1 枚なので、`Sr3500pFlowOptions` に `copies` がある。SR-R2500P / SR5900P の枚数は、エンコード時の `copies` でジョブに入る（SR5900P は、ラベルごとのページとして）。

`parseSr3500pStatus` は、`ST` と `ER` の両方があるフレームだけを採る（どちらかが欠けたフレームは飛ばす）。

印刷手順は、抽象チャネルに対して書いてある。

| チャネル | 必要な操作 | 実装 |
|---|---|---|
| `ByteChannel` | `write` / `read` | WebUSB・Web Serial |
| `UsbPrinterChannel` | `ByteChannel` ＋ `softReset` / `portStatus` | WebUSB |
| `TprtControl` | UDP の要求・応答 | `@takustaqu/labelbridge/node` |
| `DataSink` | TCP への書き込み | `@takustaqu/labelbridge/node` |

ほかの環境（Node の libusb、Electron の IPC 越しなど）も、このインターフェースを実装すれば同じ手順で印刷できる。

## Rust 版との一致

`@takustaqu/labelbridge` の 3 つのエンコーダは、Rust の `labelbridge` と同じバイト列を出す。`packages/labelbridge/test/fixtures.test.ts` が、Rust で作った fixture と 1 バイトずつ照合している。Rust 側を変えたら、fixture を作り直す:

```bash
cargo run -p labelbridge --example fixtures -- packages/labelbridge/test/fixtures
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
import { printArea } from '@takustaqu/labelbridge'
import { printImageSrR2500p, readSrR2500p, requestSppPort } from '@takustaqu/labelbridge/web'

const port = await requestSppPort()
const { area } = await readSrR2500p(port) // 装着テープの印字範囲
const image = myRenderer(area!.printableDots, area!.dpi) // 利用側でビットマップを作る
await printImageSrR2500p(port, image, area!.tapeMm)
```
