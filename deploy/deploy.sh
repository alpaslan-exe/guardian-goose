#!/usr/bin/env bash
# Deploy the anti-spam bot to `personal_vps` via sshkit (keychain auth, no plaintext creds).
# Isolated Node 22 (nvm) so the host's stock node18 and other services stay untouched.
set -euo pipefail

ALIAS="personal_vps"
REMOTE_DIR="/opt/antispam"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RUN() { sshkit agent-exec "$ALIAS" bash -lc "$1"; }

echo "== 1. install nvm + Node 22 (idempotent) =="
RUN 'export NVM_DIR=$HOME/.nvm; [ -d "$NVM_DIR" ] || { curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; }; . "$NVM_DIR/nvm.sh"; nvm install 22 >/dev/null; nvm alias default 22 >/dev/null; node -v'

NODE_BIN="$(RUN 'export NVM_DIR=$HOME/.nvm; . "$NVM_DIR/nvm.sh"; nvm which 22' | tr -d "\r")"
echo "   node: $NODE_BIN"

echo "== 2. push source (tar over agent-exec; excludes secrets/state) =="
B64="$(cd "$HERE" && tar czf - src config.example.js package.json deploy | base64 | tr -d '\n')"
RUN "mkdir -p $REMOTE_DIR && printf %s '$B64' | base64 -d | tar xz -C $REMOTE_DIR"

echo "== 3. config.js (only if absent — never clobber a live config) =="
RUN "cd $REMOTE_DIR && [ -f config.js ] || cp config.example.js config.js"

echo "== 4. npm install (production) =="
RUN "cd $REMOTE_DIR && $(dirname "$NODE_BIN")/npm install --omit=dev --no-audit --no-fund"

echo "== 5. install + enable systemd unit =="
RUN "sed 's#__NODE__#$NODE_BIN#' $REMOTE_DIR/deploy/antispam.service > /etc/systemd/system/antispam.service && systemctl daemon-reload && systemctl enable antispam"

echo
echo "Done. FIRST RUN NEEDS QR PAIRING (one time, interactive):"
echo "  sshkit exec-tty $ALIAS bash -lc 'cd $REMOTE_DIR && $NODE_BIN src/index.js'"
echo "  -> scan the QR with the BURNER phone's WhatsApp (Linked Devices), then Ctrl-C."
echo "Then start the persistent service:"
echo "  sshkit agent-exec $ALIAS bash -lc 'systemctl start antispam && systemctl status antispam --no-pager'"
