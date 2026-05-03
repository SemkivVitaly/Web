import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = 'http://127.0.0.1:3780';

const apiProxy = {
  '/api': { target: backend, changeOrigin: true },
  '/uploads': { target: backend, changeOrigin: true },
  '/socket.io': { target: backend, ws: true, changeOrigin: true },
} as const;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/scheduler')) return 'vendor-react';
          if (id.includes('socket.io-client')) return 'vendor-socket';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { ...apiProxy },
  },
  /** Без этого `vite preview` не проксирует API — POST /api/... даёт Cannot POST */
  preview: {
    port: 4173,
    proxy: { ...apiProxy },
  },
});
