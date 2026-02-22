#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${BASE_DIR:-$SCRIPT_DIR}"
AUTH_DIR="${AUTH_DIR:-$BASE_DIR/auths}"

ACC1_HOME="${CODEX_ACC1_HOME:-$HOME/.codex-acc1}"
ACC2_HOME="${CODEX_ACC2_HOME:-$HOME/.codex-acc2}"

SRC1="${CODEX_ACC1_AUTH:-$ACC1_HOME/auth.json}"
SRC2="${CODEX_ACC2_AUTH:-$ACC2_HOME/auth.json}"
DST1="$AUTH_DIR/codex-acc1.json"
DST2="$AUTH_DIR/codex-acc2.json"

mkdir -p "$AUTH_DIR"

convert() {
  local src="$1"
  local dst="$2"

  if [[ ! -f "$src" ]]; then
    echo "missing source: $src" >&2
    return 1
  fi

  jq -r '{
    id_token:.tokens.id_token,
    access_token:.tokens.access_token,
    refresh_token:.tokens.refresh_token,
    account_id:.tokens.account_id,
    last_refresh:.last_refresh,
    email:(.tokens.id_token
      | split(".")[1]
      | gsub("-";"+")
      | gsub("_";"/")
      | . + (if (length%4)==2 then "==" elif (length%4)==3 then "=" else "" end)
      | @base64d
      | fromjson
      | .email // ""
    ),
    type:"codex"
  }' "$src" > "$dst"

  chmod 600 "$dst"
}

convert "$SRC1" "$DST1"
convert "$SRC2" "$DST2"

echo "synced: $DST1"
echo "synced: $DST2"
