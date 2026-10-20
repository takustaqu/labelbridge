import { defineConfig } from 'tsup'

// npm 公開用のビルド（ESM + 型定義）。ワークスペース内ではソースを直接使う。
//   @takustaqu/labelbridge       → dist/index.js（環境非依存）
//   @takustaqu/labelbridge/web   → dist/web.js（ブラウザ）
//   @takustaqu/labelbridge/node  → dist/node.js（Node / Electron のメインプロセス）
export default defineConfig({
  entry: { index: 'src/core/index.ts', web: 'src/web/index.ts', node: 'src/node/index.ts' },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
  external: [/^node:/],
})
