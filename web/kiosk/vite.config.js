import { defineConfig } from 'vite';

// 개발 시 /api 요청(WebSocket 포함)을 로컬 Workers(wrangler dev)로 프록시한다.
// 운영(Cloudflare Pages)에서는 VITE_API_BASE / VITE_WS_URL 로 Workers 주소를 지정한다.
const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://127.0.0.1:8787';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
