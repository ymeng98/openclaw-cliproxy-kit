# OpenClaw + Codex + CLIProxyAPI 域名化部署 Runbook

## 目标

- 本地 OpenClaw 统一走：`OPENAI_BASE_URL=https://api.<domain>/v1`
- 远端 `cliproxyapi` 不暴露公网端口，仅监听本机
- 通过 Nginx + TLS 对外提供稳定 API

## 分层检查

1. DNS
- `dig +short api.<domain> A`

2. 端口
- 本地：`nc -vz <public-ip> 443`
- 远端：`ss -lntp | grep -E ":(443|15900)"`

3. 服务
- `systemctl is-active cliproxyapi`
- `systemctl is-active nginx`

4. 接口
- 未授权：`curl -i https://api.<domain>/v1/models` -> 401
- 授权：`curl -H "Authorization: Bearer <key>" https://api.<domain>/v1/models`

## 标准步骤

1. CLIProxyAPI 仅本机监听

```yaml
host: "127.0.0.1"
port: 15900
```

2. Nginx 反代

```nginx
server {
  server_name api.<domain>;
  location / {
    proxy_pass http://127.0.0.1:15900;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

3. DNS 记录
- `api` -> `<public-ip>`

4. 证书

```bash
certbot --nginx -d api.<domain>
```

5. OpenClaw 永久环境
- `OPENAI_BASE_URL=https://api.<domain>/v1`
- `OPENAI_API_KEY=<cliproxy key>`

## 常见问题

- `NXDOMAIN`：DNS 未全球传播，稍后重试 certbot
- `401 Missing API key`：没带 `Authorization: Bearer ...`
- `openai-codex` 刷新失败：检查代理和网络路径
