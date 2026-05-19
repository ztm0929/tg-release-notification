# Telegram Release Notification Bot

仅供 ztm0929 自用的 GitHub Release 通知机器人。

部署在 Cloudflare Workers 上的自动化工具，监控订阅的开源项目 release，实时推送通知到 Telegram 频道。

## 功能特性

- Serverless 部署：Cloudflare Workers + Cron 定时触发
- 自动推送：每小时检查一次订阅项目的新 release，推送到 Telegram 频道
- 智能过滤：只推送正式版，自动过滤 alpha/beta/rc/pre-release 等预发版
- 动态订阅：通过 Telegram bot 命令管理订阅列表，无需修改代码
- 去重机制：用 KV 存储已通知的 release ID，避免重复推送
- 高效缓存：利用 GitHub ETag 减少 API 请求

## 项目结构

```
src/
├── index.ts           # HTTP 路由 + Cron 触发
├── types.ts           # TypeScript 类型定义
├── telegram.ts        # Telegram bot 命令处理 + 消息推送
├── github.ts          # GitHub API 调用 + release 过滤
├── kv.ts              # KV 存储管理（订阅列表、状态）
├── cron.ts            # 定时检查 release 逻辑
└── utils.ts           # 通用工具函数
```

## 前置条件

- Cloudflare 账号（免费版即可）
- GitHub Token（用于 API 调用，可选但推荐；无 token 受 60 次/小时限制）
- Telegram Bot Token（已有）
- Telegram User ID（管理员 ID，通过 Telegram getUpdates API 或第三方 bot 获取）
- Node.js + pnpm

## 快速开始

### 1. 本地安装依赖

```bash
pnpm install
```

### 2. 登录 Cloudflare

```bash
pnpm exec -- wrangler login
```

浏览器会打开 Cloudflare 授权页面，完成登录即可。

### 3. 创建 KV 命名空间

```bash
pnpm exec -- wrangler kv namespace create tg_release_notif --binding KV --update-config
```

这会自动在 `wrangler.toml` 中添加 KV 配置。

### 4. 配置环境变量

编辑 `wrangler.toml`，修改以下配置：

```toml
[vars]
# 你的 Telegram user ID（通过 bot /whoami 命令获取）
ADMIN_USER_ID = "YOUR_USER_ID"

# 其他配置（通常无需改动）
TELEGRAM_CHANNEL_ID = "-1001774738011"
KEYWORD_BLOCKLIST = "alpha,beta,rc,pre-release"
GITHUB_API_BASE = "https://api.github.com"
```

### 5. 设置 Secrets（敏感信息）

在本地命令行交互式输入，不会明文保存：

```bash
# Telegram bot token
pnpm exec -- wrangler secret put TELEGRAM_BOT_TOKEN
# 输入你的 bot token，然后按 Ctrl+D（或 Ctrl+Z + Enter）结束

# GitHub token（用于提升 API 限额）
pnpm exec -- wrangler secret put GITHUB_TOKEN
# 输入你的 GitHub PAT

# 可选：Telegram webhook 防伪造
pnpm exec -- wrangler secret put TELEGRAM_WEBHOOK_SECRET
# 输入任意字符串作为 secret token
```

### 6. 类型检查

```bash
pnpm run typecheck
```

### 7. 部署到 Cloudflare

```bash
pnpm exec -- wrangler deploy
```

部署完成后输出 Worker 公网 URL。

### 8. 配置 Telegram Webhook

使用 curl 向 Telegram Bot API 注册 webhook（替换 `<BOT_TOKEN>` 和 `<WORKER_URL>`）：

```bash
curl -X POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<your-worker-domain>/telegram"}'
```

验证 webhook 配置：

```bash
curl https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

应看到返回的 `url` 字段指向 Worker 地址。

### 9. 同步命令列表

部署后，调用 `/admin/sync-commands` 端点将命令列表注册到 Telegram（替换 `<BOT_TOKEN>` 和 `<WORKER_URL>`）：

```bash
curl -X POST https://<your-worker-domain>/admin/sync-commands \
  -H "Authorization: Bearer <BOT_TOKEN>"
```

成功时返回：

```json
{"ok": true, "message": "Commands synchronized successfully"}
```

## 使用说明

部署成功后，在 Telegram 私聊机器人（`@ztm0929_bot`）可执行以下命令：

### /help 或 /start

显示所有可用命令。

### /list

显示所有已订阅的仓库列表。

### /add owner/repo

添加订阅。支持的格式：
- `owner/repo`
- `https://github.com/owner/repo`
- `https://github.com/owner/repo.git`

添加订阅时，bot 会在管理员私聊中静音补发最近一条正式版 release（如果存在），后续每小时检查新版本并静音推送到 Telegram 频道。

示例：

```
/add clash-verge-rev/clash-verge-rev
/add https://github.com/openclaw/openclaw
```

### /remove owner/repo

移除订阅，同时清除该仓库的状态记录。

## 工作流程

1. Telegram Webhook (POST /telegram)
   - 处理 /add /remove /list 命令
   - 更新 KV 存储中的订阅列表

2. Cloudflare Cron（每小时）
   - 遍历所有订阅
   - 调用 GitHub API 拉取 releases
   - 过滤：draft=false、prerelease=false、标题不包含 alpha/beta/rc/pre-release
   - 检查 KV 去重：是否已推送过该 release
   - 若为新 release，推送到 Telegram 频道并更新状态

## GitHub API 限额

- **无 Token**：60 次/小时（匿名请求）
- **有 Token**：5000 次/小时（认证请求）

本项目按 5 个并发查询 GitHub，每个仓库 1 次请求。如果订阅超过 100 个仓库，建议调整 `cron.ts` 中的并发数。

## 存储结构（KV）

### `subs:v1`（订阅列表）

```json
["owner/repo1", "owner/repo2", ...]
```

### `state:v1:<owner/repo>`（去重状态）

```
<release_id>
```

例如：`state:v1:clash-verge-rev/clash-verge-rev` → `123456789`

### `etag:v1:<owner/repo>`（GitHub ETag 缓存）

```
"W/\"abcdef123456\""
```

用于 GitHub API 的 304 Not Modified 优化。

## 故障排查

### Webhook 设置失败

检查项：
- Bot token 是否正确
- Worker URL 是否正确（必须是 `https://`）
- Telegram getWebhookInfo 是否显示正确的 URL

### 推送时出错 "Telegram sendMessage failed"

检查项：
- `TELEGRAM_BOT_TOKEN` 是否正确
- `TELEGRAM_CHANNEL_ID` 是否正确（必须是 `-1001774738011`）
- Bot 是否在频道中并有发送消息权限

### GitHub API 返回 401

检查项：
- `GITHUB_TOKEN` 是否正确
- Token 是否过期或被撤销

### Cron 没有执行

检查项：
- 在 Cloudflare Dashboard > Workers > Triggers 中查看 Cron 触发记录
- 确认 wrangler.toml 的 `crons = ["0 * * * *"]` 配置正确

### 查看 Worker 日志

```bash
pnpm exec -- wrangler tail
```

实时查看 Worker 执行日志。

## 开发与测试

### 本地开发

```bash
pnpm exec -- wrangler dev
```

启动本地 Worker，监听 `http://localhost:8787`。

测试 Telegram webhook：

```bash
curl -X POST http://localhost:8787/telegram \
  -H "Content-Type: application/json" \
  -d '{"update_id": 1, "message": {"message_id": 1, "date": 1234567890, "text": "/list", "chat": {"id": 123456789, "type": "private"}, "from": {"id": 123456789}}}'
```

测试健康检查：

```bash
curl http://localhost:8787/health
```

### 类型检查

```bash
pnpm run typecheck
```

## 常见配置修改

### 修改过滤关键词

编辑 `wrangler.toml`：

```toml
KEYWORD_BLOCKLIST = "alpha,beta,rc,pre-release,dev,nightly"
```

### 修改 Cron 检查频率

编辑 `wrangler.toml`：

```toml
crons = ["0 */6 * * *"]  # 每 6 小时一次
```

参考 [Cron 表达式](https://crontab.guru/)。

### 修改并发数

编辑 `src/cron.ts`，调整 `mapWithConcurrency` 的第二个参数：

```typescript
await mapWithConcurrency(subs, 10, async (fullName) => {
  // ...
});
```

## 许可证

仅供 ztm0929 自用，不作为模板分发。

## 参考资源

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Cloudflare KV 文档](https://developers.cloudflare.com/kv/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [GitHub REST API](https://docs.github.com/en/rest)
