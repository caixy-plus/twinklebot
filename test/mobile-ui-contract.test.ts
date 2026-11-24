import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROJECT_ROOT,
  readWebSourceTs,
  renderFullAppHtml,
} from "./helpers/react-test-helpers.js";

test("public/index.html, React App & mobile.css provide 2-level stack navigation, Bottom Sheets, and preserve forbidden-string rules", () => {
  const html = renderFullAppHtml();
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/mobile.css"), "utf8");

  assert.ok(html.includes("viewport-fit=cover"));
  assert.ok(html.includes('href="/mobile.css'));
  for (const id of [
    "mobile-back-btn",
    "mobile-inspector-btn",
    "mobile-search-input",
    "mobile-tools-btn",
    "mobile-settings-btn",
    "mobile-new-bot-btn",
    "mobile-node-switcher-card",
    "mobile-node-sheet",
    "mobile-lan-scan-btn",
    "mobile-lan-list",
    "mobile-cloud-list",
    "mobile-pair-modal",
    "mobile-pair-code-input",
    "mobile-lan-offline-modal",
    "mobile-bot-editor-sheet",
    "mobile-bot-name-input",
    "mobile-bot-save-btn",
    "mobile-inspector-sheet",
    "mobile-settings-sheet",
    "mobile-settings-more-row",
    "mobile-settings-modal-back-btn",
    "mobile-apps-back-btn",
    "mobile-host-control-card",
    "mobile-host-status-badge",
    "mobile-cloud-hosts-list",
    "mobile-lan-manual-ip-input",
    "mobile-lan-manual-pair-btn",
    "desktop-pairing-modal",
    "desktop-pairing-code-display",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }

  assert.ok(mobileCss.includes("env(safe-area-inset-top)"));
  assert.ok(mobileCss.includes("env(safe-area-inset-bottom)"));
  assert.ok(mobileCss.includes("@media (max-width: 768px)"));
  assert.ok(mobileCss.includes(".mobile-sheet.is-open"));
  assert.ok(mobileCss.includes("@keyframes mobileMsgEnter"));
  assert.ok(mobileCss.includes("z-index: 400"));

  const renderedHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const bad of ["Grok Bot", "管理订阅", "1Password", "连接应用", "语音通话", "经此电脑转发流量"]) {
    assert.equal(renderedHtml.includes(bad), false, `forbidden mobile placeholder found in rendered HTML: ${bad}`);
  }

  const mobileUiJs = fs.readFileSync(path.join(PROJECT_ROOT, "src/web/mobile-ui.ts"), "utf8");
  const appJs = readWebSourceTs();
  const styleCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/style.css"), "utf8");
  assert.ok(mobileUiJs.includes("onKeyboardOpen"), "initKeyboardViewportSync must notify onKeyboardOpen");
  assert.ok(appJs.includes("scrollChatStreamToBottom"), "app must scroll chat stream to bottom when keyboard opens");
  assert.ok(appJs.includes("syncBotScreenLandscapeState"), "app must toggle landscape desktop mode only for Bot screen");
  assert.ok(mobileCss.includes('data-landscape-desktop="true"'), "mobile.css must define landscape fullscreen desktop mode");
  assert.match(styleCss, /\.live-activity-row\s*\{[^}]*align-self:\s*flex-start/s, "thinking bubble must align left");

  assert.ok(html.includes('data-mobile-inspector-tab="activity"'));
  assert.ok(html.includes('data-mobile-inspector-tab="library"'));
  assert.equal(html.includes('data-mobile-inspector-tab="computer"'), false);
  assert.ok(html.includes('class="mobile-node-card-left"'));
  assert.ok(mobileCss.includes(".mobile-node-card-left"));
  assert.ok(mobileCss.includes("#mobile-active-node-name"));

  // Mobile Settings sheet removes timezone/computer/skills rows, groups primary items together, and pins standalone 关于 card to bottom
  assert.equal(html.includes('id="mobile-auto-timezone-toggle"'), false);
  assert.equal(html.includes('id="mobile-timezone-value"'), false);
  assert.equal(html.includes('id="mobile-settings-computer-row"'), false);
  assert.equal(html.includes('id="mobile-settings-skills-row"'), false);
  assert.equal(html.includes('<div class="mobile-section-caption">Bot</div>'), false);
  assert.equal(html.includes('<div class="mobile-section-caption">更多</div>'), false);
  const moreIdx = html.indexOf('id="mobile-settings-more-row"');
  const aboutCardIdx = html.indexOf('class="mobile-grouped-card mobile-settings-about-card"');
  const aboutIdx = html.indexOf('id="mobile-settings-about-row"');
  assert.ok(
    moreIdx > 0 && aboutCardIdx > moreIdx && aboutIdx > aboutCardIdx,
    "更多设置 must sit inside main grouped card above standalone bottom-pinned 关于 card"
  );
  assert.match(mobileCss, /#mobile-settings-sheet\s+\.mobile-settings-about-card\s*\{[^}]*margin-top:\s*auto/);
  assert.ok(html.includes("更多设置"));

  // Unified top-left back buttons across fullscreen mobile pages without X close buttons or drawer back buttons
  for (const backBtnId of [
    "mobile-back-btn",
    "mobile-settings-close-btn",
    "mobile-bot-editor-close-btn",
    "mobile-settings-modal-back-btn",
    "mobile-apps-back-btn",
  ]) {
    assert.ok(html.includes(`id="${backBtnId}"`), `missing mobile back button #${backBtnId}`);
  }
  assert.equal(html.includes('id="mobile-inspector-close-btn"'), false);
  assert.equal(html.includes('id="mobile-node-sheet-close-btn"'), false);
  assert.match(mobileCss, /\.apps-modal\s+\.modal-close-btn,\s*\.settings-modal\s+\.modal-close-btn\s*\{[^}]*display:\s*none\s*!important/s);

  assert.ok(html.includes('id="mobile-apps-back-btn"') || html.includes("mobile-apps-back-btn"));
  assert.equal(appJs.includes("settings-mobile-editor-sheet"), false, "list editing must stay inline instead of opening mobile popup sheet");
  assert.equal(mobileCss.includes("settings-mobile-editor-sheet"), false);
  assert.ok(styleCss.includes(".is-inline-row-editor"), "style.css must define .is-inline-row-editor for inline row editing");
  assert.ok(appJs.includes("isEditingThisProv") && appJs.includes("isEditingThisMem") && appJs.includes("isEditingThisVault"));
  assert.ok(appJs.includes("isEditingThisSkill") && appJs.includes("isEditingThisAcct"));
  assert.ok(html.includes('id="bot-memory-modal-backdrop"') && html.includes('id="schedule-modal-backdrop"'));
  assert.equal(html.includes('id="new-bot-memory-form-card"'), false);
  assert.equal(html.includes('id="mobile-new-bot-memory-form-card"'), false);
  assert.ok(appJs.includes("editingScheduleId") && appJs.includes("botMemoryModal"));
  const webSrc = readWebSourceTs();
  assert.ok(webSrc.includes("BotMemoriesList"));
  assert.ok(webSrc.includes("SchedulesList"));
  assert.ok(webSrc.includes("LibraryItemsPanel"));
  assert.equal(appJs.includes("memDst.innerHTML = memSrc.innerHTML"), false);
  assert.equal(appJs.includes("schedDst.innerHTML = schedSrc.innerHTML"), false);
  assert.equal(appJs.includes("libDst.innerHTML = libSrc.innerHTML"), false);
});

test("Confirmation prompts use branded native <dialog> (#app-confirm-dialog) with no native window.confirm/alert/prompt", () => {
  const html = renderFullAppHtml();
  const styleCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/style.css"), "utf8");
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/mobile.css"), "utf8");
  const bundleJs = readWebSourceTs();

  for (const id of [
    "app-confirm-dialog",
    "app-confirm-icon",
    "app-confirm-title",
    "app-confirm-message",
    "app-confirm-detail",
    "app-confirm-cancel-btn",
    "app-confirm-ok-btn",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /<dialog[^>]*id="app-confirm-dialog"[^>]*closedby="any"/s);
  assert.ok(styleCss.includes(".app-confirm-dialog"));
  assert.ok(styleCss.includes("overscroll-behavior: contain"));
  assert.ok(mobileCss.includes(".app-confirm-dialog"));
  assert.ok(html.includes('class="icon-svg clear-session-icon"'));
  assert.ok(mobileCss.includes(".clear-session-label"));
  assert.ok(mobileCss.includes(".clear-session-icon"));
  assert.ok(bundleJs.includes("showConfirmDialog"));
  assert.equal(/\bwindow\.(?:confirm|alert|prompt)\s*\(/.test(bundleJs), false, "native window.confirm/alert/prompt must not be used");
  for (const title of [
    "清空对话记录",
    "删除 Bot",
    "删除群聊",
    "删除模型供应商",
    "删除例行任务",
    "移除保险库条目",
    "删除全局记忆",
    "删除专属记忆",
    "移除权限规则",
    "移除群聊成员",
    "移除云端账号",
    "移除邮箱账号",
  ]) {
    assert.ok(bundleJs.includes(title), `missing confirmation prompt for ${title}`);
  }
});

test("Hardware back button minimizes or exits mobile app when already on root list view", async () => {
  const appJs = readWebSourceTs();
  assert.ok(appJs.includes("minimizeOrExitMobileApp"), "useMobileViewport must delegate root back press to minimizeOrExitMobileApp");
  assert.ok(appJs.includes("is-closing"), "animated sheet transitions must track is-closing state");
  assert.ok(appJs.includes("lanOfflineModalShown") && appJs.includes("mobile-lan-offline-modal"), "hardware back must dismiss mobile-lan-offline-modal");

  const bridgeMod = await import(pathToFileURL(path.join(PROJECT_ROOT, "public/dist/mobile-bridge.js")).href);
  const prevWindow = (globalThis as any).window;
  try {
    let minimized = 0;
    let exited = 0;
    (globalThis as any).window = {
      Capacitor: {
        Plugins: {
          App: {
            minimizeApp: async () => {
              minimized += 1;
            },
            exitApp: async () => {
              exited += 1;
            },
          },
        },
      },
    };
    assert.equal(await bridgeMod.minimizeOrExitMobileApp(), true);
    assert.equal(minimized, 1);
    assert.equal(exited, 0);

    (globalThis as any).window.Capacitor.Plugins.App.minimizeApp = async () => {
      throw new Error("unsupported");
    };
    assert.equal(await bridgeMod.minimizeOrExitMobileApp(), true);
    assert.equal(exited, 1);

    delete (globalThis as any).window.Capacitor.Plugins.App;
    assert.equal(await bridgeMod.minimizeOrExitMobileApp(), false);
  } finally {
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  }
});

test("Mobile composer keeps keyboard open on send and pins scroll cleanly on enter and send", () => {
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/mobile.css"), "utf8");
  const appJs = readWebSourceTs();
  const mobileUiJs = fs.readFileSync(path.join(PROJECT_ROOT, "src/web/mobile-ui.ts"), "utf8");
  const styleCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/style.css"), "utf8");

  assert.equal(/messageInput\?\.\s*blur/.test(appJs), false, "sendUserMessage must not blur messageInput on mobile");
  assert.ok(appJs.includes("keepInputFocusedOnSend"), "sendBtn pointer/mouse handlers must retain composer focus");
  assert.ok(appJs.includes("preventScroll: true"), "sendUserMessage must preserve composer focus without scroll jump");
  assert.ok(appJs.includes("selectSessionSeq"), "selectSession must ignore stale async fetches");
  assert.ok(mobileCss.includes(".event-stream:not(.is-replaying) > *"), "mobile CSS must suppress enter animation during history replay");
  assert.ok(appJs.includes("is-replaying"), "ChatStage must toggle is-replaying around replay render");
  assert.ok(appJs.includes("scrollChatStreamToBottom({ guardMs: 500, settle: true })"), "sendUserMessage must immediately snap scroll to bottom even after scrolling up");
  assert.ok(appJs.includes("scrollChatStreamToBottom({ guardMs: 450, settle: true })"), "selectSession must settle scroll at bottom after replay");
  assert.ok(appJs.includes("ResizeObserver"), "useChatScrollPin must observe eventStream resizes to keep pinned bottom intact");
  assert.ok(appJs.includes('case "user_message"') && appJs.includes("autoScrollPinned = true"), "new user_message SSE event must re-pin scroll to bottom");
  assert.equal(mobileUiJs.includes('if (shrank || document.activeElement?.id === "message-input")'), false, "minor viewport resizes must not hijack scroll when user intentionally scrolled up");

  // Soft keyboard Enter / newline + multiline auto-grow contracts
  assert.ok(
    /if\s*\(\s*isMobileViewport\(\)\s*\)\s*return/.test(appJs),
    "mobile Enter keydown must insert newline instead of submitting"
  );
  assert.match(
    appJs,
    /enterKeyHint\s*[:=]\s*\{?\s*mobileMode\s*\?\s*"enter"\s*:\s*"send"/,
    "Composer must set enterKeyHint=enter on mobile and send on desktop"
  );
  assert.ok(
    appJs.includes("syncComposerInputHeight"),
    "composer must sync multiline textarea height cleanly on input and send reset"
  );
  assert.ok(styleCss.includes("overflow-y: auto;"), ".composer-input must allow scrolling past max-height");
});

test("Desktop popover/inspector rows & mobile custom-skills/settings layouts prevent text crushing and tab overlap", () => {
  const html = renderFullAppHtml();
  const styleCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/style.css"), "utf8");
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/mobile.css"), "utf8");
  const appJs = readWebSourceTs();

  // 1. Account popover & inspector kv-row keep labels single-line and chevron inline
  assert.match(styleCss, /\.account-popover\s*\{[^}]*width:\s*284px/s);
  assert.match(styleCss, /\.menu-item-leading\s*\{[^}]*white-space:\s*nowrap[^}]*flex-shrink:\s*0/s);
  assert.match(styleCss, /\.kv-label\s*\{[^}]*white-space:\s*nowrap;\s*flex-shrink:\s*0/s);
  assert.ok(html.includes('class="kv-value kv-value-trailing"'));
  assert.ok(html.includes('class="kv-value-summary"'));
  assert.match(styleCss, /\.kv-value-summary\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis/s);
  assert.match(
    html,
    /<span class="kv-value-summary">[\s\S]*?<\/span><span id="session-cost-badge" class="session-cost-inline"/
  );
  assert.match(styleCss, /\.session-cost-inline\s*\{[^}]*flex-shrink:\s*0;/s);

  // 2. Mobile Settings nav sits inside .settings-nav-wrap with centered active tab, left/right blur, and swipeable content
  assert.match(mobileCss, /\.settings-mobile-topbar\s*\{[^}]*display:\s*flex/s);
  assert.match(mobileCss, /\.settings-nav-wrap::before,[\s\S]*?backdrop-filter:\s*blur\(5px\)/s);
  assert.match(mobileCss, /\.settings-nav\s*\{[^}]*scroll-snap-type:\s*x\s+proximity/s);
  assert.match(mobileCss, /\.settings-nav-item\s*\{[^}]*scroll-snap-align:\s*center/s);
  assert.ok(appJs.includes("handleContentTouchStart") && appJs.includes("handleContentTouchEnd"));
  assert.match(styleCss, /\.perm-rule-chip\s*>\s*span\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1/s);
  assert.match(styleCss, /\.section-action-link\s*\{[^}]*white-space:\s*nowrap;\s*flex-shrink:\s*0/s);

  // 3. Mobile Custom Skills header count pill and cards do not collapse text vertically
  assert.match(styleCss, /\.custom-skills-count-badge\s*\{[^}]*white-space:\s*nowrap;\s*flex-shrink:\s*0/s);
  assert.match(styleCss, /\.custom-skill-slug-chip\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(styleCss, /\.custom-skill-shared-tag\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(mobileCss, /\.custom-skill-card-main\s*\{[^}]*flex-direction:\s*column\s*!important/s);
  assert.match(mobileCss, /\.custom-skill-card-actions\s*\{[^}]*width:\s*100%\s*!important/s);

  // 4. Desktop narrow-window responsiveness stays 100% pure Desktop UI and never turns into Mobile UI
  const electronMainTs = fs.readFileSync(path.join(PROJECT_ROOT, "src/electron/main.ts"), "utf8");
  const mobileUiJs = fs.readFileSync(path.join(PROJECT_ROOT, "src/web/mobile-ui.ts"), "utf8");
  const minWMatch = electronMainTs.match(/minWidth:\s*(\d+)/);
  assert.ok(minWMatch && Number(minWMatch[1]) === 560, "Electron minWidth must be 560px for split-screen desktop");
  assert.ok(
    mobileCss.includes("@media (max-width: 768px) and (hover: none) and (pointer: coarse)"),
    "mobile.css must require coarse touch pointer so shrinking desktop window never triggers mobile UI"
  );
  assert.ok(
    html.includes('id="mobile-stylesheet"') && html.includes('mLink.media = "not all"'),
    "index.html must disable mobile.css in Electron desktop shell"
  );
  assert.match(
    styleCss,
    /\.mobile-only[\s\S]*?display:\s*none\s*!important/,
    "style.css must itself hide .mobile-only elements when mobile.css is disabled in Electron"
  );
  assert.ok(
    mobileUiJs.includes("twinklebotDesktop?.isElectron") && !mobileUiJs.includes("(max-width: 768px)"),
    "isMobileViewport must always return false on desktop"
  );
  assert.ok(
    appJs.includes("syncDesktopResponsivePanes") &&
      appJs.includes("DESKTOP_INSPECTOR_COLLAPSE_W = 920") &&
      appJs.includes("DESKTOP_SIDEBAR_COMPACT_W = 720"),
    "desktop resize must auto-collapse right inspector (<920px) and compact left icon rail (<720px)"
  );
  assert.match(styleCss, /@media\s*\(max-width:\s*919px\)\s*\{[\s\S]*?\.inspector-right\s*\{[\s\S]*?position:\s*absolute/);

  // 5. Mobile .event-stream pads below floating stage header and above floating composer using --mobile-composer-bottom
  assert.match(
    mobileCss,
    /\.event-stream\s*\{[^}]*padding:\s*calc\(var\(--stage-header-height\)\s*\+\s*10px\)\s+14px\s+calc\(var\(--mobile-composer-bottom\)\s*\+\s*10px\)\s*!important/s
  );
  assert.equal(/\.event-stream\s*\{[^}]*padding:[^;]*--mobile-composer-bottom/s.test(mobileCss), true);
});

test("Mobile stage-header & composer-wrap use floating glass pills with mask-fade layers and @supports fallback", () => {
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/mobile.css"), "utf8");

  assert.ok(mobileCss.includes("--glass-tint-strong:"));
  assert.ok(mobileCss.includes("--glass-pill-bg:"));
  assert.ok(mobileCss.includes("--glass-pill-border:"));
  assert.match(mobileCss, /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*?--glass-pill-bg:\s*rgba\(28,\s*28,\s*30,\s*0\.72\)/);
  assert.match(mobileCss, /\[data-theme="dark"\][\s\S]*?--glass-pill-bg:\s*rgba\(28,\s*28,\s*30,\s*0\.72\)/);

  assert.equal(/\.stage-header\s*\{[^}]*background:\s*var\(--bg-bar-glass\)/s.test(mobileCss), false);
  assert.equal(/\.stage-header\s*\{[^}]*border-bottom:\s*1px/s.test(mobileCss), false);
  assert.equal(/\.composer-wrap\s*\{[^}]*background:\s*var\(--bg-bar-glass\)/s.test(mobileCss), false);
  assert.equal(/\.composer-wrap\s*\{[^}]*border-top:\s*1px/s.test(mobileCss), false);

  assert.match(mobileCss, /\.stage-header\s*\{[^}]*background:\s*transparent;[^}]*border-bottom:\s*none;/s);
  assert.match(mobileCss, /\.composer-wrap\s*\{[^}]*background:\s*transparent;[^}]*border-top:\s*none;/s);
  assert.match(
    mobileCss,
    /\.stage-header::before\s*\{[^}]*backdrop-filter:\s*blur\(20px\)\s+saturate\(180%\)[^}]*mask-image:\s*linear-gradient\(to bottom,\s*#000\s+50%,\s*transparent\s+100%\)/s
  );
  assert.match(
    mobileCss,
    /\.composer-wrap::before\s*\{[^}]*backdrop-filter:\s*blur\(20px\)\s+saturate\(180%\)[^}]*mask-image:\s*linear-gradient\(to top,\s*#000\s+55%,\s*transparent\s+100%\)/s
  );

  assert.match(
    mobileCss,
    /#mobile-back-btn,\s*#mobile-inspector-btn,\s*\.share-pill-btn,\s*\.stage-bot-pill\s*\{[^}]*backdrop-filter:\s*blur\(24px\)\s+saturate\(180%\)[^}]*border:\s*0\.5px\s+solid\s+var\(--glass-pill-border\)/s
  );
  const pillMatch = mobileCss.match(/\.composer-pill\s*\{[^}]*\}/s);
  assert.ok(pillMatch, "mobile.css must style .composer-pill");
  assert.ok(pillMatch[0].includes("backdrop-filter:"), ".composer-pill must include backdrop-filter");
  const radiusMatch = pillMatch[0].match(/border-radius:\s*(\d+)px/);
  assert.ok(radiusMatch && Number(radiusMatch[1]) >= 24, ".composer-pill border-radius must be >= 24px");

  assert.match(
    mobileCss,
    /@supports\s+not\s+\(\(backdrop-filter:\s*blur\(1px\)\)\s+or\s+\(-webkit-backdrop-filter:\s*blur\(1px\)\)\)\s*\{[\s\S]*?rgba\(255,\s*255,\s*255,\s*0\.92\)[\s\S]*?rgba\(28,\s*28,\s*30,\s*0\.92\)/
  );
});

test("Mobile topbar consolidates actions into #mobile-more-popover and prevents status text wrapping", () => {
  const html = renderFullAppHtml();
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/mobile.css"), "utf8");
  const bundleJs = readWebSourceTs();

  assert.ok(html.includes('id="mobile-more-popover"'));
  assert.ok(html.includes('data-mobile-more-action="inspector"'));
  assert.ok(html.includes('data-mobile-more-action="clear"'));
  assert.ok(html.includes('data-mobile-more-action="delete"'));
  assert.ok(html.includes("能力与电脑面板"));
  assert.ok(html.includes("清空会话"));
  assert.ok(html.includes("删除 Bot"));
  assert.ok(html.includes('id="clear-session-btn"'));

  assert.match(mobileCss, /#clear-session-btn,[\s\S]*?display:\s*none\s*!important/);
  assert.match(mobileCss, /\.stage-bot-pill\s*\{[^}]*max-width:\s*calc\(100vw\s*-\s*84px\)/s);
  assert.match(mobileCss, /\.status-state\s*\{[^}]*white-space:\s*nowrap/s);
  assert.ok(mobileCss.includes(".mobile-more-popover"));

  assert.ok(bundleJs.includes("deleteSessionWithConfirm"));
  assert.ok(bundleJs.includes('"mobile-more"') || bundleJs.includes('"mobile-more-popover"'));
  assert.ok(bundleJs.includes('"mobile-more-popover"'));
});

test("SE3 small-screen, keyboard viewport lock, and direct-attach composer contracts stay intact", () => {
  const html = renderFullAppHtml();
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/mobile.css"), "utf8");
  const styleCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/style.css"), "utf8");
  const mobileUiTs = fs.readFileSync(path.join(PROJECT_ROOT, "src/web/mobile-ui.ts"), "utf8");
  const webSrc = readWebSourceTs();
  const sceneSwift = fs.readFileSync(path.join(PROJECT_ROOT, "ios/App/App/SceneDelegate.swift"), "utf8");

  assert.ok(mobileCss.includes(".mobile-sheet-panel > *:not(.mobile-inspector-scroll)"));
  assert.ok(mobileCss.includes(".mobile-sheet.is-fullscreen.is-open::before"));
  assert.ok(mobileCss.includes("#mobile-bot-editor-sheet .mobile-sheet-header"));
  assert.ok(mobileCss.includes("grid-template-columns: minmax(42px, 1fr) minmax(0, auto) minmax(42px, 1fr)"));
  assert.ok(mobileCss.includes(".msg-reply-anchor"));
  assert.ok(mobileCss.includes("font-size: 16px !important"));
  assert.ok(mobileCss.includes("height: 100% !important"));
  assert.ok(mobileCss.includes("var(--mobile-vv-height, 100dvh)"));
  assert.ok(mobileCss.includes(".skills-search-box"));

  assert.ok(!html.includes("composer-ops-popover"));
  assert.ok(!html.includes("slash-popover"));
  assert.ok(!styleCss.includes(".slash-cmd-row"));
  assert.ok(!webSrc.includes("renderSlashPopover"));
  assert.ok(!webSrc.includes("longPressTimer"));

  assert.ok(mobileUiTs.includes("--mobile-vv-height"));
  assert.ok(mobileUiTs.includes('shell.classList.toggle("is-keyboard-open"'));
  assert.ok(mobileUiTs.includes("window.scrollTo(0, 0)"));
  assert.ok(html.includes('id="composer-ops-btn"'));
  assert.ok(webSrc.includes("fileInputRef.current?.click()"));

  assert.ok(mobileCss.includes("-webkit-overflow-scrolling: touch"));
  assert.ok(mobileCss.includes("touch-action: pan-y"));
  assert.ok(mobileCss.includes(".session-list::after"));
  assert.ok(mobileCss.includes(".event-stream::after"));
  assert.ok(sceneSwift.includes("scrollView.alwaysBounceVertical = false"));
  assert.ok(!sceneSwift.includes("scrollView.isScrollEnabled = false"));
  assert.ok(sceneSwift.includes("scrollView.contentInsetAdjustmentBehavior = .never"));
  assert.ok(sceneSwift.includes("observe(\\.contentOffset"));
  assert.ok(sceneSwift.includes("WKAccessoryBarHider"));
  assert.ok(sceneSwift.includes("inputAccessoryView"));
  assert.ok(sceneSwift.includes("scrollView.maximumZoomScale = 1.0"));
  assert.ok(sceneSwift.includes("viewForZooming"));
  assert.ok(html.includes("maximum-scale=1"));
  assert.ok(html.includes("user-scalable=no"));
  assert.ok(mobileCss.includes("touch-action: manipulation"));
  assert.ok(mobileUiTs.includes("gesturestart"));

  // Usage & Billing pane on mobile must not stack inner 28px padding on top of .settings-content's 16px padding
  assert.match(
    mobileCss,
    /\.settings-pane\[data-settings-pane="usage"\]\s+\.vault-header-row\s*\{[^}]*padding:\s*0\s*!important/s
  );
  assert.match(
    mobileCss,
    /\.settings-pane\[data-settings-pane="usage"\]\s+#usage-main-view:not\(\[hidden\]\),[\s\S]*?padding:\s*0\s*!important/
  );
});

test("window traffic dots are hidden on Windows/Web and only reserved as invisible macOS Electron spacer", () => {
  const styleCss = fs.readFileSync(path.join(PROJECT_ROOT, "public/style.css"), "utf8");
  assert.match(styleCss, /\.window-traffic-dots\s*\{[^}]*display:\s*none;/s);
  assert.match(
    styleCss,
    /html\[data-electron="true"\]\[data-platform="darwin"\]\s*\.window-traffic-dots\s*\{[^}]*display:\s*flex;[^}]*visibility:\s*hidden;/s
  );
  assert.match(styleCss, /\.sidebar-top-actions\s*\{[^}]*margin-left:\s*auto;/s);
});
