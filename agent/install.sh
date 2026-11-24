#!/usr/bin/env bash
# Installs (or updates) the grants portal browser agent on a Debian/Ubuntu VM.
#
#   curl -fsSL <PORTAL_URL>/agent/install.sh | bash -s -- <PORTAL_URL> <AGENT_TOKEN>      (as root)
#
# What it sets up, all as systemd services that survive reboots:
#   - a virtual screen with one visible Chrome the agent drives (persistent profile, so logins stick)
#   - a password-protected live view of that screen (noVNC through a Cloudflare quick tunnel) for human take-over
#   - the runner, which polls the portal for Apply jobs and uses the Hermes agent when it is installed
# Safe to run again; it never touches anything outside /opt/grants-agent, /var/lib/grants-agent, /etc/grants-agent.env,
# its own grants-*.service units and (only to add the skill + browser attachment) ~/.hermes.
set -euo pipefail

PORTAL="${1:-}"; TOKEN="${2:-}"
[ -n "$PORTAL" ] && [ -n "$TOKEN" ] || { echo "usage: install.sh <PORTAL_URL> <AGENT_TOKEN>" >&2; exit 1; }
[ "$(id -u)" = "0" ] || { echo "Please run as root (sudo)." >&2; exit 1; }
command -v apt-get >/dev/null || { echo "This installer supports Debian/Ubuntu (apt) only." >&2; exit 1; }
PORTAL="${PORTAL%/}"
APP=/opt/grants-agent
DATA=/var/lib/grants-agent
DISPLAY_NUM=77; VNC_PORT=5977; NOVNC_PORT=6090; CDP_PORT=9333
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates xvfb x11vnc novnc websockify openbox fonts-liberation >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v cloudflared >/dev/null; then
  say "Installing cloudflared (for the live view link)"
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" \
    && dpkg -i /tmp/cloudflared.deb >/dev/null && rm -f /tmp/cloudflared.deb \
    || echo "   cloudflared could not be installed; the live view will only be reachable on the VM itself."
fi

say "Installing the runner into $APP"
mkdir -p "$APP" "$DATA"
for f in runner.mjs grantctl SKILL.md package.json liveview.sh; do
  curl -fsSL "$PORTAL/agent/files/$f" -o "$APP/$f"
done
chmod +x "$APP/runner.mjs" "$APP/grantctl" "$APP/liveview.sh"
ln -sf "$APP/grantctl" /usr/local/bin/grantctl
( cd "$APP" && npm install --omit=dev --no-audit --no-fund --silent )
say "Installing the browser (Chromium) and its libraries"
( cd "$APP" && npx --yes playwright install --with-deps chromium >/dev/null )

if [ ! -s "$DATA/vnc_pass" ]; then
  head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 8 > "$DATA/vnc_pass"
fi
x11vnc -storepasswd "$(cat "$DATA/vnc_pass")" "$DATA/vnc_auth" >/dev/null 2>&1
chmod 600 "$DATA/vnc_pass" "$DATA/vnc_auth"

HERMES_BIN="$(command -v hermes || true)"
[ -z "$HERMES_BIN" ] && [ -x /root/.local/bin/hermes ] && HERMES_BIN=/root/.local/bin/hermes

umask 077
cat > /etc/grants-agent.env <<ENV
PORTAL_URL=$PORTAL
AGENT_TOKEN=$TOKEN
ENGINE=auto
DATA_DIR=$DATA
DISPLAY=:$DISPLAY_NUM
CDP_PORT=$CDP_PORT
NOVNC_PORT=$NOVNC_PORT
HOME=/root
PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERMES_BIN=${HERMES_BIN:-hermes}
ENV
umask 022

if [ -n "$HERMES_BIN" ]; then
  say "Hermes found ($("$HERMES_BIN" --version 2>/dev/null | head -1)): adding the form-filler skill and attaching it to the agent's browser"
  echo "   To have Hermes fill the forms, choose it under Settings > Browser agent in the portal (the built-in engine is the default)."
  mkdir -p /root/.hermes/skills/automation/form-filler
  cp "$APP/SKILL.md" /root/.hermes/skills/automation/form-filler/SKILL.md
  touch /root/.hermes/.env && chmod 600 /root/.hermes/.env
  grep -q '^BROWSER_CDP_URL=' /root/.hermes/.env && sed -i "s#^BROWSER_CDP_URL=.*#BROWSER_CDP_URL=http://127.0.0.1:$CDP_PORT#" /root/.hermes/.env \
    || echo "BROWSER_CDP_URL=http://127.0.0.1:$CDP_PORT" >> /root/.hermes/.env
  if ! grep -q '^DEEPSEEK_API_KEY=' /root/.hermes/.env; then
    # No DeepSeek key on this machine: let Hermes reach the model through the portal instead (the key stays in Cloudflare).
    echo "DEEPSEEK_API_KEY=$TOKEN" >> /root/.hermes/.env
    echo "DEEPSEEK_BASE_URL=$PORTAL/api/agent/llm/v1" >> /root/.hermes/.env
  fi
else
  echo
  echo "   Hermes was not found for root on this machine. The runner will use its built-in form-filling engine."
  echo "   If Hermes is installed for another user or path, set HERMES_BIN in /etc/grants-agent.env and restart grants-agent."
fi

say "Creating services"
unit() { cat > "/etc/systemd/system/$1.service"; }
unit grants-xvfb <<UNIT
[Unit]
Description=Grants agent virtual screen
[Service]
ExecStart=/usr/bin/Xvfb :$DISPLAY_NUM -screen 0 1366x900x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
unit grants-wm <<UNIT
[Unit]
Description=Grants agent window manager
After=grants-xvfb.service
Requires=grants-xvfb.service
[Service]
Environment=DISPLAY=:$DISPLAY_NUM
ExecStart=/usr/bin/openbox
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
unit grants-vnc <<UNIT
[Unit]
Description=Grants agent screen sharing (local only)
After=grants-xvfb.service
Requires=grants-xvfb.service
[Service]
ExecStart=/usr/bin/x11vnc -display :$DISPLAY_NUM -forever -shared -localhost -rfbport $VNC_PORT -rfbauth $DATA/vnc_auth -noxdamage -quiet
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
unit grants-novnc <<UNIT
[Unit]
Description=Grants agent live view (web, local only)
After=grants-vnc.service
[Service]
ExecStart=/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:$NOVNC_PORT 127.0.0.1:$VNC_PORT
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
unit grants-liveview <<UNIT
[Unit]
Description=Grants agent live view link (Cloudflare quick tunnel)
After=grants-novnc.service network-online.target
[Service]
EnvironmentFile=/etc/grants-agent.env
ExecStart=$APP/liveview.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
unit grants-agent <<UNIT
[Unit]
Description=Grants portal browser agent
After=grants-xvfb.service grants-wm.service network-online.target
Requires=grants-xvfb.service
[Service]
EnvironmentFile=/etc/grants-agent.env
WorkingDirectory=$APP
ExecStart=/usr/bin/env node $APP/runner.mjs
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
SERVICES="grants-xvfb grants-wm grants-vnc grants-novnc grants-agent"
command -v cloudflared >/dev/null && SERVICES="$SERVICES grants-liveview"
systemctl enable $SERVICES >/dev/null 2>&1 || true
systemctl restart $SERVICES || true

say "Checking"
sleep 8
systemctl is-active --quiet grants-agent && echo "   runner: running" || { echo "   runner: NOT running - see: journalctl -u grants-agent -n 50"; }
for i in $(seq 1 15); do [ -s "$DATA/live_view_url" ] && break; sleep 2; done
[ -s "$DATA/live_view_url" ] && echo "   live view: $(cat "$DATA/live_view_url")" || echo "   live view link not ready yet (it appears in the portal once the tunnel is up)"
echo
echo "Done. Open the portal: the Settings page should show the browser agent as Online within a minute."
echo "Logs: journalctl -u grants-agent -f"
