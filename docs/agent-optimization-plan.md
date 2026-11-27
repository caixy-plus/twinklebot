# TwinkleBot 智能体系统深度诊断与可执行优化计划

> **文档性质**：基于真实用户运行日志（`%APPDATA%\TwinkleBot\data\`，2026-11-17 至 2026-11-26）与仓库 `main` 分支源码联合核验输出的可执行改造规划。  
> **安全与隐私声明**：全篇严格执行零密钥、零 Token、零密码、零个人手机号/邮箱/公网 IP/Chat ID/敏感完整 URL 脱敏规范；所有改造均只针对框架架构与通用能力。  
> **实施状态**：**Phase 1（`P0-1`–`P0-4`）已完成**（commit `1b671a4`）；Phase 2（`P1-1`–`P1-6`）与 Phase 3（`P2-1`–`P2-4`）待实施。

---

## 一、本地数据全景量化总览

### 1.1 运行盘面与 5 个活跃 Bot 画像

截至 `2026-11-26T14:07Z`，本机共积累 8 个活跃日的数据。`sessions/` 中共有 **5 个活跃 Bot 会话**（全部为 `type: "dm"`，暂无 `type: "group"` 群聊会话；另 `route-stats.ndjson` 保留 3 个已清理历史 Bot 记录）：

| Bot 名称（ID 前缀） | 角色定位 | `rolePrompt` | 专属记忆（条 / 字符） | `.history.json` 体积 / 条数 | 模型总调用 (`usageByModel`) | Input / Cached（命中率） | 累计成本 (CNY) |
|---|---|---:|---:|---:|---:|---:|---:|
| **Twinkle** (`8967f0a4`) | 主控/通道/定时 (`isAdmin`) | **0 字（空）** | 2 条 / 565 字 | 520.6 KB / 236 条 | 854（flash:721, pro:133） | 28.71M / 26.46M (**92.1%**) | ¥7.8474 |
| **TwinkleBot 项目管家** (`f916ffa8`) | 缺陷排查/台账/Issue | 648 字 | 8 条 / 1,413 字 | **3.32 MB** / **1,230 条** | 698（flash:682, pro:16） | **90.90M** / 81.32M (89.5%) | **¥14.6144** |
| **Klip 专业推广官** (`5047dd3c`) | 竞品调研/视频/ASC 上架 | 95 字 | 6 条 / **4,127 字** | 2.14 MB / 1,195 条 | 702（flash:702, pro:0） | 80.09M / 72.83M (90.9%) | ¥9.4985 |
| **阿B管理员** (`214f2d7c`) | B站账号运营/投稿/复盘 | 74 字 | 1 条 / 665 字 | 960.0 KB / 720 条 | 423（flash:423, pro:0） | 20.46M / 18.60M (90.9%) | ¥2.6315 |
| **博客管理员** (`46c2b7dc`) | Hugo 博文/WSL 构建部署 | 60 字 | 2 条 / 912 字 | 141.7 KB / 184 条 | 105（flash:103, pro:2） | 1.88M / 1.58M (83.7%) | ¥0.7275 |
| **合计（5 个活跃 Bot）** | — | — | **19 条 / 7,682 字** | **~6.61 MB / 3,565 条** | **2,782**（flash:2,631, pro:151） | **222.05M / 200.78M (90.42%)** | **¥35.3193** |

### 1.2 智能路由与辅助开销全景（`route-stats.ndjson` + 现存 `.ndjson`）

- **全周期路由统计（`route-stats.ndjson`, N = 214 轮 / 1,275 步 / `$8.7548`）**：
  - **终态分布**：`done` 199（93.0%）、`stopped` 8（3.7%）、`error` 4（1.9%）、`max_steps` 3（1.4%，均跑满 60 步）。
  - **类别费用重心**：`chat` 占 46.7% 轮次（100 轮）却贡献 **$4.1702（47.6% 总费用）**；Top 10 最贵轮次（仅 4.7%）吞噬 **28.86%** 总花费，Top 20（9.3%）吞噬 **46.52%**。
  - **步骤档位名实分布**：名义 `fast` 593 步（46.51%）、`standard` 675 步（52.94%）、`deep` 仅 7 步（0.55%）；但因 `settings.json` 将 `routing.tiers.fast` 与 `routing.tiers.medium` 同绑 `deepseek-flash`，**99.0% 的 `standard` 调用实际上仍在调 `deepseek-flash`**。
  - **埋点失真**：`route-stats.ndjson` 全量 214 轮 `escalations` 字段**恒为 `0`**，而 `.ndjson` 中实际发生 **41 次**运行时升级/恢复（`错误恢复` 31 次、`执行受阻 · 升级 Argon` 8 次、`连续失败 · Carbon 救援` 2 次）。
- **辅助 LLM 调用占比（5 个会话现存 `usage` 事件 N = 2,081）**：
  - `summary`（进度提炼）：**976 次（46.90%）**，平均几乎 1 步主模型就伴随 1 次摘要调用，Cache 命中率仅 **41.4%**。
  - `router`（路由规划）：**121 次（5.81%）**，占首步前串行阻塞等待：P50 **2,510 ms**、均值 **2,975 ms**、P90 **4,777 ms**、Max **11,545 ms**。
  - **合计**：辅助模型调用占比高达 **52.71%**，且两者及后台记忆提取均未计入 `TurnBudget`。
- **记忆、定时与跨 Bot 协同盘面**：
  - **全局记忆**：4 条（812 字），与 `settings.json` 中 `privateSkills` 100% 重复；全部 23 条记忆（全局 4 + 专属 19）均三份复制 `desc === instruction === content`。
  - **定时任务**：1 个启用任务（`每日 8 点科技圈新闻简报`，`0 8 * * *`），单次 42.2s / `$0.0169`，依赖 `run_shell + curl` 调 Telegram API。
  - **跨 Bot 协同（`exchanges/`）**：3 个双边线程（27 条 / 16,808 字），存在双回执冗余及 `Maximum inter-Bot hop depth (4) reached` 阻断。

### 1.3 已对照当前 `main` 源码核销的陈旧历史问题（不列入待办）

经核对仓库最新源码，以下两类日志中出现过的历史故障**已在当前 `main` 修复**（连同 `docs/product-issues.md:17-32` 已标记 `FIXED` 的 `PI-001`~`PI-016` 一并剔除）：

1. **`max_steps` 到达 60 步后无任何前端提示与续跑入口**（历史 `11-19` / `11-20` 日志）：当前 `src/agent/loop.ts:2287-2322` 已发送 `route_notice`（`level: "max_steps"`，含已完成步数和近期工具名）并向 `.history.json` 写入 `[System Notice]`，`src/web/components/chat/ChatStage.tsx:715-730` 已渲染「继续执行」按钮，且 `src/lib/channel-manager.ts:467-475` 已同步透传该通知至外部通道。（注：若模型在第 60 步未直接收口输出阶段总结仍会退回通用提示，可在 P2 轻度增强，不按“完全静默”立项。）
2. **网络瞬断 `fetch failed` 无自动重试导致 0 步直接失败**（历史 `11-24` 日志）：当前 `src/agent/providers/openai-compat-driver.ts:453-470, 878-905` 已将 `fetch failed` / `ECONNRESET` / `ETIMEDOUT` / `429` / `5xx` 纳入 `isTransientRetryableError`，并通过 `executeWithTransientRetry` 提供带随机抖动的指数退避自动重试（无独立 fallback 时默认重试 2 次）。

---

## 二、核心问题诊断与脱敏实证

| 诊断域 | 核心病灶 | 脱敏数据实证 |
|---|---|---|
| **1. 成本与 KV Cache 失血** | 1M 上下文阈值形同虚设 + 每步重建 System Prompt，导致 `memory_manage` 触发 550K 级缓存雪崩 | ① 会话 A/B 上下文分别膨胀至 **551,526 / 448,400 tokens**，LLM 压缩触发 **0 次**（因 `deepseek` 窗口设 `1_000_000` × 85% = 850K）；② `memory_manage` 改写前缀后后续步 Cache 命中率由 99% 暴跌至 **0%–0.07%**（如 `in=551,526, cached=384`），令普通 `chat/trivial/Hydrogen` 单轮最高花费 **$0.3744**（11-26 单日占全期 22.6% 费用）。 |
| **2. 路由退化与控制流空转** | `fast/medium` 同模空转 + 首步串行规划 + 死循环检测盲区 + 辅助调用失控 | ① `standard` 99.0% 仍在调 `deepseek-flash`，41 次自动升级无从获取强模型；② `route_plan` 首步阻塞 **2.5s–11.5s**；③ `阿B管理员` 在图形验证码死磕 **58 步 / 238.5s** 零救援，`Klip 推广官` `run_shell` **30.1%（37/123）** 为 `sleep` 轮询，坐标点击在 `(x1,y1)↔(x2,y2)` 交替空转；④ `pause` 后在途步骤仍执行写入并创建外部 Issue；⑤ `thoughts=2,348` 挤占输出导致仅回复 `"扫完"` 2 字。 |
| **3. 工具工程与跨平台摩擦** | 缺分片读与局部编辑 + Windows PS/WSL 语法碰撞 + `web_search` 中文质量偏置 | ① `docs/product-issues.md` 11 次修改全靠 `host_write_file` **整文件覆写**且每次弹审批（最长等 **151.3s**）；② `博客管理员` PS 混写 `| tail` 与 WSL 引号崩溃 6 次、触发 2 次昂贵 Carbon 救援，低风险 `Get-ChildItem` 也弹审批；③ PowerShell CLIXML stderr 误判 `exitCode=1` 6 次；④ `browser_snapshot` 空骨架/36.2s 超时与 `open_url` 拒 `file://`；⑤ `web_search` 优先 Bing 导致定时简报首页被泛词百科污染。 |
| **4. 外部通道断层与安全盲区** | 渠道回复不透传 `send_file` 媒体 + `run_shell` 敏感读未拦截 + `sandboxMode` 越界 | ① `Twinkle` 在 Telegram 发文件因 `send_file` 仅生成 App 卡片，被迫 `curl` 暴力试探 8 个公共网盘；之后擅自推送又被「没让你发tg」打断；② `run_shell`/`host_run_shell` 未拦截 `cat`/`Get-Content` 读 `.env`/`vault.json`/跨 Bot 目录；③ `policy.ts` 缺 PowerShell 危险语法规则且 `sandboxMode=full` 短路 `writeRoots` 检查。 |
| **5. 记忆治理与多 Bot/存储底座** | 记忆无确定性守卫且三字段冗余 + 跳数上限偏低 + 无锁同步写盘 | ① `globalMemories === privateSkills` 且三字段同存；② 自动记忆漏记用户身份、乱记临时需求、删除同轮可能回写；③ `阿B管理员` 两次因 `Maximum inter-Bot hop depth (4) reached` 截断关键文件路径同步，Twinkle 发消息后 `sleep 25` 盲等；④ 活跃 `.history.json` 达 3.32MB 仍每步全量同步写盘。 |

---

## 三、P0 / P1 / P2 可执行优化项

> **发布模式说明**：以下全部 **14 项优化**均位于 `src/agent/`、`src/shared/`、`src/lib/`、`src/store/`、`src/server/`、`src/web/` 与 `executor/executor.py`，**不涉及** `src/electron/**`、`electron/*`、`android/**`、`ios/**` 原生壳层，**全部 100% 支持 `ota-only` 热更新交付**。

### 【P0 级：立即止血（直击高费用、低缓存、卡死循环与渠道断层）】— **已完成 (`1b671a4`)**

#### P0-1：重构上下文触发预算与 Prompt 前缀稳定性（解决 550K 膨胀与 `memory_manage` 缓存雪崩） ✅ `已完成 (1b671a4)`
1. **现象与痛点**：长会话输入膨胀至 450K–551K tokens 仍零压缩；同时步内修改记忆/日程/保险箱立即重写 System Prompt 前缀，使数十万 token 的 KV Cache 瞬间归零。
2. **数据实证**：会话 A 累计 Input 90.90M（Max 551,526）、会话 B 80.09M（Max 448,400），LLM 压缩均 **0 次**；`memory_manage`（88 次）调用后下一步 Cache 命中率从 ~99% 骤降至 **0%–0.07%**，单轮花费高达 `$0.3744`。
3. **精确 `file:line` 根因**：
   - `src/shared/context-compression.ts:73-91`：将 `deepseek-flash` / `deepseek-v4` 硬编码为 `1_000_000` 窗口，乘以 `75%–85%` 后阈值高达 750K–850K。
   - `src/agent/loop.ts:1482`：在 `for (let stepNo = 1; ...)` 循环内**每步**重新拼装 `buildSystemInstruction(promptConfig)`。
   - `src/agent/prompt.ts:24-51, 199-251`：将易变的 `botMemories`、`botSchedules`、`vaultItems`、`globalMemories` 无裁剪直拼进位于请求最顶部的静态 System Prompt。
4. **具体改造方案**：
   - **增设有效压缩软上限（Effective Compression Ceiling）**：在 `src/shared/context-compression.ts` 为不同模型/档位引入“成本与注意力甜点上限”（如默认按 `Math.min(modelContextWindow, config.effectiveContextCeiling ?? 160_000)` 计算 `triggerTokens`，同时保留 `>= 200K` 长文档专项任务可配置开关），使 `75%` 默认在 **120K tokens** 左右触发温和增量摘要（40% 低水位保留最近轮次），避免拖到 550K。
   - **冻结轮内 System Prompt 前缀 + 动态状态尾置注入**：在 `src/agent/loop.ts` 轮次开始时计算并冻结 `baseSystemInstruction`（仅包含角色、规则与初始记忆快照）；当步内调用 `memory_manage` / `schedule_manage` / `vault_manage` 修改状态时，**不修改 `systemInstruction`**，而是在工具返回值或本轮末尾追加一条轻量的 `[System State Delta]` `user_input`（或在下一用户轮再刷新系统提示词），保证同轮多步 100% 命中 KV Prefix Cache。
   - **限制 System Prompt 注入条数与长度**：在 `src/agent/prompt.ts:24-51, 199-251` 对注入系统的记忆条数/总字符设硬预算（如记忆最多保留最近/启用的 2,500 字，超限改由 `memory_manage(action: "list")` 按需拉取）。
5. **验收指标**：长会话单步峰值输入控制在 `<= 160K` tokens；同一轮内执行 `memory_manage` 后下一步 Prompt Cache 命中率维持 `>= 85%`；高频长对话单轮均价下降 `>= 45%`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**（修改 `src/shared/`、`src/agent/`）。

---

#### P0-2：修复 Smart Router v2“同模空转”、埋点失真与辅助调用预算黑洞 ✅ `已完成 (1b671a4)`
1. **现象与痛点**：① `fast` 与 `medium` 绑定同一模型时，`standard` 升级和`错误恢复`空转；② 每次非闲聊均先阻塞等待 `router` LLM 2.5–11.5 秒；③ `summary` + `router` 占总调用 52.7% 且完全逃逸单轮费用预算；④ `escalations` 统计全 0。
2. **数据实证**：`route-stats.ndjson` 214 轮 `escalations` 全为 `0`，实际发生 41 次升级/恢复；`standard` 510 次中 **99.0%** 仍调 `deepseek-flash`；`summary` 976 次（Cache 41.4%）+ `router` 121 次（P50 2,510ms / P90 4,777ms）共占 **52.71%** 总调用数。
3. **精确 `file:line` 根因**：
   - `src/agent/router.ts:140-166, 267-294` & `src/agent/route-signals.ts:244-255`：未比较 `m.fast === m.standard`，导致同模时仍发“升级 Argon”及盲目切换名义档位。
   - `src/agent/loop.ts:837-860` & `src/agent/route-planner.ts:58-89, 308-329, 381-385`：开局同步阻塞 `planRoute`（12s 超时），`cacheKey` 漏掉 `recentContext` 致短追问错命中，提示词写死 `Hydrogen/Argon/Carbon`。
   - `src/agent/loop.ts:421`：仅读 `escalationEvents.length`，漏计 `decideEscalation` 自动触发的升级。
   - `src/agent/loop.ts:694-706, 719-721, 1162-1176, 1869-1878, 1892-1896`：每步无节制触发 `scheduleThinkingSummary`，且进度摘要、上下文摘要、记忆提取均未计入 `smart.budget.add(...)`。
4. **具体改造方案**：
   - **同模折叠与真实升档跃迁**：在 `src/agent/router.ts` 与 `src/agent/route-signals.ts:244-255` 判断当 `m.fast === m.standard` 时，将“升级 Argon”改为直接提升 `thinkingLevel`（`low -> medium -> high`）并标记 `skipNominalUpgrade`，若连续受阻（>=2 次失败或长循环）直接按预算放行升级至 `m.deep`（`deepseek-v4-pro`），避免无效同模跳转。
   - **大幅削减 `summary` 与 `router` 辅助调用**：
     - `thinking-summarizer.ts` / `loop.ts:719, 1892`：第 1 步仅在预计多步任务或耗时 >1.5s 时按需触发；连续同类工具或无 `thoughts` 文本的简单工具步直接走零成本 `fallbackThinkingSummary`（本地映射仅 <1ms，无需每步调一次 LLM）；相邻两步至少间隔 `>= 2` 步或工具域切换时再调模型提炼。
     - `route-planner.ts`：扩展纯规则 L0（短追问“继续/好的/行/查一下”及明确单一工具直达任务直接走启发式 `selectRoute`，目标将 `planRoute` LLM 调用率从 ~82% 降至 <=35%）；`cacheKey` 纳入 `recentContext` 摘要哈希及 `hasAttachments`；当配置非 Gemini 主导时动态调整 Planner 提示词描述（去 Gemini 专有词汇）。
   - **统一预算与埋点核算**：
     - 在 `loop.ts:705, 1175` 及 `memory-extractor.ts:277`（传入 `emit` 与 `budget`）将全部辅助调用纳入 `smart.budget.add(...)` 与 `usage` 事件；
     - 在 `loop.ts:421` 与 `route-signals.ts:262` 将 `decideEscalation` 实际执行的升档/救援/恢复次数计入 `autoEscalations`（并汇总入 `route-stats.ndjson` 的 `escalations`）。
5. **验收指标**：辅助调用占比由 `52.7%` 降至 `<= 20%`；简单/常规追问首字前路由延迟（P50）由 `2.51s` 降至 `< 300ms`；`route-stats.ndjson` 真实反映全部 100% 升档事件；全部 LLM 成本纳入 `TurnBudget`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P0-3：打通外部渠道（Telegram / 飞书）媒体投递闭环与安全投递边界 ✅ `已完成 (1b671a4)`
1. **现象与痛点**：在 Telegram / 飞书渠道交互时，Bot 调用 `send_file` 或 `generate_image` 后文件只停留在 App 内卡片，外部端完全收不到；Bot 被迫用 `run_shell + curl` 暴力试错 8 个公共匿名网盘并明文落盘 Token，甚至在 App 内擅自推消息到 Telegram 遭用户喝止。
2. **数据实证**：`Twinkle` Run 05-08 连续两次因收不到文件被用户纠偏，Run 06 连续 7 次 `curl` 外网网盘；Run 16 未经确认直接推送 TG 被「没让你发tg」打断 `ask_user_choice`；沙箱 `/root/.twinkle_tg_token` 留存明文凭据，且原始命令记入 `.ndjson`/`.history.json`。
3. **精确 `file:line` 根因**：
   - `src/lib/channel-manager.ts:458-496`：事件监听器仅收集 `answer`/`assistant_message` 的 `event.text` 进入 `turn.buffer`，完全忽略同轮 `result` 中 `send_file` 与 `generate_image` 产出的文件元数据。
   - `src/lib/channel-integrations.ts:1955-1967`（Telegram）及飞书发送函数：仅调用 `api.sendMessage(chatId, chunk)` 发纯文本，没有复用 `sendPhoto` / `sendDocument`（或飞书 `im.file` / `im.image`）投递本地文件。
   - `src/agent/loop.ts:1831-1843`：仅把 `deliveredFileEmbeds` 追加为 Markdown 链接文本，外部渠道无法解析本地 `/api/files/...` 路径。
4. **具体改造方案**：
   - **渠道回复附件透传**：在 `src/lib/channel-manager.ts` 为每个 `activeTurn` 增加 `pendingMedia: Array<{ path, mimeType, isMedia, name, caption }>`，在监听到 `result`（`name === "send_file" || name === "generate_image"` 且 `ok === true`）时收集物理 `source_path` / `path`；在终态投递阶段（`channel-manager.ts:477-496`）先发文本再调用 `sendTelegramMedia`（`api.sendPhoto` / `api.sendDocument`，遵循 TG 25MB/50MB 上限）与 `sendFeishuMedia` 真实上传发送。
   - **明确同源投递原则与禁用匿名网盘兜底**：在 `src/agent/prompts/app-capabilities.md` 与 `skills-channels-and-vault.md` 明确“从哪个渠道收到指令，默认通过 `send_file` 原路交付，渠道层已自动透传附件；**严禁**未授权上传用户文件至匿名公共图床/网盘，**严禁**在 App 对话中未经 `propose_draft` 或用户明确指令向外部 Telegram/飞书主动推送”。
   - **外部通道与日志密钥脱敏**：增强 `src/lib/file-attachments.ts` / `store/index.ts:appendEvent` 与 `loop.ts:1926` 展示/持久化前的正则脱敏（覆盖 Telegram Bot Token `bot\d+:[A-Za-z0-9_-]{30,}` 等常见格式），防止明文 Token 写入 `.ndjson` 或 `.history.json`。
5. **验收指标**：Telegram/飞书单测验证 `send_file` / `generate_image` 100% 触发媒体接口发送；App 内跨渠道投递需经显式确认；`.ndjson`/`.history.json` 新增事件零明文 Bot Token 落盘。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P0-4：强化死循环检测（交替循环 / 观察空转 / 验证码与 `sleep` 轮询熔断） ✅ `已完成 (1b671a4)`
1. **现象与痛点**：`A -> B -> A -> B` 坐标盲点交替循环、连续 `browser_snapshot`/`read_file` 只读空转、以及 37 次 `run_shell("sleep ...")` 盲等均无法触发 L2 死循环检测，导致 58 步图形验证码卡死 238.5 秒且无人工接管引导。
2. **数据实证**：`阿B管理员` Run 02 在图形验证码死磕 58 步（写 4 个脚本 + 放大盲点），全过程 0 次救援；`Klip 推广官` `run_shell` **30.1%（37/123）** 为 `sleep` 轮询，并多次在 `(183,351) <-> (1084,608)` 来回空点。
3. **精确 `file:line` 根因**：
   - `src/agent/route-signals.ts:123-125`：仅比对上 1 步 `lastCallHash`，无法识别周期 `>= 2` 的 `A->B->A->B` 循环。
   - `src/agent/route-signals.ts:12-19`：`OBSERVE_ONLY_TOOLS` 仅 6 个工具，漏掉 `read_file`、`host_read_file`、`browser_snapshot`、`browser_tabs`、`browser_wait`、`web_search`、`web_fetch`、`mail_list_*`、`app_knowledge`、`system_diagnostics`。
   - `src/agent/route-signals.ts:199-206, 267-275`：预算 >=80% 走 `fast/xhigh` 时 `commitStepTier` 不衰减 `softFailures`，造成救援分支锁死。
   - `src/agent/loop.ts:1277-1279, 1294-1301`：`baseTier` 单向棘轮只升不降，且单步 `smartEsc` 忽略原 `step_plan` 后续阶段规划。
   - `src/agent/loop.ts:2155, 2253`：单步多工具连调 `SCREEN_CHANGING` 时 `lastScreenSha1` 未在步内更新。
4. **具体改造方案**：
   - **滑动窗口循环检测（支持周期 1~3 的 `A-B-A-B`）**：在 `RouteRuntime` 中维护最近 8 次调用哈希窗口 `recentCallHashes`，检测到 `A->B->A->B` 重复模式或连续 `>= 3` 次 `screen_changed === false` 时即触发降噪/重规划 nudge；针对 `run_shell` 检测纯 `sleep` 命令（`/^\s*(sleep\s+\d+|for\s+.*sleep)/`）累计 `>= 2` 次立即注入 `[System Notice]` 禁止短轮询，改为单次带超时阻塞等待或直接报错/引导。
   - **扩充 `OBSERVE_ONLY_TOOLS` & 修复状态机缺陷**：补全 `read_file`、`host_read_file`、`browser_snapshot`、`browser_tabs`、`browser_wait`、`web_search`、`web_fetch`、`mail_list_accounts`、`mail_list_messages`、`app_knowledge`、`system_diagnostics`；在 `commitStepTier` 中当走 `fast/xhigh` 救援分支时同样将 `softFailures >= 2` 衰减为 `1`；并支持连续 3 步 `ok` 后允许 `baseTier` 回落至 `step_plan` 原定档位。
   - **验证码 / GUI 死锁自动接管熔断**：在 `loop.ts` / `tools.ts` 中，当 `browser_snapshot` 返回 `challenge_detected: true`（`tools.ts:335` 已有该字段）或连续 `>= 4` 步出现 GUI `screen_changed === false` / `element_count === 0` 且处于登录/验证码页时，强制提醒或自动触发 `pause` + 发送提示引导用户打开左侧「Bot 的电脑」扫码/人工接管，禁止无休止 OCR 脚本穷举。
   - **步内更新 `lastScreenSha1`**：在 `loop.ts:1903-2277` 的 `for (const call of turn.calls)` 内，每次 `screenshotBuf` 返回立即刷新 `lastScreenSha1`，且首个动作发生 `error` 或关键坐标无变化时中止同批后续盲目坐标动作（补齐 `toolResultSteps` 配对结果）。
5. **验收指标**：`A->B->A->B` 循环在第 4 次调用内 100% 触发重规划；验证码/空点场景不再跑超 15 步；单测覆盖周期循环、预算 xhigh 衰减、只读空转与 `step_plan` 恢复。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

### 【P1 级：高频体验与工具工程提效（减少审批弹窗、消除读写报错与降延迟）】

#### P1-1：新增分片 `read_file`/`host_read_file` 与局部精确 `edit_file`/`host_edit_file` 工具
1. **现象与痛点**：修改较大文件（如 `docs/product-issues.md`）必须整文件覆写，既浪费输出 Token 又频频触发敏感写入审批弹窗；读取大文件缺乏行号范围过滤。
2. **数据实证**：会话 A 调用 `host_write_file` 11 次**全部**为整文件覆写 `docs/product-issues.md`，11 次全部弹审批（最长等 `151.3s`）；模型因缺局部读取和编辑工具，193 次高频依赖 `host_run_shell` + `Get-Content`/PowerShell 拼接脚本读写。
3. **精确 `file:line` 根因**：
   - `src/agent/tools.ts:281-294`（`read_file`）与 `src/agent/host-tools.ts:82-95, 430-456`（`host_read_file`）均不支持 `start_line` / `end_line`。
   - `src/agent/tools.ts` 与 `src/agent/host-tools.ts` 均缺失 `edit_file` / `host_edit_file`（按 `target` 精确替换或 `append` 工具）。
4. **具体改造方案**：
   - 为 `read_file` / `host_read_file` 增加可选参数 `start_line`、`end_line`（返回带行号区间文本与 `totalLines`、`hasMore`）。
   - 新增 `edit_file` 与 `host_edit_file`（支持 `target` -> `replacement` 精确替换，及 `append: true` 尾部追加），接入与 `write_file` / `host_write_file` 一致的 `assessToolCall` 安全策略校验与单文件并发锁；并在提示词中引导优先用 `read_file` + `edit_file` 替代 `run_shell` 拼接改文件。
5. **验收指标**：追加/局部修改文件输出 Token 减少 `>= 70%`；`host_run_shell` 用于纯读文件占比显著下降；单测覆盖越界行号、多处匹配拦截与路径策略检验。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-2：按需裁剪工具 Schema 声明，消除非 Admin Bot 越权与纯对话工具膨胀
1. **现象与痛点**：每轮无论任务类型和 Bot 权限，均无差异注入 42–48 个工具的完整 JSON Schema，增大 `overheadTokens` 与误调用率。
2. **数据实证**：纯寒暄“你好”仍携带全套 40+ 工具（`阿B管理员` `seq=1258` 收到“你好”后竟主动调 `browser_snapshot` 打开后台）；普通 Bot 可看到标有 `ADMIN-BOT EXCLUSIVE` 的工具并在运行时被拒。
3. **精确 `file:line` 根因**：
   - `src/agent/loop.ts:1023-1025, 1464-1471`：仅过滤了 `mail_*` 与 `channel_pairing_manage`，未按 `isAdminBot` 过滤 `computer_provision`、`account_manage`、`self_update`（`src/agent/bot-tools/declarations.ts:1047-1137`）。
   - 纯闲聊/问答（`plan.complexity === "trivial" && plan.category === "chat" && !plan.needs_visual`）依然注入全部桌面坐标（`click`、`drag`、`scroll`、`screenshot`）与宿主机工具。
4. **具体改造方案**：
   - 在 `src/agent/loop.ts:1464` 根据 `isAdminBot` 严格剔除 `computer_provision`、`account_manage` 与仅 Admin 可用的管理参数；
   - 对 `smart.plan.complexity === "trivial" && smart.plan.category === "chat" && !smart.plan.needs_visual` 首步仅暴露轻量化核心工具集（如 `memory_manage`、`app_knowledge`、`web_search`、`route_escalate` 等，不含重型桌面鼠标键盘及危险 Shell 工具；若后续用户追问或模型调 `route_escalate` 立即热解锁全集，注意保持工具列表变化尽量跨轮而非同轮内破坏前缀缓存）。
5. **验收指标**：非 Admin Bot 越权调用工具次数降为 `0`；纯文本对话 `overheadTokens` 降低 `>= 45%`；闲聊误触浏览器/桌面工具降为 `0`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-3：优化 Windows `host_run_shell`（WSL 直通、CLIXML 误报消除与只读命令降噪）
1. **现象与痛点**：Windows 下模型频繁将 Linux `| tail`、WSL bash 引号混入 PowerShell 导致崩溃；Git/WSL 输出 CLIXML 到 stderr 引起 `exitCode=1` 误判；`Get-ChildItem` 等只读命令也弹确认。
2. **数据实证**：`博客管理员` 出现 6 次 PS↔WSL 转义报错并诱发 2 次 Carbon 救援；会话 A `host_run_shell` 7 次失败中有 6 次为 PowerShell CLIXML stderr 误报（实际命令已成功）；`博客管理员` `seq=26` 执行 `Get-ChildItem` 触发人工审批。
3. **精确 `file:line` 根因**：
   - `src/agent/host-tools.ts:25-52, 178-287`：`host_run_shell` 无 `shell`（`"powershell" | "wsl"`）显式参数，模型必须手工拼装 `wsl -e bash -lc "..."` 多层转义；`runHostShellCommand` 未配置 `$ErrorActionPreference = 'Continue'` 对原生 exe CLIXML 降噪，且严格以 `code === 0` 判定 `ok` 时易受 PS stderr 包装干扰。
   - `src/agent/policy.ts:673, 718`：虽然 `Get-ChildItem` 未在 `DANGEROUS_COMMAND_NAMES` 中，但若模型自带 `risk: "high"` 或命令中包含管道/路径触发规则则无法像 `host_read_file` 那样被识别为纯只读探索（检查 `isHostShellSafeForAlwaysMode` 及 `allowRules` 覆盖）。
4. **具体改造方案**：
   - 为 `host_run_shell` 增加可选 `shell?: "auto" | "powershell" | "wsl"` 与 `wsl_distro?: string` 参数：当 `shell === "wsl"` 时由 Node 宿主机直接 `spawn("wsl.exe", [...(distro?["-d",distro]:[]), "--", "bash", "-lc", command])`，彻底绕过 PowerShell 引号转义地狱和 CRLF 污染。
   - 在 `buildWindowsPowerShellEncodedCommand`（`host-tools.ts:178-184`）补充清洗或抑制 PowerShell CLIXML 进度流（如 `[Console]::Error` 剥离 `#< CLIXML` 标签，避免原生 `git` 等 stderr 进度被 PS 包装成异常退出码）。
   - 在 `policy.ts:356-360` 增强只读白名单判定（如纯 `Get-ChildItem` / `dir` / `git status` / `git log` / `git diff` 在无写重定向、无危险子命令时，忽略 LLM 误标的 `risk: "high"`）。
5. **验收指标**：Windows + WSL 场景下 `host_run_shell` 语法/转义失败率降低 `>= 80%`；CLIXML 误报 `exitCode=1` 降为 `0`；常规只读目录检索审批弹窗降为 `0`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-4：精简记忆存储结构与双轨触发守卫（去冗余、防删后回写、补齐主控画像）
1. **现象与痛点**：① `globalMemories` 与 `privateSkills` 双份同存；② 每条记忆三字段重复 `desc === instruction === content`；③ 删除/关闭某条记忆同轮结束仍可能被后台重新提取写回；④ 超过 24 字普通指令即触发后台 LLM 提取；⑤ `Twinkle` 主控无 `rolePrompt`。
2. **数据实证**：`settings.json` 双份存储 4 条全局记忆；23 条记忆持久化体积膨胀 3 倍；两主会话均出现过记忆自相矛盾、乱记一次性 Issue 细节及漏记核心身份，用户多次喊停“整理记忆”。
3. **精确 `file:line` 根因**：
   - `src/agent/memory-extractor.ts:355-358`、`src/agent/bot-tools/system-tools.ts:165-168`、`src/agent/prompt.ts:227-231`：保留遗留双写 `privateSkills: nextGlobalList`，且 `desc/instruction/content` 三字段冗余写入。
   - `src/agent/memory-extractor.ts:54-55`：只要 `text.length >= 24 && hasAssistantReply` 即放行后台提取。
   - `src/agent/loop.ts:1861, 1970-1972`：仅 `call.args?.action === "save"` 时置 `memoryManagedInTurn = true`，`remove`/`toggle` 未置位。
4. **具体改造方案**：
   - **收敛持久化字段与停止双写**：写入时仅存单一正文字段 `content`（读取端兼容 `m.content || m.instruction || m.desc` 过渡），不再把 `globalMemories` 镜像写入 `privateSkills`（读取迁移后逐步清空旧字段）。
   - **严格化后台提取门控 & 修复 `remove/toggle` 同轮防回写**：将 `loop.ts:1970` 改为任意 `memory_manage` 写操作（`save`/`remove`/`toggle`）均置 `memoryManagedInTurn = true`；收紧 `shouldRunMemoryExtraction`（对不含 `EXPLICIT_MEMORY_*` 或 `SIGNAL_MEMORY_*` 关键词的纯任务指令，提高阈值至 `>= 60` 字或检测纠偏/偏好特征句式再触发，减少无效后台 LLM 调用）。
   - **默认主控模板补全**：检查并确保默认主控初始化（`src/store/index.ts:385`）具备精炼的默认 `rolePrompt`（覆盖调度定位、工作边界与默认协作原则），避免空白人设。
5. **验收指标**：记忆持久化体积减少 `>= 65%`；无偏好信号的普通长指令后台提取误触发降低 `>= 70%`；删除记忆后同轮回写率为 `0%`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P1-5：提升 `browser_snapshot` 稳定性、支持本地预览与跨 Bot 工作区路径自认知
1. **现象与痛点**：复杂 SPA 页面 `browser_snapshot` 频繁返回 `element_count: 0` 或 36s 超时；`open_url` 拒绝 `file://` 迫使模型自启 HTTP 服务看图；跨 Bot 读交付物不知道宿主机/WSL 挂载映射路径导致全盘 `find /` 超时 60s。
2. **数据实证**：`阿B管理员` 出现 3 次 `element_count: 0`、1 次 `browser_snapshot` 36.2s 超时（后触发 `stopped`）、1 次 `open_url` 报 `invalid scheme: file`、1 次 `find / -maxdepth 6` 60s 超时。
3. **精确 `file:line` 根因**：
   - `executor/executor.py:3026` & `src/lib/local-chrome-cdp.ts:1036`：`browser_snapshot` 导航后缺少短暂 DOM 稳定等待，且超时未优雅降级返回已加载摘要或 `iframes` 结构。
   - `executor/executor.py:1713, 2895, 3032`：严格校验仅允许 `http/https`，拒绝合法工作区内的 `file://` 预览（或未在提示中引导使用 `send_file`）。
   - `src/agent/prompt.ts:65-75`：仅告知当前 Bot 自己的 `botWorkspaceRoot`，未说明与同机其他 Bot 共享的工作区父目录及 Windows/WSL 映射关系（`/mnt/c/...`）。
4. **具体改造方案**：
   - 在 `executor/executor.py:3026` 与 `src/lib/local-chrome-cdp.ts:1036` 为 `browser_snapshot` 增加可选 `wait_ms`（导航或 `element_count === 0` 时自动短等 800ms 重采一次），并设置单次评估硬超时（如 15s 内优雅截断 DOM 遍历返回已有元素与诊断信息，避免卡死 36s+）。
   - 引导 Bot 预览本地图片/报告时优先使用 `send_file`（前端直接内联预览），或允许 `browser_snapshot`/`open_url` 对当前 `botWorkspaceRoot` 内的安全本地 `.html`/图片 `file://` 预览开放只读白名单（阻断敏感系统目录）。
   - 在 `src/agent/prompt.ts:72` 与 `list_bots` 返回中补充工作区父目录路径与跨平台路径提示（Windows 宿主机 vs Ubuntu 沙箱 `/mnt/...`）。
5. **验收指标**：SPA 页面首调 `browser_snapshot` 空骨架率下降 `>= 60%`，不再发生 >20s 的无响应卡死；跨 Bot 查找共享文件不再出现 `find /` 全盘扫描。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**（含 `executor/executor.py` 走 Core OTA 随包更新）。

---

#### P1-6：安全策略闭环（封堵 Shell 读敏感路径、补齐 PowerShell 规则与模式一致性）
1. **现象与痛点**：文件工具严防死守的 `.ssh`/`vault.json`/`.env` 及跨 Bot 私有目录，可被 `run_shell` / `host_run_shell` 用 `cat`/`Get-Content` 直接读取；PowerShell 高危命令扫描存在盲区；`sandboxMode="full"` 短路了 `write_file` 的 `writeRoots` 校验。
2. **数据实证**：`agent-code-map.md` 与 `policy.ts` 源码审计直接确认的 4 处策略不一致缺陷（含 `policy.ts:497 vs 554`、`604-612`、`681-693`）。
3. **精确 `file:line` 根因**：
   - `src/agent/policy.ts:515-541` vs `604-612, 716-725`：`run_shell` / `host_run_shell` 仅检查导出钥匙串和写入重定向，未对命令参数中的敏感路径做 `isPathDenied` / `isOtherBotPrivateWorkspacePath` 校验。
   - `src/agent/policy.ts:66-100, 127-207`：未解析 PowerShell 反引号转义、`` @'...'@ ``、`iwr/irm ... | iex` 及 `rd`/`rmdir`/`clear-content`/`set-content`/`reg`/`bcdedit`/`schtasks`/`icacls`。
   - `src/agent/policy.ts:554`：`browser_upload_file` 回落 `hostExecutionMode || "ask"`，与 `:497` 默认 `"always"` 冲突。
   - `src/agent/policy.ts:681-693`：第 4 步 `sandboxMode === "full"` 直接放行 `write_file`，跳过了第 7 步 `writeRoots` 检查。
4. **具体改造方案**：
   - 在 `assessToolCall` 的 Shell 检查阶段（`policy.ts:604`）提取命令行路径/令牌，命中 `isPathDenied` 时直接 `deny`，命中 `isOtherBotPrivateWorkspacePath` 时返回 `confirm`；
   - 补齐 `policy.ts` Windows PowerShell 转义解析、`PIPE_TO_SHELL_RE`（`iwr|irm ... | iex`）及高危 cmdlet 集合；
   - 统一 `browser_upload_file` 默认模式读取（`config?.hostExecutionMode || "always"`）；在 `policy.ts:682-692` 保留非空 `writeRoots` 边界验证（允许 `botWorkspaceRoot` 及 `/tmp` 临时运行目录，防止沙箱内越界污染）。
5. **验收指标**：新增安全单测覆盖 Shell 读 `.env`/`vault.json` 拦截、PowerShell `irm | iex` / `Remove-Item` 拦截、`writeRoots` 边界校验 100% 通过。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

### 【P2 级：长期质量、协同与底座健壮性（控制流、跨 Bot、检索与存储）】

#### P2-1：跨 Bot 协同升级（动态防环跳数、回执合并与事件等待回调）
1. **现象与痛点**：`MAX_BOT_HOPS = 4` 硬限制阻断正常业务多轮对齐；跨 Bot 发消息后发起方立即返回，模型只得 `run_shell("sleep 25")` 干等；同一 Bot 2 秒内连续发双回执浪费配额。
2. **数据实证**：`ex_9320769ca26aec76` 中 `阿B管理员` 两次因 `Maximum inter-Bot hop depth (4) reached`（`seq=599, 633`）丢掉关键原图路径；`Twinkle` 发消息后紧跟 `sleep 25`；`ex_1aa548d7` / `ex_9320769c` 多次出现 2–3 秒双回执。
3. **精确 `file:line` 根因**：
   - `src/agent/bot-tools/declarations.ts:43` & `src/agent/bot-tools/collab-tools.ts:301`：`MAX_BOT_HOPS` 硬编码为 `4`，且每次双向消息无条件 `+1`（`collab-tools.ts:855`）。
   - `src/agent/bot-tools/collab-tools.ts:321-331, 791-864`：`send_bot_message` 仅投递不提供 `wait_for_reply` 或完成回调唤醒原发起会话的能力。
4. **具体改造方案**：
   - 将 `MAX_BOT_HOPS` 提升至 `8`（并支持按 `exchangeId` 去重与循环检测，如连续 3 次内容相似度 `> 0.85` 才触发防环阻断）；
   - 为 `send_bot_message` 增加可选 `await_reply?: boolean`（带超时等待目标 Bot 产出结果并直接作为工具返回值带回，或支持完成后异步回调唤醒发起方），彻底消除 `sleep 25`；
   - 在 `deliverInterBotMessage` 中对同一对 Bot `3s` 内重复提交的相似文本合并防抖，并在提示词中要求发完协作消息即可先结束当前等待。
5. **验收指标**：多轮对齐业务不再在 4 跳时被硬切断；跨 Bot 协作 `run_shell("sleep ...")` 等待次数降为 `0`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-2：修复控制流边界毛刺（`pause` 即时止动、长思考短输出拦截、清理历史过时文案）
1. **现象与痛点**：用户点击暂停后，已在途的模型步在返回后依然继续执行写操作；模型耗尽 2,348 thoughts tokens 后仅输出 `"扫完"` 2 字就结束；工具声明和提示词仍残留 `"Mac"`/`"Finder"`/`"1440x900"`/`"Nori"` 等陈旧字样。
2. **数据实证**：会话 A 在 `14:24:40` 触发 `paused` 后，在途步于 `14:24:42-44` 继续运行 `host_run_shell` 创建了 GitHub Issue；会话 A 第 289 步 `thoughts=2,348` 后只吐 `"扫完"` 2 字导致用户追问 `"怎么停下了"`。
3. **精确 `file:line` 根因**：
   - `src/agent/loop.ts:1230` 仅在循环顶部调用 `waitIfPaused()`；当推理进行中用户点 `pause` 时，`loop.ts:1903` 的工具循环与 `executeApprovedCall`（`:2067`）未检查 `ctrl.isPaused?.()`。
   - `src/agent/loop.ts:1714` 仅拦截 `trimmedTurnText === ""`，对“经过 `thoughts > 1000` 且工具已执行但最终 `answer` 极短（`< 6` 字且无嵌入物）”的情况未做续写提示。
   - `src/agent/tools.ts:106-228` 硬编码 `1440x900`；`declarations.ts:325-333, 1029`、`collab-tools.ts:172` 写死 Mac/Finder；`system-tools.ts:678`、`integrations.ts:1097` 写死 `"Nori"`；`integrations.ts:1200-1210` 在 `upsert` 传入新 `account_id` 时若找不到直接报错。
4. **具体改造方案**：
   - 为 `createControl()`（`loop.ts:256`）暴露 `isPaused()`，在模型返回后进入 `for (const call of turn.calls)` 前（`loop.ts:1903` 之前）以及每个工具执行前若检测到 `ctrl.isPaused()`，立即先挂载 `await ctrl.waitIfPaused()`（保留模型本步原始 `turn.calls` 在 `history` 中待恢复后执行，或先挂起不落副作用）；
   - 当 `turn.calls.length === 0` 且 `turn.usage?.thoughts >= 800` 而 `trimmedTurnText.length <= 6` 且不含确认态词时，触发 1 次温和纠偏要求补充完整结论；
   - 清理 `tools.ts`（动态屏幕分辨率提示）、`declarations.ts`/`collab-tools.ts`（改为跨平台 `local computer` / `file manager`）、`system-tools.ts`/`integrations.ts`（统一读默认管理员名 `"Twinkle"`，`skill_configure_channel(action="upsert")` 允许创建指定 `account_id` 或给出明确提示）。
5. **验收指标**：`pause` 生效后 0 次在途副作用工具继续执行；极短废回复自检命中并补全；工具描述中零单 OS/错误默认名称硬编码。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-3：优化 `web_search` 中文时效检索排序与定时任务执行保障
1. **现象与痛点**：国内网络无 Google 时 `web_search` 默认首选 Bing，导致中文 + `freshness="day"` 查询返回首页全为静态百科/教程页，污染定时简报并曾导致 Bot 误报代码缺陷；定时任务在会话忙时直接静默跳过。
2. **数据实证**：`2026-11-26` 早上 8 点定时简报两次 `web_search` 均被 Bing 静态百科污染，靠 `web_fetch` 门户首页兜底；该问题亦直接诱发了 `Twinkle` 向项目管家误派 Issue #20。
3. **精确 `file:line` 根因**：
   - `src/lib/web-search.ts:530-533`：引擎优先级写死 `["bing", "duckduckgo", "baidu"]`（无论查询是否为中文或带 `freshness`）。
   - `src/agent/scheduler.ts:156-178`：遇到 `runner.isSessionBusy(item.sessionId)` 直接 `continue` 且不记录跳过状态；触发 `runner.start` 即推进 `nextRunAt`，不追踪执行成败。
4. **具体改造方案**：
   - 在 `src/lib/web-search.ts:530` 中，当 `cleanQuery` 包含中文且处于实时/时效查询（`effectiveFreshness` 存在）且不可达 Google 时，将引擎优先级调整为 `["baidu", "bing", "duckduckgo"]`（或并行抓取 Baidu + Bing 去重排序），并对 `baike.baidu.com` / 纯词条静态页在 `freshness="day"` 模式下做降权过滤；
   - 在 `src/agent/scheduler.ts:156` 当会话忙时改用 `runner.enqueue` 排队或设置短延迟重试（最多 5 分钟窗口），并记录 `lastRunStatus` / `lastRunError` 至 `schedules.json`。
5. **验收指标**：中文时效检索前 5 条百科静态页占比降至 `< 10%`；定时任务在并发对话忙时不再静默丢触发。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

#### P2-4：群聊协同连贯性、审批精准路由与存储层锁/I/O 性能加固
1. **现象与痛点**：群聊存在历史上下文断层、与 `steer` 割裂及无边界 `@` 误匹配；`approve`/`choose` 未命中 `callId` 时误落回首个活跃会话；`store` 全量同步写盘无互斥锁且每步重序列化 3.3MB 历史。
2. **数据实证**：`sessions/` 已有 3.32MB / 1,230 条的 `.history.json`，每步全量写盘已成热点；源码审计定位了 4 处跨模块并发/状态错位隐患。
3. **精确 `file:line` 根因**：
   - `src/agent/runner.ts:504`（`skipHistorySave: true`）、`:310-316`（群聊 `steer` 未刷新 `pendingSpeakers`）、`:816-840`（`approve`/`choose` 兜底 `resolveTargetEntry()`）。
   - `src/agent/group-coordinator.ts:20-47, 140-161`：`indexOf('@name')` 无边界匹配，零分时硬选前 2 Bot。
   - `src/store/index.ts:188-233, 410-429, 455-562, 769-839`：全量同步读写、无单域写互斥、`truncateSessionFromSeq` 依赖 `user` 事件数与 `skipUserEvent` 不对齐。
4. **具体改造方案**：
   - **修复审批精准路由**：删除 `runner.ts:823-826, 836-839` 中“找不到 `callId` 时回落首个活跃会话”的危险逻辑，未命中则仅记录日志/忽略。
   - **群聊防误触与状态连贯**：`group-coordinator.ts` 改为边界正则匹配 `@BotName`；无明确提及且相关性均为 0 时仅让管理员或单个最匹配成员回复；`buildGroupPromptContext` 增加最近工具产出摘要与附件描述，并支持 `steer` 唤醒重算发言队列及透传 `hopDepth`。
   - **存储层优化**：在 `src/store/index.ts` 增加 `readEventsTail` / 增量内存缓存避免每轮全量 `JSON.parse` 整份 `.ndjson`；`saveHistory` 去掉格式化缩进（`JSON.stringify` 紧凑输出体积减 ~35% 并支持按会话防抖/原子写入）及在 `truncateSessionFromSeq` 优先按 `seq` 锚定或校验 `skipUserEvent` 标记；为 `writeSettings`/`writeSchedules`/`updateSession` 添加同步读-改-写串行化保护。
5. **验收指标**：`approve`/`choose` 跨会话串线率为 `0`；群聊单测覆盖 `@` 边界、工具摘要透传与 `steer`；`store` 并发写入单测零丢更新，`.history.json` 单步序列化耗时降低 `>= 40%`。
6. **是否支持 `ota-only`**：**支持（`ota-only`）**。

---

## 四、分阶段实施排期与单测 / E2E 验证方案

### 4.1 分阶段实施排期（全部基于 `ota-only` 增量演进）

| 阶段 | 状态 | 目标定位 | 纳入优化项 | 预期收益 |
|---|---|---|---|---|
| **Phase 1：止血降本与防死循环**（第 1 周） | **已完成 (`1b671a4`)** | 优先切断 550K 费用热点、辅助翻倍开销、渠道媒体断层与 GUI 死循环 | **P0-1**（上下文 160K 甜点上限 + 轮内冻结 System Prompt）<br>**P0-2**（同模折叠 + `summary`/`router` 降频 + 预算/埋点闭环）<br>**P0-3**（Telegram/飞书 `send_file` 媒体透传 + Token 脱敏）<br>**P0-4**（`A-B-A-B` 检测 + 观察工具补全 + 验证码接管熔断） | • 综合 LLM 费用下降 **50%+**<br>• 辅助调用占比降至 **≤20%**<br>• 外部渠道交付闭环打通<br>• 消除 50+ 步验证码空转 |
| **Phase 2：工具提效与安全加固**（第 2 周） | 待实施 | 减少高频工具失败与审批打断，补齐安全边界 | **P1-1**（分片 `read_file` + `edit_file` / `host_edit_file`）<br>**P1-2**（按角色/场景裁剪工具声明）<br>**P1-3**（`host_run_shell` `shell:"wsl"` + CLIXML 消除 + 只读降噪）<br>**P1-4**（记忆去冗余 + 严格提取守卫 + `Twinkle` 人设补全）<br>**P1-5**（`browser_snapshot` 稳态化 + 共享路径认知）<br>**P1-6**（Shell 敏感路径拦截 + PowerShell 规则 + 策略对齐） | • 写文件审批弹窗大幅减少<br>• Windows WSL 失败率下降 **80%+**<br>• 闲聊工具 `overheadTokens` 减半<br>• 消除 Shell 读取敏感文件安全漏洞 |
| **Phase 3：协同、调度与底座健壮**（第 3 周） | 待实施 | 完善多 Bot 协同、控制流毛刺与存储层高并发性能 | **P2-1**（`MAX_BOT_HOPS=8` + 去重 + 协作等待/回执合并）<br>**P2-2**（`pause` 即时止动 + 长思考短回复自检 + 文案清理）<br>**P2-3**（`web_search` 中文时效优先百度 + 定时忙时排队）<br>**P2-4**（审批精准路由 + 群聊连贯性 + `store` 缓存/压缩/互斥） | • 消除 `pause` 越界落盘与审批串线<br>• 跨 Bot 协作摆脱 `sleep 25` 盲等<br>• `.history.json` 读写耗时显著下降 |

### 4.2 自动化验证矩阵（单测 + Executor 测 + Tiered E2E）

每完成一个 Phase 合入前，按以下层级递进执行验证（遵循仓库 `AGENTS.md` 规范）：

1. **静态类型检查与构建验证**：
   ```bash
   npm run typecheck
   npm run build:ota
   ```
   - 核验 `src/shared/`、`src/agent/`、`src/lib/`、`src/store/`、`src/server/` 编译及 `dist-server/core-runtime/server-bundle.mjs` 打包零错误。

2. **Node 原生单元测试（`npm test`）—— 必跑并补充以下新用例**：
   - `context` / `loop` 测试：验证 160K 软上限触发增量摘要；验证同轮调用 `memory_manage(save/remove/toggle)` 时 `systemInstruction` 字符串字节一致（保持 KV Cache 不破），且 `remove`/`toggle` 阻断同轮后台记忆提取。
   - `route-signals` / `router` / `route-stats` 测试：覆盖 `fast === standard` 同模折叠；覆盖 `A->B->A->B` 周期循环检出；覆盖预算 80% 走 `fast/xhigh` 后 `softFailures` 正确衰减；覆盖 `decideEscalation` 自动升档计入 `escalations` 与辅助模型费用计入 `TurnBudget`。
   - `policy` & `host-tools` 测试：覆盖 `run_shell`/`host_run_shell` 拦截 `cat ~/.ssh/id_rsa` / `Get-Content vault.json` / 跨 Bot 私有目录；覆盖 `irm ... | iex` / `Remove-Item` 拦截；覆盖 `sandboxMode="full"` 下的 `writeRoots` 校验；覆盖 `host_run_shell(shell:"wsl")` 与 CLIXML 清洗；覆盖 `edit_file` / 分片 `read_file`。
   - `channel-manager` & `channel-integrations` 测试：Mock Telegram/飞书 API 验证 `send_file` 与 `generate_image` 产出的本地路径经 `sendPhoto`/`sendDocument` 透传，且日志/事件脱敏不落盘 Bot Token。
   - `runner` / `group-coordinator` / `store` 测试：覆盖 `approve`/`choose` 未命中 `callId` 时不回落误触发其他会话；覆盖 `pause` 挂起在途工具；覆盖并发写入 `settings`/`sessions` 零丢失。

3. **Ubuntu 沙箱 Executor 单元测试**：
   ```bash
   orb -m ubuntu python3 -m unittest discover -s executor -v
   ```
   - 补充覆盖 `browser_snapshot` 短等待重采与超时截断、`open_url` 白名单本地工作区预览安全校验。

4. **分级端到端测试（`twinklebot-e2e` Skill / Headless）**：
   - Phase 1/2/3 完成后按影响面执行局部校验与回归审计：
     ```bash
     npm run e2e:audit
     npm run e2e:sync-check
     node scripts/run-e2e.mjs --tier=p0
     ```
   - 针对核心交互卡片（`send_file`、审批卡、`max_steps` 续跑、`memory_manage` 与定时任务）、`smart_router` 及 `web_search` 跑对应套件（`--suite=...`），确认 `test-results/reports/latest.md` 全绿且不引入任何回归。

5. **OTA 热更新交付门禁**：
   - 因本计划全部改造均落在非原生壳层，待所有 Phase 验证通过并由用户确认提交推送后，直接通过 `ota-*` 标签（或 `release.yml` `mode=ota-only`）发布 **Core + Web OTA**，无需执行 `npm run version:bump` 或重发桌面/移动端原生安装包。
