#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REMOTE_HOST="${REMOTE_HOST:-}"
REMOTE_USER="${REMOTE_USER:-ubuntu}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/openclaw-cliproxy-kit}"
REMOTE_TMP="${REMOTE_TMP:-/tmp/openclaw-cliproxy-deploy}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"

CODEX_ACC1_HOME="${CODEX_ACC1_HOME:-$HOME/.codex-acc1}"
CODEX_ACC2_HOME="${CODEX_ACC2_HOME:-$HOME/.codex-acc2}"

CLIPROXY_PORT="${CLIPROXY_PORT:-15900}"
CLIPROXY_API_KEY="${CLIPROXY_API_KEY:-}"
ENABLE_NGINX="${ENABLE_NGINX:-1}"
DOMAIN="${DOMAIN:-}"
ENABLE_TLS="${ENABLE_TLS:-0}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
RUN_USER="${RUN_USER:-$REMOTE_USER}"

if [[ -z "$REMOTE_HOST" ]]; then
  echo "REMOTE_HOST is required" >&2
  exit 1
fi

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
    date +%s | awk '{print $1 "remote-fallback"}'
  fi
}

require_cmd bash
require_cmd jq
require_cmd scp
require_cmd ssh

if [[ ! -f "$ROOT_DIR/cliproxyapi-linux-amd64" ]]; then
  echo "missing $ROOT_DIR/cliproxyapi-linux-amd64" >&2
  exit 1
fi
if [[ ! -f "$CODEX_ACC1_HOME/auth.json" ]]; then
  echo "missing $CODEX_ACC1_HOME/auth.json" >&2
  exit 1
fi
if [[ ! -f "$CODEX_ACC2_HOME/auth.json" ]]; then
  echo "missing $CODEX_ACC2_HOME/auth.json" >&2
  exit 1
fi

if [[ -z "$CLIPROXY_API_KEY" ]]; then
  CLIPROXY_API_KEY="$(random_api_key)"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/auths"
CODEX_ACC1_HOME="$CODEX_ACC1_HOME" CODEX_ACC2_HOME="$CODEX_ACC2_HOME" BASE_DIR="$TMP_DIR" AUTH_DIR="$TMP_DIR/auths" bash "$ROOT_DIR/sync_codex_auths.sh"
cp "$ROOT_DIR/cliproxyapi-linux-amd64" "$TMP_DIR/cliproxyapi-linux-amd64"
cp "$ROOT_DIR/scripts/oneclick-tencent-server.sh" "$TMP_DIR/oneclick-tencent-server.sh"
chmod +x "$TMP_DIR/oneclick-tencent-server.sh"

SSH_OPTS=("-p" "$REMOTE_PORT")
SCP_OPTS=("-P" "$REMOTE_PORT")
if [[ -n "$SSH_KEY_PATH" ]]; then
  SSH_OPTS+=("-i" "$SSH_KEY_PATH")
  SCP_OPTS+=("-i" "$SSH_KEY_PATH")
fi

echo "[1/4] prepare remote temp dir"
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" "rm -rf '$REMOTE_TMP' && mkdir -p '$REMOTE_TMP/auths'"

echo "[2/4] upload deployment bundle"
scp "${SCP_OPTS[@]}" "$TMP_DIR/oneclick-tencent-server.sh" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_TMP/oneclick-tencent-server.sh"
scp "${SCP_OPTS[@]}" "$TMP_DIR/cliproxyapi-linux-amd64" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_TMP/cliproxyapi-linux-amd64"
scp "${SCP_OPTS[@]}" "$TMP_DIR/auths/codex-acc1.json" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_TMP/auths/codex-acc1.json"
scp "${SCP_OPTS[@]}" "$TMP_DIR/auths/codex-acc2.json" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_TMP/auths/codex-acc2.json"

echo "[3/4] run remote installer"
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" \
  "set -euo pipefail; cd '$REMOTE_TMP'; chmod +x ./oneclick-tencent-server.sh; \
   CLIPROXY_API_KEY='$CLIPROXY_API_KEY' CLIPROXY_PORT='$CLIPROXY_PORT' REMOTE_ROOT='$REMOTE_ROOT' RUN_USER='$RUN_USER' ENABLE_NGINX='$ENABLE_NGINX' DOMAIN='$DOMAIN' ENABLE_TLS='$ENABLE_TLS' CERTBOT_EMAIL='$CERTBOT_EMAIL' ./oneclick-tencent-server.sh"

echo "[4/4] cleanup remote temp dir"
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" "rm -rf '$REMOTE_TMP'"

echo ""
echo "Remote deployment complete"
echo "Host: $REMOTE_USER@$REMOTE_HOST"
if [[ -n "$DOMAIN" ]]; then
  if [[ "$ENABLE_TLS" == "1" ]]; then
    echo "Public API: https://$DOMAIN/v1"
  else
    echo "Public API: http://$DOMAIN/v1"
  fi
fi
echo "API Key: $CLIPROXY_API_KEY"
