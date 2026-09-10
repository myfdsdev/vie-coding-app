#!/bin/sh
# Seed an empty project volume from the baked template, then start Vite.
# Idempotent: an existing project is left exactly as the agent wrote it.
set -eu

SRC=/opt/preinstalled/template

if [ ! -f /app/package.json ]; then
  echo "[sandbox] seeding project from template"
  cp -a "$SRC/." /app/
fi

if [ ! -d /app/node_modules ] || [ -z "$(ls -A /app/node_modules 2>/dev/null || true)" ]; then
  echo "[sandbox] linking preinstalled node_modules"
  cp -a "$SRC/node_modules" /app/node_modules
fi

# The orchestrator sets SANDBOX_INSTALL=1 after it writes a package.json that
# adds dependencies. Runtime installs are the risky ones — see SETUP-GUIDE.md.
if [ "${SANDBOX_INSTALL:-0}" = "1" ]; then
  echo "[sandbox] installing added dependencies"
  npm install --no-audit --no-fund --prefer-offline || echo "[sandbox] install failed (non-fatal)"
fi

echo "[sandbox] starting vite on 0.0.0.0:5173"
exec npm run dev -- --host 0.0.0.0 --port 5173
