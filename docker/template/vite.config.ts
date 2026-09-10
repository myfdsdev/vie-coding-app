import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { previewInstrumentation } from './vite-plugin-preview-instrumentation';

// PREVIEW_HOST is injected by the orchestrator, e.g. "sbx-a1b2c3.lvh.me"
const PREVIEW_HOST = process.env.PREVIEW_HOST ?? 'localhost';
const PREVIEW_PORT = Number(process.env.PREVIEW_PUBLIC_PORT ?? 3000);
const PREVIEW_PROTO: 'ws' | 'wss' = process.env.PREVIEW_PROTO === 'wss' ? 'wss' : 'ws';

export default defineConfig({
  plugins: [react(), previewInstrumentation()],
  server: {
    // 0.0.0.0, never 127.0.0.1 — the proxy cannot reach container loopback
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Vite rejects unknown Host headers as a DNS-rebinding defence
    allowedHosts: [PREVIEW_HOST, '.lvh.me', '.localhost'],
    hmr: {
      protocol: PREVIEW_PROTO,
      host: PREVIEW_HOST,
      clientPort: PREVIEW_PORT,
    },
    watch: {
      // bind mounts on macOS/Windows do not deliver inotify events reliably
      usePolling: true,
      interval: 300,
    },
  },
});
