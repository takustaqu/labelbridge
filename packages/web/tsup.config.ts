import { defineConfig } from 'tsup'

// npm 公開用のビルド（ESM + 型定義）。ワークスペース内ではソースを直接使う。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    // 公開 API が使う WebUSB / Web Serial の型を、利用側でも解決させる
    banner: '/// <reference types="w3c-web-usb" />\n/// <reference types="w3c-web-serial" />',
  },
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'browser',
})
