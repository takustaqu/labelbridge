# labelbridge

**English** | [日本語](README.ja.md)

A library (Rust and TypeScript) for driving some KING JIM "TEPRA" PRO label printers without the vendor's drivers or apps. It is not an OS printer driver: it talks to the printer directly over USB, Bluetooth or LAN.

Label editing, templates and web/desktop apps are meant to be built separately, as **consumers** of this repository. This repository only holds the code that talks to the printer, plus usage samples (a CLI and a web page).

- Read the loaded tape width and the **number of printable dots per line** for that tape
- Print a 1-bit image **dot by dot, never scaled: one pixel = one dot**
- Read the printer status (idle, printing, errors, tape width)

**Demo:** <https://takustaqu.github.io/labelbridge/> (Chromium-based desktop browsers)

> This is an unofficial project and is not affiliated with KING JIM CO., LTD. "TEPRA" and "テプラ" are registered trademarks of KING JIM CO., LTD.

## Supported printers

Support is split into two tiers. See [docs/protocol.md](docs/protocol.md) (Japanese) for details.

### Verified on hardware (the author's three printers, 2026-10-20)

| Printer | Connection | Resolution | Rust (CLI) | TypeScript | Verified |
|---|---|---|---|---|---|
| TEPRA PRO SR3500P | USB | 180 dpi | ✅ libusb | ✅ WebUSB (`@takustaqu/labelbridge/web`) | 12 mm: print, cut, QR |
| TEPRA PRO SR-R2500P | Bluetooth SPP | 180 dpi | ✅ macOS bridge app / `/dev/…` | ✅ Web Serial (`@takustaqu/labelbridge/web`) | 12 mm: print, cut, QR |
| TEPRA PRO SR5900P | LAN (UDP/TCP 9100) | 360 dpi | ✅ | ✅ Node (`@takustaqu/labelbridge/node`) | 12 mm: print, cut, QR |

Printable dot counts for tape widths other than 12 mm are estimates taken from reference material. `labelbridge area` and `printArea()` tell them apart through `confidence` / `verified`.

### Expected to work (supported by the reference implementations; not verified, not implemented)

TEPRA PRO SR3700P (USB), SR920 (USB), SR-MK1 (Bluetooth), SR-R7900P (LAN). The reference implementations support them, so they are likely to work the same way, but this library does not implement them yet and they have not been tested. The differences are summarised in [docs/protocol.md](docs/protocol.md).

## Layout

| Path | Contents |
|---|---|
| `crates/labelbridge` | Capability table, job encoding (3 models), status parsing, 1-bit bitmaps |
| `crates/labelbridge-transport` | USB (libusb, feature `usb`), serial (`serial`), Unix sockets, TCP, TPRT (UDP 9100) |
| `crates/labelbridge-cli` | Sample CLI `labelbridge` (area / status / print-image / testprint) |
| `tools/bt-bridge` | Bluetooth SPP ↔ Unix socket bridge app for macOS (Swift; re-establishes the link through IOBluetooth) |
| `packages/labelbridge` | npm package `@takustaqu/labelbridge`: `src/core` (environment-independent job encoding, status parsing, print flows and print areas; byte-for-byte identical to the Rust side), `src/web` (WebUSB, Web Serial), `src/node` (UDP/TCP 9100) |
| `examples/web` | Web sample and demo (plain TypeScript + Vite): connect → read the tape → print text or an image dot by dot |
| `docs/protocol.md` | Protocol notes with sources and confidence (Japanese) |
| `docs/typescript.md` | TypeScript API and how to print dot by dot (Japanese) |

## Sample: CLI (Rust)

`crates/labelbridge-cli` shows how to use the Rust libraries (`labelbridge` / `labelbridge-transport`).

```bash
cargo build --release
```

```bash
target/release/labelbridge --help
```

List the print area for each model and tape width (no printer needed):

```bash
target/release/labelbridge area
```

Read the loaded tape and the printable dots per line (does not print; without `--model`, the printer connected over USB is used):

```bash
target/release/labelbridge status
```

```bash
target/release/labelbridge status --host <printer IP address>
```

Print a PNG dot by dot (image width = label length, height ≤ printable dots, aligned to the top; never scaled):

```bash
target/release/labelbridge print-image label.png
```

Print a test pattern:

```bash
target/release/labelbridge testprint --length 30
```

For Bluetooth printers on macOS, build the bridge app once and allow it to use Bluetooth:

```bash
tools/bt-bridge/build.sh
```

```bash
target/release/labelbridge print-image label.png --port <Bluetooth device name>
```

Main options: `--model sr3500p|sr-r2500p|sr5900p` (if omitted: `--host` → LAN, `--port` → Bluetooth, otherwise the USB printer found), `--tape MM` (read from the printer if omitted), `--copies N`, `--cut full|half|none`, `--density -5..5`, `--margin DOTS` (added before and after, or only before, depending on the model), `--threshold 0-255`, `--dry-run out.bin` (write the job bytes instead of sending them).

libusb is required (macOS: `brew install libusb`). Build with `--no-default-features` if you need neither USB nor Bluetooth.

> **About the libusb license**: if you distribute binaries with USB support, the terms of libusb (LGPL-2.1 or later) also apply. `rusb` links the system libusb dynamically by default, but `libusb1-sys` statically links its bundled copy when none is found. Check how your binary is linked and meet the LGPL requirements (notice, source availability, relinking) when distributing ([libusb](https://libusb.info/)).

## Sample: Web (TypeScript)

`examples/web` shows how to use `@takustaqu/labelbridge/web` from a browser (no framework, Vite). It connects to a printer, reads the tape width and printable dots, builds a 1-bit image of exactly that height from text or an image file, and prints it one pixel per dot. Without a printer, you can pick a model and tape width by hand and just look at the preview. The same page is published as the [demo](https://takustaqu.github.io/labelbridge/).

```bash
pnpm install
```

```bash
pnpm --filter labelbridge-example-web dev
```

Open it in a Chromium-based desktop browser. USB uses WebUSB and Bluetooth (SPP) uses Web Serial, so the page must be served from `localhost` or over HTTPS.

## TypeScript library

Published on npm.

```bash
npm install @takustaqu/labelbridge
```

| Import | Runs in |
|---|---|
| `@takustaqu/labelbridge` | Anywhere. Job encoding, status parsing, print areas |
| `@takustaqu/labelbridge/web` | Browsers (WebUSB / Web Serial) |
| `@takustaqu/labelbridge/node` | Node / Electron main process (LAN) |

See [docs/typescript.md](docs/typescript.md) for usage (Japanese).

The Rust crates (`crates/`) are not published to crates.io; they are distributed as source in this repository.

## Tests

```bash
cargo test
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

When you change job encoding on the Rust side, regenerate the fixtures that the TypeScript side is checked against:

```bash
cargo run -p labelbridge --example fixtures -- packages/labelbridge/test/fixtures
```

## Known limitations

- **USB on Windows**: the OS printer driver claims USB printers, so the device has to be switched to WinUSB (not verified).
- **USB on Linux**: `usblp` has to be detached (not verified).
- **First Bluetooth connection from a browser**: when the Bluetooth link is not up yet, the first attempt to open the port fails after about 10 seconds while the link comes up; the library retries automatically, so the first connection takes a while. If the link drops (for example, the printer is turned off), the library closes the port and reconnects on the next operation; no browser restart is needed ([docs/protocol.md](docs/protocol.md) §3).
- **LAN from a browser**: LAN printers use UDP for control, which browsers cannot send. Send from Node instead (the Electron main process or a server).

## Acknowledgements

Much of the protocol knowledge comes from the research and implementations of the following projects (the referenced commits are listed in [docs/protocol.md](docs/protocol.md) §5).

- [ruimo/tpsr3700](https://github.com/ruimo/tpsr3700) (Apache-2.0)
- [hikalium/sr5900p](https://github.com/hikalium/sr5900p) (MIT)
- [azishio/tepra-net-print](https://github.com/azishio/tepra-net-print) (MIT)
- [Mine02C4/TEPRA_PRO_SR5900P_analysis](https://github.com/Mine02C4/TEPRA_PRO_SR5900P_analysis)
- [nikachu2012/tepra_web](https://github.com/nikachu2012/tepra_web) (MIT)
- [nyacom/tepraprint](https://github.com/nyacom/tepraprint)
- [oxplot/nospero](https://github.com/oxplot/nospero)
- [igrbtn/LW700Print](https://github.com/igrbtn/LW700Print) (MIT)

No code or text has been copied from them. What this project takes from them are protocol facts (what commands mean, procedures, numbers); the table in [docs/protocol.md](docs/protocol.md) §5 shows where each item comes from.

## License

Either MIT or Apache-2.0, at your option ([LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)).
