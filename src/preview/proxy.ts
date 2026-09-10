import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createProxyMiddleware } from 'http-proxy-middleware';

/**
 * Preview proxy: routes sbx-<id>.<PREVIEW_DOMAIN>:<PORT> to the sandbox's Vite
 * dev server, including the HMR WebSocket. Everything else goes to Next.
 *
 * The target is the preview gateway (docker-compose.yml), which reaches
 * vibe-sbx-<id>:5173 over the sandbox network. The Host header is preserved
 * (changeOrigin: false) — Vite checks it against server.allowedHosts, and the
 * gateway uses it to pick the container.
 */

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function previewHostPattern(domain = process.env.PREVIEW_DOMAIN || 'lvh.me'): RegExp {
  return new RegExp(`^sbx-([a-z0-9]+)\\.${escapeRegExp(domain)}(:\\d+)?$`, 'i');
}

/** The project id if `host` is a preview hostname, else null. */
export function previewProjectId(host: string | undefined, pattern = previewHostPattern()): string | null {
  const m = pattern.exec(host ?? '');
  return m ? m[1].toLowerCase() : null;
}

const NOT_READY_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Starting preview…</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#121110;color:#978f85;font:13px system-ui,sans-serif">
Starting the preview…</body></html>`;

export interface PreviewProxy {
  web(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createPreviewProxy(gatewayUrl = process.env.PREVIEW_GATEWAY_URL || 'http://127.0.0.1:3100'): PreviewProxy {
  const proxy = createProxyMiddleware<IncomingMessage, ServerResponse>({
    target: gatewayUrl,
    changeOrigin: false,
    // ws: false on purpose. With ws: true the middleware subscribes to EVERY
    // upgrade on the server, including Next's own HMR socket. The custom
    // server routes preview upgrades here explicitly instead.
    ws: false,
    timeout: 30_000,
    proxyTimeout: 30_000,
    on: {
      error(err, _req, res) {
        if ('writeHead' in res && typeof res.writeHead === 'function') {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(NOT_READY_HTML);
        } else {
          (res as Duplex).destroy(err);
        }
      },
    },
  });

  return {
    web(req, res) {
      proxy(req, res, () => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not a preview');
      });
    },
    upgrade(req, socket, head) {
      proxy.upgrade(req, socket as never, head);
    },
  };
}
