# @takustaqu/labelbridge

キングジム製ラベルプリンター「テプラ」PRO の一部機種を、メーカー純正のドライバーやアプリを使わずに扱うためのライブラリです。装着テープの幅と 1 行の印字可能ドット数を読み、1bpp 画像を**拡大縮小せずに 1 画素 = 1 ドット**で印刷します。

> 非公式のライブラリで、株式会社キングジムとは関係ありません。「テプラ」「TEPRA」は株式会社キングジムの登録商標です。

```bash
npm install @takustaqu/labelbridge
```

| import 先 | 動く場所 | 内容 |
|---|---|---|
| `@takustaqu/labelbridge` | どこでも（DOM・Node 非依存） | 1bpp 画像、機種ごとの印字範囲、ジョブ生成、ステータス解釈 |
| `@takustaqu/labelbridge/web` | ブラウザ | USB 接続（WebUSB）、Bluetooth 接続（Web Serial）、画像の変換 |
| `@takustaqu/labelbridge/node` | Node / Electron のメインプロセス | LAN 接続（UDP/TCP 9100） |

| 機種 | 接続 | 動作確認 |
|---|---|---|
| SR3500P | USB | 12mm テープで印字・カット |
| SR-R2500P | Bluetooth SPP | 12mm テープで印字・カット |
| SR5900P | LAN | 12mm テープで印字・カット |

## ブラウザ

Chromium 系のデスクトップ版ブラウザで、`localhost` か HTTPS のページから使えます。

```ts
import { blankImage } from '@takustaqu/labelbridge'
import { requestPrinter } from '@takustaqu/labelbridge/web'

// ボタンのクリックなど、ユーザー操作の中で呼ぶ
const printer = await requestPrinter('usb') // or 'serial'
const { area } = await printer.read() // 装着テープと、1 行の印字可能ドット数
const image = blankImage(300, area!.printableDots) // 幅 = ラベル長、高さ = 印字可能ドット数
image.bits[0] = 1 // 1 = 黒
await printer.print(image, area!.tapeMm, { copies: 1 })
```

## Node / Electron（LAN）

```ts
import { blankImage } from '@takustaqu/labelbridge'
import { printImageSr5900p, readSr5900p } from '@takustaqu/labelbridge/node'

const host = '192.0.2.10' // プリンターの IP アドレスかホスト名
const { area } = await readSr5900p(host)
await printImageSr5900p(host, blankImage(600, area!.printableDots), area!.tapeMm, { cut: 'full' })
```

API の詳細は [docs/typescript.md](https://github.com/takustaqu/labelbridge/blob/main/docs/typescript.md)、プロトコルは [docs/protocol.md](https://github.com/takustaqu/labelbridge/blob/main/docs/protocol.md)、動くサンプルは [examples/web](https://github.com/takustaqu/labelbridge/tree/main/examples/web) を参照してください。

## 既知の制約

- Windows では OS のプリンタードライバーが USB 接続のプリンターを掴むため、WebUSB で開けません（WinUSB への差し替えが必要。未検証）。
- macOS の Chromium では、Bluetooth のリンクが一度切れると、ブラウザを再起動するまで Web Serial で開けなくなることがあります。
- LAN 接続の機種は制御に UDP を使うため、ブラウザからは使えません。`@takustaqu/labelbridge/node` から使います。

## ライセンス

MIT または Apache-2.0 のいずれか（同梱の `LICENSE-MIT`、`LICENSE-APACHE`）。
