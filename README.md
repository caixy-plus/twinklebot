# TwinkleBot (v1.0.0)

TwinkleBot 是一个跨平台 **Multi-Bot AI 桌面与移动端智能体**：支持在单机或局域网/云端架构下协同调度多位专属 Bot 与群聊，支持通过 OrbStack Ubuntu XFCE 沙箱桌面（`:1`，1440×900）与宿主机执行桥（Host Executor）完成文件处理、终端命令、浏览器自动化及日常任务。

## 安装包下载（GitHub Releases）

桌面端预编译安装包（macOS `.dmg`/`.zip`、Windows `.exe`/`.zip`、Linux `.AppImage`/`.tar.gz`）发布在 [GitHub Releases](https://github.com/caixy-plus/twinklebot-releases/releases)：

- **最新版本**：[Latest Release](https://github.com/caixy-plus/twinklebot-releases/releases/latest)
- **全部版本**：[github.com/caixy-plus/twinklebot-releases/releases](https://github.com/caixy-plus/twinklebot-releases/releases)

## 核心能力

- **多模型供应商与三档智能路由**：支持 Gemini、Vertex AI、OpenAI、DeepSeek、Anthropic 及任意 OpenAI-Compatible 接口；API Key 支持直接填写密钥或环境变量名；内置 `极速 / 中等 / 高级 / 生图` 分档智能路由与单轮预算保护。
- **多端统一体验**：提供 Web（`http://127.0.0.1:3230`）、Electron 桌面应用、以及 Capacitor 移动端（Android 支持局域网自动发现 `LanDiscovery`；桌面端额外支持 Web Speech 语音朗读）。
- **可控长上下文管理**：支持 **上下文过长自动压缩（可配置规则）**——支持智能摘要压缩 / 滑动窗口截断两种策略，并可自定义触发步数阈值、字符阈值、保留最近轮次、保留截图数、工具输出截断长度与自定义保留提示；支持一键 **清空会话记录** 与 **用户消息就地修改重发（覆盖后续历史与上下文）**。
- **扩展生态**：内置商店技能（网页检索 `websearch`、QQ 邮箱、自定义 IMAP/SMTP 邮箱、macOS 桌面控制 `kimi-cu`）、自定义 Markdown 技能（`data/custom-skills/`）、定时任务调度、MCP 服务接入与加密保险库。

## 目录结构（TypeScript 模块化架构）

```text
twinklebot/
├── src/
│   ├── shared/      # 前后端共享类型、DTO 与浏览器安全模块（accounts-store / skills-catalog / context-compression）
│   ├── server/      # HTTP / WebSocket 服务端（index.ts、context.ts、http-utils.ts、static.ts、routes/*.ts）
│   ├── agent/       # 执行循环、智能路由、上下文压缩、权限策略、模型适配（providers/*.ts）、工具集（bot-tools/*.ts）
│   ├── store/       # 会话（.json/.ndjson/.history.json）、技能、日程、保险库原子持久化（写入 data/）
│   ├── lib/         # LAN 发现、设备配对鉴权、邮件客户端、MCP 客户端、网页搜索、计费与宿主机桥接
│   ├── electron/    # Electron 主进程与桌面端配置
│   ├── web/         # 前端 Web/Desktop/Mobile TypeScript 源码（app.ts、modules/*.ts、mobile-*.ts）
│   └── landing/     # 官网展示页源码
├── public/          # 静态资源、样式（style.css / mobile.css）与编译产物 public/dist/
├── executor/        # Ubuntu 沙箱执行守护脚本（仅依赖 Python 3 标准库，监听 7300 端口）
├── android/ & ios/  # Capacitor 原生工程（含 Android LanDiscoveryPlugin）
└── test/            # Node test 测试套件
```

## 环境要求与快速启动

### 环境要求

1. **Node.js 22.13+**（ESM + TypeScript）
2. **可选沙箱桌面（OrbStack Ubuntu）**：运行在 `:1`（1440×900），安装 `xdotool`、`wmctrl`、`xclip`、`imagemagick`、`firefox`、`fonts-noto-cjk`、`fonts-noto-color-emoji` 与 noVNC（端口 `6080`）
3. **模型密钥**：可在根目录 `.env` 中配置 `GEMINI_API_KEY`（或其它供应商环境变量），也可启动后直接在前端「设置 → 模型接入与路由」中填写密钥或环境变量名完成引导

### 启动服务与命令行模式

```bash
# 1. 安装依赖
npm install

# 2. （可选）部署 Ubuntu 沙箱执行器（生成 TWINKLEBOT_EXECUTOR_TOKEN 并启动 twinklebot-executor.service）
./scripts/deploy-executor.sh

# 3. 编译 TypeScript 并启动本地服务（http://127.0.0.1:3230）
npm start

# 或使用命令行模式单次执行任务
npm run cli -- "你的任务描述"
```

## 打包与构建

```bash
# 类型检查与编译（dist-server/ + public/dist/ + landing/dist/）
npm run typecheck
npm run build:ts

# 桌面端打包（Electron）
npm run electron:pack:mac    # macOS 免签名目录包（dist/mac-arm64/TwinkleBot.app）
npm run electron:dist:mac    # macOS dmg / zip 安装包
npm run electron:dist:win    # Windows 安装包
npm run electron:dist:linux  # Linux AppImage / tar.gz

# 移动端构建（剥离服务端与敏感文件至 dist-web/ 并同步 Capacitor）
npm run mobile:build:web
npm run mobile:sync:android
npm run mobile:apk:debug
```

## 安全机制

- **本地回环与令牌隔离**：Web 服务默认绑定 `127.0.0.1:3230`（开启局域网访问或云端模式时强制 Bearer Token 设备配对鉴权）；Ubuntu 执行器（端口 `7300`）与宿主机通信均校验令牌。
- **高危操作与目录写保护**：`sudo`、`rm`、目录外移动/写入、管道脚本执行、删除数据或外发邮件/消息等高危动作默认触发用户确认；敏感路径（`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gcloud`、`.env*`、`*credentials*`、`*secret*`、`*token*`、`id_rsa`、`id_ed25519`）在策略层与执行层双重拦截，严禁读取、外发或提交到 Git。
- **提示注入防御**：系统提示词严格将屏幕内容与网页/邮件正文视作不可信数据，防止越权指令注入。
- **上下文与资源保护**：默认单任务上限 60 步、单条 Shell 超时 120 秒，并依据可配置的上下文压缩规则自动裁剪历史截图、截断早期工具输出或压缩旧对话轮次。

## 测试

```bash
# 运行全部后端/前端契约单元测试（先编译 TypeScript，再运行 node --test）
npm test

# 运行 Ubuntu 执行器单元测试
orb -m ubuntu bash -lc 'cd /Users/YOUR_USERNAME/Workspace/twinklebot && python3 -m unittest discover -s executor -v'
```
