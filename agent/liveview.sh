#!/usr/bin/env bash
# Publishes the agent's screen (noVNC on localhost) through a Cloudflare quick tunnel and records the public link,
# so the portal can show an "Open the agent's browser" button. No Cloudflare account or open firewall port needed.
set -u
DATA_DIR="${DATA_DIR:-/var/lib/grants-agent}"
PORT="${NOVNC_PORT:-6090}"
PASS="$(cat "$DATA_DIR/vnc_pass" 2>/dev/null || true)"
rm -f "$DATA_DIR/live_view_url"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"
  url="$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)"
  if [ -n "$url" ]; then
    printf '%s/vnc.html?autoconnect=1&resize=scale&reconnect=1&password=%s\n' "$url" "$PASS" > "$DATA_DIR/live_view_url"
  fi
done
