# @labelbridge/web

キングジム製ラベルプリンター「テプラ」PRO の一部機種を、ブラウザから直接使うためのパッケージです。USB は WebUSB、Bluetooth（SPP）は Web Serial を使います。メーカーのドライバーやアプリは要りません。

> 非公式のライブラリで、株式会社キングジムとは関係ありません。「テプラ」「TEPRA」は株式会社キングジムの登録商標です。

```bash
npm install @labelbridge/web
```

Chromium 系のデスクトップ版ブラウザで、`localhost` か HTTPS のページから使えます。

```ts
import { blankImage } from '@labelbridge/core'
import { requestPrinter } from '@labelbridge/web'

// ボタンのクリックなど、ユーザー操作の中で呼ぶ
const printer = await requestPrinter('usb') // or 'serial'
const { area } = await printer.read() // 装着テープと、1 行の印字可能ドット数
const image = blankImage(300, area!.printableDots) // 高さ = 印字可能ドット数で 1 画素 = 1 ドット
await printer.print(image, area!.tapeMm, { copies: 1 })
```

| 機種 | 接続 | 状態 |
|---|---|---|
| SR3500P | USB（WebUSB） | 12mm テープで動作確認済み |
| SR-R2500P | Bluetooth SPP（Web Serial） | 12mm テープで動作確認済み |

画像ファイルからの変換（`imageFromBitmap`）やプレビュー用の変換（`imageToDataUrl`）も入っています。動くサンプルは [examples/web](https://github.com/takustaqu/labelbridge/tree/main/examples/web)、API の詳細は [docs/typescript.md](https://github.com/takustaqu/labelbridge/blob/main/docs/typescript.md) を参照してください。

## 既知の制約

- Windows では OS のプリンタードライバーが USB を掴むため、WebUSB で開けません（WinUSB への差し替えが必要。未検証）。
- macOS の Chromium では、Bluetooth のリンクが一度切れると、ブラウザを再起動するまで Web Serial で開けなくなることがあります。

## ライセンス

MIT または Apache-2.0 のいずれか（同梱の `LICENSE-MIT`、`LICENSE-APACHE`）。
