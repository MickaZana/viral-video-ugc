import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The control panel is a client-side SPA. In dev, `/api/*` is proxied to the
// review-dashboard backend (which owns the real queue/runs/stats/creators data
// and the account-session auth). The proxy keeps the browser same-origin so the
// session cookie flows normally — no CORS needed in development.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 4330,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:4310',
        // Keep the browser's Host header intact. The backend's CSRF/same-origin
        // guard (server.ts) compares the request Origin against the Host header it
        // receives; with changeOrigin: true Vite rewrote Host to "localhost:4310",
        // which never matches the browser's real origin (e.g. 127.0.0.1:4330), so
        // every POST (login/signup) was rejected as "cross-origin mutation".
        changeOrigin: false,
        // Rewrite /api/... -> /... so the backend sees its real route paths.
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      // The shared design-tokens stylesheet (/tokens.css) is served by the same
      // backend — proxy it in dev the same way so `vite dev` renders the same
      // workspace tokens the built app loads at runtime.
      '/tokens.css': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:4310',
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
