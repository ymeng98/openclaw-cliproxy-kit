# CLIProxyAPI + OpenClaw 号池管理面板

本项目用于把本地 `codex` 多账号会话接入 `CLIProxyAPI`，并提供一个前端运维面板来管理账号、模型、服务和日志。

## 功能

- 双账号会话同步：`sync_codex_auths.sh`
- 本地代理健康检查：服务状态、端口监听、模型可用性
- 账号会话可视化：邮箱、account_id（脱敏）、token 存在性
- 一键运维：`start / stop / restart / sync`
- 配置与日志快照（自动脱敏 `api-keys` / token 字段）

## 目录

- `server.js`: Dashboard 后端 API
- `web/`: 前端页面
- `sync_codex_auths.sh`: 把 Codex `auth.json` 转成 CLIProxyAPI auth 文件
- `config.example.yaml`: CLIProxyAPI 示例配置
- `.env.example`: Dashboard 环境变量示例
- `scripts/oneclick-local.sh`: 本地一键部署
- `scripts/oneclick-tencent-remote.sh`: 本地发起腾讯云一键部署
- `scripts/oneclick-tencent-server.sh`: 腾讯云服务器端安装脚本（由 remote 脚本调用）

## 一键部署（本地）

1. 准备两个 Codex 账号会话

```bash
CODEX_HOME=~/.codex-acc1 codex login
CODEX_HOME=~/.codex-acc2 codex login
```

2. 一键部署并启动（会自动同步 auth、写 config、拉依赖、启动 proxy + dashboard）

```bash
bash scripts/oneclick-local.sh
```

3. 打开页面：`http://127.0.0.1:8328`

## 环境变量

默认值见 `.env.example`。最常用的是：

- `DASHBOARD_PORT`
- `CLIPROXY_BASE_URL`
- `CLIPROXY_PORT`
- `CLIPROXY_SERVICE_NAME`
- `SERVICE_MANAGER` (`brew` / `systemd`)

本地一键脚本常用覆盖项：

- `CODEX_ACC1_HOME` / `CODEX_ACC2_HOME`
- `CLIPROXY_PORT`
- `DASHBOARD_PORT`
- `CLIPROXY_API_KEY`

示例：

```bash
CLIPROXY_PORT=18317 DASHBOARD_PORT=18328 bash scripts/oneclick-local.sh
```

## 安全注意事项

- 不要把以下文件提交到 Git：
  - `auths/*.json`
  - `config.yaml`
  - 任意日志文件
- 脚本和页面已做脱敏展示，但仓库中仍应只保存示例配置。

## 一键部署（腾讯云）

在本地执行（会自动打包二进制 + auth，并远程安装 systemd + nginx）：

```bash
REMOTE_HOST=81.70.32.11 \
REMOTE_USER=ubuntu \
DOMAIN=api.yuchenxu.cn \
ENABLE_TLS=1 \
CERTBOT_EMAIL=you@example.com \
bash scripts/oneclick-tencent-remote.sh
```

可选参数：

- `SSH_KEY_PATH=~/.ssh/your-key`
- `REMOTE_PORT=22`
- `REMOTE_ROOT=/opt/openclaw-cliproxy-kit`
- `CLIPROXY_PORT=15900`
- `CLIPROXY_API_KEY=<your-key>`
- `ENABLE_NGINX=1`
- `RUN_USER=ubuntu`

部署完成后：

- 内网代理：`127.0.0.1:<CLIPROXY_PORT>`
- 域名 API：`https://<DOMAIN>/v1`（开启 TLS 时）

## 复盘问题（已修）

- `Telegram getUpdates conflict (409)`：同一个 bot token 被多个进程同时 long polling。
- `Missing config`：独立 bot 网关目录缺少 `clawdbot.json`。
- `Invalid allowFrom entry`：`allowFrom/groupAllowFrom` 使用了用户名，必须使用数字 Telegram sender ID。

推荐做法：

- 只保留一个 Telegram polling 实例（统一主网关托管）。
- 不再单独启动 deepseek/glm 的独立 gateway。
- 把 `allowFrom/groupAllowFrom` 改成数字 ID，或直接移除错误项。
