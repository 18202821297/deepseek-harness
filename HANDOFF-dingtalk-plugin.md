# DSH 钉钉插件 — 交接文档（2026-08-20，API 中断点）

> 给重新开对话的 agent 的完整上下文。工作目录：`/Users/mac/Documents/脚本/deepseek-harness/`
>
> ✅ **2026-08-20：agent「无回复」已解决并实测通过，插件完整可用。** 详见 §3 与插件级文档 `packages/dingtalk/AGENTS.md`（新 agent 开工先读）。

## 1. 项目全貌与用户目标

**用户目标**：DSH 插件 = 钉钉 webhook 推送 + 钉钉机器人（Stream 对话），都支持多通道配置。

- **webhook 通道** = 群自定义机器人推送（✅ 已完整实现 + 实测）
- **钉钉机器人（Stream）** = 群里 @机器人 → DSH agent 对话 → 回复回群（✅ 已完整实现 + 实测：单条 + 多轮上下文，2026-08-20 修复「无回复」）

**开发方法**（用户强调）：
- 一次最多 3 个小任务，每步用户验证通过再继续
- 代码 bug 不要写进 skill；skill（`~/.dsh/skills/dsh-plugin-dev-test/`）只记录 DSH 插件开发流程规则
- 用户凭据：Client ID `dings6ononu21t3m4yem`，Client Secret（用户自填，已存在 ~/.dsh/storages/channels.json 加密存储）

## 2. 已完成（全部验证通过）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 架构 | Host/Client 双包拆分（`packages/dingtalk/dingtalk-host/` + `packages/client/ui-wh-im-channels/`） | ✅ |
| 配置 | webhook 通道（webhookUrl + secret 加签）+ app 通道（clientId + 加密 clientSecret + agentPreset）多通道 CRUD | ✅ |
| 持久化 | storage-domain JSON 落盘（`$DSH_HOME/storages/channels.json`），AES-GCM 加密 secret | ✅ |
| UI | 两个区块：webhook 配置 + 机器人配置，各自列表/添加/编辑/删除/启停/测试发送 | ✅ |
| 推送 | webhook 加签发送（HMAC-SHA256）到群，实测收到 | ✅ |
| Stream | dingtalk-stream SDK 长连接，收 @消息 + echo 回复，实测双向通 | ✅ |
| Agent 对话 | @机器人 → DSH agent 执行 → 回复回群（含多轮上下文，turn/end completed） | ✅ |
| 测试 | 27/27 全过（dingtalk 8 + send 10 + wh-im-channels 9） | ✅ |

## 3. 历史卡点（2026-08-20 已解决）

**@机器人 → agent 执行 → 曾回 `(no reply)`** —— 已定位并修复，群内实测收到正常回复。

现象（旧）：`turn/start` → `turn/end` 完整跑完，**中间无 `assistant/message`** → parts 空 → `(no reply)`。

根因（从 `~/.dsh/sessions/` 真实会话日志直接读到 `turn/end reason`）与三处修复（全在 `agent.ts`）：
1. **`prompt variable "{{model}}" has no value`** → 插件用底层 `agents.create()` 但没装 model-selection 瀑布（ApiProxy/headless 官方入口都会装）。修复：create/resume 的 `setup` 回调里 `installModelSelection(...)`，模型取 `agentDefaultModel.currentSelection()`（settings `agent-default-model`）。
2. **`session "dingtalk-<id>" ... id collision`** → 固定 sessionId 且磁盘已有持久化日志时 `create` 被拒（持久化层规定必须 resume）。修复：先查 `sessionPersistence.list()` 有无该 id，有则 `agents.resume()`、无则 `create()`。
3. **`prompt variable "{{cwd}}" has no value`** → 旧会话无 cwd（落 `_no-cwd`）。修复：create 时 `meta.cwd` 取 `workspaceRegistry.list()[0].path`（兜底 `process.cwd()`）；并清除无 cwd 的残留旧会话。

**改动文件**：`dingtalk-host/src/agent.ts`（三处修复）+ `dingtalk-host/package.json`（新增 `@deepseek-ai/dsh-agent` 运行时依赖，已 `pnpm install`）。

**验证（用户实测确认）**：第 1 条「你好」群内收到回复（LLM = modlens-ark-coding → ark-coding → deepseek-v4-flash，`turn/end reason: completed`）；第 2 条追问走 resume 路径、多轮上下文保留、正确回答。web 在 3080，Stream 常连。

> 详细 agent 驱动契约见 `packages/dingtalk/AGENTS.md`（插件级文档，新 agent 开工先读）。

## 4. 关键文件

- Host 服务：`packages/dingtalk/dingtalk-host/src/index.ts`
- agent 驱动：`packages/dingtalk/dingtalk-host/src/agent.ts`（runAgentTurn + collectReply，含调试日志）
- Stream 连接：`packages/dingtalk/dingtalk-host/src/stream.ts`
- 加密：`packages/dingtalk/dingtalk-host/src/cipher.ts`
- 发送（webhook）：`packages/dingtalk/dingtalk-host/src/send.ts`
- 数据模型：`src/types.ts` / `src/spec.ts`
- Client UI：`packages/client/ui-wh-im-channels/src/client/ImChannels.tsx`
- 测试：`packages/dingtalk/dingtalk-host/tests/*.spec.ts` + `packages/client/ui-wh-im-channels/tests/wh-im-channels.client.spec.tsx`
- **插件文档（新 agent 开工先读）**：`packages/dingtalk/AGENTS.md`（`CLAUDE.md` 软链指向它）

## 5. 关键技术结论（供继续）

1. **Agent 驱动**（正确姿势，踩坑固化）：
   ```ts
   const agents = ctx.reflect.get('agents', false)  // 可选访问，别放 static inject
   const setup = (agentCtx) => {
     const d = ctx.reflect.get('agentDefaultModel', false)  // 可选
     installModelSelection(agentCtx, { current: d?.currentSelection(), assembled: undefined })
   }
   // 固定 sessionId：磁盘已有 → resume；否则 create（create 必须带 meta.cwd）
   const persisted = (await ctx.reflect.get('sessionPersistence', false)?.list())?.find(h => h.id === sessionId)
   const handle = persisted
     ? await agents.resume({ resumeSessionId: sessionId, setup })
     : await agents.create({ sessionId, meta: { cwd, agentPreset }, setup })
   const message = createUserMessage({ content: [{type:'text',text}], source: {kind:'plugin',plugin:'dingtalk'} })
   handle.agent.followup(message)
   // 监听 ctx.on('session/event', (session,event)=>) 收 assistant/message；ctx.on 返回 stop 函数
   // turn/end 事件：{ turn, reason }，reason 是排查关键（kind: completed = 正常）
   ```
   三条硬性要求：**装 model-selection**、**固定 id 必须 resume（不能 create）**、**create 带 cwd**——缺一即 turn 报错、无 assistant 输出（详见 §3 与 AGENTS.md）。
2. **ctx 服务访问**：要访问 `ctx.xxx` 必须声明 `static inject`，否则 `cannot get property without inject`。可选能力用 `ctx.reflect.get('xxx', false)`（返回 undefined 不抛错）。
3. **Session 事件类型**：`assistant/message` 的 data 是 `{ message: { content: ContentBlock[] } }`，文本在 `type:'text'` 块的 `.text`。
4. **clientSecret 加密**：AES-256-GCM，`encryptSecret`/`decryptSecret`/`maskSecret`；Remote 只返回掩码。
5. **每次改 Host Remote 类型后**：`build:lib:host` → `pnpm --filter @deepseek-ai/dsh-api-remotes bundle` → `pnpm --filter @deepseek-ai/dsh-client-ui-wh-im-channels bundle` → 重启 web → 强刷浏览器（skill 已记）。
6. **Storage schema 变更**：旧 channels.json 会崩启动（invalid-record），开发期直接删 `~/.dsh/storages/channels.json`。

## 6. Skill 约束

`~/.dsh/skills/dsh-plugin-dev-test/SKILL.md`（git 仓库，commit 最新 `3054fbc`）：
- 只记录 DSH 插件开发流程规则（构建顺序、Remote 边界、双包拆分、storage harness、jsdom 测试、改 Remote 后重打包）
- **不记代码 bug**（用户明确要求：代码 bug 是"程序逻辑问题"，不属于开发流程规范）
- 收到 @消息的 Stream 功能完成后，若涉及流程知识再补

## 7. 重启 web 的命令

```sh
cd /Users/mac/Documents/脚本/deepseek-harness
pnpm run build:lib:host
PID=$(lsof -nP -iTCP:3080 -sTCP:LISTEN -t); [ -n "$PID" ] && kill $PID
(pnpm dsh web > /tmp/dsh-web.log 2>&1 &)
# 日志在 /tmp/dsh-web.log，Stream 连接成功会有 "connect success"
```

## 8. 用户验证路径

- 浏览器：`http://127.0.0.1:3080` → 设置 → 插件 → 钉钉通道（✅ 已验证）
- 钉钉群：@机器人 → 触发 agent → 回复回群（✅ 已验证：单条 + 多轮上下文）
- webhook 通道发消息也仍可用（推送，✅ 已验证）
