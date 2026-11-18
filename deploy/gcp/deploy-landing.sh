#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LANDING_DIR="$ROOT_DIR/landing"
TARGET_DIR="${TARGET_DIR:-/var/www/twinklebot-landing}"

if [ -n "${REMOTE_HOST:-}" ]; then
  echo "[deploy-landing] Uploading $LANDING_DIR -> $REMOTE_HOST:$TARGET_DIR"
  ssh "$REMOTE_HOST" "sudo mkdir -p '$TARGET_DIR' && sudo chown -R \$(whoami) '$TARGET_DIR'"
  rsync -avz --delete "$LANDING_DIR/" "$REMOTE_HOST:$TARGET_DIR/"
  ssh "$REMOTE_HOST" "sudo systemctl reload nginx 2>/dev/null || sudo systemctl reload caddy 2>/dev/null || true"
  echo "[deploy-landing] Verifying endpoints..."
  LANDING_BASE_URL="${LANDING_BASE_URL:-https://example.com}"
  curl -s -o /dev/null -w "Root (/) status: %{http_code}\n" "${LANDING_BASE_URL}/"
  curl -s -o /dev/null -w "Landing (/twinklebot/) status: %{http_code}\n" "${LANDING_BASE_URL}/twinklebot/"
else
  echo "[deploy-landing] Installing locally to $TARGET_DIR"
  sudo mkdir -p "$TARGET_DIR"
  sudo rsync -av --delete "$LANDING_DIR/" "$TARGET_DIR/"
  sudo systemctl reload nginx 2>/dev/null || sudo systemctl reload caddy 2>/dev/null || true
fi
