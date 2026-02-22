#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AUTH_DIR="${AUTH_DIR:-$ROOT_DIR/auths}"
CONFIG_PATH="${CONFIG_PATH:-$ROOT_DIR/config.yaml}"
SYNC_SCRIPT_PATH="${SYNC_SCRIPT_PATH:-$ROOT_DIR/sync_codex_auths.sh}"

CLIPROXY_HOST="${CLIPROXY_HOST:-127.0.0.1}"
CLIPROXY_PORT="${CLIPROXY_PORT:-8317}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8328}"

CODEX_ACC1_HOME="${CODEX_ACC1_HOME:-$HOME/.codex-acc1}"
CODEX_ACC2_HOME="${CODEX_ACC2_HOME:-$HOME/.codex-acc2}"

CLIPROXY_LOG_PATH="${CLIPROXY_LOG_PATH:-$ROOT_DIR/cliproxyapi.log}"
DASHBOARD_LOG_PATH="${DASHBOARD_LOG_PATH:-$ROOT_DIR/dashboard.log}"
CLIPROXY_PID_PATH="${CLIPROXY_PID_PATH:-$ROOT_DIR/cliproxyapi.pid}"
DASHBOARD_PID_PATH="${DASHBOARD_PID_PATH:-$ROOT_DIR/dashboard.pid}"

FORCE_REWRITE_CONFIG="${FORCE_REWRITE_CONFIG:-0}"
SKIP_NPM_INSTALL="${SKIP_NPM_INSTALL:-0}"

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
    date +%s | awk '{print $1 "local-fallback"}'
  fi
}

extract_api_key() {
  if [[ -f "$CONFIG_PATH" ]]; then
    awk '/^api-keys:/{getline; gsub(/^[[:space:]]*-[[:space:]]*"?|"?$/, ""); print; exit }' "$CONFIG_PATH"
  fi
}

stop_by_pid_file() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" || true
      fi
    fi
    rm -f "$pid_file"
  fi
}

write_config() {
  local api_key="$1"
  cat > "$CONFIG_PATH" <<CFG
host: "$CLIPROXY_HOST"
port: $CLIPROXY_PORT
auth-dir: "$AUTH_DIR"
api-keys:
  - "$api_key"
routing:
  strategy: "round-robin"
quota-exceeded:
  switch-project: true
  switch-preview-model: true
request-retry: 3
max-retry-interval: 30
debug: false
CFG
  chmod 600 "$CONFIG_PATH"
}

echo "[1/7] preflight"
require_cmd jq
require_cmd node
require_cmd npm
require_cmd codex
require_cmd cliproxyapi
require_cmd curl

if [[ ! -f "$CODEX_ACC1_HOME/auth.json" ]]; then
  echo "missing $CODEX_ACC1_HOME/auth.json" >&2
  exit 1
fi
if [[ ! -f "$CODEX_ACC2_HOME/auth.json" ]]; then
  echo "missing $CODEX_ACC2_HOME/auth.json" >&2
  exit 1
fi

echo "[2/7] sync codex auths"
mkdir -p "$AUTH_DIR"
CODEX_ACC1_HOME="$CODEX_ACC1_HOME" CODEX_ACC2_HOME="$CODEX_ACC2_HOME" BASE_DIR="$ROOT_DIR" AUTH_DIR="$AUTH_DIR" bash "$SYNC_SCRIPT_PATH"

echo "[3/7] prepare config"
API_KEY="${CLIPROXY_API_KEY:-$(extract_api_key)}"
if [[ -z "$API_KEY" ]]; then
  API_KEY="$(random_api_key)"
fi
if [[ "$FORCE_REWRITE_CONFIG" == "1" || ! -f "$CONFIG_PATH" ]]; then
  write_config "$API_KEY"
fi

echo "[4/7] install dependencies"
if [[ "$SKIP_NPM_INSTALL" != "1" ]]; then
  (cd "$ROOT_DIR" && npm install)
fi

echo "[5/7] restart cliproxyapi"
stop_by_pid_file "$CLIPROXY_PID_PATH"
nohup cliproxyapi -config "$CONFIG_PATH" > "$CLIPROXY_LOG_PATH" 2>&1 &
echo $! > "$CLIPROXY_PID_PATH"
sleep 2
if ! kill -0 "$(cat "$CLIPROXY_PID_PATH")" 2>/dev/null; then
  echo "cliproxyapi failed to start" >&2
  tail -n 80 "$CLIPROXY_LOG_PATH" >&2 || true
  exit 1
fi

echo "[6/7] restart dashboard"
stop_by_pid_file "$DASHBOARD_PID_PATH"
nohup env \
  APP_ROOT="$ROOT_DIR" \
  DASHBOARD_PORT="$DASHBOARD_PORT" \
  CLIPROXY_BASE_URL="http://$CLIPROXY_HOST:$CLIPROXY_PORT" \
  LOCAL_CONFIG_PATH="$CONFIG_PATH" \
  LOCAL_LOG_PATH="$CLIPROXY_LOG_PATH" \
  node "$ROOT_DIR/server.js" > "$DASHBOARD_LOG_PATH" 2>&1 &
echo $! > "$DASHBOARD_PID_PATH"
sleep 2
if ! kill -0 "$(cat "$DASHBOARD_PID_PATH")" 2>/dev/null; then
  echo "dashboard failed to start" >&2
  tail -n 80 "$DASHBOARD_LOG_PATH" >&2 || true
  exit 1
fi

echo "[7/7] health check"
HEALTH_URL="http://127.0.0.1:${DASHBOARD_PORT}/api/health"
if ! curl -fsS "$HEALTH_URL" >/dev/null; then
  echo "dashboard health check failed: $HEALTH_URL" >&2
  exit 1
fi

echo ""
echo "Local deployment complete"
echo "Dashboard: http://127.0.0.1:${DASHBOARD_PORT}"
echo "Proxy:     http://${CLIPROXY_HOST}:${CLIPROXY_PORT}/v1"
echo "API Key:   ${API_KEY}"
echo ""
echo "Quick test:"
echo "curl -sS http://${CLIPROXY_HOST}:${CLIPROXY_PORT}/v1/models -H \"Authorization: Bearer ${API_KEY}\""
