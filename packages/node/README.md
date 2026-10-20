# @labelbridge/node

キングジム製ラベルプリンター「テプラ」PRO の LAN 対応機（SR5900P）を、Node や Electron のメインプロセスから使うためのパッケージです。制御に UDP 9100、データに TCP 9100 を使います（ブラウザからは UDP が使えないため、このパッケージが必要です）。

> 非公式のライブラリで、株式会社キングジムとは関係ありません。「テプラ」「TEPRA」は株式会社キングジムの登録商標です。

```bash
npm install @labelbridge/node
```

```ts
import { blankImage } from '@labelbridge/core'
import { printImageSr5900p, readSr5900p } from '@labelbridge/node'

const host = '192.0.2.10' // プリンターの IP アドレスかホスト名
const { area } = await readSr5900p(host) // 装着テープと、1 行の印字可能ドット数
const image = blankImage(600, area!.printableDots)
await printImageSr5900p(host, image, area!.tapeMm, { cut: 'full' })
```

SR5900P（12mm テープ）で動作確認済みです。Node 20 以降。API の詳細は [docs/typescript.md](https://github.com/takustaqu/labelbridge/blob/main/docs/typescript.md) を参照してください。

## ライセンス

MIT または Apache-2.0 のいずれか（同梱の `LICENSE-MIT`、`LICENSE-APACHE`）。
