import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderAppHtml, ssr } from "./helpers/react-test-helpers.js";

test("reduceSessionEvent handles user, thought, tool_call/tool_result, thinking_summary, and done transitions", () => {
  let state = {
    ...ssr.createInitialState(),
    activeSessionId: "s-test",
    sessionStatus: "running",
    autoScrollPinned: false,
  };

  // 1. Live user_message appends message item, records seq, and re-pins scroll
  state = ssr.reduceSessionEvent(state, {
    type: "user_message",
    seq: 1,
    text: "帮我画一个 SVG 图标",
    at: "2026-11-16T10:00:00.000Z",
  }).next;
  assert.equal(state.autoScrollPinned, true);
  assert.equal(state.renderedSeqs.has(1), true);
  assert.ok(
    state.streamItems.some(
      (it: any) => it.kind === "message" && it.isUser === true && it.text === "帮我画一个 SVG 图标"
    )
  );

  // Duplicate seq in live mode is ignored, but allowed in replay mode
  const afterDupLive = ssr.reduceSessionEvent(state, {
    type: "user_message",
    seq: 1,
    text: "重复事件",
  }).next;
  assert.equal(afterDupLive.streamItems.length, state.streamItems.length);

  const afterDupReplay = ssr.reduceSessionEvent(
    state,
    { type: "user_message", seq: 1, text: "回放同序号事件" },
    { replay: true }
  ).next;
  assert.ok(afterDupReplay.streamItems.length > state.streamItems.length);

  // 2. thinking_summary sanitizes punctuation and updates liveThinkingSummary
  state = ssr.reduceSessionEvent(state, {
    type: "thinking_summary",
    text: "正在构思图标草稿...",
  }).next;
  assert.equal(state.liveThinkingSummary, "正在构思图标草稿");

  // 3. thought + tool_call + tool_result populate traceItems and stepCount
  state = ssr.reduceSessionEvent(state, {
    type: "thought",
    text: "先用代码直接输出 SVG",
    usedModel: "models/gemini-4-argon",
  }).next;
  assert.equal(state.lastObservedModel, "gemini-4-argon");
  assert.equal(state.traceItems.length, 1);

  state = ssr.reduceSessionEvent(state, {
    type: "tool_call",
    callId: "c-1",
    name: "run_shell",
    args: { command: "ls -la" },
  }).next;
  assert.equal(state.stepCount, 1);
  assert.equal(state.traceItems[1].status, "pending");

  state = ssr.reduceSessionEvent(state, {
    type: "tool_result",
    callId: "c-1",
    name: "run_shell",
    result: { exit_code: 0, stdout: "ok" },
  }).next;
  assert.equal(state.traceItems[1].status, "ok");

  // 4. answer + done append assistant message and reset liveThinkingSummary
  state = ssr.reduceSessionEvent(state, {
    type: "answer",
    seq: 2,
    text: "这是为你生成的图标：\n```svg\n<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/></svg>\n```",
  }).next;
  state = ssr.reduceSessionEvent(state, {
    type: "done",
    status: "done",
  }).next;
  assert.equal(state.sessionStatus, "done");
  assert.equal(state.liveThinkingSummary, "");
  assert.ok(
    state.streamItems.some(
      (it: any) => it.kind === "message" && it.isUser === false && it.seq === 2
    )
  );
});

test("reduceSessionEvent manages ChoiceCard and ApprovalCard lifecycle in live vs replay mode", () => {
  let state = {
    ...ssr.createInitialState(),
    activeSessionId: "s-cards",
    sessionStatus: "idle",
  };

  // Replay of historical choice_request must NOT flip idle sessionStatus to awaiting_choice
  const replayed = ssr.reduceSessionEvent(
    state,
    {
      type: "choice_request",
      callId: "ch-old",
      questions: [{ id: "q1", question: "选择风格", options: ["扁平", "拟物"] }],
    },
    { replay: true }
  ).next;
  assert.equal(replayed.sessionStatus, "idle");

  // Live choice_request flips sessionStatus to awaiting_choice; choice_superseded marks earlier choice superseded
  state = ssr.reduceSessionEvent(state, {
    type: "choice_request",
    callId: "ch-1",
    questions: [{ id: "q1", question: "选择配色", options: ["深色", "浅色"] }],
  }).next;
  assert.equal(state.sessionStatus, "awaiting_choice");

  state = ssr.reduceSessionEvent(state, {
    type: "choice_superseded",
    callId: "ch-1",
  }).next;
  state = ssr.reduceSessionEvent(state, {
    type: "choice_request",
    callId: "ch-2",
    questions: [{ id: "q2", question: "选择尺寸", options: ["16x16", "32x32"] }],
  }).next;
  const firstChoice = state.streamItems.find((it: any) => it.callId === "ch-1");
  const secondChoice = state.streamItems.find((it: any) => it.callId === "ch-2");
  assert.equal(firstChoice.status, "superseded");
  assert.equal(secondChoice.status, "pending");

  state = ssr.reduceSessionEvent(state, {
    type: "choice_resolved",
    callId: "ch-2",
    selected: "32x32",
  }).next;
  assert.equal(
    state.streamItems.find((it: any) => it.callId === "ch-2").status,
    "resolved"
  );

  // Live approval_request -> approval_resolved
  state = ssr.reduceSessionEvent(state, {
    type: "approval_request",
    callId: "ap-1",
    name: "run_shell",
    args: { command: "rm -rf /tmp/demo" },
    reason: "敏感命令审批",
  }).next;
  assert.equal(state.sessionStatus, "awaiting_approval");

  state = ssr.reduceSessionEvent(state, {
    type: "confirmation_resolved",
    callId: "ap-1",
    allowed: true,
  }).next;
  const resolvedApproval = state.streamItems.find((it: any) => it.callId === "ap-1");
  assert.equal(resolvedApproval.resolved, true);
});

test("MessageGroup, MarkdownRenderer, MarkupPreviewCard, and InteractiveCards render declarative markup", () => {
  // MarkdownRenderer: GFM table + fenced code block
  const mdHtml = ssr.renderMarkdownToStaticMarkup(
    "### 性能对比\n\n| 框架 | 耗时 |\n| --- | --- |\n| React 19 | 12ms |\n\n```ts\nconst ok = true;\n```"
  );
  assert.ok(mdHtml.includes('class="msg-table-scroll"'));
  assert.ok(mdHtml.includes("<td>React 19</td>"));
  assert.ok(mdHtml.includes('class="msg-code-block"'));

  // MarkupPreviewCard: sandboxed iframe without allow-same-origin
  const svgCardHtml = ssr.renderMarkupPreviewToStaticMarkup({
    code: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>',
    kind: "svg",
    badgeLabel: "SVG 预览",
    lang: "svg",
  });
  assert.ok(svgCardHtml.includes('data-preview-kind="svg"'));
  assert.ok(svgCardHtml.includes("SVG 预览"));
  assert.ok(svgCardHtml.includes('sandbox="allow-scripts allow-forms"'));
  assert.equal(svgCardHtml.includes("allow-same-origin"), false);

  // MessageGroup with reply quote and embedded SVG code fence (TTS, emoji reaction, feedback removed)
  const msgHtml = ssr.renderStreamItemToStaticMarkup({
    kind: "message",
    id: "m-1",
    seq: 42,
    text: "给你画好了：\n```svg\n<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>\n```",
    isUser: false,
    botName: "Nori",
    replyTo: { seq: 41, author: "用户", snippet: "画个方块" },
  });
  assert.ok(msgHtml.includes('class="msg-reply-anchor"'));
  assert.ok(msgHtml.includes("画个方块"));
  assert.ok(msgHtml.includes('data-preview-kind="svg"'));
  assert.ok(msgHtml.includes('aria-label="回复此消息"'));
  assert.ok(msgHtml.includes('aria-label="复制文本"'));
  assert.equal(msgHtml.includes('aria-label="朗读此消息"'), false);
  assert.equal(msgHtml.includes('aria-label="添加表情回应"'), false);
  assert.equal(msgHtml.includes('aria-label="反馈改进此回复"'), false);

  // ChoiceCard, ApprovalCard, DraftCard, CredentialCard, BotExchangePill
  const choiceHtml = ssr.renderStreamItemToStaticMarkup({
    kind: "choice",
    id: "c-card",
    callId: "call-ch",
    questions: [
      {
        id: "q1",
        question: "部署环境？",
        options: ["本地", "云端"],
        multiSelect: false,
        placeholder: "",
      },
    ],
    allowCustom: true,
    status: "pending",
  });
  assert.ok(choiceHtml.includes('class="choice-card"'));
  assert.ok(choiceHtml.includes("部署环境？"));

  const approvalHtml = ssr.renderStreamItemToStaticMarkup({
    kind: "approval",
    id: "a-card",
    callId: "call-ap",
    name: "run_shell",
    args: { command: "echo test" },
    reason: "执行终端命令",
    resolved: false,
  });
  assert.ok(approvalHtml.includes('class="confirm-card"'));
  assert.ok(approvalHtml.includes("执行终端命令"));

  const draftHtml = ssr.renderStreamItemToStaticMarkup({
    kind: "draft",
    id: "d-card",
    callId: "call-dr",
    draftKind: "email",
    recipient: "team@example.com",
    title: "周报汇总",
    content: "本周重构完成。",
    resolved: false,
  });
  assert.ok(draftHtml.includes('class="draft-card"'));
  assert.ok(draftHtml.includes("team@example.com"));

  const credHtml = ssr.renderStreamItemToStaticMarkup({
    kind: "credential",
    id: "cr-card",
    callId: "call-cr",
    service: "GitHub",
    label: "Personal Access Token",
    resolved: false,
  });
  assert.ok(credHtml.includes('class="credential-card"'));
  assert.ok(credHtml.includes("Personal Access Token"));

  const exHtml = ssr.renderStreamItemToStaticMarkup({
    kind: "bot_exchange",
    id: "ex-card",
    exchangeId: "ex-1",
    messageCount: 3,
    peer: { title: "ReviewerBot" },
  });
  assert.ok(exHtml.includes("ReviewerBot"));
});

test("Native <dialog> elements, Settings 7 tabs, Skills Store 3 views, and App shell data attributes", async () => {
  const html = renderAppHtml({
    sidebarCompact: true,
    inspectorOpen: false,
    mobileView: "chat",
    accentColor: "blue",
    appsModalOpen: true,
    skillsView: "manage",
    settingsModal: { open: true, tab: "permissions" },
  });

  // App shell root data-* state reflection
  assert.ok(html.includes('data-sidebar-compact="true"'));
  assert.ok(html.includes('data-inspector-open="false"'));
  assert.ok(html.includes('data-mobile-view="chat"'));
  assert.ok(html.includes('data-accent-color="blue"'));

  // Native <dialog> elements must NOT add redundant role="dialog" or aria-modal="true"
  for (const dialogId of [
    "app-confirm-dialog",
    "html-preview-dialog",
    "shortcuts-help-dialog",
  ]) {
    const match = html.match(new RegExp(`<dialog[^>]*id="${dialogId}"[^>]*>`));
    assert.ok(match, `missing native <dialog id="${dialogId}">`);
    assert.equal(match[0].includes('role="dialog"'), false, `${dialogId} must not set role="dialog"`);
    assert.equal(match[0].includes("aria-modal="), false, `${dialogId} must not set aria-modal`);
  }

  // All 7 Settings tabs & panes present, and active tab is permissions
  for (const tab of [
    "general",
    "models",
    "computer",
    "permissions",
    "vault",
    "usage",
    "updates",
  ]) {
    assert.ok(html.includes(`data-settings-tab="${tab}"`), `missing settings tab ${tab}`);
    assert.ok(html.includes(`data-settings-pane="${tab}"`), `missing settings pane ${tab}`);
  }
  assert.match(html, /data-settings-pane="permissions"(?![^>]*hidden)/);
  assert.ok(
    !html.includes("settings-content is-usage-pane-active"),
    "non-usage settings tabs must keep standard .settings-content padding"
  );

  const usageHtml = renderAppHtml({
    settingsModal: { open: true, tab: "usage", standaloneBotSessionId: "s-1" },
  });
  assert.ok(
    usageHtml.includes("settings-content is-usage-pane-active"),
    "usage settings tab must apply is-usage-pane-active to avoid stacking outer and inner padding"
  );

  // Skills Store manage view visible while store & detail views are hidden
  assert.match(html, /id="skills-manage-view"(?![^>]*hidden)/);
  assert.match(html, /id="skills-store-view"[^>]*hidden=""/);
  assert.match(html, /id="skill-detail-view"[^>]*hidden=""/);

  // Diagnostics pane renders exact /api/system/diagnostics fields without any "undefined"
  const diagHtml = renderAppHtml({
    settingsModal: { open: true, tab: "updates" },
    diagnostics: {
      appVersion: "1.2.0",
      nodeVersion: "v24.22.2",
      platform: "darwin/arm64",
      llmConfigured: true,
      geminiKeyConfigured: true,
      deployEnv: "local",
      executorOnline: true,
      executorLatencyMs: 3,
      executorUrl: "http://127.0.0.1:7300",
      models: ["gemini-4-argon"],
      writeRoots: ["/tmp/ws"],
      sessionCount: 7,
    },
  });
  assert.ok(diagHtml.includes("TwinkleBot v1.2.0 (darwin/arm64)"));
  assert.ok(diagHtml.includes("Node.js v24.22.2 · 当前管理 7 个会话"));
  assert.ok(diagHtml.includes("模型已就绪"));
  assert.ok(diagHtml.includes("在线 (http://127.0.0.1:7300) · 响应延迟 3ms"));
  assert.equal(diagHtml.includes("undefined"), false, "Diagnostics markup must never contain 'undefined'");

  assert.equal(html.includes('id="tier-tts-select"'), false);
  assert.equal(html.includes('id="provider-tts-models-input"'), false);
  assert.equal(html.includes('id="voice-select"'), false);
  assert.equal(html.includes('id="reaction-picker-popover"'), false);

  const { formatClientRouteLabel } = await import("../src/web/state/helpers.js");
  assert.equal(formatClientRouteLabel("极速对话 · Flash", "gemini-4-argon"), "极速对话 · Flash");
  assert.equal(formatClientRouteLabel("中等档 · deepseek-v4-pro", "gemini-4-argon"), "中等档 · deepseek-v4-pro");
});

test("Bot preset avatars preserve all 13 shapes x 11 colors with Astro-Visor mascot lineage and zero tilted Grok eyes", async () => {
  const { BOT_SHAPES, BOT_COLORS, getMascotFaceElements } = await import("../src/web/avatars.js");

  assert.deepEqual(
    BOT_SHAPES.map((s) => s.key),
    [
      "blob",
      "cloud",
      "square",
      "sparkle",
      "clover",
      "heart",
      "flower",
      "teardrop",
      "tablet",
      "wedge",
      "house",
      "star",
      "hex",
    ]
  );
  assert.equal(BOT_COLORS.length, 11);

  // Primary Mascot #1 ('blob') uses Astro-Visor face aligned with the App Icon
  assert.equal(BOT_SHAPES[0].key, "blob");
  assert.equal(BOT_SHAPES[0].face, "visor");
  const visorEls = getMascotFaceElements(BOT_SHAPES[0], "#ffffff");
  assert.equal(visorEls.length, 3); // visor window + 2 upright capsule eyes

  // All 4 coordinated facial expression families are covered across the 13 shapes
  const faceKinds = new Set(BOT_SHAPES.map((s) => s.face));
  assert.deepEqual([...faceKinds].sort(), ["focused", "happy", "star", "visor"]);

  // SSR render with all 13 shapes in sidebar + Avatar Editor open in RightInspector
  const sessions = BOT_SHAPES.map((s, idx) => ({
    id: `s-${s.key}`,
    title: `Bot ${s.label}`,
    status: "idle",
    kind: "direct" as const,
    avatar: { type: "mascot" as const, shape: s.key, color: BOT_COLORS[idx % BOT_COLORS.length].key },
    updatedAt: new Date(Date.now() - idx * 1000).toISOString(),
  }));

  const html = renderAppHtml({
    sessions,
    activeSessionId: "s-blob",
    inspectorOpen: true,
    avatarEditor: { open: true, tab: "bot" },
  });

  assert.ok(html.includes('data-shape-key="blob"'));
  assert.ok(html.includes('data-shape-key="hex"'));
  assert.equal(
    html.includes("rotate(-24"),
    false,
    "Rendered UI must not contain legacy Grok -24deg tilted eye slits"
  );
});

test("Sidebar and mobile topbar show blue cloud-download update button only when update is available", () => {
  const noUpdateHtml = renderAppHtml({
    updateState: {
      checking: false,
      lastCheckedAt: 1,
      error: "",
      localMeta: {
        platform: "desktop",
        nativeVersion: "1.2.0",
        activeWebBuild: "20261117.100018-abcdef1234",
        usingBuiltIn: true,
        lastRollbackReason: "",
      },
      latestManifest: null,
      decision: { status: "up-to-date", sourceKind: "github", latestWebBuild: "20261117.100018-abcdef1234" },
      connectedNodeStatus: null,
      progress: null,
      applying: false,
      dismissedVersionKey: "",
    },
  });
  assert.equal(noUpdateHtml.includes('id="sidebar-update-btn"'), false);
  assert.equal(noUpdateHtml.includes('id="compact-update-btn"'), false);
  assert.equal(noUpdateHtml.includes('id="mobile-update-btn"'), false);

  const hasUpdateHtml = renderAppHtml({
    updateState: {
      checking: false,
      lastCheckedAt: 1,
      error: "",
      localMeta: {
        platform: "desktop",
        nativeVersion: "1.2.0",
        activeWebBuild: "20261117.090000-1111111111",
        usingBuiltIn: true,
        lastRollbackReason: "",
      },
      latestManifest: null,
      decision: {
        status: "ota-available",
        sourceKind: "github",
        latestWebBuild: "20261117.100018-abcdef1234",
        otaBundle: {
          target: "desktop",
          webBuild: "20261117.100018-abcdef1234",
          bundleUrl: "https://github.com/caixy-plus/twinklebot-releases/releases/download/ota-20261117.1/twinklebot-web-desktop.tar.gz",
          sha256: "a".repeat(64),
          sizeBytes: 421000,
        },
      },
      connectedNodeStatus: null,
      progress: null,
      applying: false,
      dismissedVersionKey: "",
    },
  });
  assert.ok(hasUpdateHtml.includes('id="sidebar-update-btn"'));
  assert.ok(hasUpdateHtml.includes('id="compact-update-btn"'));
  assert.ok(hasUpdateHtml.includes('id="mobile-update-btn"'));
  assert.ok(hasUpdateHtml.includes("sidebar-update-btn"));
  assert.ok(hasUpdateHtml.includes("mobile-update-btn"));
});

test("compiled mobile.css preserves flex/inline-flex layout on mobile-only bars and circle buttons", () => {
  const mobileCssPath = path.resolve(process.cwd(), "public", "mobile.css");
  const css = fs.readFileSync(mobileCssPath, "utf8");
  assert.match(
    css,
    /\.mobile-list-topbar\.mobile-only,\s*\.mobile-list-bottombar\.mobile-only\s*\{\s*display:\s*flex\s*!important;/
  );
  assert.match(
    css,
    /\.mobile-circle-btn\.mobile-only\s*\{\s*display:\s*inline-flex\s*!important;/
  );
});

test("vite frontend production bundle is minified and ships zero source maps", () => {
  const distDir = path.resolve(process.cwd(), "public", "dist");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(distDir);
  const mapFiles = files.filter((f) => f.endsWith(".map"));
  assert.deepEqual(mapFiles, [], "production public/dist must not emit .map sourcemaps");
  const appJs = fs.readFileSync(path.join(distDir, "app.js"), "utf8");
  assert.equal(appJs.includes("sourceMappingURL="), false);
  assert.equal(appJs.includes("triggerLanUnreachableFallback"), false, "internal identifiers must be mangled");
});
