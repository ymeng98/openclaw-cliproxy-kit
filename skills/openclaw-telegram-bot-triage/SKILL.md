---
name: openclaw-telegram-bot-triage
description: Diagnose and fix OpenClaw or ClawDBot Telegram no-reply incidents, especially getUpdates 409 conflict, missing bot config, and invalid allowFrom/groupAllowFrom entries. Use when users report "机器人不回", "getUpdates conflict", "Missing config", or multi-bot polling issues.
---

# OpenClaw Telegram Bot Triage

## Goal

Restore Telegram bot replies with minimum downtime and no token leakage.

## Fast Workflow

1. Check launch status:

```bash
uid=$(id -u)
launchctl list | rg 'openclaw|clawdbot|deepseek|glm'
launchctl print gui/$uid/ai.openclaw.gateway | sed -n '1,120p'
```

2. Check key logs:

```bash
tail -n 120 ~/.openclaw/logs/gateway.err.log
tail -n 220 /tmp/openclaw/openclaw-$(date +%F).log
```

3. Apply fixes by symptom:

- `409 Conflict: terminated by other getUpdates request`
  - Keep only one polling process per bot token.
  - Stop duplicate standalone agents:

```bash
uid=$(id -u)
launchctl bootout gui/$uid/com.clawdbot-deepseek.gateway || true
launchctl bootout gui/$uid/com.clawdbot-glm.gateway || true
```

- `Missing config. Run clawdbot setup...`
  - Standalone gateway lacks `clawdbot.json`.
  - Either initialize config for standalone mode or retire standalone and route through main OpenClaw gateway.

- `Invalid allowFrom/groupAllowFrom`
  - Telegram auth allowlists require numeric sender IDs.
  - Remove usernames like `yuchenxu_clawdbot` and reload gateway.

4. Re-verify:

```bash
launchctl list | rg 'openclaw|clawdbot|deepseek|glm'
rg -n 'getUpdates conflict|Invalid allowFrom|Missing config' /tmp/openclaw/openclaw-$(date +%F).log | tail
```

## Safety

- Never output full bot token/API key in logs or chat.
- Keep `cliproxyapi` behind localhost + reverse proxy.
- Prefer main gateway unified account routing to avoid polling races.
