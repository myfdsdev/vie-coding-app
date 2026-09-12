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
/** The prefix a generated app calls its own backend on (src/forge/data.ts). */
const BACKEND_PREFIX = '/_forge/';

/** The builder route a preview-origin backend call maps to, or null for the app itself. */
function backendPath(url: string | undefined, projectId: string): string | null {
  if (!url || !url.startsWith(BACKEND_PREFIX)) return null;
  return `/api/app/${projectId}/${url.slice(BACKEND_PREFIX.length)}`;
}

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
    // Only this line may set it; a client that sends it must not be believed.
    delete req.headers['x-forge-preview'];
    const projectId = previewProjectId(req.headers.host);
    if (projectId) {
      // The generated app's own backend (M4). It answers on the preview origin,
      // so the app can call it with its session cookie, but it runs here —
      // the sandbox never sees the data, the sessions or the secrets.
      const backend = backendPath(req.url, projectId);
      if (backend) {
        req.url = backend;
        req.headers['x-forge-preview'] = '1';
      } else {
        return preview.web(req, res);
      }
    }
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
