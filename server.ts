import { loadEnvConfig } from '@next/env';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import next from 'next';
import { createPreviewProxy, previewProjectId } from './src/preview/proxy';

/**
 * One port, two origins:
 *   http://localhost:3000            -> the builder (Next.js)
 *   http://sbx-<id>.lvh.me:3000      -> that project's preview (proxied to the sandbox)
 *
 * The preview must be a different origin from the builder, or the iframe
 * sandbox attribute is meaningless (SETUP-GUIDE §7).
 */
async function main() {
  loadEnvConfig(process.cwd());
  const dev = process.env.NODE_ENV !== 'production';
  const port = Number(process.env.PORT || 3000);

  const app = next({ dev, hostname: 'localhost', port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const preview = createPreviewProxy();
  const isPreview = (req: http.IncomingMessage) => previewProjectId(req.headers.host) !== null;

  const server = http.createServer((req, res) => {
    if (isPreview(req)) return preview.web(req, res);
    handle(req, res).catch((err) => {
      console.error('[forge] request failed', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    });
  });

  // Next attaches its own 'upgrade' listener on the first request (for its
  // HMR socket) and ends any upgrade it does not recognise — which would kill
  // Vite's HMR socket too. Wrap every foreign upgrade listener so it only ever
  // sees non-preview hosts; preview upgrades go to the preview proxy alone.
  type UpgradeListener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  const previewUpgrade: UpgradeListener = (req, socket, head) => {
    if (isPreview(req)) preview.upgrade(req, socket, head);
  };
  const originalOn = server.on.bind(server);
  const guardedOn = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'upgrade' && listener !== previewUpgrade) {
      const inner = listener as unknown as UpgradeListener;
      return originalOn('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!isPreview(req)) inner(req, socket, head);
      });
    }
    return originalOn(event, listener);
  }) as typeof server.on;
  server.on = guardedOn;
  server.addListener = guardedOn;
  server.on('upgrade', previewUpgrade);

  server.listen(port, () => {
    const domain = process.env.PREVIEW_DOMAIN || 'lvh.me';
    console.log(`[forge] builder  http://localhost:${port}`);
    console.log(`[forge] previews http://sbx-<id>.${domain}:${port} -> ${process.env.PREVIEW_GATEWAY_URL || 'http://127.0.0.1:3100'}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
