# labelbridge

キングジム製ラベルプリンター「テプラ」PRO の一部機種を、メーカー純正のドライバーやアプリを使わずに扱うためのライブラリです（Rust と TypeScript）。OS のプリンタードライバーではなく、USB / Bluetooth / LAN で直接プリンターと話すコードです。

ラベルの編集やテンプレート、Web・デスクトップのアプリは、このリポジトリの**利用者**として別に作る前提です。ここには、プリンターとのやりとりと、使い方の見本（CLI と Web のサンプル）だけを置いています。

- 装着テープの幅と、そのテープでの**1 行の印字可能ドット数**を読む
- 1bpp 画像を**拡大縮小せずに 1 画素 = 1 ドット**で印刷する（ドットバイドット）
- ステータス（待機・印字中・エラー・テープ幅）を読む

> 本プロジェクトは非公式で、株式会社キングジムとは関係ありません。「テプラ」「TEPRA」は株式会社キングジムの登録商標です。

## 対応機種

サポート範囲は 2 段階に分けています。詳細は [docs/protocol.md](docs/protocol.md) を参照してください。

### 動作検証済み（当方所有の 3 台、2026-10-20）

| 機種 | 接続 | 解像度 | Rust（CLI） | TypeScript | 確認内容 |
|---|---|---|---|---|---|
| テプラ PRO SR3500P | USB | 180dpi | ✅ libusb | ✅ WebUSB（`@takustaqu/labelbridge/web`） | 12mm: 印字・カット・QR |
| テプラ PRO SR-R2500P | Bluetooth SPP | 180dpi | ✅ macOS 中継アプリ / `/dev/…` | ✅ Web Serial（`@takustaqu/labelbridge/web`） | 12mm: 印字・カット・QR |
| テプラ PRO SR5900P | LAN（UDP/TCP 9100） | 360dpi | ✅ | ✅ Node（`@takustaqu/labelbridge/node`） | 12mm: 印字・カット・QR |

12mm 以外のテープ幅の印字可能ドット数は、参考資料からの推定値です。`labelbridge area` と `printArea()` の `confidence` / `verified` で区別できます。

### 想定サポート（参考実装が対応している機種・未検証・未実装）

テプラ PRO SR3700P（USB）、SR920（USB）、SR-MK1（Bluetooth）、SR-R7900P（LAN）。参考にした実装が対応しているので、同じ方式で動く見込みがあります。ただし本ライブラリには未実装で、当方での動作確認もしていません。各機種との差分は [docs/protocol.md](docs/protocol.md) にまとめています。

## 構成

| 場所 | 内容 |
|---|---|
| `crates/labelbridge` | 機種の能力表、ジョブ生成（3 機種）、ステータス解釈、1bpp ビットマップ |
| `crates/labelbridge-transport` | USB（libusb、`usb`）、シリアル（`serial`）、Unix ソケット、TCP、TPRT（UDP 9100） |
| `crates/labelbridge-cli` | CLI サンプル `labelbridge`（area / status / print-image / testprint） |
| `tools/bt-bridge` | macOS 用の Bluetooth SPP ↔ Unix ソケット中継アプリ（Swift。IOBluetooth でリンクを張り直す） |
| `packages/labelbridge` | npm パッケージ `@takustaqu/labelbridge`。`src/core`（環境非依存。ジョブ生成・ステータス解釈・印刷手順・印字範囲。Rust 版とバイト単位で一致）、`src/web`（WebUSB・Web Serial）、`src/node`（UDP/TCP 9100） |
| `examples/web` | Web サンプル（素の TypeScript + Vite）。接続 → テープ幅を読む → テキストか画像をドットバイドットで印刷 |
| `docs/protocol.md` | プロトコル資料（出どころと確度つき） |
| `docs/typescript.md` | TypeScript API とドットバイドット印刷の手順 |

## サンプル: CLI（Rust）

`crates/labelbridge-cli` は、Rust のライブラリ（`labelbridge` / `labelbridge-transport`）の使い方の見本です。

```bash
cargo build --release
```

```bash
target/release/labelbridge --help
```

機種・テープ幅ごとの印字範囲の一覧（プリンター不要）:

```bash
target/release/labelbridge area
```

装着テープの幅と印字ドット数を読む（印字はしない。`--model` を省くと、USB につながっている機種を使う）:

```bash
target/release/labelbridge status
```

```bash
target/release/labelbridge status --model sr5900p --host <プリンターの IP アドレス>
```

PNG をドットバイドットで印刷する（画像の幅 = ラベル長、高さ = 印字可能ドット数以下、上詰め。拡大縮小しない）:

```bash
target/release/labelbridge print-image label.png
```

テストパターンを印刷する:

```bash
target/release/labelbridge testprint --length 30
```

SR-R2500P（macOS）は、初回に中継アプリをビルドし、Bluetooth の利用を許可します。

```bash
tools/bt-bridge/build.sh
```

```bash
target/release/labelbridge print-image label.png --model sr-r2500p
```

主なオプション: `--model sr3500p|sr-r2500p|sr5900p`（省略時は --host → LAN、--port → Bluetooth、どちらもなければ USB 機器から決める）、`--tape MM`（省略時は実機から読む）、`--copies N`、`--cut full|half|none`、`--density -5..5`、`--margin DOTS`（SR3500P は前後、SR-R2500P は先頭のみ）、`--threshold 0-255`、`--dry-run out.bin`（送らずにバイト列を書く）。

libusb が必要です（macOS: `brew install libusb`）。USB や Bluetooth を使わない場合は `--no-default-features` でビルドできます。

> **libusb のライセンスについて**: USB 対応のバイナリを配布する場合、libusb（LGPL-2.1 以降）の条件が別途かかります。`rusb` は環境の libusb を動的リンクするのが既定ですが、見つからないと `libusb1-sys` が同梱ソースを静的リンクします。配布時はリンク方式を確認し、LGPL の通知・ソース提供・再リンクの条件を満たしてください（[libusb](https://libusb.info/)）。

## サンプル: Web（TypeScript）

`examples/web` は、`@takustaqu/labelbridge/web` をブラウザから使う見本です（フレームワークなし、Vite）。プリンターにつないでテープ幅と印字可能ドット数を読み、テキストか画像ファイルからその高さの 1bpp 画像を作って、1 画素 = 1 ドットで印刷します。プリンターがなくても、機種とテープ幅を手で選んでプレビューだけ見られます。

```bash
pnpm install
```

```bash
pnpm --filter labelbridge-example-web dev
```

Chromium 系ブラウザ（デスクトップ版）で開きます。USB は WebUSB、Bluetooth（SPP）は Web Serial を使うため、どちらも `localhost` か HTTPS が必要です。

## TypeScript ライブラリ

npm で公開しています。

```bash
npm install @takustaqu/labelbridge
```

| import 先 | 動く場所 |
|---|---|
| `@takustaqu/labelbridge` | どこでも。ジョブ生成・ステータス解釈・印字範囲 |
| `@takustaqu/labelbridge/web` | ブラウザ（WebUSB / Web Serial） |
| `@takustaqu/labelbridge/node` | Node / Electron のメインプロセス（LAN） |

使い方は [docs/typescript.md](docs/typescript.md) を参照してください。

Rust のクレート（`crates/`）は crates.io には公開せず、このリポジトリのソースとして配布します。

## テスト

```bash
cargo test
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

Rust のジョブ生成を変えたら、TS 側との一致テスト用の fixture を作り直します。

```bash
cargo run -p labelbridge --example fixtures -- packages/labelbridge/test/fixtures
```

## 既知の制約

- **Windows での USB**：OS のプリンタードライバが SR3500P を掴むため、WinUSB への差し替えが必要です（未検証）。
- **Linux での USB**：`usblp` を外す必要があります（未検証）。
- **macOS + Chromium 系ブラウザ（SR-R2500P）**：Bluetooth のリンクが一度切れると、ブラウザを再起動するまで Web Serial で開けなくなります（[docs/protocol.md](docs/protocol.md) §3）。
- **ブラウザから SR5900P**：UDP が使えないため、直接は送れません。Node（Electron のメインプロセスやサーバー）から送ってください。

## 謝辞

プロトコルの多くは、次のプロジェクトの調査と実装に基づいています（参照したコミットは [docs/protocol.md](docs/protocol.md) §5 に記載）。

- [ruimo/tpsr3700](https://github.com/ruimo/tpsr3700)（Apache-2.0）
- [hikalium/sr5900p](https://github.com/hikalium/sr5900p)（MIT）
- [azishio/tepra-net-print](https://github.com/azishio/tepra-net-print)（MIT）
- [Mine02C4/TEPRA_PRO_SR5900P_analysis](https://github.com/Mine02C4/TEPRA_PRO_SR5900P_analysis)
- [nikachu2012/tepra_web](https://github.com/nikachu2012/tepra_web)（MIT）
- [nyacom/tepraprint](https://github.com/nyacom/tepraprint)
- [oxplot/nospero](https://github.com/oxplot/nospero)
- [igrbtn/LW700Print](https://github.com/igrbtn/LW700Print)（MIT）

コードや文章はこれらから流用していません。取り入れたのはプロトコルの事実（コマンドの意味・手順・数値）で、どの項目がどこから来たかは [docs/protocol.md](docs/protocol.md) §5 の表にまとめています。

## ライセンス

MIT または Apache-2.0 のいずれか（[LICENSE-MIT](LICENSE-MIT)、[LICENSE-APACHE](LICENSE-APACHE)）。
