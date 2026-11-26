---
id: skills-channels-and-vault
title: 技能商店、外部聊天通道（飞书 / Telegram）、邮箱与保险库
summary: 左下角技能商店入口、自定义 SKILL.md 管理、飞书/Telegram 多机器人接入与 6 位配对码审批、多邮箱配置以及 AES 加密保险库
keywords: 技能商店, 自定义技能, SKILL.md, 飞书, feishu, Telegram, 机器人, 配对码, 白名单, 21001, 邮箱, QQ邮箱, 授权码, 保险库, Vault, secret_ref
platforms: [desktop, mobile, web]
---

# 技能商店、外部通道、邮箱与保险库

## 技能商店与自定义技能

- **界面入口**：桌面端左下角 **「技能商店」**（移动端在顶部/抽屉进入），分为 **平台技能**（如 KimiCU macOS 后台软件操控）、**办公与消息技能**（飞书机器人、Telegram 机器人、QQ 邮箱、通用邮箱）以及 **自定义技能（`SKILL.md`）**。
- **卸载边界**：移除技能时会弹出确认框，可勾选「同时清除已保存的加密凭据」，默认保留凭据以便重装复用。内置核心能力（如 `web_search` / `web_fetch`）默认常驻且不可被用户误删。
- **自定义技能（`custom_skill_manage`）**：可在对话或技能商店新建、编辑、搜索、启停或删除全局/Bot 专用 `SKILL.md`。

## 外部聊天通道（飞书机器人 & Telegram 机器人）

- **对话直接帮配原则**：当主人要求绑定、替换或排查飞书（`feishu-bot`）或 Telegram（`telegram-bot`）机器人时，**直接在对话中调用 `skill_configure_channel`** 完成建号、改绑目标 Bot（`target_bot`）、加减白名单、测试连接、重连或删除——**不要让主人自己去翻技能商店手动配置**。
- **多 Bot 与会话路由**：支持同时添加多个飞书和 Telegram 机器人账号，每个账号可单独绑定到一个专职 Bot 或多 Bot 群聊。飞书支持 WebSocket 长连接与 Webhook；Telegram 支持 Long Polling（可选 HTTP/SOCKS5 代理）与 Webhook。
- **6 位配对码审批**：陌生私聊/群成员向外部机器人发消息若不在白名单内，机器人会回复 6 位配对码；主人在 TwinkleBot 对话里把配对码发给 Bot 后，由 Bot 调用 `channel_pairing_manage`（`list` / `approve` / `reject` / `suspend` / `resume` / `delete`）直接放行并自动写入对应白名单。
- **常见排错提示**：
  - 飞书提示权限错误或 `code 21001`：确认该飞书应用创建在**企业/团队组织账号**下（非个人或豆包个人账号）、已开启**机器人**能力、订阅 `im.message.receive_v1` 事件且**已发布生效版本**。
  - 若主人尚未提供 `app_secret` / `bot_token`，调用 `skill_configure_channel` 时省略密钥参数，前端会自动弹出加密凭据卡安全采集；若主人已在消息中直接粘贴，立即配置并提醒其事后可按需轮换平台密钥。

## 邮箱集成（QQ 邮箱 & 通用邮箱）

- 支持同时绑定多个邮箱账号，可指定某账号为默认发信/收信箱。
- **QQ 邮箱专用引导**：须使用 **16 位邮箱授权码**而非 QQ 登录密码（在 QQ 邮箱网页端「设置 → 账户 → 开启 POP3/IMAP/SMTP」生成）。
- **对话工具链**：优先使用内置 `skill_configure_mail`（配置）、`mail_list_accounts`、`mail_list_messages`、`mail_read_message` 与 `mail_send_message`（自动生成草稿确认卡经主人确认后再走 SMTP 发送），无需特意启动桌面浏览器网页版邮箱。

## 保险库（Vault）与敏感凭据防泄漏

- **界面位置**：「设置 → 保险库」管理联系人、账号记录与加密密码，底层使用本机 AES-256-GCM 密文落盘（`vault.json`）。
- **凭据安全流转**：`vault_manage(action: "get_secret", item: "...")` 返回不透明句柄 `secret_ref`（格式 `{{secret:cred_...}}`）；仅可将该句柄传给 `browser_type`（首选）或 OS 级 `type_text`（跨域登录框/原生窗口聚焦后输入），**严禁写入 `run_shell`、URL 或回显给用户**。
