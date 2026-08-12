import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // same-origin API in dev -> backend on :8000 (avoids CORS, matches HttpGateway's /api base)
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        // The backend scopes its refresh cookie to Path=/auth (deliberate, kept for prod). But we
        // strip /api before proxying, so the browser sees the response as coming from /api/auth/*
        // and would store the cookie under /auth — a path it then never sends back to /api/auth/*.
        // Rewrite the cookie path to match the browser-visible URL so /auth/refresh actually gets
        // the cookie in dev. Dev-only; the backend is untouched.
        cookiePathRewrite: { '/auth': '/api/auth' },
      },
    },
  },
});
