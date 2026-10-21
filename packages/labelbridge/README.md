# @takustaqu/labelbridge

**English** | [日本語](https://github.com/takustaqu/labelbridge/blob/main/packages/labelbridge/README.ja.md)

Drive some KING JIM "TEPRA" PRO label printers without the vendor's drivers or apps. It reads the loaded tape width and the number of printable dots per line, and prints a 1-bit image **dot by dot, never scaled: one pixel = one dot**.

> This is an unofficial library and is not affiliated with KING JIM CO., LTD. "TEPRA" and "テプラ" are registered trademarks of KING JIM CO., LTD.

**Demo:** <https://takustaqu.github.io/labelbridge/>

```bash
npm install @takustaqu/labelbridge
```

| Import | Runs in | Contents |
|---|---|---|
| `@takustaqu/labelbridge` | Anywhere (no DOM or Node dependency) | 1-bit images, print area per model, job encoding, status parsing |
| `@takustaqu/labelbridge/web` | Browsers | USB (WebUSB), Bluetooth (Web Serial), image conversion |
| `@takustaqu/labelbridge/node` | Node / Electron main process | LAN (UDP/TCP 9100) |

| Printer | Connection | Verified |
|---|---|---|
| SR3500P | USB | 12 mm tape: print and cut |
| SR-R2500P | Bluetooth SPP | 12 mm tape: print and cut |
| SR5900P | LAN | 12 mm tape: print and cut |

## Browser

Works in Chromium-based desktop browsers, on pages served from `localhost` or over HTTPS.

```ts
import { blankImage } from '@takustaqu/labelbridge'
import { requestPrinter } from '@takustaqu/labelbridge/web'

// Call from a user gesture, such as a button click
const printer = await requestPrinter('usb') // or 'serial'
const { area } = await printer.read() // loaded tape and printable dots per line
const image = blankImage(300, area!.printableDots) // width = label length, height = printable dots
image.bits[0] = 1 // 1 = black
await printer.print(image, area!.tapeMm, { copies: 1 })
```

## Node / Electron (LAN)

```ts
import { blankImage } from '@takustaqu/labelbridge'
import { printImageSr5900p, readSr5900p } from '@takustaqu/labelbridge/node'

const host = '192.0.2.10' // printer IP address or host name
const { area } = await readSr5900p(host)
await printImageSr5900p(host, blankImage(600, area!.printableDots), area!.tapeMm, { cut: 'full' })
```

See [docs/typescript.md](https://github.com/takustaqu/labelbridge/blob/main/docs/typescript.md) for the API, [docs/protocol.md](https://github.com/takustaqu/labelbridge/blob/main/docs/protocol.md) for the protocol (both in Japanese), and [examples/web](https://github.com/takustaqu/labelbridge/tree/main/examples/web) for a working sample.

## Known limitations

- On Windows the OS printer driver claims USB printers, so WebUSB cannot open them (the device has to be switched to WinUSB; not verified).
- In Chromium on macOS, once the Bluetooth link drops, Web Serial may not open the port again until the browser is restarted.
- LAN printers use UDP for control, which browsers cannot send. Use them from `@takustaqu/labelbridge/node`.

## License

Either MIT or Apache-2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE` in the package).
