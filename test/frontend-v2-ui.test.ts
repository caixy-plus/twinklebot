import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PROJECT_ROOT,
  readWebSourceTs,
  renderAppHtml,
  renderFullAppHtml,
} from "./helpers/react-test-helpers.js";

const html = renderFullAppHtml();
const appJs = readWebSourceTs();
const styleCss = fs.readFileSync(path.join(PROJECT_ROOT, "public", "style.css"), "utf8");

test("public/index.html + React App contain all v2.0 UI elements (onboarding, models tab, account switcher, cloud modal)", () => {
  const requiredSelectors = [
    'id="onboarding-overlay"',
    'id="onboarding-provider-type"',
    'id="onboarding-api-key"',
    'id="onboarding-base-url"',
    'id="onboarding-models-input"',
    'id="onboarding-test-btn"',
    'id="onboarding-tier-fast"',
    'id="onboarding-tier-medium"',
    'id="onboarding-tier-advanced"',
    'id="onboarding-submit-btn"',
    'data-settings-tab="models"',
    'data-settings-pane="models"',
    'id="tier-fast-select"',
    'id="tier-medium-select"',
    'id="tier-advanced-select"',
    'id="providers-list"',
    'id="provider-form"',
    'id="account-list-section"',
    'id="add-cloud-account-btn"',
    'id="cloud-account-modal"',
    'id="cloud-account-url-input"',
    'id="cloud-account-name-input"',
    'id="cloud-account-token-input"',
    'id="save-cloud-account-btn"',
    'data-provider-preset="gemini"',
    'data-provider-preset="openai"',
    'data-provider-preset="deepseek"',
    'data-provider-preset="openai-compatible"',
    'id="cancel-vault-item-btn"',
  ];

  for (const token of requiredSelectors) {
    assert.ok(html.includes(token), `Rendered UI missing ${token}`);
  }

  for (const removedToken of [
    'value="vertex"',
    'id="onboarding-vertex-project"',
    'id="onboarding-vertex-location"',
    'id="provider-vertex-project-input"',
    'id="provider-vertex-location-input"',
  ]) {
    assert.equal(html.includes(removedToken), false, `Legacy Vertex UI field must be removed: ${removedToken}`);
  }
});

test("React web bundle implements v2.0 account switching, onboarding, multi-provider pricing, admin pin/delete lock, and Bot Computer state machine", () => {
  assert.ok(appJs.includes('from "/accounts-store.js"'), "must import /accounts-store.js");
  assert.ok(appJs.includes("async function switchAccount("), "must define switchAccount");
  assert.ok(appJs.includes("/api/system/role"), "switchAccount must toggle /api/system/role");
  assert.ok(appJs.includes("/api/providers/test"), "must wire provider connection test");
  assert.ok(appJs.includes("/api/onboarding/complete"), "must wire onboarding completion");
  assert.ok(appJs.includes("PRESET_BOT_COMPUTER_INIT_PROMPT"), "must define PRESET_BOT_COMPUTER_INIT_PROMPT");
  assert.ok(appJs.includes('compState === "uncreated"'), "must handle uncreated Bot Computer state");
  assert.ok(appJs.includes(".isAdmin"), "must bind pinned slot and RBAC checks to session.isAdmin");
  assert.ok(appJs.includes("gpt-4o") && appJs.includes("deepseek-chat"), "CLIENT_MODEL_RATES must cover OpenAI and DeepSeek models");

  // Context menu declaratively hides pin for all bots and hides delete for admin bot
  const adminCtxHtml = renderAppHtml({
    sessions: [{ id: "adm-1", title: "Admin", isAdmin: true }],
    openPopover: "ctx-menu",
    sidebarContextMenu: { x: 10, y: 10, sessionId: "adm-1" },
  });
  assert.match(adminCtxHtml, /data-ctx-action="pin"\s+hidden=""/);
  assert.match(adminCtxHtml, /data-ctx-action="delete"\s+hidden=""/);

  const normalCtxHtml = renderAppHtml({
    sessions: [{ id: "bot-2", title: "Worker", isAdmin: false }],
    openPopover: "ctx-menu",
    sidebarContextMenu: { x: 10, y: 10, sessionId: "bot-2" },
  });
  assert.match(normalCtxHtml, /data-ctx-action="pin"\s+hidden=""/);
  assert.doesNotMatch(normalCtxHtml, /data-ctx-action="delete"\s+hidden=""/);
  assert.doesNotMatch(normalCtxHtml, /data-ctx-action="unread"/);
  assert.doesNotMatch(normalCtxHtml, /data-ctx-action="mute"/);

  const shortcutsBlock = styleCss.match(/\.shortcuts-help-dialog\s*\{[^}]+\}/)?.[0] || "";
  assert.match(shortcutsBlock, /background:\s*var\(--bg-modal\)/);
  assert.equal(styleCss.includes("--bg-surface"), false);

  // Bot Computer click must jump to Admin Bot and dispatch preset prompt when uncreated
  assert.match(appJs, /handleBotComputerCardActivate/);
  assert.match(appJs, /selectSession\(adminBot\.id\)/);

  // Bot Computer status card must reflect computerStatus.online rather than defaulting idle local sessions to 休眠中
  assert.ok(appJs.includes("isCompOnline"), "RightInspector must check computerStatus?.online");
  assert.ok(appJs.includes("computer-sleep-zz"), "RightInspector must toggle sleep indicator based on online state");
  assert.ok(
    !html.includes('id="computer-card-status" class="computer-card-sub">休眠中</div>'),
    "initial HTML should not hardcode 休眠中 before status probe"
  );

  // Bot Computer fullscreen overlay must stay strictly view-only until takeover is requested
  assert.ok(
    styleCss.includes('.bot-screen-overlay[data-takeover="false"] .novnc-frame') &&
      styleCss.includes("pointer-events: none"),
    "style.css must disable pointer events on .novnc-frame when not in takeover mode"
  );
  assert.ok(
    !appJs.includes('url.searchParams.set("view_only", "0")'),
    "BotComputerOverlay must not hardcode view_only=0 unconditionally"
  );
  assert.ok(
    appJs.includes("view_only") && appJs.includes("仅观看"),
    "BotComputerOverlay must toggle view_only based on takeover mode and display 仅观看 when read-only"
  );
});

test("public/style.css includes styles for v2.0 onboarding, provider cards, account list, and computer state badges", () => {
  for (const cls of [
    ".onboarding-overlay",
    ".provider-card",
    ".account-switch-item",
    ".computer-card[data-computer-state=",
  ]) {
    assert.ok(styleCss.includes(cls), `public/style.css missing ${cls}`);
  }
});

test("chat renderer hides auto context_compressed divider banners from chat UI", () => {
  assert.ok(!appJs.includes("上下文已自动压缩"), "context_compressed notice must not render in chat UI");
});

test("context compression settings UI exposes window percentage slider and removes 6 complex knobs", () => {
  assert.ok(html.includes('id="setting-ctx-compress-percent"'));
  assert.ok(html.includes('id="ctx-compress-percent-label"'));
  for (const legacyId of [
    "setting-ctx-compress-strategy",
    "setting-ctx-compress-max-steps",
    "setting-ctx-compress-max-chars",
    "setting-ctx-compress-keep-turns",
    "setting-ctx-compress-keep-screens",
    "setting-ctx-compress-tool-chars",
  ]) {
    assert.ok(!html.includes(legacyId), `legacy control ${legacyId} must be removed`);
  }
});

test("settings modal scroll stability avoids nested GPU RenderPass clipping and defers async DOM mutations until scrollend", () => {
  const settingsModalBlock = styleCss.match(/\.settings-modal\s*\{[^}]+\}/)?.[0] || "";
  assert.ok(settingsModalBlock.length > 0, ".settings-modal CSS block must exist");
  assert.ok(
    !settingsModalBlock.includes("translateZ(0)"),
    ".settings-modal must not force a nested rounded-corner transform RenderSurface over .settings-content"
  );

  const settingsContentBlock = styleCss.match(/\.settings-content\s*\{[^}]+\}/)?.[0] || "";
  assert.ok(
    settingsContentBlock.includes("contain: layout style paint"),
    ".settings-content must isolate layout/style/paint reflows during scroll"
  );

  const usageActiveContentBlock =
    styleCss.match(/\.settings-content\.is-usage-pane-active\s*\{[^}]+\}/)?.[0] || "";
  assert.match(
    usageActiveContentBlock,
    /padding:\s*0\s*;/,
    ".settings-content.is-usage-pane-active must clear outer padding on desktop so Usage does not double-pad"
  );

  assert.ok(
    styleCss.includes(".app-shell:has(.modal-backdrop:not([hidden])) .stage-header"),
    "style.css must suspend underlying backdrop-filter layers while a modal is open"
  );

  assert.ok(
    appJs.includes("runWhenSettingsScrollIdle"),
    "actions/SettingsModal must defer background refresh renders while scrolling"
  );
  assert.ok(
    appJs.includes("scrollend"),
    "actions/SettingsModal must listen for scrollend (with fallback) to flush deferred renders"
  );
  assert.match(
    styleCss,
    /--compact-sidebar-w:\s*92px\s*;/,
    "collapsed sidebar width must leave symmetric padding around macOS traffic-light buttons"
  );
  assert.ok(
    !styleCss.includes("78px minmax"),
    "collapsed sidebar grid rules must use --compact-sidebar-w instead of tight 78px"
  );
  assert.match(
    styleCss,
    /\.private-skills-list\s*>\s*\.skills-empty\s*\{\s*padding:\s*12px 15px\s*;\s*\}/,
    ".private-skills-list empty state must align with 12px 15px settings card padding"
  );
  assert.ok(
    styleCss.includes("@layer reset, tokens, base, primitives, layout, features, utilities, mobile;"),
    "public/style.css must declare cascade layer order"
  );
  const mobileCss = fs.readFileSync(path.join(PROJECT_ROOT, "public", "mobile.css"), "utf8");
  assert.ok(
    mobileCss.includes("@layer reset, tokens, base, primitives, layout, features, utilities, mobile;"),
    "public/mobile.css must declare matching cascade layer order"
  );
  const desktopImportantCount = (styleCss.match(/!important/g) || []).length;
  const mobileImportantCount = (mobileCss.match(/!important/g) || []).length;
  assert.ok(
    desktopImportantCount <= 10,
    `desktop style.css !important budget exceeded (${desktopImportantCount} > 10)`
  );
  assert.ok(
    mobileImportantCount <= 55,
    `mobile.css !important budget exceeded (${mobileImportantCount} > 55)`
  );
  const composerPillBlock = styleCss.match(/\.composer-pill\s*\{[^}]+\}/)?.[0] || "";
  assert.match(composerPillBlock, /background:\s*var\(--bg-popover\)/);
  assert.match(composerPillBlock, /border-radius:\s*26px/);
  const sidebarFooterBlock = styleCss.match(/\.sidebar-footer\s*\{[^}]+\}/)?.[0] || "";
  assert.equal(sidebarFooterBlock.includes("border-top:"), false);

  assert.match(settingsModalBlock, /max-width:\s*min\(920px,\s*calc\(100vw - 48px\)\)/);
  assert.match(settingsModalBlock, /height:\s*min\(calc\(100dvh - 124px\),\s*840px\)/);
  assert.ok(
    styleCss.includes(".settings-modal.is-continuous-scroll .settings-pane + .settings-pane"),
    "continuous desktop settings modal must separate stacked category panes"
  );
  assert.ok(
    styleCss.includes(
      '.settings-modal.is-continuous-scroll .settings-pane[data-settings-pane="usage"]'
    ),
    "continuous desktop settings modal must expand usage pane into the unified vertical scroller"
  );
  assert.ok(
    appJs.includes("is-continuous-scroll"),
    "SettingsModal must enable continuous desktop scroll class"
  );
});
