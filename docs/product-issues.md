# TwinkleBot 产品问题 / 改进台账（Product Issues & Backlog）

> **记录规则（本文件是唯一台账）**
> - **用途**：记录作者在日常使用 / 测试中发现的**产品问题、体验缺陷、能力缺口、改进建议**。
> - **只记录问题**：每条写**问题现象 + 根因位置（文件:行号）**，**不写解决方案 / 修复建议 / 期望改法**（避免误导实现者，由实际修复方自行判断）。
> - **每条一行**，字段固定为：`ID | 区域 | 严重度 | 状态 | 简述 | 相关代码 / 根因`。
> - **ID**：`PI-XXX`（三位递增，不复用）。
> - **状态**：`NEW` / `PLANNED` / `FIXING` / `FIXED`（标提交号）/ `WONTFIX`（写原因）。
> - **严重度**：`P0` 阻断 / `P1` 严重 / `P2` 一般 / `P3` 建议。
> - **追加不覆盖**：只往末尾追加，修复时只改状态并补提交号。
> - **必带源码定位**：每条必须写明具体文件路径（+行号）。

## 台账

| ID | 区域 | 严重度 | 状态 | 简述 | 相关代码 / 根因 |
|----|------|--------|------|------|------------------|
| PI-001 | Agent 能力自认知 | P1 | FIXED (4fa6694) | Bot 不知道 App 右侧自带「Bot 的电脑」实时查看面板，想让用户看屏幕时甩 `localhost:6080/vnc.html` 裸地址，而非引导用户点右侧面板 | `src/agent/prompt.ts`（缺产品自认知段）；`src/web/components/inspector/RightInspector.tsx:726`（`Bot 的电脑` 面板已存在）；`src/shared/config.ts:74` / `src/server/index.ts:147`（novncUrl 来源） |
| PI-002 | Agent 桌面控制 | P1 | FIXED (4fa6694) | Prompt 明确"劝退" OS 级点击（只允许非浏览器窗口 / canvas / 看外观时兜底），撞上跨域 iframe（如 Apple / Google 登录）即放弃，不会用 screenshot→click→type_text 兜底 | `src/agent/prompt.ts`（"ZERO-SCREENSHOT WEB GROUNDING" 段未把跨域 iframe 列入兜底触发条件）；能力本身存在于 `src/agent/tools.ts:76-149` |
| PI-003 | 凭据安全通道 | P1 | FIXED (2517abd) | `type_text` / `key` 不能消费加密凭据 `secret_ref`，OS 级输入接不了凭据卡；跨域 iframe 密码框无法安全输入（只有 browser_type 能注入 secret） | `src/agent/tools.ts`：`SECRET_INJECTABLE_TOOLS = new Set(["browser_type"])` |
| PI-004 | 消息来源标识 | P2 | FIXED (b8cfe96) | 聊天消息未标注来源（手机端 / 电脑端），无法区分消息从哪一端发出 | 消息 DTO 无 source/device 字段；气泡无 badge；`src/web/mobile-bridge.ts` 已有 `getMobilePlatform()` / `isNativePlatform()` 可复用 |
| PI-005 | 移动端 VNC 输入 | P2 | FIXED (b8cfe96) | 手机浏览器打开 noVNC 桌面时，点击输入框无法唤起手机输入法（软键盘弹不出），无法在远程桌面里输入 | noVNC 客户端焦点 / IME 问题；挂载入口 `src/web/state/helpers.ts:256-305`、`src/web/components/modals/BotComputerOverlay.tsx:79-85` |
| PI-006 | 保险箱 / 凭据存储 | P1 | FIXED (2517abd) | 保险箱不能存密码：产品本意是「账号+密码」，但 `vault_manage` 只支持 contact/account/note 三类、无 password 字段；凭据卡勾选「存入保险箱」只写一条 `category:"credential"` 的壳（标题+账号+备注），密码本身不落盘，仅存 30 分钟临时内存 | `src/agent/bot-tools/declarations.ts:823`；`src/agent/bot-tools/system-tools.ts:691-697,765-771`（只存 title/subtitle/notes）；`src/agent/bot-tools/collab-tools.ts:560-570`（saveToVault 不写密码）；`src/store/index.ts:757-795`（vault.json 无 password 字段） |
| PI-007 | 本机加密落盘 | P1 | FIXED (2517abd) | 保险箱与邮箱授权明文落盘、无本机加密：`data/vault.json`、`data/mail-auth.json` 均为明文 JSON；`integrations.ts` 对邮箱密码宣称「仅加密保存在本机」，但全项目无任何加密实现（encrypt/cipher/safeStorage/keytar 均无） | `src/store/index.ts:99-100,791-795`（vaultFile/mailAuthFile + writeJsonAtomic 明文）；`src/agent/bot-tools/integrations.ts:893` |
| PI-008 | 移动端横向溢出 | P1 | FIXED (d104dd3) | 手机端聊天框可横向滚动（无可见滚动条却能左右拖拽）；作者实测根因＝**权限确认卡片太高太宽**。要求：手机端绝不能出现横向滚动 | 权限确认卡 `.confirm-card`：`src/web/styles/04-chat/interactive-cards.css:150-157`（只设 `max-width:80%`，无 `overflow-x:hidden` / `min-width:0`）；`.confirm-cmd-details` `:515-522` 长命令不换行（无 overflow-wrap/word-break）；`.confirm-actions` `:178-182`；卡片无 `max-height` |
| PI-009 | 跨平台 / Windows 适配 | P1 | FIXED (d104dd3) | Windows 版出现 **Mac 专属路径/提示**：KimiCU(`kimi-cu`) 未安装时把 `/Applications/KimiCU.app/...` 抛给用户（预期只需说"未安装/不可用"）。这类"项目主要在 Mac 开发→硬编码 Mac 路径/`.app`"是普遍隐患 | `src/lib/mcp-client.ts:17-21`（`DEFAULT_MCP_SERVERS["kimi-cu"].command` 写死 Mac 路径，无平台判断）；`:315-318`；`:625`；`src/agent/prompt.ts:166-169`；`src/web/components/modals/SkillsStoreModal.tsx:527,2507,2532-2536` |
| PI-010 | 权限确认 / 放行逻辑 | P1 | FIXED (4fa6694) | 已把「你的电脑」设为**完全允许执行任何命令**（`hostExecutionMode="always"`），但仍频繁弹**文件读写确认框**，与"完全放行"预期不符。根因：命令放行与文件读写放行是两套独立边界 | `src/agent/policy.ts` `assessToolCall`：默认 always(:156)、`off`→deny(:159)、敏感路径 deny / 跨 Bot 工作区 confirm(:174-200)、`risk:"high"`→confirm(:238-243)、sandbox `full` 放行(:246-252)、`ask` 模式 confirm(:255-262)、**写入 `writeRoots` 外→confirm(:286 起)** |
| PI-011 | 权限语义 / 双电脑区分 | P2 | FIXED (4fa6694) | 预期「在这台电脑上执行/允许本地执行」指**你的电脑（宿主机）**、「Bot 的电脑」是沙箱命令免确认；但 prompt 未明确写"沙箱内命令无需确认"，且「你的电脑」段强调 `Auto-audit always checks every action`，易把沙箱与宿主机权限混为一谈 | 提示词 `src/agent/prompt.ts:137-157`（`:139` Bot's Computer 未说明沙箱免确认；`:150,155-156` 受 hostExecutionMode + auto-audit）；设置文案 `src/web/components/modals/SettingsModal.tsx:2767-2794`；权限实现 `src/agent/policy.ts:155-262` |
| PI-012 | 移动端输入 / 语音输入 | P2 | FIXED (d104dd3) | 手机端点发送后**输入框文字有时不被清空**（非必现、与语音输入相关）：发送已清空 `composerText`，但语音识别异步把识别文本又写回 | `src/web/services/actions.ts:1066-1072`（发送后 `composerText: ""`）；`src/web/services/actions.ts:2032-2040`（`rec.onresult` 异步 `composerText: prev+transcript`）；`src/web/components/chat/Composer.tsx:396-398`（受控 value=composerText） |
| PI-013 | E2E 测试覆盖 / 技能商店 | P2 | FIXED (5ad9a21) | 全量自动化测试对**技能商店**覆盖偏粗：仅 `p1-skills-mail-and-mcp` 一个 suite、5 条 P1-SKILL 用例，实际写成一个大 test；多个子功能无独立断言（邮件多账号/设默认/删账号/连通性失败/QQ 16位授权码；KimiCU 未安装·未检测/配置编辑/重连；技能禁用/启停边界/列表详情搜索边界/安装卸载确认） | `.agents/skills/twinklebot-e2e/references/catalog.json`（suite 5 用例）；`references/test-plan.md:3,68-72`；`test/e2e/p1-skills-mail-and-mcp.e2e.ts`（单大 test，关键词取证缺失：set_default/remove_account/test_account/reconnect/未检测/未安装/认证码/16 位/多账号/disable 均未命中） |
| PI-014 | 代码可维护性 / 提示词 | P3 | FIXED (4fa6694) | 系统提示词全部内联硬编码在 `prompt.ts` 中，与代码强耦合：修改提示词需改 TS、diff 不直观、非研发无法编辑 | `src/agent/prompt.ts`（系统提示词以内联字符串拼装） |
| PI-015 | 移动端交互 / 键盘 | P2 | FIXED (d104dd3) | 手机端键盘弹出后，向上滑动查看历史消息时键盘**不会自动收起**（滚动消息区时未 blur 输入框） | `src/web/hooks/useChatScrollPin.ts:24-52`（handleScroll 仅处理 autoScrollPinned + 底部指标同步，pointerdown/touchstart/wheel 只 clearScrollPinGuard，无 blur）；`src/web/mobile-ui.ts` initKeyboardViewportSync 只管键盘开合视口，无"滚动→blur" |
| PI-016 | 记忆功能 / 自动触发 | P2 | FIXED (4fa6694, 28b5315) | 自动记忆触发机制不可靠：有时记录无关紧要的信息（过度记录）、有时该记的却漏记，全靠模型自行判断、无用户提醒式触发 | `src/agent/prompt.ts:187-195`（"Memory vs Shared Custom Skills (Auto-Classify & Execute Directly)" 仅软性规则）；`src/agent/bot-tools/declarations.ts:493-537`（memory_manage 无触发/去重/重要性逻辑）；`src/agent/bot-tools/system-tools.ts:101 起`（save/remove/toggle 直接落库） |
