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

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 准备配置

```bash
cp config.example.yaml config.yaml
mkdir -p auths
chmod 700 auths
```

3. 登录两个 Codex 账号（示例）

```bash
CODEX_HOME=~/.codex-acc1 codex login
CODEX_HOME=~/.codex-acc2 codex login
```

4. 同步账号会话到 `auths/`

```bash
bash sync_codex_auths.sh
```

5. 启动 Dashboard

```bash
npm run start
```

6. 打开页面

- `http://127.0.0.1:8328`

## 环境变量

默认值见 `.env.example`。最常用的是：

- `DASHBOARD_PORT`
- `CLIPROXY_BASE_URL`
- `CLIPROXY_PORT`
- `CLIPROXY_SERVICE_NAME`
- `SERVICE_MANAGER` (`brew` / `systemd`)

## 安全注意事项

- 不要把以下文件提交到 Git：
  - `auths/*.json`
  - `config.yaml`
  - 任意日志文件
- 脚本和页面已做脱敏展示，但仓库中仍应只保存示例配置。

## 腾讯云部署要点（摘要）

- `cliproxyapi` 监听 `127.0.0.1:15900`
- Nginx 对外提供 `https://api.<your-domain>/v1`
- DNS 增加 `api` A 记录到服务器公网 IP
- `certbot --nginx -d api.<your-domain>` 申请证书
