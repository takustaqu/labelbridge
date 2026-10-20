# @labelbridge/core

キングジム製ラベルプリンター「テプラ」PRO の一部機種（SR3500P / SR-R2500P / SR5900P）向けの、環境に依存しない部分です。1bpp 画像、機種ごとの印字範囲（テープ幅と 1 行の印字可能ドット数）、ジョブのバイト列生成、ステータスの解釈、印刷手順を含みます。DOM にも Node にも依存しません。

> 非公式のライブラリで、株式会社キングジムとは関係ありません。「テプラ」「TEPRA」は株式会社キングジムの登録商標です。

実際にプリンターとつなぐには、ブラウザなら [`@labelbridge/web`](https://www.npmjs.com/package/@labelbridge/web)、Node / Electron のメインプロセスなら [`@labelbridge/node`](https://www.npmjs.com/package/@labelbridge/node) を使います。

```bash
npm install @labelbridge/core
```

```ts
import { blankImage, encodeSr3500p, printArea } from '@labelbridge/core'

const area = printArea('SR3500P', 12) // 12mm テープ → printableDots: 72
const image = blankImage(300, area.printableDots) // 幅 = ラベル長、高さ = 印字可能ドット数
image.bits[0] = 1 // 1 = 黒
const job = encodeSr3500p(image, { tapeMm: 12 }) // 拡大縮小せず 1 画素 = 1 ドット
```

API の詳細は [docs/typescript.md](https://github.com/takustaqu/labelbridge/blob/main/docs/typescript.md)、プロトコルは [docs/protocol.md](https://github.com/takustaqu/labelbridge/blob/main/docs/protocol.md) を参照してください。

## ライセンス

MIT または Apache-2.0 のいずれか（同梱の `LICENSE-MIT`、`LICENSE-APACHE`）。
