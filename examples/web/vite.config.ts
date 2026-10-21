import { defineConfig } from 'vite'

// GitHub Pages（https://takustaqu.github.io/labelbridge/）では /labelbridge/ 以下に置く。
// ローカルの dev / preview はルートのまま。
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
})
