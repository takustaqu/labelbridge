import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// GitHub Pages（https://takustaqu.github.io/labelbridge/）では /labelbridge/ 以下に置く。
// ローカルの dev / preview はルートのまま。
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  build: {
    rollupOptions: {
      // デモ本体と、Bluetooth の切断・復帰を調べる診断ページ
      input: { main: resolve(import.meta.dirname, 'index.html'), btDiag: resolve(import.meta.dirname, 'bt-diag.html') },
    },
  },
})
