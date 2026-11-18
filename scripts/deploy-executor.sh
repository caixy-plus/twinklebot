#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$WORKSPACE_DIR/.env"

# Ensure .env exists
if [[ ! -f "$ENV_FILE" ]]; then
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# Read or generate TWINKLEBOT_EXECUTOR_TOKEN
TOKEN="$(grep -E '^TWINKLEBOT_EXECUTOR_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  if grep -q '^TWINKLEBOT_EXECUTOR_TOKEN=' "$ENV_FILE"; then
    # Replace empty value
    sed -i '' "s/^TWINKLEBOT_EXECUTOR_TOKEN=.*/TWINKLEBOT_EXECUTOR_TOKEN=$TOKEN/" "$ENV_FILE"
  else
    # Append
    echo "TWINKLEBOT_EXECUTOR_TOKEN=$TOKEN" >> "$ENV_FILE"
  fi
fi

# Resolve target Ubuntu/OrbStack username dynamically (override via TWINKLEBOT_EXECUTOR_USER)
TARGET_USER="${TWINKLEBOT_EXECUTOR_USER:-$(orb -m ubuntu id -un 2>/dev/null || id -un)}"

# Ensure /opt/twinklebot exists in Ubuntu and copy executor.py
orb -m ubuntu -u root mkdir -p /opt/twinklebot
orb -m ubuntu -u root cp "$WORKSPACE_DIR/executor/executor.py" /opt/twinklebot/executor.py
orb -m ubuntu -u root chown -R "$TARGET_USER:$TARGET_USER" /opt/twinklebot
orb -m ubuntu -u root chmod 755 /opt/twinklebot/executor.py

# Ensure /etc/twinklebot exists and write executor.env (mode 640, root:$TARGET_USER)
orb -m ubuntu -u root mkdir -p /etc/twinklebot
# Write executor.env via stdin to avoid logging the secret token
printf "TWINKLEBOT_EXECUTOR_TOKEN=%s\nTWINKLEBOT_BROWSER=%s\n" "$TOKEN" "/usr/local/bin/google-chrome" | \
  orb -m ubuntu -u root bash -c 'cat > /etc/twinklebot/executor.env'
orb -m ubuntu -u root chown "root:$TARGET_USER" /etc/twinklebot/executor.env
orb -m ubuntu -u root chmod 640 /etc/twinklebot/executor.env

# Install and start systemd service (rendering User=$TARGET_USER dynamically)
sed "s/^User=.*/User=$TARGET_USER/" "$WORKSPACE_DIR/executor/twinklebot-executor.service" | \
  orb -m ubuntu -u root bash -c 'cat > /etc/systemd/system/twinklebot-executor.service'
orb -m ubuntu -u root systemctl daemon-reload
orb -m ubuntu -u root systemctl enable --now twinklebot-executor.service
orb -m ubuntu -u root systemctl restart twinklebot-executor.service

echo "TwinkleBot executor deployed successfully."
