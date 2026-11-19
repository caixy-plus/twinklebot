# TwinkleBot 全量分级 E2E 测试计划（SSOT）

> 本文件由技能 `/twinklebot-e2e` 与机器映射源 [catalog.json](./catalog.json) 共同维护。当前共登记 **12 个分级套件 / 82 项原子用例**（P0: 17 · P1: 31 · P2: 24 · P3: 10）。

## 一、二维优先级矩阵（功能层级 × 测试难易度）

| 功能层级 \ 测试难易度 | **D1 低**（纯 API / 确定性 DOM） | **D2 中**（多步 UI / 协议桩 / WebSocket / 移动端） | **D3 高**（真实 OrbStack X11 / Electron / OTA / 公网真 API） |
| :--- | :---: | :---: | :---: |
| **F1 核心主链路**（引导/对话/安全红线/审批/凭据/沙盒/配对） | **P0** | **P0** | **P1** *(实网冒烟归 P3)* |
| **F2 重要业务模块**（群聊/跨 Bot/卡片/邮箱/MCP/路由/账单/移动端） | **P1** | **P1** | **P3** |
| **F3 细小微交互与边缘红队**（设置项/头像/快捷键/CLI/官网/混沌红队） | **P2** | **P2** | **P3** |

## 二、五大运行面与双模外部依赖

1. **Web 桌面端**：原生 Chrome CDP（macOS 默认可见 + HUD 状态角标，CI 自动无头）。
2. **Ubuntu 沙盒 (`executor/executor.py`)**：OrbStack `ubuntu` / Linux `Xvfb`/`Xtigervnc` 真实 Google Chrome 多标签共享 Profile 与物理 X11 输入。
3. **移动端 (`dist-web/`)**：`APP_TARGET=mobile` 构建产物 + 390×844 触屏视口 + Capacitor 桥接桩。
4. **Electron 桌面端**：真实 Electron 主进程启动、端口回退、IPC 桥、托盘 `tray.html` 与 OTA 看门狗回滚。
5. **CLI 与官网 Landing**：`dist-server/src/cli/index.js` + `landing/index.html` 多 OS UA 与 Releases 降级。
- **默认离线确定性模式**：通过 `test/helpers/e2e-protocol-fixtures.ts` 提供本地 HTTP/SSE LLM（含 Gemini `/v1beta/interactions`）、IMAP/POP3/SMTP、Stdio MCP、OTA 归档与静态测试站点，零外网、零费用。
- **可选实网冒烟**：仅当显式设置 `TWINKLEBOT_E2E_LIVE=1` 且存在 `.env` 时运行 `P3-LIVE-01`。

## 三、新增功能定级与命名规范

1. 每次新增 API 路由、UI 弹窗/组件、Bot 工具或 Executor 接口，按上表定级并分配唯一用例 ID：`P<0-3>-<AREA>-<NN>`（如 `P1-SKILL-06`、`P2-SET-09`）。
2. 同步更新三处：对应 `test/e2e/*.e2e.ts`（或 `executor/test_e2e_*.py`）、`references/catalog.json` 与本表。
3. 运行 `npm test` 中的 `test/e2e-skill-sync.test.ts` 校验 100% 一致性，再执行 `npm run test:e2e:affected` 做定向验证。

## 四、全量原子用例总表（82 项）

| 优先级 | 用例 ID | 维度 | 所属套件 | 模块 | 用例标题 |
| :---: | :--- | :---: | :--- | :--- | :--- |
| **P0** | `P0-ONB-01` | `F1×D1` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Onboarding / Session Bootstrap | 空工作台自动初始化唯一置顶管理员 Bot Twinkle 并弹出首屏引导遮罩 |
| **P0** | `P0-ONB-02` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Onboarding / Providers | 引导页 4 类供应商预设切换、去重联动 3 档、测速(败/胜)与提交脱敏落盘 |
| **P0** | `P0-GEM-01` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Gemini Driver | 原生 Gemini Interactions API 驱动链路：thought_tokens 计费与 invalid thought signature 自动剥离重试 |
| **P0** | `P0-CHAT-01` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Chat / Composer | 单聊收发(Enter 发送 / Shift+Enter 换行)、自动改名、流式多气泡与状态徽章流转 |
| **P0** | `P0-CHAT-02` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Thinking Summarizer | 运行中呼吸工作条浓缩思考摘要(<=9字)及脏工具路径泄漏拦截 |
| **P0** | `P0-CHAT-03` | `F1×D2` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Agent Loop / Live Steering | 运行中 Live Steering 非打断插话：并行多 tool_call 中途插话自动补齐配对并续答 |
| **P0** | `P0-CHAT-04` | `F1×D1` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Stop Detector / Control | 显式停止按钮 + 自然语言停止词('停下'/'stop')中止 vs 正常指令('stop nginx')区分 |
| **P0** | `P0-RELOAD-01` | `F1×D1` | `test/e2e/p0-onboarding-and-chat.e2e.ts` | Session Persistence / Reload Recovery | F5 整页刷新后挂起审批态(awaiting_approval)无损恢复并继续完成任务 |
| **P0** | `P0-SEC-01` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Policy / Static Guard | 硬编码安全禁区强制拦截：.ssh / .env / *auth*.json / devices.json / Keychain dump |
| **P0** | `P0-SEC-02` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Interactive Approval | ApprovalCard 审批闭环：单次允许、暂不允许与 Escape 快捷键拒绝 |
| **P0** | `P0-SEC-03` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Policy AllowRules | ApprovalCard 始终允许持久化 allowRules 与 risk=high 不可绕过保护 |
| **P0** | `P0-SEC-04` | `F1×D2` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Credential Secret Ref | CredentialCard 加密凭据零明文泄漏：browser_type 真实输入、禁入 run_shell、Vault 仅存非敏元数据 |
| **P0** | `P0-BOT-01` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Bot Lifecycle | 新建单聊 Bot(语义头像自动匹配)、右键克隆、清空历史与删除清理私有目录 |
| **P0** | `P0-BOT-02` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Admin Bot Guard | 管理员 Bot 固顶与禁删双重保护(UI隐藏删除 + API 403/400) |
| **P0** | `P0-BOT-03` | `F1×D1` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Workspace Isolation | 单 Bot 私有工作区目录隔离：跨 Bot 文件读取 403 与资料库隔离 |
| **P0** | `P0-BOT-04` | `F1×D2` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | Group Chat / Mention | 多选拉群、#mention-popover @Bot 自动补全点名路由与群聊发言者头部渲染 |
| **P0** | `P0-PAIR-01` | `F1×D2` | `test/e2e/p0-security-multibot-and-pairing.e2e.ts` | LAN Device Auth & Pairing | 真实非回环局域网 IPv4 401 鉴权拦截 + 双标签 6 位配对码握手换取 deviceToken |
| **P1** | `P1-SBOX-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Fullstack Sandbox | 全栈真沙盒闭环：Web UI → Node Agent → 真实 Python executor.py → 真实 Chrome 登录 + send_file 投递卡片 |
| **P1** | `P1-SBOX-02` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Sandbox Shared Profile | 共享 Chrome Profile 跨 Bot 登录态(Cookie + localStorage)与双标签并发 DOM 操作隔离 |
| **P1** | `P1-SBOX-03` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Screen Lease Pool | 屏幕并发池 FIFO 排队、纯 CLI 零阻塞、调大上限实时唤醒与右侧排队状态徽章 |
| **P1** | `P1-SBOX-04` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | BotComputerOverlay / noVNC | noVNC 顶栏隐藏注入、人工独占接管(#pause-btn -> #resume-btn 补拍截图续跑)与群聊自动跟屏/手动切屏 |
| **P1** | `P1-ELEC-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Electron Desktop Shell | 真实 Electron v45 主进程启动(短暂闪窗 3~5s 自动关闭)、端口冲突回退、IPC 桥与生产态非可信 OTA 拦截 |
| **P1** | `P1-OTA-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Web OTA Manager | 纯前端 OTA 热更新全周期：SHA-256 校验、Tar-Slip 拦截、热切静态目录固化与看门狗超时自动回滚 |
| **P1** | `P1-BRIDGE-01` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Cloud Auth / Runtime Role Gate | 云端模式 Bearer 鉴权与静态隐藏 + 本地切 host_executor 角色 409 门控与切回 master 恢复 |
| **P1** | `P1-BRIDGE-02` | `F1×D3` | `test/e2e/p1-sandbox-electron-and-bridge.e2e.ts` | Cloud↔Host WebSocket Bridge | 云端↔本地 /ws host_rpc_request 跨网宿主机操控(含全 5 工具与环境变量脱敏)及多宿主机切换 |
| **P1** | `P1-GRP-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Group Coordinator | 群聊协调器 4 项规则：最长前缀优先(@谷歌账号管家 vs @谷歌)、回复优先路由、职责打分选人与 MAX_GROUP_TURNS=3 |
| **P1** | `P1-COLLAB-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Multi-Bot Collaboration | Agent 跨 Bot 工具链(create_bot/send_bot_message/4跳防环/create_bot_group) + 交流胶囊与抽屉 |
| **P1** | `P1-CARD-01` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Interactive ChoiceCard | ChoiceCard 提问卡全模式：单选、多选、多题步进 1/N、自定义输入与插话自动跳过(.is-superseded) |
| **P1** | `P1-CARD-02` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Approval Rule Editor / DraftCard | ApprovalCard 自定义规则编辑器(.btn-edit-rule) + DraftCard 内联编辑确认/取消 |
| **P1** | `P1-MSG-01` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Message Edit & Rewind | 历史用户消息内联「修改并重发」截断回滚 DOM / NDJSON / History 并重跑 |
| **P1** | `P1-MSG-02` | `F2×D1` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Reply Anchor & Selection Quote | 消息悬停「回复此消息」锚点定位闪烁 + 正文划词浮窗(#selection-quote-toolbar)多条引用筹码 |
| **P1** | `P1-MSG-03` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Attachments & File Delivery | 三入口附件上传(选文件/粘贴图片/舞台拖拽) + 筹码移除 + FileAttachmentCard 下载与缺失置灰 |
| **P1** | `P1-MSG-04` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | HTML/SVG Sandboxed Preview | MarkupPreviewCard HTML/SVG 实时沙盒预览、无 allow-same-origin 隔离与全屏三档视口切换 |
| **P1** | `P1-SYNC-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | Realtime Transport / Multi-Tab Sync | 双桌面标签页实时同步 & 首连 /ws 失败自动降级 SSE(/api/events) + billing_updated 通道取证 |
| **P1** | `P1-INSP-01` | `F2×D2` | `test/e2e/p1-collab-cards-and-messages.e2e.ts` | RightInspector / Memories / Scheduler | 右侧人设保存、Bot 专属记忆启停注入 Prompt 与例行定时任务到期自动唤醒执行 |
| **P1** | `P1-SKILL-01` | `F2×D1` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Skills Store | 技能商店搜索/分类筛选、内置常驻技能禁删(400)与一键创建「邮箱管家」模板 Bot |
| **P1** | `P1-SKILL-02` | `F2×D1` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Custom Skills | 自定义 SKILL.md 全生命周期(新建/YAML 预览/Slug 去重/重命名/启停/删除)与渐进式披露读取 |
| **P1** | `P1-SKILL-03` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | Mail Integration (Custom Mail) | 通用邮箱对接本地回环 IMAP/POP3/SMTP：域名预设推断、测试/发自测信/保存 + Agent 收读与草稿确认发信 |
| **P1** | `P1-SKILL-04` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | QQ Mail & Credential Cleanup | QQ邮箱专项 + 对话式 skill_configure_mail 缺密凭据卡脱敏 + 卸载技能保留/清除凭据边界取证 |
| **P1** | `P1-SKILL-05` | `F2×D2` | `test/e2e/p1-skills-mail-and-mcp.e2e.ts` | MCP Client (kimi-cu) | kimi-cu MCP 安装握手、工具芯片展示、截图回传、子进程 env 脱敏与反自控(com.twinklebot.desktop)拒绝 |
| **P1** | `P1-ROUTE-01` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Providers & Failover Router | 多供应商 CRUD/测速/启停/删除重平衡 + 429(冷却)/404(屏蔽)自动无感故障转移 |
| **P1** | `P1-ROUTE-02` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Smart Router v2 | 智能路由 economy/balanced/quality 切换、关闭 smartRouter 退回规则、route_escalate 主动升档与 route-stats 落盘 |
| **P1** | `P1-ROUTE-03` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Image Generation & SVG Fallback | AI 生图 + 无生图模型自动降级 LLM 生成 SVG + /api/images/convert 转 PNG/PDF 落入资料库 |
| **P1** | `P1-ROUTE-04` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Context Compression | 3 阶段上下文自动压缩与 413 context_length_exceeded 溢出强制压缩自愈重试 |
| **P1** | `P1-BILL-01` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Usage & Billing | 用量与账单：单轮预算护栏、DeepSeek 实时查余与定时周期、手动校准(set/add/sub/clear)与旧版 googleBilling 迁移 |
| **P1** | `P1-MOB-01` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Mobile Web Bundle & Sheets | 移动端 dist-web (390×844 触屏) 列表↔对话导航、左缘右滑返回、4 大底部抽屉与创建 13×11 Bot |
| **P1** | `P1-MOB-02` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Mobile Node Discovery & Orientation | 移动端局域网发现扫描、手动 IP 输入与全屏桌面横屏解锁(setScreenOrientation sensor -> portrait) |
| **P1** | `P1-MOB-03` | `F2×D2` | `test/e2e/p1-routing-billing-and-mobile.e2e.ts` | Mobile Hardware Back Stack | Android 硬件返回键 22 级优先栈逐级出栈(弹窗 -> 抽屉 -> 对话退列表 -> minimizeApp) |
| **P2** | `P2-SET-01` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings General / Profile | 设置·通用：个人昵称保存与 6 色头像圆点切换(侧边栏联动 + 刷新持久化) |
| **P2** | `P2-SET-02` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings General / Appearance | 设置·通用：浅色/深色/跟随系统主题(color-scheme 同步)、Bot 强调色 vs 默认黑灰与拼写检查开关 |
| **P2** | `P2-SET-03` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings General / Compression & Global Memories | 设置·通用：上下文压缩预设卡(50%/75%/85%)、滑块、自定义规则与全局共享记忆 CRUD/启停 |
| **P2** | `P2-SET-04` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Computer | 设置·电脑：宿主机策略 always/ask/off(切 off 自动关闭 MCP)、自动展开开关与检测/重置按钮 |
| **P2** | `P2-SET-05` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Permissions | 设置·权限：自动审核开关与 11 类目标工具 askRules / allowRules 增删改 |
| **P2** | `P2-SET-06` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Settings Vault | 设置·保险库 Vault：分类筛选(all/login/contact)、实时搜索与条目 CRUD (PATCH /api/vault/:id) |
| **P2** | `P2-SET-07` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | Diagnostics & Capability Gate | 设置·关于与诊断 + 连接 v1.0.0 旧节点动态隐藏 multi-display-v1 屏幕池控件 |
| **P2** | `P2-SET-08` | `F3×D1` | `test/e2e/p2-settings-vault-and-permissions.e2e.ts` | LAN Toggle & Admin Provision Gate | LAN 开关关闭停用局域网发现 + 非管理员 Bot 调用 POST /api/computer/provision 返回 403 |
| **P2** | `P2-UI-01` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Avatar Editor / Preset | 右侧头像编辑器：13形状×11颜色切换、恢复默认与名称输入框回车保存 |
| **P2** | `P2-UI-02` | `F3×D2` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Avatar Editor / AI & Upload | 右侧头像编辑器：AI 生成头像(含 SVG 降级)与本地上传大图 Canvas 裁剪 128×128 PNG |
| **P2** | `P2-UI-03` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Sidebar Badges & Header Share | 侧边栏微状态：未读蓝点累加/切入清零(touch:false)+未读分割线、空状态与顶部分享克隆 |
| **P2** | `P2-UI-04` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | MarkdownRenderer | Markdown 语法细节与安全：标题/引用/嵌套列表/任务复选框/snake_case 保护与 javascript: 危险链接拦截 |
| **P2** | `P2-UI-05` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Markdown Code & Table Copy | 代码块一键复制与 GFM 表格行数徽章 + 复制 TSV 到剪贴板 |
| **P2** | `P2-UI-06` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | MarkupPreviewCard Micro | HTML/SVG 预览卡微交互：浅色/透明格/深色三态底色循环、刷新与切源码 |
| **P2** | `P2-UI-07` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Library & Lightbox | 右侧资料库 all/media/file 筛选、超 5 项展开收起(#library-expand-btn)与大图灯箱 |
| **P2** | `P2-UI-08` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | useChatScrollPin | 长对话上滚脱离底部浮现「回到底部」(#scroll-bottom-btn)点击平滑吸底 |
| **P2** | `P2-UI-09` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Composer IME & Size Guard | 中文 IME compositionend 50ms 窗口按 Enter 防误发 + 上传 >10MB 文件拦截弹 Toast |
| **P2** | `P2-UI-10` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Splitters & Responsive Collapse | 左右分栏拖拽调宽(#left-splitter / #right-splitter 边界限制) + 窄屏 <720px/<920px 自动折叠恢复 |
| **P2** | `P2-UI-11` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | Search Palette & Help Dialog | ⌘K 全局搜索命令面板(搜 Bot / 历史消息 / 快捷导航)与快捷键帮助弹窗(#shortcuts-help-dialog) |
| **P2** | `P2-UI-12` | `F3×D1` | `test/e2e/p2-micro-ui-markdown-and-shortcuts.e2e.ts` | useGlobalShortcuts | 全局快捷键(⌘, / ⌘\\ / ⌘I / 无焦点 1~6 秒选提问卡)与 Escape 优先关闭栈 |
| **P2** | `P2-CLI-01` | `F3×D2` | `test/e2e/p2-cli-and-landing.e2e.ts` | CLI Multi-Provider Bootstrap | CLI 空参数退出码 1 + 白盒线索 #1 取证：仅配置 settings.json 供应商(无 GEMINI_API_KEY)运行 CLI |
| **P2** | `P2-CLI-02` | `F3×D2` | `test/e2e/p2-cli-and-landing.e2e.ts` | CLI Interactive Execution & SIGINT | CLI 流式执行、readline [y/N] 审批放行、会话落盘与 SIGINT 优雅中断 |
| **P2** | `P2-LAND-01` | `F3×D1` | `test/e2e/p2-cli-and-landing.e2e.ts` | Landing Page Interactive | Landing 官网 4 个工作台模拟 Tab 切换(collab/desktop/mobile/routing) + 多 OS UA 自动高亮下载卡 |
| **P2** | `P2-LAND-02` | `F3×D1` | `test/e2e/p2-cli-and-landing.e2e.ts` | Landing Hydration & Copy | Landing 官网 GitHub Releases 资产水合、403 限流静态兜底与一键复制按钮 |
| **P3** | `P3-X11-01` | `F2×D3` | `executor/test_e2e_x11_desktop.py` | Physical X11 Input | Ubuntu 物理 X11 桌面控制：/click、/type(xclip+ctrl+v 中文输入)、/key、/scroll 与 /drag |
| **P3** | `P3-X11-02` | `F3×D3` | `executor/test_e2e_x11_desktop.py` | Physical X11 Windows | Ubuntu 物理 X11 窗口管理：双 Chrome 窗口 /windows 识别、/focus 切换与 /screenshot 根窗口截屏 |
| **P3** | `P3-ELEC-02` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Electron Tray & Menu Commands | Electron 托盘 UI(electron/tray.html)全状态与按钮交互 + 8 项原生菜单指令联动渲染层 |
| **P3** | `P3-RES-01` | `F2×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Agent Loop Resilience | Agent 死循环重复检测告警、finishReason='length' 截断工具拦截重试、markInterrupted 与孤立调用清洗 |
| **P3** | `P3-RES-02` | `F2×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Built-in Tools & Security Headers | web_search(DDG→Bing 回退)、workspace_search / library_manage(save_note) 及 /api/workspace/file 安全响应头 |
| **P3** | `P3-CHAOS-01` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Security Redteam (SSRF & Traversal) | 安全红队：web_fetch 内网/元数据 SSRF 拦截、URL 空字节 \\0、静态目录 .. 穿越与非法截图路径拦截 |
| **P3** | `P3-CHAOS-02` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Auth Redteam & Vertex Gate | 认证红队：配对码 5 次输错销毁锁定 403、设备吊销即时 401 与非 GCP 伪造 Vertex 强制阻断 |
| **P3** | `P3-CHAOS-03` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | Storage Resilience & Body Limits | 存储损坏容错(.ndjson 混入半截非法行跳过不丢数据) + 超大 JSON 请求体拦截返回 400 |
| **P3** | `P3-CHAOS-04` | `F3×D2` | `test/e2e/p3-tray-resilience-and-chaos.e2e.ts` | WebSocket Reconnect Sync | WebSocket 强制断线 2s 自动重连并无损追平断线期间产生的新消息 |
| **P3** | `P3-LIVE-01` | `F1×D3` | `test/e2e/p3-live-smoke.e2e.ts` | Live API Smoke | 可选真实 .env 大模型与真实沙盒端到端冒烟(需配置 TWINKLEBOT_E2E_LIVE=1 与真实 API Key) |
