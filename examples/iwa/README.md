# Isolated Web App sample (LAN printing with Direct Sockets)

**English** | [日本語](#日本語)

A web app that prints to LAN printers (UDP/TCP 9100) from Chrome, with the [Direct Sockets API](https://github.com/WICG/direct-sockets). Direct Sockets only works inside an **Isolated Web App (IWA)**, so this page cannot run as a normal website or on GitHub Pages.

The manifest (`public/.well-known/manifest.webmanifest`) asks for `direct-sockets`, plus `direct-sockets-private` and `local-network`, which are needed to reach printers on a private network.

## Try it in developer mode (Chrome on desktop)

1. Open `chrome://flags/#enable-isolated-web-apps` and `chrome://flags/#enable-isolated-web-app-dev-mode`, enable both, and restart Chrome.
2. Build and serve the sample (always on the same port):

   ```bash
   pnpm --filter labelbridge-example-iwa build
   ```

   ```bash
   pnpm --filter labelbridge-example-iwa preview
   ```

3. Open `chrome://iwa-dev` (older versions: the Isolated Web Apps section at the top of `chrome://web-app-internals`), enter `http://localhost:5194` as the dev mode proxy URL, and install it.
4. Launch "labelbridge LAN printing" from the app launcher (or `chrome://apps`), enter the printer's IP address, then **Read tape** → **Print**.

After changing the code, build again and relaunch the app. If you change the manifest, install it again from `chrome://iwa-dev`.

## 日本語

Chrome の [Direct Sockets API](https://github.com/WICG/direct-sockets) で、LAN 接続のプリンター（UDP/TCP 9100）に印刷する Web アプリです。Direct Sockets は **Isolated Web App（IWA）** の中でしか使えないため、普通の Web ページや GitHub Pages としては動きません。

manifest（`public/.well-known/manifest.webmanifest`）では `direct-sockets` に加えて、プライベートネットワークの機器に届くための `direct-sockets-private` と `local-network` を要求しています。

### 開発者モードで試す（デスクトップの Chrome）

1. `chrome://flags/#enable-isolated-web-apps` と `chrome://flags/#enable-isolated-web-app-dev-mode` を有効にして、Chrome を再起動する
2. サンプルをビルドして配信する（ポートは毎回同じにする）

   ```bash
   pnpm --filter labelbridge-example-iwa build
   ```

   ```bash
   pnpm --filter labelbridge-example-iwa preview
   ```

3. `chrome://iwa-dev` を開き（古い版では `chrome://web-app-internals` の上部にある Isolated Web Apps の欄）、開発サーバー（Dev Mode Proxy）の URL として `http://localhost:5194` を入れてインストールする
4. アプリ一覧（または `chrome://apps`）から「labelbridge LAN printing」を起動し、プリンターの IP アドレスを入れて **Read tape** → **Print**

コードを変えたら、ビルドし直してアプリを開き直します。manifest を変えたときは、`chrome://iwa-dev` から入れ直します。
