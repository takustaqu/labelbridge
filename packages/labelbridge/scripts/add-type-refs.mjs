// dist/web.d.ts に WebUSB / Web Serial の型参照を付ける（公開 API の USBDevice / SerialPort を利用側でも解決させる）。
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../dist/web.d.ts', import.meta.url)
const refs = '/// <reference types="w3c-web-usb" />\n/// <reference types="w3c-web-serial" />\n'
const src = readFileSync(path, 'utf8')
if (!src.startsWith(refs)) writeFileSync(path, refs + src)
