# TwinkleBot 全量分级 E2E 测试计划（SSOT）

> 本文件由技能 `/twinklebot-e2e` 与机器映射源 [catalog.json](./catalog.json) 共同维护。当前共登记 **14 个分级套件 / 110 项原子用例**（P0: 21 · P1: 47 · P2: 30 · P3: 12），覆盖全仓库 6 大静态审计维度 100%（源码文件 / HTTP API 路由 / Bot·宿主机·沙盒工具 / Executor 端点 / Web UI 组件 / API 能力声明）。

## 一、二维优先级矩阵（功能层级 × 测试难易度）

| 功能层级 \ 测试难易度 | **D1 低**（纯 API / 确定性 DOM） | **D2 中**（多步 UI / 协议桩 / WebSocket / 移动端） | **D3 高**（真实 OrbStack X11 / Electron / OTA / 公网真 API） |
| :--- | :---: | :---: | :---: |
| **F1 核心主链路**（引导/对话/安全红线/审批/凭据/加密/双轨记忆/沙盒/配对） | **P0** | **P0** | **P1** *(实网冒烟归 P3)* |
| **F2 重要业务模块**（群聊/跨 Bot/内置工具/提示词/卡片/邮箱/MCP/路由/账单/弱网离线/移动端） | **P1** | **P1** | **P3** |
| **F3 细小微交互与边缘红队**（设置项/SSR/头像/紧凑轨/快捷键/CLI/官网/托盘/探针/混沌红队） | **P2** | **P2** | **P3** |

## 二、五大运行面与双模外部依赖

1. **Web 桌面端**：原生 Chrome CDP（macOS 默认可见 + HUD 状态角标，CI 自动无头；跨主/子标签页全局捕获零漏报 `pageerror` / `console.error`）。
2. **Ubuntu 沙盒 (`executor/executor.py`)**：OrbStack `ubuntu` / Linux `Xvfb`/`Xtigervnc` 真实 Google Chrome 多标签共享 Profile、物理 X11 输入（含敏感剪贴板擦除）与全 26 个 Executor HTTP 端点契约。
3. **移动端 (`dist-web/`)**：`APP_TARGET=mobile` 构建产物（mtime 自动增量重编）+ 375×667 / 390×844 触屏视口 + 真实触摸滑动手势 + Capacitor 桥接桩（含 WebUpdater OTA）。
4. **Electron 桌面端**：真实 Electron 主进程启动、端口回退、数据目录隔离、IPC 桥、托盘 `tray.html`、全部 8 项菜单指令与 OTA 看门狗回滚。
5. **CLI、官网 Landing 与 SSR**：`dist-server/src/cli/index.js`（含真实 `readline [y/N]`、`max_steps` 与双次 SIGINT）+ `landing/index.html`（4 大 OS UA + 7 项 Release 链接）+ `ssr-entry.js` 全量静态标记渲染。
- **默认离线确定性模式**：通过 `test/helpers/e2e-protocol-fixtures.ts` 提供本地 HTTP/SSE LLM（含 Gemini `/v1beta/interactions`）、IMAP/POP3/SMTP、Stdio MCP、OTA 归档与静态测试站点，零外网、零费用。
- **可选实网冒烟**：仅当显式设置 `TWINKLEBOT_E2E_LIVE=1` 且存在 `.env` 时运行 `P3-LIVE-01`。

## 三、新增功能定级、定向过滤与审计规范

1. 每次新增 API 路由、UI 弹窗/组件、Bot 工具、Executor 接口或 API 能力，按上表定级并分配唯一用例 ID：`P<0-3>-<AREA>-<NN>`（如 `P1-NET-01`、`P2-SSR-01`）。
2. 同步更新三处：对应 `test/e2e/*.e2e.ts`（或 `executor/test_e2e_*.py`）、`references/catalog.json` 与本表。
3. 常用命令：
   - 覆盖率 6 维静态审计：`npm run e2e:audit`
   - 列出全部套件与用例：`npm run test:e2e:list`
   - 按单套件 / 单用例精准执行：`node scripts/run-e2e.mjs --suite=<id>` 或 `node scripts/run-e2e.mjs --case=<ID>`
   - 校验目录双向一致性：`node --test dist-server/test/e2e-skill-sync.test.js`

## 四、全量原子用例总表（110 项）

| 优先级 | 用例 ID | 维度 | 所属套件 | 模块 | 用例标题 |
| :---: | :--- | :---: | :--- | :--- | :--- |
| **P0** | `P0-ONB-01` | `F1×D1` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Onboarding / Session Bootstrap | 空工作台自动初始化唯一置顶管理员 Bot Twinkle 并弹出首屏引导遮罩 |
| **P0** | `P0-ONB-02` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Onboarding / Providers | 引导页 4 类供应商预设切换、去重联动 3 档、测速(败/胜)与提交脱敏落盘 |
| **P0** | `P0-GEM-01` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Gemini Driver | 原生 Gemini Interactions API 驱动链路：thought_tokens 计费与 invalid thought signature 自动剥离重试 |
| **P0** | `P0-CHAT-01` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Chat / Composer | 单聊收发(Enter 发送 / Shift+Enter 换行)、自动改名、流式多气泡与状态徽章流转 |
| **P0** | `P0-CHAT-02` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Thinking Summarizer | 运行中呼吸工作条浓缩思考摘要(<=9字)及脏工具路径泄漏拦截 |
| **P0** | `P0-CHAT-03` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Agent Loop / Live Steering | 运行中 Live Steering 非打断插话：并行多 tool_call 中途插话自动补齐配对并续答 |
| **P0** | `P0-CHAT-04` | `F1×D1` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Stop Detector / Control | 显式停止按钮 + 自然语言停止词('停下'/'stop')中止 vs 正常指令('stop nginx')区分 |
| **P0** | `P0-RELOAD-01` | `F1×D1` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Session Persistence / Reload Recovery | F5 整页刷新后挂起审批态(awaiting_approval)无损恢复与错误提示跨端持久化同步关闭 |
| **P0** | `P0-CHAT-05` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Agent Loop / Max Steps Continue | 单轮最大步数上限暂停(.max-steps-card)、尾步提醒、历史封口与点击「继续执行」无缝接续 |
| **P0** | `P0-CRYPTO-01` | `F1×D1` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Local Crypto & Capabilities | 本地 AES-256-GCM 静态加密落盘、明文自动迁移、篡改容错与 8 项 backend apiCapabilities 宣告 |
| **P0** | `P0-SEC-01` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Policy / Static Guard | 硬编码安全禁区强制拦截：.ssh / .env / *auth*.json / accounts / vault / .aws / .gnupg / devices.json / Keychain dump |
| **P0** | `P0-SEC-02` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Interactive Approval | ApprovalCard 审批闭环：单次允许、暂不允许与 Escape 快捷键拒绝 |
| **P0** | `P0-SEC-03` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Policy AllowRules | ApprovalCard 始终允许持久化 allowRules 与 risk=high 不可绕过保护 |
| **P0** | `P0-SEC-04` | `F1×D2` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Credential Secret Ref & Vault Secret | CredentialCard + vault-secret-v1 全链路零泄漏：AES加密落盘、/reveal、vault_manage(get_secret)、browser_type 与 OS type_text 注入及跳过/OTP |
| **P0** | `P0-SEC-05` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Dual-Computer Policy Matrix | 双电脑权限策略矩阵(PI-010/011)：宿主机 always/ask/off、只读放行、高危命令确认、沙盒 full vs restricted 与跨 Bot 工作区确认 |
| **P0** | `P0-BOT-01` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Bot Lifecycle | 新建单聊 Bot(语义头像自动匹配)、右键克隆、清空历史与删除清理私有目录 |
| **P0** | `P0-BOT-02` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Admin Bot Guard | 管理员 Bot 固顶与禁删双重保护(UI隐藏删除 + API 403/400) |
| **P0** | `P0-BOT-03` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Workspace Isolation | 单 Bot 私有工作区目录隔离：跨 Bot 文件读取 403 与资料库隔离 |
| **P0** | `P0-BOT-04` | `F1×D2` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Group Chat / Mention | 多选拉群、#mention-popover @Bot 自动补全点名路由与群聊发言者头部渲染 |
| **P0** | `P0-PAIR-01` | `F1×D2` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | LAN Device Auth & Pairing | 真实非回环局域网 IPv4 401 鉴权拦截 + 双标签 6 位配对码握手换取 deviceToken |
| **P0** | `P0-MEM-01` | `F1×D2` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Auto & Explicit Memory System | 自动与显式双路径记忆系统(PI-016)：显式「记住」直存、自动触发静默落库(零推荐卡片)、异步快模型提炼去重/防密钥与兼容 /resolve 校验 |
| **P1** | `P1-SBOX-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Fullstack Sandbox | 全栈真沙盒闭环：Web UI → Node Agent → 真实 Python executor.py → 真实 Chrome 登录 + browser_tabs + send_file 投递卡片 |
| **P1** | `P1-SBOX-02` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Sandbox Shared Profile | 共享 Chrome Profile 跨 Bot 登录态(Cookie + localStorage)与每 Bot 独立窗口并发 DOM 操作隔离 |
| **P1** | `P1-SBOX-03` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Screen Lease Pool | 屏幕并发池 FIFO 排队、纯 CLI 零阻塞、调大上限实时唤醒与右侧排队状态徽章 |
| **P1** | `P1-SBOX-04` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | BotComputerOverlay / noVNC | noVNC 顶栏隐藏注入、人工独占接管(#pause-btn -> #resume-btn 补拍截图续跑)与群聊自动跟屏/手动切屏 |
| **P1** | `P1-SBOX-05` | `F1×D2` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Bot Computer Lifecycle Routes | Bot 电脑生命周期接口与设置页控件：/api/computer/status、displays、provision(管理员)、update 与 reset 释放屏幕 |
| **P1** | `P1-ELEC-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Electron Desktop Shell | 真实 Electron v45 主进程启动(短暂闪窗 3~5s 自动关闭)、端口冲突回退、IPC 桥与生产态非可信 OTA 拦截 |
| **P1** | `P1-ELEC-03` | `F1×D2` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Electron Prefs & Desktop Control Routes | Electron 桌面偏好持久化(keepRunningInBackground)、损坏恢复与 /api/desktop/wake\|quit 路由契约 |
| **P1** | `P1-OTA-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Web OTA Manager | 纯前端 OTA 热更新全周期：SHA-256 校验、Tar-Slip 拦截、热切静态目录固化与看门狗超时自动回滚 |
| **P1** | `P1-BRIDGE-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Cloud Auth / Runtime Role Gate | 云端模式 Bearer 鉴权与静态隐藏 + 本地切 host_executor 角色 409 门控与切回 master 恢复 |
| **P1** | `P1-BRIDGE-02` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Cloud↔Host WebSocket Bridge | 云端↔本地 /ws host_rpc_request 跨网宿主机操控(含全 5 工具与环境变量脱敏)及多宿主机切换 |
| **P1** | `P1-GRP-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Group Coordinator | 群聊协调器 4 项规则：最长前缀优先(@谷歌账号管家 vs @谷歌)、回复优先路由、职责打分选人与 MAX_GROUP_TURNS=3 |
| **P1** | `P1-COLLAB-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Multi-Bot Collaboration | Agent 跨 Bot 工具链全实测(list_bots/create_bot/send_bot_message/4跳防环/create_bot_group/bot_manage) + 交流胶囊与抽屉 |
| **P1** | `P1-TOOL-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Built-in System Bot Tools | 内置系统工具全覆盖：memory_manage / schedule_manage / vault_manage / workspace_search / library_manage / system_diagnostics / computer_provision / account_manage / skill_list |
| **P1** | `P1-PROMPT-01` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Modular Prompts & Prompt Loader | 模块化 Markdown 系统提示词(PI-001/002/011/014)：5 份模板装配、UI 自认知、跨域 iframe 兜底与动态注入校验 |
| **P1** | `P1-CARD-01` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Interactive ChoiceCard | ChoiceCard 提问卡全模式：单选、多选、多题步进 1/N、自定义输入与插话自动跳过(.is-superseded) |
| **P1** | `P1-CARD-02` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Approval Rule Editor / DraftCard | ApprovalCard 自定义规则编辑器(.btn-edit-rule) + DraftCard 内联编辑确认/取消 |
| **P1** | `P1-MSG-01` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Message Edit & Rewind | 历史用户消息内联「修改并重发」截断回滚 DOM / NDJSON / History 并重跑 |
| **P1** | `P1-MSG-02` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Reply Anchor & Selection Quote | 消息悬停「回复此消息」锚点定位闪烁 + 正文划词浮窗(#selection-quote-toolbar)复制与多条引用筹码 |
| **P1** | `P1-MSG-03` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Attachments & File Delivery | 三入口附件上传(选文件/粘贴图片/舞台拖拽) + 筹码移除 + FileAttachmentCard 下载与缺失置灰 |
| **P1** | `P1-MSG-04` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | HTML/SVG Sandboxed Preview | MarkupPreviewCard HTML/SVG 实时沙盒预览、无 allow-same-origin 隔离与全屏三档视口切换 |
| **P1** | `P1-SYNC-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Realtime Transport / Multi-Tab Sync | 双桌面标签页实时同步 & 首连 /ws 失败自动降级 SSE(/api/events) + billing_updated 通道取证 |
| **P1** | `P1-INSP-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | RightInspector / Memories / Scheduler | 右侧人设保存、Bot 专属记忆 UI 启停开关注入/剥离 Prompt、例行定时任务 UI 弹窗 CRUD(含 5 段 Cron 表达式校验/实时预览/schedule-cron-v1)与到期自动唤醒执行 |
| **P1** | `P1-SKILL-01` | `F2×D1` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Skills Store | 技能商店搜索/空搜索态/分类筛选/已添加入口/内置常驻标签禁删(400)、遮罩关闭与一键创建「邮箱管家」模板 Bot |
| **P1** | `P1-SKILL-02` | `F2×D1` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Custom Skills | 自定义 SKILL.md 全 UI 生命周期(新建/校验/YAML预览/搜索/启停开关/内联编辑重命名/删除确认)与 Agent custom_skill_manage 全动作 |
| **P1** | `P1-SKILL-03` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Mail Integration (Custom Mail) | 通用邮箱表单全交互(域名预设/手动改Host保护/密码显隐/协议端口联动/测试/发自测信/两级返回) + Agent 查账号/收读/草稿确认发信 |
| **P1** | `P1-SKILL-04` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Mail Multi-Account & Diagnostics | 多邮箱账号全流程(PI-013)：新增第2账号、设为默认、单账号测试成功/认证失败诊断、内联编辑留空保密、POP3收读、删除单账号与兼容路由 |
| **P1** | `P1-SKILL-05` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | QQ Mail UI & Conversational Config | QQ邮箱专用表单(PI-013：16位授权码提示/短码校验/显隐/高级协议切换) + 对话式 skill_configure_mail 全动作与缺密凭据卡脱敏 |
| **P1** | `P1-SKILL-06` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Skill Uninstall & Credential Cleanup | 技能安装/卸载确认 UI(PI-013)：商店添加、管理页/详情页移除取消、卸载保留加密凭据与勾选清除凭据边界 |
| **P1** | `P1-SKILL-07` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | MCP Client & Multi-Bot Channels | KimiCU / MCP 全面板与多实例对话渠道(飞书/TG + 6位配对码 + 对话式配置)闭环：MCP配置重连/env脱敏/反自控、多Bot渠道CRUD/Webhook隔离、skill_configure_channel、channel-multi-bot-pairing-v1 与配对审批流 |
| **P1** | `P1-ROUTE-01` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Providers & Failover Router | 多供应商 UI/API CRUD(含 PATCH/测速/启停/4档绑定/删除重平衡/vertex 400) + 429(冷却)/404(永久屏蔽)自动无感故障转移 |
| **P1** | `P1-ROUTE-02` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Smart Router v2 | 智能路由 UI(开关/三档模式/预算上限)、关闭 smartRouter 退回规则、route_escalate(think/visual + cap=2 封顶)与 route-stats 落盘 |
| **P1** | `P1-ROUTE-03` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Image Generation & SVG Fallback | AI 生图(API + Live Agent generate_image 自动嵌入 & SVG 降级) + /api/images/convert 全格式(png/jpg/webp/pdf/dataBase64/越权403/422) |
| **P1** | `P1-ROUTE-04` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Context Compression | 3 阶段上下文自动压缩、413 context_length_exceeded 溢出强制压缩自愈重试与 OpenAI 兼容 400 降级自愈 |
| **P1** | `P1-BILL-01` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Usage & Billing | 用量与账单全链路：单轮预算护栏(maxTurnUsd)、DeepSeek 实时查余/全量刷新、定时周期、UI 手动校准(set/add/sub/clear)、单Bot明细与 /api/billing/gcp 迁移 |
| **P1** | `P1-MOB-01` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Mobile Web Bundle & Sheets | 移动端 dist-web (390×844 触屏) 列表↔对话导航、真实左缘右滑手势返回、搜索筛选、技能工具入口、4大抽屉与创建 13×11 Bot |
| **P1** | `P1-MOB-02` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Mobile Node Discovery & Orientation | 移动端局域网发现扫描、手动 IP 输入、6位配对码弹窗与全屏桌面横屏解锁(setScreenOrientation sensor -> portrait) |
| **P1** | `P1-MOB-03` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Mobile Hardware Back Stack | Android 硬件返回键深层优先栈逐级出栈(弹窗 -> 技能页 -> 抽屉 -> 对话退列表 -> minimizeApp) |
| **P1** | `P1-NET-01` | `F2×D2` | `test/e2e/p1-network-resilience-and-offline.e2e.ts` | NetworkStatusBanner Desktop | 桌面端统一弱网/重连/离线/恢复横幅(NetworkStatusBanner)四态生命周期、收起按钮、切换账号入口与浏览器离线区分 |
| **P1** | `P1-NET-02` | `F2×D2` | `test/e2e/p1-network-resilience-and-offline.e2e.ts` | WS Heartbeat & Exponential Backoff | 远端 WS 心跳 RTT 弱网感知、Pong 超时重连与 WS+SSE 双失败指数退避(reconnecting -> offline -> 恢复追平消息) |
| **P1** | `P1-NET-03` | `F2×D2` | `test/e2e/p1-network-resilience-and-offline.e2e.ts` | API Client Slow/Stale Guard | HTTP 慢请求在途弱网提示、连续失败转离线与切换账号 STALE_ACCOUNT_EPOCH 中止陈旧请求 |
| **P1** | `P1-NET-04` | `F2×D2` | `test/e2e/p1-network-resilience-and-offline.e2e.ts` | Account Disconnected Gate (Desktop) | 桌面端断连独占门禁页(AccountDisconnectedGate)：云端断连全屏锁定、禁止 Esc/快捷键穿透、仅允许刷新与切回本机，本机账号永不触发 |
| **P1** | `P1-NET-05` | `F2×D2` | `test/e2e/p1-network-resilience-and-offline.e2e.ts` | Account Disconnected Gate (Mobile) | 移动端(390×844 dist-web)断连独占门禁页(AccountDisconnectedGate)：局域网失联全屏锁定、内联配对/添加云端入口与一键切回在线云端恢复 |
| **P1** | `P1-NET-06` | `F2×D2` | `test/e2e/p1-network-resilience-and-offline.e2e.ts` | Foreground Resume Probe | 前台切回探活(visibilitychange)与浏览器 online/offline 恢复联动 |
| **P1** | `P1-NET-07` | `F2×D2` | `test/e2e/p1-network-resilience-and-offline.e2e.ts` | Mobile Cloud QR Scan & Self-Connect Guard | 移动端(390×844 dist-web)纯本地/云端模型、QrScanner扫码添加跨电脑Cloud账号与桌面端禁止自连校验 |
| **P1** | `P1-MOB-04` | `F2×D2` | `test/e2e/p1-mobile-ux-and-gestures.e2e.ts` | Mobile Layout, Tap Actions & Composer | 移动端零横向溢出护栏(375/390px 长命令卡片/表格/代码)、点击消息气泡弹出操作栏、Composer Enter 换行与更多菜单 |
| **P1** | `P1-MOB-05` | `F2×D2` | `test/e2e/p1-mobile-ux-and-gestures.e2e.ts` | Mobile Deep Sheets & Drag Gestures | 移动端全抽屉深入交互：检查器活动/资料库 Tab、编辑 Bot 13×11、设置 6 项独立子页返回闭环与拖拽手势 |
| **P1** | `P1-MOB-06` | `F2×D2` | `test/e2e/p1-mobile-ux-and-gestures.e2e.ts` | Mobile OTA Updater UI | 移动端 OTA 热更新全 UI 链路(WebUpdater 检查/更新徽章 #mobile-update-btn/下载应用进度) |
| **P2** | `P2-SET-01` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings General / Profile | 设置·通用：个人昵称保存(按钮+回车保存+空值防误存提示)与 6 色头像圆点切换(侧边栏联动 + 刷新持久化) |
| **P2** | `P2-SET-02` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings General / Appearance | 设置·通用：浅色/深色/跟随系统三态主题(color-scheme 同步)、Bot 强调色 vs 默认黑灰与拼写检查(#message-input spellcheck)开关 |
| **P2** | `P2-SET-03` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings General / Compression & Global Memories | 设置·通用：上下文压缩 3 档预设卡(50%/75%/85%)、滑块、高级自定义规则与全局共享记忆 CRUD/启停/编辑/删除 |
| **P2** | `P2-SET-04` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Computer | 设置·电脑：宿主机策略 always/ask/off(切 off 自动关闭 MCP)与检测/健康状态联动 |
| **P2** | `P2-SET-05` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Permissions | 设置·权限：自动审核开关(#policy-auto-audit-toggle)与 askRules / allowRules 全套 UI 增删改 |
| **P2** | `P2-SET-06` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Vault | 设置·保险库 Vault：分类筛选、实时搜索、AES加密密码(#vault-password-input/查看/清除)与 UI 内联编辑/删除/PATCH |
| **P2** | `P2-SET-07` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Diagnostics & Capability Gate | 设置·关于与诊断(/api/system/diagnostics & /api/system/updates/check) + 连接 v1.0.0 旧节点动态隐藏 multi-display-v1 屏幕池控件 |
| **P2** | `P2-SET-08` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | LAN Toggle & Admin Provision Gate | LAN 开关读写(GET/POST /api/lan/settings)停用局域网发现 + 非管理员 Bot 调用 POST /api/computer/provision 返回 403 |
| **P2** | `P2-SET-09` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Shell, ConfirmDialog & Toast | 设置弹窗交互外壳(遮罩点击关闭/切 Tab 滚动复位/滚轮边界) + ConfirmDialog 取消/Escape 与 Toast 提示组件 |
| **P2** | `P2-SET-10` | `F3×D2` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Computer / Remote Relay | 设置·电脑：外网中继(remote-relay-v1)卡片配置保存(/api/relay/config)、二维码配对(/api/relay/invite)、VPS模板(/api/relay/templates)、探活(/api/relay/control|ping)与共享账号目录(/api/accounts) |
| **P2** | `P2-SSR-01` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | SSR Static Markup & Render Parity | SSR 静态渲染入口(ssr-entry.js)全量校验：整页 App + 全部 StreamItem(含 max_steps/budget_warning/error/unread_divider) 与弱网横幅 |
| **P2** | `P2-UI-01` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Avatar Editor / Preset | 右侧头像编辑器：13形状×11颜色切换、恢复默认与名称输入框回车保存 |
| **P2** | `P2-UI-02` | `F3×D2` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Avatar Editor / AI & Upload | 右侧头像编辑器：AI 生成头像(含 SVG 降级)与本地上传大图 Canvas 裁剪 128×128 PNG |
| **P2** | `P2-UI-03` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Sidebar Badges & Header Share | 侧边栏微状态：未读蓝点累加/切入清零(touch:false)+.unread-divider 分割线、清空历史(.empty-state)与顶部分享克隆 |
| **P2** | `P2-UI-04` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | MarkdownRenderer | Markdown 全语法细节与安全：H1~H6/引用/嵌套列表(.msg-sublist)/有序起始/删除线/分隔线/复选框/snake_case 保护与 javascript: 拦截 |
| **P2** | `P2-UI-05` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Markdown Code & Table Copy | 代码块一键复制与 GFM 表格行数徽章 + 复制 TSV 到剪贴板 |
| **P2** | `P2-UI-06` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | MarkupPreviewCard Micro | HTML/SVG 预览卡全套微交互：浅色/透明格/深色三态底色循环、刷新、复制源码与切源码视图 |
| **P2** | `P2-UI-07` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Library & Lightbox | 右侧资料库 all/media/file 全筛选、超 5 项展开/收起(#library-expand-btn)与真实大图灯箱(#image-lightbox-modal)开关 |
| **P2** | `P2-UI-08` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | useChatScrollPin | 长对话上滚脱离底部浮现「回到底部」(#scroll-bottom-btn)点击平滑吸底 |
| **P2** | `P2-UI-09` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Composer IME & Size Guard | 中文 IME compositionend 50ms 窗口按 Enter 防误发 + 上传 >10MB 文件拦截弹 Toast |
| **P2** | `P2-UI-10` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Splitters & Responsive Collapse | 左右双分栏拖拽调宽(#left-splitter & #right-splitter 边界限制) + 窄屏 <920px 折叠检查器与 <720px 自动紧凑侧栏恢复 |
| **P2** | `P2-UI-11` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Search Palette & Help Dialog | ⌘K 全局搜索命令面板(快捷键呼出 + GET /api/search + 点击 Bot/消息结果跳转)与快捷键帮助弹窗(#shortcuts-help-dialog) |
| **P2** | `P2-UI-12` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | useGlobalShortcuts | 全局快捷键(⌘, / ⌘\\ / ⌘I / 无焦点 1~6 & A~F 秒选提问卡)与完整 Escape 优先关闭栈 |
| **P2** | `P2-UI-13` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Compact Rail & Account Popover | 紧凑侧边栏底部轨道(.compact-rail-footer 全部按钮)与 #account-popover 多账号列表/云端弹窗交互 |
| **P2** | `P2-UI-14` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Bot Computer Card & Trace Pills | 右侧 #bot-computer-card 状态展示与执行追踪列表 TraceEventsList(<details class='trace-pill'>)展开 |
| **P2** | `P2-CLI-01` | `F3×D2` | `test/e2e/p2-cli-and-landing.e2e.ts` | CLI Multi-Provider Bootstrap | CLI 空参数退出码 1 + 仅配置 settings.json 供应商(无 GEMINI_API_KEY)成功执行与 Usage 落盘 |
| **P2** | `P2-CLI-02` | `F3×D2` | `test/e2e/p2-cli-and-landing.e2e.ts` | CLI Interactive Approval & SIGINT | CLI 真实 readline [y/N] 交互式审批(输入 y 放行与输入 n 拒绝) + 单次 SIGINT 优雅中断落盘 |
| **P2** | `P2-CLI-03` | `F3×D2` | `test/e2e/p2-cli-and-landing.e2e.ts` | CLI Edge Guards & Double-SIGINT | CLI route_notice(max_steps 告警输出)、非 GCP 伪造 Vertex 报错退出(1) 与双次 SIGINT 强制退出 |
| **P2** | `P2-LAND-01` | `F3×D1` | `test/e2e/p2-cli-and-landing.e2e.ts` | Landing Page Interactive | Landing 官网 4 个工作台模拟 Tab 切换(内容/aria-selected) + 4 大 OS UA 自动高亮下载卡与跳转芯片 |
| **P2** | `P2-LAND-02` | `F3×D1` | `test/e2e/p2-cli-and-landing.e2e.ts` | Landing Hydration & Copy | Landing 官网全部 7 个 GitHub Release 资产链接水合、403 限流静态兜底与一键复制「已复制 ✓」反馈 |
| **P3** | `P3-X11-01` | `F2×D3` | `executor/test_e2e_x11_desktop.py` | Physical X11 Input & Sensitive Clipboard | Ubuntu 真实 X11 物理事件验证：左/右/双击、中文剪贴板、sensitive 敏感输入后剪贴板擦除、按键、四向滚轮与拖拽 |
| **P3** | `P3-X11-02` | `F3×D3` | `executor/test_e2e_x11_desktop.py` | Physical X11 Windows & Screenshot | Ubuntu 真实 X11 窗口管理：wmctrl /windows 枚举双窗口、/focus 切换激活与非空白物理截屏 |
| **P3** | `P3-X11-03` | `F3×D3` | `executor/test_e2e_x11_desktop.py` | Executor Full HTTP & Security Matrix | Executor 全 21 端点 HTTP 契约与安全边界：Bearer 401、/displays 生命周期、/read\|/write 禁区 403 与截断、/shell 隔离与超时 124、/open_url 与错误码 |
| **P3** | `P3-ELEC-02` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Electron Tray & Menu Commands | Electron 托盘 UI(electron/tray.html)实时状态推送/全按钮交互 + 全部 8 项原生菜单指令联动渲染层 |
| **P3** | `P3-RES-01` | `F2×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Agent Loop Resilience | Agent 死循环重复检测告警(repeatCount>=2)、finishReason='length' 截断工具拦截重试、markInterrupted 与孤立调用清洗 |
| **P3** | `P3-RES-02` | `F2×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Built-in Tools & Security Headers | web_search(DDG→Bing 回退)、web_fetch 正文抽取、workspace_search / library_manage 及 /api/workspace/file(.html/.svg/download)安全响应头 |
| **P3** | `P3-CHAOS-01` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Security Redteam (SSRF & Traversal) | 安全红队：web_fetch 内网/元数据 SSRF 拦截、URL 空字节 \\0、静态目录 .. 穿越与非法截图路径拦截 |
| **P3** | `P3-CHAOS-02` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Auth Redteam & Vertex Gate | 认证红队：配对码 5 次输错销毁锁定 403、已配对设备吊销即时 401 与非 GCP 伪造 Vertex 强制阻断 |
| **P3** | `P3-CHAOS-03` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Storage Resilience & Body Limits | 存储损坏容错(.ndjson 混入半截非法行跳过不丢数据) + 超大 JSON 请求体拦截返回 413 |
| **P3** | `P3-CHAOS-04` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | WebSocket Reconnect Sync | WebSocket 强制断线自动重连并无损追平断线期间产生的新消息 |
| **P3** | `P3-CHAOS-05` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Bot Computer Provisioner & Updater | Bot 电脑环境探针与一键热更新状态机(probeBotComputerState / buildMacOrbExecutorDeployScript / updateBotComputer) |
| **P3** | `P3-LIVE-01` | `F1×D3` | `test/e2e/p3-live-smoke.e2e.ts` | Live API Smoke | 可选真实 .env 大模型与真实沙盒端到端冒烟(需配置 TWINKLEBOT_E2E_LIVE=1 与真实 API Key) |
