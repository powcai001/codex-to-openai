# codex-to-openai

将第三方 Codex（尤其是 `wire_api = "responses"`）接口转换为 OpenAI 标准接口。

当前支持：
- `POST /v1/chat/completions`
- `POST /chat/completions`
- `POST /v1/responses`
- `POST /responses`
- `GET /healthz`

## 典型场景

你的上游配置类似：
- `base_url = "https://rawchat.cn/codex"`
- `wire_api = "responses"`

本项目会把它包装成 OpenAI 常见调用方式（`/v1/chat/completions`）。

## 快速开始

```bash
cp .env.example .env
# 编辑 .env 后启动
node src/server.js
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
node src/server.js
```

## 环境变量

必填：
- `OPENCLAW_API_BASE_URL` 例如 `https://rawchat.cn/codex`
- `OPENCLAW_WIRE_API`：`responses` 或 `chat_completions`
- `OPENCLAW_AUTH_MODE`：`bearer` 或 `cookie`

认证二选一：
- `OPENCLAW_ACCESS_TOKEN`（bearer 模式）
- `OPENCLAW_COOKIE`（cookie 模式）

可选：
- `OPENCLAW_RESPONSES_PATH`（默认 `/responses`）
- `OPENCLAW_CHAT_PATH`（默认 `/chat/completions`）
- `OPENAI_PROXY_API_KEY`（给你的代理再加一层鉴权）

## 调用示例

### chat/completions（非流式）

```bash
curl -sS -X POST "http://127.0.0.1:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.3-codex","messages":[{"role":"user","content":"只回复 OK"}]}'
```

### chat/completions（流式）

```bash
curl -N -sS -X POST "http://127.0.0.1:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.3-codex","stream":true,"messages":[{"role":"user","content":"只回复 STREAM_OK"}]}'
```

## 安全建议

- 不要提交 `.env`、token、cookie 到 GitHub。
- 发现密钥泄露请立即轮换。
- 生产环境建议设置 `OPENAI_PROXY_API_KEY`。

## 免责声明

请确保你的使用符合上游服务的条款与合规要求。
