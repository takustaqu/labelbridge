import { defineConfig } from 'vite'

// Chrome の「Install IWA via Dev Mode Proxy」には、毎回同じ URL（ポートも）を渡す必要がある。
// IWA の CSP では HMR の WebSocket が使えないので切っておく（変更後はアプリを開き直す）。
export default defineConfig({
  server: { port: 5194, strictPort: true, hmr: false },
  preview: { port: 5194, strictPort: true },
})
