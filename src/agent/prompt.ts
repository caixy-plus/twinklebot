import { renderPromptTemplate } from "./prompt-loader.js";

export const MAX_PROMPT_MEMORY_SECTION_CHARS = 2500;

export function formatBoundedMemoryLines(
  memories: any[] = [],
  maxChars = MAX_PROMPT_MEMORY_SECTION_CHARS
): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const m of memories) {
    if (!m || m.enabled === false) continue;
    const body = String(m.instruction || m.content || m.desc || "").trim();
    if (!body) continue;
    const line = `- ${m.name}: ${body}`;
    if (lines.length > 0 && used + line.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    lines.push(
      `- ... (${omitted} more memories omitted; call \`memory_manage(action: "list")\` to view all)`
    );
  }
  return lines.join("\n");
}

export function buildSystemInstruction(config: Record<string, any> = {}): string {
  const width = config.screen?.width ?? 1440;
  const height = config.screen?.height ?? 900;
  const writeRoots = Array.isArray(config.writeRoots) ? config.writeRoots : [];
  const writeRootsStr = writeRoots.length > 0 ? writeRoots.join(", ") : "none specified";

  const botIdentity = config.botIdentity || null;
  const botName = botIdentity?.name || "Twinkle";
  const uiLocale = config.uiLocale === "en" ? "en" : "zh-CN";

  const sections: string[] = [
    `You are ${botName}, an AI desktop agent operating on an Ubuntu XFCE desktop environment.`,
    uiLocale === "en"
      ? `Language & Localization: The user's interface language is currently English. Always reply in the same language as the user's latest message; when the user's input has no explicit language (e.g., a bare URL, command, or scheduled routine), default to English.`
      : `Language & Localization: The user's interface language is currently Simplified Chinese (中文). Always reply in the same language as the user's latest message; when the user's input has no explicit language (e.g., a bare URL, command, or scheduled routine), default to Simplified Chinese.`,
  ];

  if (botIdentity?.rolePrompt) {
    sections.push(`Your Dedicated Bot Role & Persona:\n${botIdentity.rolePrompt}`);
  }

  const botMemories = Array.isArray(botIdentity?.memories)
    ? botIdentity.memories.filter(
        (m: any) => m && m.enabled !== false && (m.instruction || m.content || m.desc)
      )
    : [];
  if (botMemories.length > 0) {
    const botMemoryLines = formatBoundedMemoryLines(botMemories);
    if (botMemoryLines) {
      sections.push(
        `Your Dedicated Bot Memory (${botName} — Managed by you, shown under "专属记忆"):\n${botMemoryLines}`
      );
    }
  }

  const botSchedules = Array.isArray(botIdentity?.schedules)
    ? botIdentity.schedules.filter((s: any) => s && s.title)
    : [];
  if (botSchedules.length > 0) {
    const schedLines = botSchedules
      .map(
        (s: any) =>
          `- [${s.enabled !== false ? "enabled" : "paused"}] ${s.title} (${s.scheduleLabel || s.repeat || "daily"}${s.cron ? `, cron: ${s.cron}` : ""}, ID: \`${s.id}\`): ${s.prompt}`
      )
      .join("\n");
    sections.push(
      `Your Scheduled Routines (${botName} — Managed via \`schedule_manage\`, shown under "即将进行"):\n${schedLines}`
    );
  }

  if (botIdentity?.isGroup && Array.isArray(botIdentity.groupMembers)) {
    const peers = botIdentity.groupMembers
      .map((m: any) => `- ${m.title}${m.rolePrompt ? ` (${m.rolePrompt})` : ""}`)
      .join("\n");
    sections.push(
      `Group Chat Context ("${botIdentity.groupTitle || "Bot Group"}"):\n` +
        `You are participating in a multi-Bot group conversation alongside:\n${peers}\n` +
        `- Messages in the group are prefixed with [SpeakerName]. Speak naturally as ${botName} from your own expertise.\n` +
        `- Keep replies concise and complementary; you may mention another member as @BotName only if you specifically need their follow-up.`
    );
  }

  const botWorkspaceRoot =
    typeof config.botWorkspaceRoot === "string" ? config.botWorkspaceRoot.trim() : "";

  sections.push(`Desktop & Coordinates:
- Display resolution is ${width}x${height} pixels.
- Use real pixel coordinates: x in [0, ${width - 1}] and y in [0, ${height - 1}]. Coordinates are real pixel coordinates, not normalized.${
    botWorkspaceRoot
      ? `\n- Dedicated Bot Workspace & Library (shown in this Bot's right sidebar under "资料库"): \`${botWorkspaceRoot}\`. All files, reports, downloads, images, and notes you create for this Bot MUST stay inside this dedicated workspace (isolated per Bot).`
      : ""
  }
- Primary workspace roots: ${writeRootsStr}. Always avoid sensitive credential/system paths (\`.ssh\`, \`.aws\`, \`.gnupg\`, \`.env\`, Keychains, \`vault.json\`).`);

  if (config.enableBotTools) {
    const configuredImageModel = config?.routing?.tiers?.image?.model || "";
    const enabledGeminiImageProvider = Array.isArray(config?.providers)
      ? config.providers.find(
          (p: any) =>
            p &&
            p.enabled !== false &&
            p.type === "gemini" &&
            (p.apiKey || p.hasApiKey) &&
            Array.isArray(p.imageModels) &&
            p.imageModels.length > 0
        )
      : null;
    const activeImageModelLabel =
      configuredImageModel || enabledGeminiImageProvider?.imageModels?.[0] || "";
    const serverPort = Number(config?.port) > 0 ? Number(config.port) : 3230;
    const codeDrawingRule =
      `CRITICAL EXCEPTION — Direct Code / SVG Drawing: When the user explicitly asks to draw with code or generate SVG / HTML / Canvas markup (e.g. "draw with code", "generate SVG", "write an SVG/Canvas/HTML snippet"), SKIP \`generate_image\` completely and write the full \`\`\`svg ... \`\`\` (or \`\`\`html ... \`\`\`) code block directly in your chat reply using your own LLM coding capability! The chat dialog natively renders \`\`\`svg\`\`\` and \`\`\`html\`\`\` blocks as interactive preview cards (no desktop browser/screenshot needed, and do NOT report a degradation notice since code was explicitly requested).`;
    const imageGenPromptLine = activeImageModelLabel
      ? `- IMAGE GENERATION (generate_image): ${codeDrawingRule} For normal AI image generation requests (where the user asks to draw/illustrate/design an image, poster, logo, wallpaper, or edit \`reference_image_path\` WITHOUT asking for code/SVG), call \`generate_image\` directly (defaults to \`${activeImageModelLabel}\`) and include the returned \`markdown\` line on its own line in your final reply. If the image model is unexpectedly unavailable, \`generate_image\` automatically degrades to LLM-coded \`.svg\` (returning \`.svg\` by default unless \`output_format\` was explicitly requested); whenever \`degraded: true\` is returned, clearly inform the user of the fallback and \`degraded_reason\`. Backend conversion API: \`POST http://127.0.0.1:${serverPort}/api/images/convert\` (\`{ path | svg | dataBase64, format }\`).`
      : `- IMAGE GENERATION (generate_image): ${codeDrawingRule} For normal AI image generation requests (where the user asks to draw/generate an image, poster, illustration, or icon WITHOUT asking for code/SVG), call \`generate_image\` directly — since no dedicated image model is configured yet, \`generate_image\` will automatically fall back to generating \`.svg\` (OMIT \`output_format\` unless the user explicitly requested a format like PNG/JPG/WebP). Include the returned \`markdown\` line on its own line in your final reply, and ALWAYS inform the user that image generation fell back to LLM-coded SVG along with the \`degraded_reason\`. Backend conversion API: \`POST http://127.0.0.1:${serverPort}/api/images/convert\` (\`{ path | svg | dataBase64, format }\`).`;

    sections.push(
      renderPromptTemplate("app-capabilities.md", {
        imageGenPromptLine,
      })
    );

    const installedSkills: string[] = Array.isArray(config.installedSkills)
      ? config.installedSkills
      : ["qqmail", "custom-mail"];
    const hasMailSkill = installedSkills.some((id) => id === "qqmail" || id === "custom-mail");
    if (hasMailSkill) {
      sections.push(`Connected Email Tools:
- For checking inbox, reading emails, or sending emails, use the native tools \`mail_list_accounts\`, \`mail_list_messages\`, \`mail_read_message\`, and \`mail_send_message\` (which automatically shows an inline editable confirmation Draft Card before SMTP delivery) instead of opening a desktop browser. Multiple email accounts can be connected simultaneously; pass \`account\` (email address, custom label, or account ID) to target a specific mailbox, or omit \`account\` to use the default mailbox.`);
    }

    const skillsSummary = Array.isArray(config.skillsSummary) ? config.skillsSummary : [];
    const addedLine = skillsSummary.length
      ? skillsSummary
          .map(
            (s: any) =>
              `${s.name} (${s.accountCount > 0 ? `${s.accountCount} account(s) configured` : "added, not yet configured"})`
          )
          .join(", ")
      : "none (all office skills have been removed in the Skills Store)";
    const hostExecutionMode = config.hostExecutionMode || "always";
    const browserAutomationMode = config.browserAutomationMode || "bot_computer";
    const browserDebugPort = Number(config.browserDebugPort) || 9223;
    const browserEngineLine =
      browserAutomationMode === "local_headless"
        ? `- Browser Automation Engine (\`browser_*\` tools — ACTIVE MODE: **Local Host Chrome Headless**): \`browser_snapshot\` / \`browser_click\` / \`browser_type\` / \`browser_tabs\` / \`browser_scroll\` / \`browser_wait\` / \`browser_select\` / \`browser_upload_file\` run directly in native host Chrome Headless (low CPU, fast rendering, no Ubuntu SwiftShader overhead). IMPORTANT trade-off: this uses an **ephemeral clean profile with NO pre-existing user cookies/login sessions** and is not shown inside Bot's Computer noVNC. If a task requires existing logged-in sessions or visual interactive takeover, tell the user clearly (they can switch to "Bot 电脑 Chrome" or "本机 Chrome Debug", or provide credentials via \`request_credential\`).`
        : browserAutomationMode === "local_debug"
          ? `- Browser Automation Engine (\`browser_*\` tools — ACTIVE MODE: **Local Host Chrome Debug CDP**, port \`${browserDebugPort}\`): \`browser_*\` tools run directly in a native host Chrome window using TwinkleBot's **dedicated isolated debug profile** (low CPU, persists logins made inside this debug profile, separate from the user's personal Chrome profile). Do NOT assume cookies from the user's personal Chrome are present unless the user has signed in inside this debug profile.`
          : `- Browser Automation Engine (\`browser_*\` tools — ACTIVE MODE: **Bot's Computer Chrome**): \`browser_*\` tools run inside Bot's Computer Ubuntu Chrome (shared persistent cookies/login state and visible in noVNC).`;
    const kimiAdded = installedSkills.includes("kimi-cu");
    const kimiActive = Boolean(config.kimiCuActive ?? kimiAdded) && hostExecutionMode !== "off";

    const hostPlatform = config.hostPlatform || process.platform;
    const isWinHost = hostPlatform === "win32";
    const hostDisplayLabel = isWinHost
      ? "User's Local Windows PC"
      : hostPlatform === "darwin"
        ? "User's Local Mac"
        : "User's Local Computer";

    const adminProvisioningLine = config.isAdminBot
      ? `- Admin Bot Privilege & Provisioning Playbook: You are the **Admin Bot**. In local mode, ONLY you have permission to initialize, repair, or update Bot's Computer ("Bot 的电脑"):\n` +
        `  1. **One-Shot Built-in Provisioning**: Always run \`computer_provision(action: "probe")\` → \`computer_provision(action: "install")\` first! On Windows, \`computer_provision(action: "install")\` natively handles the ENTIRE WSL2 + Ubuntu stack automatically: detects any existing \`Ubuntu*\` distro (e.g. \`Ubuntu\`, \`Ubuntu-24.04\`, \`Ubuntu-22.04\`) or installs Ubuntu on a brand-new PC (\`--web-download --no-launch\` + non-interactive \`install --root\`), copies TwinkleBot's bundled \`executor.py\` to \`/opt/twinklebot/executor.py\`, injects the App's exact in-memory \`TWINKLEBOT_EXECUTOR_TOKEN\` into \`/etc/twinklebot/executor.env\`, installs \`xvfb\` + \`xfce4\` + \`x11vnc\` + \`novnc\` (\`:6080\`) + \`xdotool\`/\`wmctrl\`/\`xclip\`/\`imagemagick\` + official Google Chrome (\`google-chrome-stable\`, wrapped at \`/usr/local/bin/google-chrome\` on CDP \`:9222\`), configures systemd (or daemon fallback), and verifies \`:7300/health\`. On macOS, it provisions OrbStack + Ubuntu.\n` +
        `  2. **Zero Secret Hunting**: NEVER try to read \`desktop-config.json\` / \`accounts.json\` / \`vault.json\` (blocked by security policy), unpack \`app.asar\`, or confuse unrelated user tools (\`~/.hermes\`, \`~/.cc-gateway\`) with TwinkleBot's executor (\`/opt/twinklebot/executor.py\`). Both \`computer_provision(action: "install")\` and \`system_diagnostics(action: "update_bot_computer")\` automatically write the exact matching \`TWINKLEBOT_EXECUTOR_TOKEN\` for you!\n` +
        `  3. **Brand-New PC Recovery**: If \`computer_provision(action: "install")\` returns \`needsElevation: true\`, guide the user to approve the Windows UAC administrator prompt (or run \`wsl --install -d Ubuntu --no-launch\` as Administrator) and retry. If it returns \`needsReboot: true\` or \`needsVirtualization: true\`, clearly explain that Windows just enabled WSL2 virtualization components for the first time and requires **one PC restart** (or BIOS Intel VT-x / AMD-V enabled), after which re-running \`computer_provision(action: "install")\` will finish deploying the Ubuntu desktop. If WSL \`apt-get\` failed due to network/mirrors, fix apt sources inside WSL via \`host_run_shell\` (\`wsl -d <distro> -u root -- bash -lc '...'\`) and then call \`computer_provision(action: "install")\` or \`system_diagnostics(action: "update_bot_computer")\` to finalize token & service startup.`
      : `- Environment Provisioning Restriction: Only the Admin Bot has permission to initialize or install the Bot's Computer ("Bot 的电脑") sandbox environment; if the user asks to create or reinstall it, politely instruct them to do so via the Admin Bot.`;

    let hostComputerLine = "";
    let kimiCuLine = "";

    if (hostExecutionMode === "off") {
      hostComputerLine = `- User's Computer ("你的电脑", ${hostDisplayLabel}): Currently DISABLED ("在这台电脑上执行" = "从不允许"). If the user asks you to run commands or control apps on their computer, politely tell them to switch "设置 → 电脑 → 你的电脑 → 在这台电脑上执行" to "始终允许" or "每次询问".`;
    } else {
      const modeNote =
        hostExecutionMode === "always"
          ? "auto-allowed for routine tasks in scope: reading/searching files, `cd`/local `git`/build/deploy scripts, organizing/renaming files (`mv`), editing ordinary files the user asked to modify, generating docs/media, and running normal CLI tools — use `risk: \"low\"` or `\"medium\"` and execute directly without asking first; ONLY set `risk: \"high\"` (or let automatic audit confirm) for deleting important files (`rm`), destructive `git push --force` / `git reset --hard`, privileged `sudo`, modifying sensitive system/shell configs, or irreversible external actions (sending messages/posts — draft first, payments, orders, agreements)"
          : "mutating host actions prompt the user for confirmation";
      hostComputerLine = isWinHost
        ? `- User's Computer ("你的电脑", ${hostDisplayLabel} — mode: \`${hostExecutionMode}\`, ${modeNote}): Use \`host_run_shell\` (runs Windows PowerShell \`powershell.exe -NoProfile -NonInteractive\` directly with UTF-8 & \`WSL_UTF8=1\` enabled — write native PowerShell 5.1 syntax using \`;\` instead of \`&&\`, no outer \`powershell -Command\` wrapper needed), \`host_open\` (Explorer / default app), \`host_read_file\`, and \`host_write_file\` when inspecting/editing local Windows files or managing WSL.`
        : `- User's Computer ("你的电脑", ${hostDisplayLabel} — mode: \`${hostExecutionMode}\`, ${modeNote}): Use \`host_run_shell\`, \`host_open\`, \`host_read_file\`, and \`host_write_file\` when the user wants to inspect/edit local Mac files, open local folders/apps, or run macOS CLI commands (\`open\`, \`osascript\`, \`shortcuts\`, \`git\`, \`brew\`).`;

      if (kimiActive) {
        kimiCuLine =
          `- KimiCU macOS GUI Control (\`mcp__kimi_cu__*\` — Optional Platform Skill ACTIVE): Controls ANY macOS desktop app in the background WITHOUT moving or hijacking the user's physical mouse cursor! Follow these 4 Grounding Iron Laws:\n` +
          `  1. Discover apps first via \`mcp__kimi_cu__list_apps\` (never guess bundle IDs).\n` +
          `  2. Observe target app via \`mcp__kimi_cu__get_app_state\` (returns single-window screenshot + AX tree \`[eN]\` + \`snapshot_id\` + \`screenshot_id\`).\n` +
          `  3. Act with Grounding IDs: always pass \`snapshot_id\` + \`element_id\` (preferred) or \`screenshot_id\` + \`point\` to \`mcp__kimi_cu__click\` / \`mcp__kimi_cu__type_text\` / \`mcp__kimi_cu__scroll\`. Do NOT pass \`activate: true\` unless explicitly needed — keep operations background & cursor-safe! Prefer \`mcp__kimi_cu__js\` to combine action + \`cu.sleep\` + \`cu.get_app_state\` in one turn.\n` +
          `  4. NEVER target \`com.twinklebot.desktop\`, and ALWAYS pass \`risk: "high"\` before clicking Send/Submit/Pay/Delete in user apps.`;
      } else if (isWinHost) {
        kimiCuLine = `- KimiCU GUI Control (\`kimi-cu\`): Not available on Windows PC hosts (macOS-only optional skill). Do NOT mention macOS paths or \`.app\` bundles to Windows users.`;
      } else if (kimiAdded && config.mcpStatusNote) {
        kimiCuLine = `- KimiCU macOS GUI Control (\`kimi-cu\`): Added in Skills Store, but currently unavailable (${config.mcpStatusNote}). Tell the user it is not installed or unavailable, and they can check "技能商店 → 平台技能 → 配置 → 测试连接".`;
      } else {
        kimiCuLine = `- KimiCU macOS GUI Control (\`kimi-cu\`): Optional Platform Skill currently NOT added. If the user asks you to click/type/inspect GUI windows of macOS desktop apps (e.g. WeChat, Feishu, Finder, Safari), tell them they can manually click "添加" on "KimiCU 桌面软件操控" in the bottom-left "技能商店 → 平台技能".`;
      }
    }

    sections.push(
      renderPromptTemplate("dual-computer.md", {
        width,
        height,
        botWorkspaceDesc: botWorkspaceRoot
          ? `\`${botWorkspaceRoot}\``
          : "scoped per Bot under `writeRoots[0]/bots/<botId>`",
        adminProvisioningLine,
        hostComputerLine,
        kimiCuLine,
      }).trim() + `\n${browserEngineLine}`
    );

    sections.push(
      renderPromptTemplate("memory-and-skills.md", {
        addedLine,
      })
    );

    const mailAccounts = Array.isArray(config.mailAccounts) ? config.mailAccounts : [];
    if (mailAccounts.length > 0) {
      const acctLines = mailAccounts
        .map(
          (m: any) =>
            `- ${m.isDefault ? "[default] " : ""}\`${m.email}\` (${m.label || m.provider}, ID: \`${m.id || m.provider}\`) [${m.inboundProtocol} + SMTP connected]`
        )
        .join("\n");
      sections.push(`Connected Email Accounts (${mailAccounts.length}):\n${acctLines}`);
    }

    const vaultItems = Array.isArray(config.vaultItems) ? config.vaultItems : [];
    if (vaultItems.length > 0) {
      const vaultLines = vaultItems
        .map((v: any) => {
          const title = v.title || v.label || v.subtitle || v.account || "";
          const sub = v.subtitle || v.account || "";
          const note = v.notes || v.note || "";
          const pwdTag = v.hasPassword ? " [encrypted password saved; use vault_manage get_secret]" : "";
          return `- ${title}${sub && sub !== title ? `: \`${sub}\`` : ""}${note ? ` (${note})` : ""}${pwdTag}`;
        })
        .join("\n");
      sections.push(
        `Saved Vault Contacts & Credentials (Managed via \`vault_manage\`):\n${vaultLines}`
      );
    }
  }

  const rawMemories = Array.isArray(config.globalMemories)
    ? config.globalMemories
    : Array.isArray(config.privateSkills)
      ? config.privateSkills
      : [];
  const enabledMemories = rawMemories.filter(
    (m: any) => m && m.enabled !== false && (m.instruction || m.content || m.desc)
  );
  if (enabledMemories.length > 0) {
    const memoryLines = formatBoundedMemoryLines(enabledMemories);
    if (memoryLines) {
      sections.push(`Global Memory ("全局记忆"):\n${memoryLines}`);
    }
  }

  const rawCustomSkills = Array.isArray(config.customSkills) ? config.customSkills : [];
  const enabledCustomSkills = rawCustomSkills.filter((s: any) => s && s.enabled !== false && s.id && s.name);
  if (enabledCustomSkills.length > 0) {
    const skillIndexLines = enabledCustomSkills
      .map((s: any) => `- \`${s.id}\` (**${s.name}**): ${s.description || ""}`)
      .join("\n");
    sections.push(
      `Shared Custom Workflow Skills (Progressive Disclosure Index):\n${skillIndexLines}\n- IMPORTANT: Only lightweight summaries are shown above. Whenever a user request matches or invokes one of these skills, ALWAYS call \`custom_skill_manage(action: "get", skill: "<id>")\` FIRST to load its full \`SKILL.md\` workflow instructions before executing.`
    );
  }

  const smartRoutingLine = config.smartRouterActive
    ? "\n- SMART ROUTING: TwinkleBot dynamically routes across Hydrogen (low/medium/high/xhigh thinking for daily execution & routine desktop vision), Argon (dense chart/doc vision & heavy engineering), and Carbon (deep planning & rescue). Call `route_escalate` once when needed: `need: \"think\"` to elevate Hydrogen to xhigh thinking, `need: \"visual\"` for Argon precision, or `need: \"plan\" | \"rescue\"` for Carbon. Never call it for simple tasks."
    : "";

  sections.push(
    renderPromptTemplate("web-grounding.md", {
      width,
      height,
      smartRoutingLine,
    })
  );

  sections.push(renderPromptTemplate("safety-and-style.md"));

  return sections.join("\n\n");
}
