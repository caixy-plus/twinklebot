# TwinkleBot 智能体系统二期深度诊断与可执行优化计划（v2 / Phase 4–6）

> **文档性质**：基于 macOS 本机真实运行日志（`data/sessions/`、`data/exchanges/`、`data/schedules.json`、`data/route-stats.ndjson`，截至 `2026-11-27` 含 `ota-20261127.0200` 上线后实测数据）与仓库 `main` 分支（`c2d165c`）源码逐行复核输出的可执行改造规划。  
> **安全与隐私声明**：全篇严格执行零密钥、零 Token、零密码、零代理 URI / 订阅 URL / 完整 UUID / 个人邮箱 / 手机号 / 公网 IP / Chat ID / 敏感完整 URL 脱敏规范；所有改造均只针对通用框架架构与产品能力。  
> **前置基线**：Phase 1–3（`P0-1`–`P0-4`、`P1-1`–`P1-6`、`P2-1`–`P2-4`）已随 `1b671a4` / `c2d165c`（`ota-20261127.0200`）全部上线；本文档仅收录经独立源码复核**当前仍未修复**的 **18 项**问题（`6 P0 / 5 P1 / 7 P2`），**100% 支持 `ota-only` 热更新**。  
> **实施状态**：**Phase 4（`P0-1`–`P0-6`）已完成**（工作区已验证）；Phase 5 / Phase 6 待实施。

---

## 一、macOS 本机日志量化总览

### 1.1 4 个活跃 Bot 会话盘面

| Bot 名称（ID 前缀） | 角色与权限 | `rolePrompt` | 记忆（条 / 字符） | `.ndjson` 体积 / 事件数 | `.history.json` 体积 / 步数 | 模型总调用 | Input / Cached（命中率） |
|---|---|---:|---:|---:|---:|---:|---:|
| **Klip 专业推广官** (`fc7eaf18`) | 竞品调研 / ASC 上架（非管理员） | 1,970 字 | 2 条 / 102 字 | 2,953.2 KB / 2,328 ev | 1,066.0 KB / 514 步 | 609 | 40.97M / 32.88M (**80.25%**) |
| **Nori** (`e20dbd98`) | 主控 / 通道 / 定时（`isAdmin`） | 328 字 | 4 条 / 968 字 | 501.3 KB / 792 ev | 714.6 KB / 343 步 | 367 | 12.92M / 10.87M (**84.10%**) |
| **博客管理员** (`ab5950ce`) | 博客构建 / 发布（非管理员） | 1,924 字 | 3 条 / 231 字 | 371.4 KB / 542 ev | 787.1 KB / 262 步 | 131 | 4.17M / 2.98M (**71.58%**) |
| **节点刷新员** (`d433e933`) | 订阅刷新 / 定时运维（非管理员） | 2,278 字 | 1 条 / 232 字 | 346.0 KB / 399 ev | 335.3 KB / 191 步 | 107 | 2.69M / 1.70M (**63.24%**) |
| **合计（4 个活跃 Bot）** | — | — | **10 条 / 1,533 字** | **4,171.9 KB / 4,061 ev** | **2,903.0 KB / 1,310 步** | **1,214** | **60.75M / 48.43M (79.72%)** |

### 1.2 `route-stats.ndjson` 路由与失败概览

- **总体盘面**：共记录 **119 轮 / 488 步 / \$12.5214**。
- **终态分布**：`done` **111**（93.3%）、`error` **8**（6.7%，其中 6 轮 `steps = 0`、**7/8 = 87.5% 误记 `errors = 0`**）。
- **复杂度分布**：`trivial` **63**（其中 **18 轮 = 28.6%** 实际 `>= 3` 步、累计耗费 **\$2.12**，最高单轮 23 步 / \$1.14）、`standard` **51**、`complex` **5**。
- **类别分布**：`chat` 60、`ops` 34、`gui` 7、`qa` 4、`data` 4、`orchestration` 3、`schedule` 3、`coding` 3、`creative` 1。

### 1.3 已由 `ota-20261127.0200`（Phase 1–3）核销的历史 macOS 痛点（不再重复立项）

1. **步内改记忆/日程触发缓存归零与 258K 上下文膨胀**：`P0-1` 轮内冻结 `frozenSystemInstruction` + 160K 软上限增量压缩已覆盖 `Nori` Turn 13/32、`节点刷新员` `seq=196/397` 与 `Klip` `seq=1023/2011`。
2. **辅助模型逃逸预算与 `route-stats.escalations` 恒为 0**：`P0-2` 已将 `summary`/`router` 计入 `TurnBudget` 并统计 `autoEscalations`，`Nori` Turn 37 已实证首步前取消无谓 `summary`。
3. **外部通道原生投递与高频工具摩擦**：`P0-3`/`P1-1`/`P1-5`/`P0-4` 已打通 Telegram / 飞书 `sendDocument`/`sendPhoto`、`host_edit_file` + 行区间 `host_read_file`、`browser_snapshot` 15s 降级超时、`sleep` 轮询熔断及跨 Bot 共享路径认知。
4. **敏感路径防护与只读/低危误报**：`P1-6` 已拦截 `channels-auth.json`/`relay-token`/`frpc.toml`，并在 `policy.ts` 消除 `always` 模式下常规 `./deploy.sh`/`git push` 的 `risk:"high"` 误报。
5. **控制流与跨模型稳定性**：`P2-2`/`P2-3` 与前置提交已解决连续空响应静默结束、工具调用前 `pause` 拦截、跨 Provider 切换签名 `400`、`web_search` 中文时效百度优先以及 `[消息来源]`/`[发送时间]` 注入。

---

## 二、待修复问题与优化方案详表（18 项，全部支持 `ota-only`）

---

### 【P0 级：立即修复 — 回归阻断、凭据泄漏、后 OTA 压缩失效与外部通道死锁】

#### P0-1：短追问（`"继续"`）与短运维指令被划入 `TRIVIAL_PLAN` 并剥离全部 Shell/文件/浏览器工具（Phase 1–2 组合回归）
1. **现象与痛点**：用户发送 `"继续"`、`"发布然后把链接给我"` 等短指令时，路由将其判为闲聊 `trivial + chat`，导致模型在首步完全看不到 `host_run_shell`、`host_read_file`、`host_edit_file`、`browser_*`、`send_file` 等核心工具，或误判无法操作本机、或在步内调用 `route_escalate` 更换工具表从而击穿 40K–110K Prompt Cache。
2. **数据实证**：
   - `博客管理员` `seq=191`（`"继续"`）、`seq=236`（`"发布然后把链接给我"`，9 字未命中 `WORK_HINT_RE`）、`节点刷新员` `seq=349`（`"继续"`，续跑中断的例行任务）均在 Step 1 立即依赖 `host_run_shell`。
   - `route-stats.ndjson` 中 63 轮 `complexity="trivial"` 有 **18 轮（28.6%，\$2.12）** 实际执行 `>= 3` 步（最高单轮 23 步 / \$1.14）。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/route-planner.ts:33-37, 100-118, 395-405`：`isSimpleFollowUp`（`"继续"/"好的"/"可以"/"再试一次"` 等）与 `<= 12` 字且未命中 `WORK_HINT_RE`（缺少 `发布|推送|上线|提交|删除|刷新|运行|执行|同步|链接` 等动词）的指令直返 `TRIVIAL_PLAN`（`complexity:"trivial", category:"chat"`）。
   - `src/agent/loop.ts:1081-1096, 1563-1573, 2136-2137`：满足 `trivial && chat` 时仅保留 13 个 `TRIVIAL_CHAT_CORE_TOOLS`，且 `src/agent/route-signals.ts:50-63` 的 `route_escalate` 说明未告知模型可用它恢复被隐藏工具。
4. **具体改造方案**：
   - 当近 2 轮存在工具调用 / 审批 / 中断状态，或命中 `isSimpleFollowUp`（特别是 `"继续"`/`"再试一次"`）时，默认置 `fullToolsUnlocked = true`，严禁剥离工程与执行工具。
   - 扩充 `WORK_HINT_RE`，纳入 `发布|推送|上线|部署|提交|删除|刷新|运行|执行|同步|构建|打包|链接|日志|订阅` 等运维高频词，并对“工具上下文延续”请求改判 `standard/ops`。
   - 仅当当前轮是**无历史工具上下文的纯寒暄**时，才允许裁剪为 `TRIVIAL_CHAT_CORE_TOOLS`。
5. **验收指标**：`"继续"` 及 12 字以内运维/发布短指令 100% 保留完整工具声明，不因工具缺失引发无谓 `route_escalate` 重试或缓存失效。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P0-2：`settings.json` / `*.env` 漏防 + `.ndjson` / `.history.json` / `thought` / `answer` 落盘层未脱敏
1. **现象与痛点**：`settings.json` 含模型 `apiKey`，`*.env` 含代理节点/订阅凭据；目前安全红线与读取工具未拦截这两类目标，且 `thought`、`result` 与 `answer` 在写盘/外发通道前未经脱敏，导致真实密钥与订阅凭据长期明文留存于本地日志乃至外部消息中。
2. **数据实证**：
   - `Nori` `seq=518-519` 读取 `settings.json` 致 `apiKey`（`sk-...`）直接落盘 `.ndjson` 与 `.history.json`，并在 `seq=229..785` 导致飞书 `answer`（`seq=347`）外发敏感字段。
   - `节点刷新员` `seq=46-47, 148-149` 读取受保护 `*.env` 配置后，`.ndjson` 与 `.history.json` 内各自明文留存多处代理协议 URI、非会话 UUID、订阅 URL 与密钥参数。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/policy.ts:606-622` & `src/lib/file-attachments.ts:72-99`：禁读规则覆盖 `.env`/`.env.*`、`*auth*.json`、`vault.json`，但**漏掉 `settings.json` 与 `*.env` 后缀文件名**。
   - `src/lib/channel-integrations.ts:1957-1966`：`redactSensitiveTokensInText` 仅覆盖 Telegram Bot Token、`sk-`、`gh*_`、`AIza`，漏掉 Bearer 头、`?token=` 参数、代理 URI 及 JSON secret/apiKey 字段。
   - `src/agent/loop.ts:1756-1767, 1986, 2232, 2476` & `src/store/index.ts:416-434, 623-627`：`truncateForDisplay` 只覆盖 `displayResult`，未在 `appendEvent`（`thought`/`result`/`action`/`answer`）与 `saveHistory`（`outputSteps`/`function_result`）统一脱敏。
4. **具体改造方案**：
   - 将 `settings.json`（及 backup）与 `/(?:^|\/|\\)[^/\\]+\.env$/i`（`*.env`）纳入 `isSensitiveFilePath` 与 Shell 读取拦截红线（读取自身运行时配置统一走经脱敏的系统工具）。
   - 扩展 `redactSensitiveTokensInText`，覆盖代理协议 URI 凭据、`Bearer ...`、`token=`/`secret=`/`apiKey=` 查询与 JSON 字段、`KEY=VALUE` 高熵密钥对。
   - 在 `appendEvent`、`history.push`/`saveHistory` 入口及飞书/Telegram 外发 `answer` 前置调用脱敏清洗，确保敏感信息不落盘、不出站。
5. **验收指标**：读取 `settings.json` / `*.env` 触发策略阻断；模拟含 `sk-` / Bearer / 代理 URI / `?token=` 的工具结果与思考过程在 `.ndjson` / `.history.json` / 外部回复中 `0` 处明文留存。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P0-3：DeepSeek 跨轮全量重传历史 `reasoning_content`（+40%–70% 输入膨胀）并致重启后 `P0-1` 120K 压缩失效
1. **现象与痛点**：每次切换或连续使用 DeepSeek 模型时，驱动把所有已完结历史轮次的思考过程（`reasoning_content`）全部重传给上游；由于压缩模块假设旧思考不占用输入预算，导致本地估算远低于真实上游输入，服务重启后 `P0-1` 的 120K 自动压缩被彻底绕过。
2. **数据实证**：
   - **post-OTA 实测**：`Nori` Turn 37（`2026-11-27T02:16Z`，已含 `P0-1`）上游 API 实测 `input=126,680→127,250`（已超 120K 软上限）仍 `0` 次压缩，因历史内含 89 条旧 `thought`（164.6 KB），`estimateEffectiveHistoryTokens` 仅估 **58.4K**（低估 **46.3%**）。
   - `节点刷新员` `.history.json` 中 `thought` 占比高达 **63.5%（197.1 KB）**，模型在 Gemini 与 DeepSeek 间切换时单步输入瞬间暴涨 **+36K–39K（+53%）**。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/providers/openai-compat-driver.ts:100-102, 231-245`：`canonicalToOpenAiMessages` 对**所有历史轮次**的 `thought` 都装配 `msg.reasoning_content` 重发给上游。
   - `src/agent/context.ts:332-353, 365-377`：估算有效上下文时忽略旧轮 `thought`，而 `src/agent/loop.ts:105-133` 的 `sessionTokenScaleMap` 仅驻内存、服务重启即归 `1.0`，叠加滞回阈值放行 `127K` 历史而不压缩。
4. **具体改造方案**：
   - 修改 `canonicalToOpenAiMessages`：遵循 DeepSeek / OpenAI 推理模型契约，仅在**最后一个真实 `user_input` 之后**（当前未完结工具调用链内）保留 `reasoning_content`；已完结历史轮次统一剥离 `thought`/`reasoning_content`。
   - 为旧轮 `history` 中超过一定轮数/体积的历史 `thought` 做持久化或压缩裁剪，并将最近校准的 `tokenScale`（或真实 `lastInputTokens`）落盘至会话元数据，防止重启后失效。
5. **验收指标**：跨轮 DeepSeek 输入不再随旧 `thought` 线性膨胀；超过 120K 实测输入时即便服务刚重启也能稳定命中 `P0-1` 压缩。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P0-4：飞书 / Telegram 外部通道遇 `ask_user_choice` 死锁 360 秒且阻塞实时 Steer
1. **现象与痛点**：用户在飞书或 Telegram 对话中，一旦 Bot 调用 `ask_user_choice`（或触发需选项卡片的工具），外部聊天窗口收不到任何选项内容，且用户后续发来的文字全部被串行会话锁卡死 5–6 分钟，既不能作答也无法实时打断/纠偏（Live Steer）。
2. **数据实证**：
   - `Nori` 飞书 Turn 9–10（`seq=130→152→156`）触发 `choice_request` 后，通道仅发通用提示未发选项，后续用户消息硬阻塞 **360.03s**（`5m safetyTimer + 60s waitUntilSessionIdle`）直至超时取消。
   - Telegram Turn 31–35 用户多条追问被严格串行排队，无法像桌面端一样直接实时 Steer 正在运行的任务。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/lib/channel-manager.ts:469-509, 807-828`：虽已实现审批 `1`/`2` 数字回复解析与 `runner.approve`，但对 `choice_request`（`:500-509`）仅发静态等待提示，不渲染问题/编号选项也不接收文本解析回写 `runner.choose`。
   - `src/lib/channel-manager.ts:597-638, 830-833`：所有入站消息被 `sessionChains` 强串行绑定并等待 `waitUntilSessionIdle`，阻塞 `runner.enqueue` 的实时 Steer。
   - `src/agent/loop.ts:1090, 1552-1573`：当消息来源于外部通道（`channelMeta`）时，`ask_user_choice` 仍完全暴露给模型。
4. **具体改造方案**：
   - 在 `channel-manager.ts` 为 `choice_request` / `draft_request` 渲染清晰的编号选项消息，并在入站消息拦截器优先匹配数字/文本选择与自定义输入，直接调用 `runner.choose(callId, ...)` 解锁挂起状态。
   - 对当前正在执行且非等待审批/选择的同会话外部消息，直接走 `runner.enqueue` 触发 Live Steer（带防抖合批回执），不再死等 `waitUntilSessionIdle`。
   - 若工具为非交互强需求多步表单且无对应通道交互能力，在系统提示或工具描述中引导直接文字询问。
5. **验收指标**：飞书/Telegram 收到 `choice_request` 后可直接回复序号解锁继续执行；外部通道追问可在运行中直接实时 Steer，消除 360s 死锁。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P0-5：MCP（`kimi-cu`）文本/Retina 图像无上限 + 旧截图跨轮永驻致 4× 压缩抖动、缓存崩塌与永久 `visual=true`
1. **现象与痛点**：macOS 桌面控制（`kimi-cu` MCP）返回的 UI 树 JSON 与高清 Retina 截图未经裁剪直接灌入历史，单步可注入上百 KB 数据；同时旧截图仅按全局条数保留 3 张而不随轮次过期，既在步内压缩改写前缀摧毁 Prompt Cache，又让多天前的历史截图长期迫使后续全文本对话强走 `visual=true` 重模型。
2. **数据实证**：
   - `Klip` T14 连续 8 次调用 `mcp__kimi_cu__get_app_state`，累计注入 **201.3K 字符**与 201KB JPEG，111 秒内触发 4 次被动压缩，缓存命中率跌至 **0%–20%**。
   - `Klip` T10 因步内删图改写前缀导致缓存从 **97.7% 崩至 12%**（单步额外浪费 ~660K tokens）；3 个本地 Bot 的 `.history.json` 中分别残存长达 **4 天（258KB）/ 14 轮（354.6KB）/ 17 轮 40 小时（317.6KB）** 的陈旧截图，令纯文本问答也锁死 `needs_visual:true`。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/model.ts:79-97`：`compactResultForModel` 不截断超大 `result.text` 与 `browser_*` 快照文本。
   - `src/lib/mcp-client.ts:471-509`：MCP 返回的 text/image 块零字符上限、零图像体积压缩/降采样。
   - `src/agent/context.ts:625-670`：`pruneScreenshots` 仅按总张数 `keepScreenshots=3` 保留，没有“过期轮次自动淘汰”。
   - `src/agent/loop.ts:1265-1267, 1374-1378, 1390-1391`：在步内直接就地修改早期历史前缀（`pruneScreenshots`）；`hasScreenInHistoryBeforeCompress` 扫描整份跨天历史而非仅当前轮次。
4. **具体改造方案**：
   - 在 `mcp-client.ts` 与 `compactResultForModel` 为 `result.text` 设置安全上限（如 MCP UI 树 / 大快照 <= 12K 字符，超出保留头尾并提示分段/定向查询），并限制单张 MCP 图像尺寸。
   - 引入**轮次边界图像衰减**：每轮开始/结束后自动剥离早于最近 1 轮的历史图片；单轮步内保持历史只追加（仅在真正触发 160K 压缩重整时才裁剪），保护前缀 KV Cache。
   - 将 `hasScreenInHistoryBeforeCompress` 的检测范围收窄为**最后一个真实用户输入（当前轮）**或仅最近 1 步。
5. **验收指标**：连续 `kimi-cu` 操作不再在步内连续触发压缩抖动；跨天/多轮纯文本追问不再被 40 小时前的旧截图锁死 `visual=true`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P0-6：HTTP `402` 泄露裸 `httpMeta` JSON、无跨 Provider 故障转移、误记 `route-stats.errors=0` 且定时任务异步失败无追踪
1. **现象与痛点**：上游余额不足 / 配额返回 `HTTP 402` 时，聊天界面直接报错抛出包含 `httpMeta` 的原始 JSON；`router` 不识别 `402`，导致主通道欠费时不会自动切换其他已配置 Provider；`route-stats` 漏记此类 0 步失败为 `errors: 0`；定时任务遇到此类异步错误后毫无自愈与持久化失败记录。
2. **数据实证**：
   - `Klip` `seq=2026-2027` 与 `节点刷新员` `seq=340-348` 定时任务均因 `402 {"httpMeta":...}` 在 `steps=0` 时直接崩溃，分别中断 **19h / 6h** 直至人工发 `"继续"` 救火。
   - `route-stats.ndjson` 共 8 轮 `status="error"`，其中 6 轮为 `steps=0`，且 **7/8（87.5%）被错误记录为 `errors=0`**。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/providers/gemini-driver.ts:159-214`：空响应体错误直接透传原始 `err` 字符串（含 `httpMeta`）。
   - `src/agent/router.ts:53-67`：`isModelUnavailableError` 未包含 `402` / 余额不足错误码，导致 `src/agent/model.ts:361` 的备用模型/Provider 故障转移不触发。
   - `src/agent/loop.ts:428, 1710-1712`：`route-stats` 的 `errors` 仅累加工件错误计数，模型步级抛出错误未计入。
   - `src/agent/scheduler.ts:209-232`：仅同步 `try/catch runner.start` 即写死 `lastRunStatus = "started"`，未挂载异步执行结果监听。
4. **具体改造方案**：
   - 在驱动层格式化 `httpMeta` 异常（仅保留可读中文摘要与状态码）；将 `402` / `insufficient balance` 纳入 `isModelUnavailableError`（配长冷却窗口，如 15–30 分钟）触发备用模型/Provider 自动故障转移。
   - 在 `loop.ts` 模型异常退出时正确递增 `route-stats.errors`。
   - 在 `scheduler.ts` 为通过 `start`/`enqueue` 触发的定时任务挂载终态回调，回写 `lastRunStatus = "done" | "error"` 与 `lastRunError`，并对可恢复网络/上游异常支持单次延迟重试。
5. **验收指标**：主模型返回 `402` 时自动切换备用模型（若全部不可用则输出可读中文报错，零 `httpMeta` 裸 JSON）；`route-stats` 错误轮次 `errors >= 1`；定时任务异步失败准确记入 `schedules.json`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

### 【P1 级：高收益可靠性、成本与体验修复】

#### P1-1：`thinking-summarizer` 降频被 `!hasThoughts` 绕过且 `summary`/`router` 83%–96% 输出耗在 `thoughts`
1. **现象与痛点**：Phase 1 `P0-2` 加入了“无重大阶段变化时降低思考摘要频率”的节流逻辑，但实际运行中约 80% 的工具步都带有模型原生 `thought`，直接绕过了 `!hasThoughts` 节流门控；更严重的是 `thinking-summarizer` 与 `route-planner` 均开启了较深思考级别，导致这两个辅助模型 ~83%–96% 的付费输出 Token 全花在隐形 `thoughts` 里。
2. **数据实证**：`Klip` 会话中 `summary` 调用 263 次，**95.8%** 的输出 Token 为 `thoughts`（其中 Gemini 路线 **97.1%**，Cached 0%），最终前端仅展示 `<= 9` 字工作条胶囊；`router` 19 次调用也有 **83.5%** 输出耗在 `thoughts`；79.2% 的工具步均包含 `thought`。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/loop.ts:674-681`：`!hasThoughts` 条件令携带思考流的工具步每步强行触发摘要请求。
   - `src/agent/thinking-summarizer.ts:217`（硬编码 `thinkingLevel: "low"`）、`src/agent/route-planner.ts:451`（硬编码 `thinkingLevel: "high"`）以及 `src/agent/providers/gemini-driver.ts:652-666`（强发 `thinking_summaries: "auto"` 并把 `"none"` 映射回 `"minimal"`）。
4. **具体改造方案**：
   - 移除 `loop.ts:677` 的 `!hasThoughts` 旁路，仅在工具集合变化、新错误出现或达到最小时间间隔（如 >= 12s / 3 步）时才生成思考摘要。
   - 将 `thinking-summarizer` 的 `thinkingLevel` 降至 `"minimal"` 并对支持 `"none"` 的模型允许关闭思考流与 `thinking_summaries`；`route-planner` 降至 `"minimal"`/`"low"`。
5. **验收指标**：辅助调用（`summary` + `router`）`thoughts` 输出占比下降 **70%+**，无重大变化的工具步不再每步触发 `summary`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-2：`browser_type` 对 `<input type="date">` 静默假成功 + 浏览器批量调用出错未中止
1. **现象与痛点**：填报日期选择器（`<input type="date">`）等特殊原生控件时，`browser_type` 走通用选区+输入文本后返回 `ok: true`，页面值实际仍为空或被浏览器重置；同时当模型在同一轮批量发出 `browser_type` + `browser_click` 且前者失败/引发 DOM 重排后，本意“中止批内后续操作”的开关因白名单遗漏并未生效，导致错误 `browser_click` 继续误点提交。
2. **数据实证**：`Klip` T26（`seq=1842-1865`）同批下发 `browser_type` 与 `browser_click`，前步输入导致动态 DOM 元素重排与 ref 错位清空了表单，随后 `browser_type(ref="e5", text="1995-01-01")` 返回 `ok: true` 但实际日期仍为空，最终只能请求人工接管。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `executor/executor.py:3488-3556`（以及 `src/lib/local-chrome-cdp.ts` 对应实现）：统一使用 `el.select()` + `Input.insertText` 且写后不校验 `el.value`。
   - `src/agent/loop.ts:2448-2453`：在 `isBrowserAutomationTool` 失败时会置 `abortRemainingGuiBatch = true`，但 `src/agent/loop.ts:2094` 的检查语句仅判断 `BATCHED_GUI_ACTIONS.has(call.name)`（只包含桌面坐标工具，**完全不含任何 `browser_*` 工具**）。
4. **具体改造方案**：
   - 在 Sandbox 与本机 CDP 的 `browser_type` 中，针对 `date`/`time`/`month`/`week`/`datetime-local`/`color`/`range` 控件走 `HTMLInputElement.prototype.value` 原生 setter + 派发 `input`/`change`/`blur` 事件，并在返回前读取校验写入后值是否生效。
   - 在 `loop.ts:2094` 同步纳入 `isBrowserAutomationTool(call.name)`，并在批内先发生改写型 `browser_click`/`browser_type` 引发 DOM 突变时阻断未刷新快照的后续 `browser_click`。
5. **验收指标**：`<input type="date">` 填入 `"YYYY-MM-DD"` 后读回校验一致（失效返回明确错误）；同批 `browser_*` 前置失败后后续调用 100% 自动跳过并配对 `function_result`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-3：`pause` 竞态漏网：`P2-2` 遗漏最终 `answer`/`done` 分支的 `ctrl.isPaused()` 守卫
1. **现象与痛点**：用户点击暂停按钮时若模型恰好处于最后一步推理（无 `turn.calls`、即将输出最终回复），由于 `P2-2` 只在 `turn.calls` 分支前加了暂停检查，最终文本输出分支仍会继续发出 `answer` 气泡、触发后台记忆提取并将任务状态覆盖为 `done`。
2. **数据实证**：`Klip` T26 `seq=1870` 触发 `paused` 后用户并未点继续，3 秒后在途步依然发出最终 `answer`（`seq=1873`）并将状态覆写为 `done`（`seq=1874`）。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/loop.ts:1804-2020`（`!turn?.calls || turn.calls.length === 0` 分支）位于 `loop.ts:2022` `ctrl.isPaused?.()` 守卫之前，发出 `answer`（`:1989`）、置 `setStatus("done")`（`:1994`）并调度 `runPostTurnMemoryExtraction`（`:2002`）。
4. **具体改造方案**：
   - 在 `model.nextTurn()` 返回之后、进入 `!turn?.calls || turn.calls.length === 0` 分支之前（或紧邻 `loop.ts:1713` 检查 `ctrl.stopped` 后），统一前置 `if (ctrl.isPaused?.())` 挂起等待；若在暂停期间收到 `stop` 则直接退出，收到 `steer` 则吸收追问重跑，收到 `resume` 再继续落盘与回复。
5. **验收指标**：在任意 `model.nextTurn()` 在途阶段点击 `pause`（包括无工具调用的终态轮），挂起期间均不输出 `answer`、不置 `done` 且不触发后台记忆提取。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-4：外部通道 `send_file` 延迟投递无回执、上传失败静默吞错且泄露本地 `/api/workspace/file` 路径
1. **现象与痛点**：在 Telegram / 飞书轮次中调用 `send_file` 时，文件实际要等整个 Turn 结束才异步上传投递，模型无法感知最终是否成功发出，甚至多耗 2 步去排查；更糟糕的是上传大文件（如 7.3MB zip）失败时仅打印后端 warn，而发给外部聊天软件的正文却原封不动透传 `[文件附件: ... · 路径: /api/workspace/file/...]` 本地路由字符串。
2. **数据实证**：`Nori` Telegram Turn 26 / 36（`seq=559-564, 762-776`）多次触发 7.3MB zip 发送无即时回执、白耗额外排查步，并向外部聊天原文发出本地 `/api/workspace/file` embed 行。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/lib/channel-manager.ts:321-344, 516-535, 570-580`：媒体发送失败仅记录 `console.warn` 与 `rt.lastSendError`，未在外部聊天窗口发送明确失败告警。
   - `src/agent/loop.ts:1964-1976` & `src/lib/channel-manager.ts:537-544, 572-574`：`loop.ts` 自动追加本地下载卡片 Markdown，`channel-manager.ts` 外发文本未剥离已进入 `pendingMedia` 队列的本地 `/api/workspace/file` 链接行；`collab-tools.ts` 中外部通道轮次也未标注 `channel_delivery: "queued_on_turn_end"`。
4. **具体改造方案**：
   - 当检测到当前处于外部通道上下文时，`send_file` 返回结果附加明确语义字段 `channel_delivery: "queued_on_turn_end"`，告知模型勿重复轮询。
   - 外部通道发送文本前自动剥离由系统追加且已成功进入媒体队列的本地 `[文件附件: ...](/api/workspace/file/...)` 行（或保留可读文件名而不泄露内网路径）。
   - 若 Telegram / 飞书媒体上传失败（如超限/网络超时），在外部聊天窗口回发可读错误提示（含文件过大说明）。
5. **验收指标**：外部通道收到纯文件媒体而不再带 `/api/workspace/file` 裸路径；上传失败时用户在聊天窗口可见清晰错误说明。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-5：macOS `host_run_shell` 缺 `zsh -o nonomatch` + 例行任务每轮缓存未命中、隔夜冷载 100K 历史且偶发无效桌面截屏
1. **现象与痛点**：macOS 宿主机 Shell 使用默认严格 glob 的 `zsh`，当 `ls /path/*.log` 无匹配文件时命令整体 `exitCode=1` 中断（而非交给管道/条件分支处理）；同时同一固定 `prompt` 的例行任务每次触发都要花 6 秒重跑路由规划 LLM、隔夜触发还全量冷载 `47K–106K` 完整对话历史，甚至偶发纯命令行巡检任务误判需视觉截一张无意义桌面截图。
2. **数据实证**：
   - `节点刷新员` `seq=20-23` 因 Shell 通配符未匹配直接以 `exitCode=1` 报错；5 次定时例行任务全部未命中 `planCache`（每次 `route_plan` 耗时 ~6.0s），其中 3 次只是检查后“跳过”却冷载 **47K–106K tokens**（Cache 0%–2.7%）。
   - `Klip` 6 次同款日报中 T32（`seq=2240`）偶发 `needs_visual: true`，额外拍摄一张 36KB 无关桌面 PNG。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/host-tools.ts:320-324`：macOS `buildHostShellSpawnSpec` 固定使用 `/bin/zsh -lc`（未启用 `nonomatch` / `null_glob` 防御）。
   - `src/agent/route-planner.ts:335, 342, 407-415`：`isScheduledRun` 仍将动态变化的 `recentContext` 拼接进 `planCache` key 导致必然 miss，且 `needs_visual` 对定时文本巡检缺少强约束。
   - `src/agent/scheduler.ts:210` & `src/agent/loop.ts:956-961`：定时唤醒直接背负全量隔夜主会话历史冷启动，未做轻量历史窗口隔离或免截屏约束。
4. **具体改造方案**：
   - macOS 宿主 Shell 默认改为 `["-o", "nonomatch", "-lc", command]`（或允许单条命令安全执行，匹配行为与 bash 一致）。
   - 当 `isScheduledRun === true` 时，`route-planner` 缓存键忽略动态 `recentContext`（复用同一例行任务的稳定路由计划，省去 6s 规划耗时与 LLM 调用），并约束仅当任务显式声明 `category === "gui"` 或有桌面动词时才 `needs_visual` 初始截屏。
   - 为例行任务配置“轻量历史策略”（默认只携带最近几轮摘要/核心规则而不冷载整本 100K 历史），或支持隔离执行上下文。
5. **验收指标**：macOS `host_run_shell` 通配符空匹配不提前崩溃；同款定时任务二次触发直接命中 `planCache`（0s 规划开销）且纯命令行巡检 0 次无效初始截屏。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

### 【P2 级：观测对齐、交互打磨与记忆治理】

#### P2-1：路由观测名实不符、热缓存步内冷切 `deep`/Provider 与 `gemini-4-neon` 费率缺失
1. **现象与痛点**：`route-stats.ndjson` 的 `tierPath` 展示仍把 DeepSeek 等第三方模型写成内部代号 `Hydrogen→Argon`；`pricing.ts` 缺少 `gemini-4-neon` 单价致成本统计回落不准；当历史已有 `>60K` 热缓存时，步内升级直接跨 Provider/跨模型冷切，导致缓存归零并付出高额重算成本。
2. **数据实证**：post-OTA `route-stats` 仍将 DeepSeek / Hydrogen 全标为 `Hydrogen`/`Argon`；`Klip` 7 次 `gemini-4-neon` 冷切（Cache 仅 17.8%）花 **\$1.41** 仅产出 1,773 output tokens；`博客管理员` 同轮步内多次出现 `cached=0` 跳变。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：`src/agent/route-signals.ts:440-450`（`formatTierPath` 硬编码 Gemini 代号）；`src/agent/pricing.ts:40-241, 306-395`（缺 `gemini-4-neon` 价目表）；`src/agent/loop.ts:1380-1415`、`src/agent/route-stats.ts:204-257`、`src/agent/route-signals.ts:323-369`（高缓存上下文下直接换模型而非先在同模型内升级 `thinkingLevel`）。
4. **具体改造方案**：`formatTierPath` 按真实绑定 `model` / `providerId` 输出；为 `gemini-4-neon` 补全精确单价；当历史 `>= 60K` 且缓存正热时，升级策略优先在当前同模型上调高 `thinkingLevel`，仅当同模型受阻或达到上限时再切换更强模型。
5. **验收指标**：`tierPath` 与实际调用模型完全一致；高热缓存下普通升级不触发 `cached=0` 悬崖。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-2：审批卡片缺上下文、与 `propose_draft` 重复确认且长时等待缺推送提醒
1. **现象与痛点**：用户在页面刚通过 `propose_draft` 确认内容后，真正点发送按钮时仍弹出一张只显示 `ref="e12"` 的冰冷审批卡，信息晦涩且构成二次重复确认；同时当桌面端挂起等待审批超过数分钟时，外部已绑定通道（Telegram/飞书）或本地无二次提醒，用户回来确认时上游 Prompt Cache 早已过期。
2. **数据实证**：`Klip` T10（`seq=974-981`）在刚批准 `propose_draft` 后再次弹出仅含 `ref="e12"` 的卡片阻塞 **729.2s** 致缓存过期；`博客管理员` `seq=411`（`rm -f`）阻塞 **2.13h** 致 90K 缓存完全失效。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：`src/agent/loop.ts:2388-2400` & `src/agent/policy.ts:83, 874-879, 940-949` 仅将原始 `call.args` 推给前端卡片，既不附带元素语义标签/页面上下文，也不识别同轮已批准 `propose_draft` 的同一目标；无超时提醒钩子。
4. **具体改造方案**：审批描述注入操作对象人类可读上下文（如按钮文案 + URL/文件路径摘要）；同轮用户已明确批准的 `propose_draft` 关联操作自动降噪/免二次弹窗；支持可配置的长时审批超时提醒（如 2 分钟未审向活跃终端/通道轻提醒一次）。
5. **验收指标**：审批卡片直观显示操作文案与对象而非裸 `ref`；同轮批准草稿后的收尾提交无重复审批弹窗。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-3：浏览器多标签恢复缺 live `tabs` 列表/提示规范 & 沙箱 `--no-sandbox` 场景指引
1. **现象与痛点**：模型有时反复 `open_url` 挤满或顶掉用户已打开的多个页面，且一旦旧 `target_id` 失效报错仅返回找不到目标而不附当前真实打开的标签页列表，导致模型盲猜重试。此外面对带强反爬风控的站点，提示词未清晰引导切回本机带登录态 Chrome。
2. **数据实证**：`Klip` 用户两次抱怨模型不该擅自新开/覆盖标签（`seq=356, 1784`），`seq=1765` 报 `target_id not found` 时未返回 `tabs` 列表；`博客管理员` `seq=105` 运行中曾担忧沙箱 Chromium `--no-sandbox` 触发目标站风控。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：`executor/executor.py:1673-1679` & `src/lib/local-chrome-cdp.ts:1105` 在 `target_id not found` 异常中不附当前 `tabs` 摘要；`src/agent/prompts/web-grounding.md:2-8` 缺明确的多标签保护规范；`executor/executor.py:1317` 对强风控登录场景缺“切用本机浏览器”文档指引。
4. **具体改造方案**：`target_id not found` 报错同时返回当前可用 `tabs` 的 `{ target_id, title, url }`；在 `web-grounding.md` 补充优先复用工作标签与强风控登录建议切换本机 Chrome（或在安全允许时使用用户环境）的明确规范。
5. **验收指标**：标签失效报错时模型单步即可依据随附 `tabs` 精确切回，不再连续瞎试。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-4：管理员全局排程/运行路径自观测缺口 & 固定 N 天间隔语义
1. **现象与痛点**：管理员 Bot（如 `Twinkle`）调用 `schedule_manage(action:"list")` 默认只查自身会话，无法一眼总览所有子 Bot 的定时任务；排查本地日志或热更新状态时，`system_diagnostics` 缺少 `dataDir`/`coreBuild`/`logDir` 自报字段导致 Bot 只能靠多步 Shell 猜测目录；此外类似“每 3 天执行”转换为日历 Cron `0 10 */3 * *` 后，在 31 号→1 号跨月时会连续两天触发（1 天抖动）。
2. **数据实证**：`Nori` 调 `schedule_manage(list)` 返回 `count:0`（实际全局库中有 2 条其他 Bot 排程），且花了 5 步 Shell 探索 `dataDir`/日志目录；`节点刷新员` `0 10 */3 * *` 存在月末跨月连续触发抖动。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：`src/agent/bot-tools/system-tools.ts:407-420` & `src/agent/bot-tools/declarations.ts:650-715` 缺 `scope:"all"` 参数；`system-tools.ts:1033-1055` 未暴露 `dataDir`/`coreBuild`/`logDir`；`src/agent/scheduler.ts:87-119` 仅支持标准 5 字段日历 Cron，未支持固定天数步长锚定语义。
4. **具体改造方案**：为管理员 Bot 在 `schedule_manage(list)` 增加可选 `scope: "all"` 返回全盘任务及归属 Bot；`system_diagnostics` 补齐 `dataDir`/`coreBuild`/`webBuild`/`logDir` 只读字段；定时任务对 `every N days`（如“每 N 天”）支持可选基准锚点 `anchorAt` / `intervalDays` 计算或在 Cron 创建提示中明确跨月对齐机制。
5. **验收指标**：管理员单次调用即可总览全盘排程并获取精确运行路径，不再花费多步 Shell 盲搜路径。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-5：`[消息来源]` 未区分 Relay 云端与局域网直连 + 跨通道共享上下文说明不足
1. **现象与痛点**：用户从手机外网中继（Relay）、手机局域网直连或飞书发来消息时，头部标注不够精细，Bot 有时会误以为飞书与桌面 App 是两个互不连通的上下文，或在诊断中继接入问题时不得不去翻服务器反代日志。
2. **数据实证**：`Nori` Turn 4–5 曾误称飞书与 App 不共享上下文；Turn 16 为确认手机请求是否走了中继隧道，还被迫 SSH 查服务端 `caddy-access.log`。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：`src/server/routes/sessions.ts:498-527` & `src/lib/channel-integrations.ts:648-665` 尚未注入服务端判定的 `viaRelay` 连接标记；`src/agent/prompts/app-capabilities.md:12` & `src/agent/knowledge/skills-channels-and-vault.md:17-25` 未明确强调各通道接入同一 Bot 时共享同一套会话记忆与对话上下文。
4. **具体改造方案**：在服务端请求入口识别中继转发头并把 `viaRelay: true/false` 注入 `clientSource` 与 `[消息来源]` 头；在自知知识库与 `app-capabilities.md` 明确“绑定同一 Bot 的桌面端、移动端与飞书/Telegram 共享同一会话上下文（同一份 `memories` 与历史）”事实。
5. **验收指标**：手机通过 Relay 接入时消息来源清晰可见；Bot 100% 准确认知跨端与外部通道共享会话上下文。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-6：防自探代码导致的记忆投毒防线 & 存量 `3×` 冗余字段懒清理
1. **现象与痛点**：当主控 Bot 在自查打包产物后发现某一时性的认知误解时，有可能将该错误结论写入长期记忆从而反向覆盖系统内置工具规范（造成持续性“记忆投毒”）；另外阶段二虽停止新增写入 3 倍冗余字段（`desc`/`instruction`/`content`），但老用户存量会话里旧记忆仍保留旧字段未被清理。
2. **数据实证**：`Nori` Turn 32 grep `server-bundle.mjs` 后自动总结写入误导性记忆（`"不要再用 send_file 卡片"`）；当前管理员会话中 4 条存量记忆仍留存 `desc === instruction === content` 三份冗余拷贝。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：`src/agent/prompts/memory-and-skills.md:14-18` 与 `memory-extractor.ts` 未明文禁止将临时源码猜测或否定内置工具契约的结论写入长期记忆；`src/agent/bot-tools/system-tools.ts:248-272` 与 `store/index.ts` 仅在单条更新时才清理冗余字段，缺少自动懒迁移。
4. **具体改造方案**：在记忆规则与提取器提示词中添加“禁止记录与内置工具声明/系统提示相矛盾的临时推断或代码阅读猜测”；在读取或写入会话 `memories` 时自动执行 `desc`/`instruction` → 单字段 `content` 的轻量懒迁移。
5. **验收指标**：后台自动提取不再生成否定内置工具的误导记忆；读取存量会话后旧 3× 冗余字段平滑归一为单 `content` 字段。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-7：AI 回复时间角色隔离按需注入 + 群聊 Bot 发言与跨 Bot 接力时间补全
1. **现象与痛点**：用户消息已注入隐藏 `[发送时间：YYYY-MM-DD HH:mm:ss ±HH:MM]`（`#24`），但 AI 回复、群聊中其他 Bot 发言及跨 Bot 接力均缺时间感知。若直接向每条 `assistant` 消息塞入时间戳，极易诱发 LLM few-shot 模仿惯性从而在回复中自行编造时间标签并外发至外部通道，同时改写已完成的历史步还会破坏 Prompt Cache；但在长耗时/审批挂起轮次、群聊多 Bot 接力与跨 Bot 唤醒场景下确实存在真实的时间盲区。
2. **数据实证**：本机日志中 `博客管理员` `seq=411` 等审批阻塞 **2.13h**、`Klip` T10 阻塞 **729.2s**，用户发送时刻与 AI 最终产出时刻相隔甚远；代码核查确认群聊 `buildGroupPromptContext` 与跨 Bot `isBotHandoff` 均未注入回复/交接时间戳。
3. **精确 `file:line` 根因（HEAD `c2d165c`）**：
   - `src/agent/loop.ts:520-575, 820-865`：仅记录并注入当前 `user` 消息的 `sentAt`，未在下一轮 `user` 系统头回注上一轮长耗时或审批挂起后的实际完成时刻与耗时。
   - `src/agent/group-coordinator.ts:235-250`：`buildGroupPromptContext` 仅为 `ev.type === "user"` 拼接 `formatMessageTimeHeader(ev)`，`answer`（`[BotName]`）与工具结果行未附时间。
   - `src/agent/runner.ts:589-591`：`const effectiveUserMeta = options.isBotHandoff ? options.userMeta || null : ensureServerSentAt(options.userMeta)` 在跨 Bot 接力时跳过了 `ensureServerSentAt`，导致目标 Bot 收不到 `[发送时间]`。
4. **具体改造方案（方案 B：角色隔离 + 按需注入）**：
   - **单聊长耗时/挂起完成回注（绝不污染 `assistant` 正文）**：在会话状态或最近一次 `answer` 事件中记录上轮完成时刻 `completedAt`、实际耗时 `durationMs` 及是否经历过 `awaiting_approval` / `awaiting_choice` / `paused`；**当且仅当上轮耗时 `>= 60s` 或经历过审批/暂停时**，在下一条 `user` 消息的系统头追加一行只读元数据 `[上轮回复完成：YYYY-MM-DD HH:mm:ss ±HH:MM，耗时 XmYs]`（仅追加不改写既有历史，零模仿污染、零 Prompt Cache 损耗）。
   - **群聊 Bot 发言补时间**：在 `buildGroupPromptContext`（本身拼入 `user_input` transcript 供当前发言者读取）中为每条 `[BotName]` 回复附带 `ev.at` 本地时间（如 `[博客管理员 · 2026-11-27 10:15:32 +08:00]: ...`），零模仿风险且清晰呈现多 Bot 接力时间线。
   - **补齐跨 Bot 接力时间戳**：`runner.ts:589` 对 `isBotHandoff` 同样调用 `ensureServerSentAt(options.userMeta)`，确保跨 Bot 协作消息稳定携带 `[发送时间]`；并同步在 `src/agent/prompts/app-capabilities.md:12` 补一句禁止原样回显 `[上轮回复完成：…]` 标签的约束。
5. **验收指标**：常规 `< 60s` 短单聊不额外注入冗余时间、零模型模仿伪造标签；长耗时/审批轮次的下一轮追问能准确回答上一轮完成时间与耗时；群聊 Bot 发言与跨 Bot 接力 100% 带准确本地时间。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

## 三、分阶段实施排期（Phase 4–6，全部 `ota-only`）与验证矩阵

### 3.1 分阶段排期

| 阶段 | 状态 | 目标定位 | 纳入优化项 | 预期收益 |
|---|---|---|---|---|
| **Phase 4：紧急回归止血、防泄漏与外部通道解锁** | **已完成 (working tree)** | 修复工具裁剪回归、明文凭据落盘、DeepSeek 压缩失效、外部通道死锁、MCP/旧图失控与 `402` 故障转移 | **P0-1**（防 `"继续"` 等短操作指令裁剪）<br>**P0-2**（禁读 `settings.json`/`*.env` + 全链路脱敏）<br>**P0-3**（历史 `reasoning_content` 止传 + scale 持久化）<br>**P0-4**（外部通道桥接 `choice_request` + 实时 Steer）<br>**P0-5**（MCP 裁剪 + 轮次边界清图 + 限当轮判图）<br>**P0-6**（`402` 故障转移 + `errors` 计数 + 异步终态追踪） | • 消除短命令丢工具回归与 `402` 中断<br>• 聊天日志与外部回复敏感凭据 `0` 泄漏<br>• 恢复 120K 压缩与 Prompt Cache 稳定命中<br>• 消除飞书/TG 360s 阻塞 |
| **Phase 5：成本降噪、浏览器批控与调度可靠性** | **已完成 (working tree)** | 削减辅助模型无效推理耗费、修补浏览器批量与暂停竞态、消除调度与 macOS Shell 高频摩擦 | **P1-1**（去 `!hasThoughts` 旁路 + `minimal` 摘要/规划）<br>**P1-2**（原生日期输入写回校验 + 修复 `browser_*` 批中止）<br>**P1-3**（`calls.length === 0` 分支补齐 `isPaused` 守卫）<br>**P1-4**（外部通道文件回执 + 失败推送 + 剥离本地路径）<br>**P1-5**（`zsh -o nonomatch` + 例行任务缓存与轻量历史） | • 辅助模型输出冗余 `thoughts` 下降 **70%+**<br>• 消除暂停瞬间越界发最终消息的竞态<br>• 表单多标签批量执行安全可控<br>• 定时任务告别 6s 重复规划与 100K 冷载 |
| **Phase 6：观测对齐、交互打磨与记忆治理** | **已完成 (working tree)** | 修正观测报表口径、减少重复确认打断、增强多标签恢复与记忆健壮性 | **P2-1**（真实模型 `tierPath` + `gemini-4-neon` 定价 + 同模优先升思考）<br>**P2-2**（审批上下文摘要 + 复用草稿授权 + 超时提醒）<br>**P2-3**（`target_id` 失败附 `tabs` + 多标签/强风控指引）<br>**P2-4**（全局排程视图 + 运行路径自观测 + N 天步长）<br>**P2-5**（`viaRelay` 标注 + 跨端共享上下文说明）<br>**P2-6**（防源码误判记忆投毒 + 存量 `3×` 记忆字段懒迁移）<br>**P2-7**（长耗时/审批上轮完成回注 + 群聊/跨 Bot 时间补全） | • 路由/费用报表完全可信<br>• 审批打断大幅下降、标签失效一步自愈<br>• 记忆干净可信无历史包袱<br>• 消除长耗时、群聊与跨 Bot 时间盲区 |

### 3.2 自动化验证矩阵（每阶段完成前均须全部通过）

1. **静态编译与 `ota-only` 产物检查**：
   ```bash
   npm run typecheck
   npm run build:ota
   ```
2. **Node 原生单元测试（`npm test`）重点补充用例**：
   - `route-planner` & `loop` 测试：覆盖 `"继续"`/`"发布然后把链接给我"` 保留完整工具、`calls.length === 0` 末步 `pause` 拦停、`isBrowserAutomationTool` 触发 `abortRemainingGuiBatch` 跳过同批后续点击、`summary`/`router` 低思考配置。
   - `policy` & `store` & `channel-integrations` 测试：覆盖 `settings.json` / `*.env` 禁读、`redactSensitiveTokensInText` 对代理 URI/Bearer/`?token=` 与 `appendEvent`/`saveHistory`/`thought`/`answer` 脱敏。
   - `openai-compat-driver` & `context` & `mcp-client` 测试：覆盖已完结历史轮次剥离 `reasoning_content`、重启恢复 `tokenScale` 后触发 120K 压缩、MCP 超大结果截断、跨轮淘汰旧截图而不破坏步内缓存。
   - `channel-manager` & `router` & `scheduler` 测试：覆盖 `choice_request` 数字选择回调、`402` 触发备用 Provider 转移与 `errors` 计数、定时任务异步终态回写及例行任务 `planCache` 复用。
   - `loop` / `group-coordinator` / `runner` 时间注入测试（`P2-7`）：验证 `<60s` 常规单聊不注入冗余完成头、`>=60s` 或经历审批/暂停后下一轮 `user` 头自动注入 `[上轮回复完成：…]`、群聊 `[BotName]` 回复带准确本地时间，以及 `isBotHandoff` 携带 `[发送时间]`。
3. **Ubuntu Sandbox Executor 单测**：
   ```bash
   orb -m ubuntu python3 -m unittest discover -s executor -p 'test_executor.py' -v
   ```
   - 补充覆盖 `<input type="date">` 原生写回校验与 `target_id not found` 返回 `tabs` 列表。
4. **E2E 全码静态审计与分级回归（Headless Chrome）**：
   ```bash
   npm run e2e:audit
   node scripts/run-e2e.mjs --tier=affected+p0
   ```
