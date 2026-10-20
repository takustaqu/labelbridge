import { defineConfig } from 'tsup'

// npm 公開用のビルド（ESM + 型定義）。ワークスペース内ではソースを直接使う。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
})
