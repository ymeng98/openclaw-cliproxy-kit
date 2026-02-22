#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

ROOT_DIR="${ROOT_DIR:-$PWD}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/openclaw-cliproxy-kit}"
AUTH_SOURCE_DIR="${AUTH_SOURCE_DIR:-$ROOT_DIR/auths}"
BINARY_SOURCE="${BINARY_SOURCE:-$ROOT_DIR/cliproxyapi-linux-amd64}"

CLIPROXY_PORT="${CLIPROXY_PORT:-15900}"
CLIPROXY_API_KEY="${CLIPROXY_API_KEY:-}"

ENABLE_NGINX="${ENABLE_NGINX:-1}"
DOMAIN="${DOMAIN:-}"
ENABLE_TLS="${ENABLE_TLS:-0}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

RUN_USER="${RUN_USER:-${SUDO_USER:-ubuntu}}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing command: $cmd" >&2
    exit 1
  fi
}

random_api_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v shasum >/dev/null 2>&1; then
    date +%s | shasum -a 256 | awk '{print $1}'
  else
    date +%s | awk '{print $1 "server-fallback"}'
  fi
}

run_as_root() {
  if [[ -n "$SUDO" ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

if [[ -z "$CLIPROXY_API_KEY" ]]; then
  CLIPROXY_API_KEY="$(random_api_key)"
fi

if [[ ! -f "$BINARY_SOURCE" ]]; then
  echo "missing binary: $BINARY_SOURCE" >&2
  exit 1
fi
if [[ ! -f "$AUTH_SOURCE_DIR/codex-acc1.json" ]]; then
  echo "missing auth: $AUTH_SOURCE_DIR/codex-acc1.json" >&2
  exit 1
fi
if [[ ! -f "$AUTH_SOURCE_DIR/codex-acc2.json" ]]; then
  echo "missing auth: $AUTH_SOURCE_DIR/codex-acc2.json" >&2
  exit 1
fi

echo "[1/8] install packages"
run_as_root apt-get update -y
run_as_root apt-get install -y ca-certificates curl jq
if [[ "$ENABLE_NGINX" == "1" ]]; then
  run_as_root apt-get install -y nginx
fi
if [[ "$ENABLE_TLS" == "1" ]]; then
  run_as_root apt-get install -y certbot python3-certbot-nginx
fi

echo "[2/8] prepare directories"
run_as_root mkdir -p "$REMOTE_ROOT/auths" "$REMOTE_ROOT/logs"

echo "[3/8] install cliproxyapi binary"
run_as_root install -m 0755 "$BINARY_SOURCE" /usr/local/bin/cliproxyapi

echo "[4/8] install auth files"
run_as_root install -m 0600 "$AUTH_SOURCE_DIR/codex-acc1.json" "$REMOTE_ROOT/auths/codex-acc1.json"
run_as_root install -m 0600 "$AUTH_SOURCE_DIR/codex-acc2.json" "$REMOTE_ROOT/auths/codex-acc2.json"

echo "[5/8] write config"
TMP_CONFIG="$(mktemp)"
cat > "$TMP_CONFIG" <<CFG
host: "127.0.0.1"
port: $CLIPROXY_PORT
auth-dir: "$REMOTE_ROOT/auths"
api-keys:
  - "$CLIPROXY_API_KEY"
routing:
  strategy: "round-robin"
quota-exceeded:
  switch-project: true
  switch-preview-model: true
request-retry: 3
max-retry-interval: 30
debug: false
CFG
run_as_root install -m 0600 "$TMP_CONFIG" "$REMOTE_ROOT/config.yaml"
rm -f "$TMP_CONFIG"

echo "[6/8] configure systemd"
TMP_SERVICE="$(mktemp)"
cat > "$TMP_SERVICE" <<UNIT
[Unit]
Description=CLIProxyAPI Service
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REMOTE_ROOT
ExecStart=/usr/local/bin/cliproxyapi -config $REMOTE_ROOT/config.yaml
Restart=always
RestartSec=2
StandardOutput=append:$REMOTE_ROOT/logs/cliproxyapi.log
StandardError=append:$REMOTE_ROOT/logs/cliproxyapi.err.log

[Install]
WantedBy=multi-user.target
UNIT
run_as_root install -m 0644 "$TMP_SERVICE" /etc/systemd/system/cliproxyapi.service
rm -f "$TMP_SERVICE"
run_as_root chown -R "$RUN_USER":"$RUN_USER" "$REMOTE_ROOT"
run_as_root systemctl daemon-reload
run_as_root systemctl enable --now cliproxyapi

echo "[7/8] optional nginx"
if [[ "$ENABLE_NGINX" == "1" ]]; then
  SERVER_NAME="_"
  if [[ -n "$DOMAIN" ]]; then
    SERVER_NAME="$DOMAIN"
  fi

  TMP_NGINX="$(mktemp)"
  cat > "$TMP_NGINX" <<NGX
server {
    listen 80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:$CLIPROXY_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGX

  run_as_root install -m 0644 "$TMP_NGINX" /etc/nginx/sites-available/cliproxyapi.conf
  rm -f "$TMP_NGINX"
  run_as_root ln -sf /etc/nginx/sites-available/cliproxyapi.conf /etc/nginx/sites-enabled/cliproxyapi.conf
  if [[ -f /etc/nginx/sites-enabled/default ]]; then
    run_as_root rm -f /etc/nginx/sites-enabled/default
  fi
  run_as_root nginx -t
  run_as_root systemctl reload nginx

  if [[ "$ENABLE_TLS" == "1" ]]; then
    if [[ -z "$DOMAIN" || -z "$CERTBOT_EMAIL" ]]; then
      echo "skip certbot: DOMAIN or CERTBOT_EMAIL missing"
    else
      run_as_root certbot --nginx -d "$DOMAIN" -m "$CERTBOT_EMAIL" --agree-tos --non-interactive --redirect
    fi
  fi
fi

echo "[8/8] verify"
run_as_root systemctl --no-pager --full status cliproxyapi | sed -n '1,18p'
run_as_root ss -lntp | grep -E ":(${CLIPROXY_PORT}|80|443)" || true

echo ""
echo "Tencent deployment complete"
echo "Service root: $REMOTE_ROOT"
echo "Local proxy: 127.0.0.1:$CLIPROXY_PORT"
if [[ -n "$DOMAIN" ]]; then
  if [[ "$ENABLE_TLS" == "1" ]]; then
    echo "Public API: https://$DOMAIN/v1"
  else
    echo "Public API: http://$DOMAIN/v1"
  fi
fi
echo "API Key: $CLIPROXY_API_KEY"
