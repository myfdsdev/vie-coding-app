#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Start ONE sandbox by hand. This is exactly what the orchestrator does
# programmatically — read it once and the Docker layer stops being magic.
#
#   ./run-sandbox.sh abc123
#
# Then open http://sbx-abc123.lvh.me:3000 (with the preview proxy running).
# ---------------------------------------------------------------------------
set -euo pipefail

SBX_ID="${1:?usage: run-sandbox.sh <sandbox-id>}"
WORKSPACES="${WORKSPACES_DIR:-$(pwd)/../workspaces}"
PROJECT_DIR="$WORKSPACES/$SBX_ID"
PREVIEW_HOST="sbx-${SBX_ID}.lvh.me"

mkdir -p "$PROJECT_DIR"

docker run -d \
  --name "vibe-sbx-${SBX_ID}" \
  --label "vibe.sandbox=1" \
  --label "vibe.id=${SBX_ID}" \
  \
  `# ---- isolation -------------------------------------------------------` \
  --network vibe-sandboxes            `# no direct internet; proxy only`     \
  --cap-drop ALL                      `# drop every Linux capability`        \
  --security-opt no-new-privileges     `# setuid binaries cannot escalate`   \
  --user 10001:10001                  `# never uid 0 inside the container`   \
  \
  `# ---- resource limits (a runaway build must not take the host down) ---` \
  --memory 1g --memory-swap 1g        `# no swap: OOM-kill instead of thrash`\
  --cpus 1.0 \
  --pids-limit 256                    `# fork-bomb guard`                    \
  --ulimit nofile=4096:4096 \
  \
  `# ---- filesystem ------------------------------------------------------` \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  -v "${PROJECT_DIR}:/app:rw" \
  \
  `# ---- egress through the allowlisting proxy ---------------------------` \
  -e HTTP_PROXY=http://egress:8888 \
  -e HTTPS_PROXY=http://egress:8888 \
  -e NO_PROXY=localhost,127.0.0.1 \
  -e NPM_CONFIG_PROXY=http://egress:8888 \
  -e NPM_CONFIG_HTTPS_PROXY=http://egress:8888 \
  \
  `# ---- preview wiring (Vite needs to know its public hostname) ---------` \
  -e PREVIEW_HOST="${PREVIEW_HOST}" \
  -e PREVIEW_PUBLIC_PORT=3000 \
  -e PREVIEW_PROTO=ws \
  \
  vibe-sandbox:latest

echo "started vibe-sbx-${SBX_ID}"
echo "container IP: $(docker inspect -f '{{.NetworkSettings.Networks.vibe-sandboxes.IPAddress}}' "vibe-sbx-${SBX_ID}")"
echo "preview:      http://${PREVIEW_HOST}:3000"
echo "logs:         docker logs -f vibe-sbx-${SBX_ID}"
