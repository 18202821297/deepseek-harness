# AGENTS.md — DSH 钉钉插件

改这个插件前先读本文件，避免重新推导插件逻辑。DSH 插件**开发流程规则**见 skill：`~/.dsh/skills/dsh-plugin-dev-test/SKILL.md`（git 仓库，只记流程不记 bug）。完整历史交接见仓库根 `HANDOFF-dingtalk-plugin.md`。

## 插件是什么

DSH 钉钉插件 = 两类通道 + 多通道配置管理，都支持列表/增删改/启停/测试发送：

- **webhook 通道**：群自定义机器人推送（直接 POST webhookUrl，可带 HMAC-SHA256 加签 secret）。
- **app 通道（机器人 / Stream）**：钉钉 Stream 长连接收 @消息 → DSH agent 执行 → 回复回群。

配置持久化在 `$DSH_HOME/storages/channels.json`，clientSecret 用 AES-256-GCM 加密存储，Remote 只返回掩码。

## 代码位置（Host/Client 双包拆分）

- **Host**（Node 侧服务）：`packages/dingtalk/dingtalk-host/`
- **Client**（浏览器 UI）：`packages/client/ui-wh-im-channels/`
- Host 通过 Typert Remote `dingtalk` 暴露给浏览器；改 Remote 类型后必须重新打包（见「构建」）。
- Host 在 web profile 的接入点：`packages/bundle/web-app/cordis.patch.yml` 的 `dingtalk-host` 插件行；Client 同理有 `ui-wh-im-channels` 行。

## 核心文件

| 文件 | 职责 |
|---|---|
| `dingtalk-host/src/index.ts` | `DingtalkService`：Remote 方法（listChannels/saveChannel/deleteChannel/setEnabled/sendText/testChannel）+ Stream 生命周期 + 消息入口 `handleIncomingMessage` |
| `dingtalk-host/src/stream.ts` | dingtalk-stream SDK 长连接，订阅 `/v1.0/im/bot/messages/get`，解析 @消息 |
| `dingtalk-host/src/agent.ts` | `runAgentTurn`：创建/resume agent、提交用户消息、收集 assistant 文本回复（契约见下） |
| `dingtalk-host/src/send.ts` | 群消息发送：webhook 加签 POST + 机器人会话回发（sessionWebhook） |
| `dingtalk-host/src/cipher.ts` | clientSecret AES-256-GCM 加解密 + maskSecret |
| `dingtalk-host/src/spec.ts` | channels domain schema（zod discriminatedUnion） |
| `dingtalk-host/src/types.ts` | Remote 请求/响应/失败类型（纯类型，浏览器可读） |
| `client/ui-wh-im-channels/src/client/ImChannels.tsx` | 浏览器 UI：webhook 配置区块 + 机器人配置区块 |

## 数据模型

`channels` 表按 channel id 存储，记录按 `type` 判别：

- `type: 'webhook'`：`{ id, name, webhookUrl, secret, enabled, createdAt, updatedAt }`
- `type: 'app'`：`{ id, name, clientId, clientSecret(加密), agentPreset(默认 'standard'), enabled, createdAt, updatedAt }`

⚠️ 变更 schema（加字段/改判别式）会让旧 channels.json **启动即崩**（`invalid-record`）；开发期直接删 `$DSH_HOME/storages/channels.json` 再重启。

## @机器人 → agent → 回复的链路

1. `stream.ts` 收到 CALLBACK（conversationId=`cid...`，text 内容）。
2. `index.ts handleIncomingMessage`：确认 @ 命中 → 取该 app 通道的 `agentPreset` → 调 `runAgentTurn`。
3. `agent.ts runAgentTurn` 返回纯文本（契约见下）。
4. 回发到群（机器人通道用消息里的 `sessionWebhook` 回发；webhook 通道直接推）。

## agent 驱动契约（务必遵守 — 踩坑后固化的正确姿势）

1. **必须装 model-selection**：`agents.create({ sessionId, meta, setup })` 的 `setup` 回调里调 `installModelSelection(agentCtx, { current: agentDefaultModel.currentSelection(), assembled: undefined })`。不装会 `prompt variable "{{model}}" has no value` → turn 报错、无 assistant 输出。
2. **固定 sessionId 必须 resume 而非 create**：sessionId = `dingtalk-<channelId>`。持久化层规定「磁盘已有该 id 日志就必须 resume，create 会抛 `id collision`」。做法：先 `ctx.reflect.get('sessionPersistence', false)?.list()` 查有无该 id，有则 `agents.resume({ resumeSessionId, setup })`，无则 `agents.create({ sessionId, meta, setup })`。
3. **create 时 meta 必须带 cwd**：`meta: { cwd, agentPreset }`；cwd 取 `workspaceRegistry.list()[0].path`，兜底 `process.cwd()`。否则继续卡 `prompt variable "{{cwd}}" has no value`。
4. **收集回复**：`ctx.on('session/event', (session, event) => ...)` 过滤 `session.id === sessionId`，收 `assistant/message` 的 content 文本块；`turn/end` 的 `event.data.reason` 是排查关键（`kind: completed` = 正常）。
5. **可选服务一律 `ctx.reflect.get('xxx', false)`**（agents / agentDefaultModel / sessionPersistence / workspaceRegistry），别放 `static inject` 强制依赖。

## 构建与运行

```sh
cd /Users/mac/Documents/脚本/deepseek-harness
# 只改 Host 逻辑（如 agent.ts）→ 重编译 host lib：
pnpm run build:lib:host
# 改 Remote 类型后还要：
pnpm --filter @deepseek-ai/dsh-api-remotes bundle
pnpm --filter @deepseek-ai/dsh-client-ui-wh-im-channels bundle
# 重启 web：
PID=$(lsof -nP -iTCP:3080 -sTCP:LISTEN -t); [ -n "$PID" ] && kill $PID
(pnpm dsh web > /tmp/dsh-web.log 2>&1 &)
```

- 浏览器：http://127.0.0.1:3080 → 设置 → 插件 → 钉钉通道。
- 日志 `/tmp/dsh-web.log`；`[dingtalk-agent]` 前缀是 agent 调试日志；Stream 连接成功有 `connect success`。
- 验证：钉钉群 @机器人 发消息，看群内回复 + 日志 `turn/end reason`。

## 测试

- Host：`packages/dingtalk/dingtalk-host/tests/*.spec.ts`（dingtalk + send）。
- Client：`packages/client/ui-wh-im-channels/tests/wh-im-channels.client.spec.tsx`。
- 运行：仓库内 `pnpm run test`（或 `vitest` 指定文件）；当前 27 项全绿。

## 当前状态

✅ 完整可用：webhook 推送 + @机器人对话 + 多通道 CRUD。
凭据：app clientId `dings6ononu21t3m4yem`；clientSecret 与 DEEPSEEK/XINLICLOUD/ARK keys 均在 `~/.dsh/.credentials.yaml`。agent 默认模型由 `~/.dsh/settings.yaml` 的 `agent-default-model` 决定（当前 `modlens-ark-coding` / `deepseek-v4-flash`）。
