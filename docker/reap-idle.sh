#!/usr/bin/env bash
# Kill sandboxes older than IDLE_MINUTES. Run from cron every 5 minutes.
# Idle containers are the entire cost problem in a self-hosted builder:
# a chat-driven session computes maybe 5-15% of its wall-clock life.
set -euo pipefail
IDLE_MINUTES="${IDLE_MINUTES:-30}"
CUTOFF=$(( $(date +%s) - IDLE_MINUTES * 60 ))

docker ps --filter "label=vibe.sandbox=1" --format '{{.Names}}' | while read -r name; do
  started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$name")" +%s)
  if [ "$started" -lt "$CUTOFF" ]; then
    echo "reaping $name (up $(( ($(date +%s) - started) / 60 ))m)"
    docker rm -f "$name" >/dev/null
  fi
done
