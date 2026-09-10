# Forge

Describe an app in plain language; Forge writes it and runs it in a live, sandboxed preview beside the chat.

Built milestone by milestone from `BUILD-PROMPT.md` (the vibe-builder-kit). **Current milestone: M0 — prove the loop.**

## Requirements

- Node 20+ (developed on Node 25) and npm
- Docker Desktop with the engine running. On Windows this needs **WSL 2** (or Hyper-V) enabled.

## First-time setup

```bash
npm install
npm run docker:build   # sandbox image, 3-6 minutes the first time
npm run docker:up      # isolated networks, egress proxy, preview gateway
```

Optional: copy `.env.example` to `.env.local` and set `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. With no key, Forge uses an offline mock model.

## Run

```bash
npm run dev:mock       # offline mock model, no key needed
npm run dev            # real model when a key is set
```

Open http://localhost:3000. Each visit starts a new project; its preview is served from `http://sbx-<id>.lvh.me:3000` (a separate origin).

## M0 acceptance check

`npm run dev:mock`, type anything, and a running app appears in the preview within 10 seconds.

## Verify the sandbox boundary (SETUP-GUIDE §5)

```bash
# direct internet from a sandbox: MUST fail
docker run --rm --network vibe-sandboxes curlimages/curl:latest -sS --max-time 8 https://example.com
# allowlisted host through the proxy: MUST print 200
docker run --rm --network vibe-sandboxes curlimages/curl:latest -sS --max-time 15 -x http://egress:8888 -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/react
# non-allowlisted host through the proxy: MUST print 403
docker run --rm --network vibe-sandboxes curlimages/curl:latest -sS --max-time 15 -x http://egress:8888 -o /dev/null -w '%{http_code}\n' https://example.com
```

## How M0 works

- `server.ts` — one port, two origins: `localhost:3000` is the builder (Next.js); `sbx-<id>.lvh.me:3000` is proxied, including the HMR WebSocket, to that project's sandbox.
- `src/agent/loop.ts` — the turn: context → stream from the model → parse `<changes>` → write files → push them into the sandbox → reload the preview.
- `src/agent/parser.ts` — streaming parser; files appear in the chat as they are written. A cut-off file is never applied.
- `src/sandbox/` — the `SandboxProvider` contract, the Docker implementation (the only file that touches dockerode), and an in-memory mock for tests.
- `src/agent/providers.ts` — `anthropic` (official SDK), `gemini` (`@google/genai`) and `mock`, behind one streaming interface.

## Deviations from the kit, and why

- **Model SDKs:** the official Anthropic SDK plus Gemini, instead of the Vercel AI SDK. Default models: `claude-opus-5` (or `claude-sonnet-5` via `ANTHROPIC_MODEL`), `gemini-3.1-pro-preview` (fast tier `gemini-3.5-flash`). `gemini-2.5-pro` is no longer available to new API keys.
- **Named volume instead of a bind mount** for `/app`. This repo lives on the Windows filesystem, where bind mounts are 10-50x slower and lose file-watch events. Files are pushed into the sandbox through the Docker API; `workspaces/<id>` stays the source of truth.
- **`preview-gateway` (nginx) added to `docker/docker-compose.yml`.** On Docker Desktop the host cannot reach container IPs, so the preview proxy forwards to this gateway on `127.0.0.1:3100`, which reaches `vibe-sbx-<id>:5173` over the sandbox network. Sandboxes still publish no ports and have no internet.
- The model may not overwrite `vite.config.ts`, the preview instrumentation plugin, `src/ErrorBoundary.tsx` or `package-lock.json`.

## Deliberately not in M0

Applying `<edit>` diffs, the file-tree pane, git checkpoints and persistence (M1) · error capture and the self-healing loop, credits and "not billed" repairs (M2) · validators and the stream fixer (M3) · backend (M4) · publish, plan mode, visual edit, version history (M5).

## Tests

```bash
npm test
npm run typecheck
```
