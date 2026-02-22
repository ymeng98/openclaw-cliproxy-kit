# One-Click Deployment Guide

## Local

```bash
bash scripts/oneclick-local.sh
```

Override example:

```bash
CODEX_ACC1_HOME="$HOME/.codex-acc1" \
CODEX_ACC2_HOME="$HOME/.codex-acc2" \
CLIPROXY_PORT=18317 \
DASHBOARD_PORT=18328 \
bash scripts/oneclick-local.sh
```

## Tencent Cloud (from local)

```bash
REMOTE_HOST="81.70.32.11" \
REMOTE_USER="ubuntu" \
SSH_KEY_PATH="$HOME/.ssh/id_rsa" \
DOMAIN="api.yuchenxu.cn" \
ENABLE_TLS=1 \
CERTBOT_EMAIL="you@example.com" \
bash scripts/oneclick-tencent-remote.sh
```

## Tencent Cloud (directly on server)

```bash
CLIPROXY_API_KEY="replace-with-strong-key" \
CLIPROXY_PORT=15900 \
DOMAIN="api.your-domain.com" \
ENABLE_NGINX=1 \
ENABLE_TLS=1 \
CERTBOT_EMAIL="you@example.com" \
bash scripts/oneclick-tencent-server.sh
```

## Verify

```bash
curl -sS http://127.0.0.1:8328/api/health
curl -sS https://api.your-domain.com/v1/models -H "Authorization: Bearer <api-key>"
```

## Troubleshooting

- `409 Conflict: terminated by other getUpdates request`
  - Cause: same bot token is being polled by more than one process.
  - Fix: keep only one polling gateway process.

- `Missing config. Run clawdbot setup...`
  - Cause: standalone bot gateway has no `clawdbot.json`.
  - Fix: use unified main gateway or initialize standalone config first.

- `Invalid allowFrom entry`
  - Cause: non-numeric Telegram sender in `allowFrom/groupAllowFrom`.
  - Fix: use numeric Telegram user IDs only.
