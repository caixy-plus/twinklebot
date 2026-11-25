import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  EN_MESSAGES,
  ZH_CN_MESSAGES,
  detectSystemLocale,
  formatLanguageOptionLabel,
  isExplicitLanguagePreference,
  normalizeLanguagePreference,
  resolveEffectiveLocale,
  t,
  translateStatusLabel,
  type I18nKey,
} from "../src/shared/i18n.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { describeCronExpression, parseCronExpression } from "../src/shared/cron.js";
import { getLocalizedSkillMeta } from "../src/shared/skills-catalog.js";
import { resolveBotComputerStatusDisplay } from "../src/shared/computer-status.js";
import { evaluateUpdateCompatibility, type VersionManifest } from "../src/shared/versioning.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import {
  PROJECT_ROOT,
  renderAppHtml,
  renderFullAppHtml,
  ssr,
} from "./helpers/react-test-helpers.js";

test("zh-CN and en dictionaries maintain 100% key & placeholder parity with zero empty entries", () => {
  const zhKeys = Object.keys(ZH_CN_MESSAGES).sort() as I18nKey[];
  const enKeys = Object.keys(EN_MESSAGES).sort() as I18nKey[];

  assert.deepEqual(enKeys, zhKeys, "EN_MESSAGES and ZH_CN_MESSAGES must have identical key sets");
  assert.ok(zhKeys.length >= 150, `Expected comprehensive i18n dictionary, got ${zhKeys.length} keys`);

  const extractPlaceholders = (str: string) =>
    [...str.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

  for (const key of zhKeys) {
    const zhVal = ZH_CN_MESSAGES[key];
    const enVal = EN_MESSAGES[key];
    assert.ok(zhVal.trim().length > 0, `ZH_CN_MESSAGES[${key}] must be non-empty`);
    assert.ok(enVal.trim().length > 0, `EN_MESSAGES[${key}] must be non-empty`);
    assert.deepEqual(
      extractPlaceholders(enVal),
      extractPlaceholders(zhVal),
      `Placeholder mismatch for i18n key "${key}"`
    );
  }
});

test("language preference normalization, system locale detection, and interpolation work accurately", () => {
  assert.equal(DEFAULT_LANGUAGE_PREFERENCE, "system");
  assert.equal(normalizeLanguagePreference(undefined), "system");
  assert.equal(normalizeLanguagePreference("system"), "system");
  assert.equal(normalizeLanguagePreference("en"), "en");
  assert.equal(normalizeLanguagePreference("en-US"), "en");
  assert.equal(normalizeLanguagePreference("zh"), "zh-CN");
  assert.equal(normalizeLanguagePreference("zh-CN"), "zh-CN");
  assert.equal(normalizeLanguagePreference("zh-TW"), "zh-CN");

  assert.equal(isExplicitLanguagePreference("system"), true);
  assert.equal(isExplicitLanguagePreference("zh-CN"), true);
  assert.equal(isExplicitLanguagePreference("en"), true);
  assert.equal(isExplicitLanguagePreference("fr-FR"), false);

  assert.equal(detectSystemLocale("en-US"), "en");
  assert.equal(detectSystemLocale("ja-JP"), "en");
  assert.equal(detectSystemLocale("zh-CN"), "zh-CN");
  assert.equal(detectSystemLocale(["zh-Hans-CN", "en-US"]), "zh-CN");

  assert.equal(resolveEffectiveLocale("en", "zh-CN"), "en");
  assert.equal(resolveEffectiveLocale("zh-CN", "en-US"), "zh-CN");
  assert.equal(resolveEffectiveLocale("system", "en-GB"), "en");
  assert.equal(resolveEffectiveLocale("system", "zh-CN"), "zh-CN");

  assert.equal(t("chat.composerPlaceholder", "en", { name: "Twinkle" }), "Message Twinkle…");
  assert.equal(t("chat.composerPlaceholder", "zh-CN", { name: "Twinkle" }), "给 Twinkle 发消息…");
  assert.equal(translateStatusLabel("running", "en"), "Running");
  assert.equal(translateStatusLabel("running", "zh-CN"), "执行中");
  assert.equal(formatLanguageOptionLabel("system", "en"), "Follow System");
  assert.equal(formatLanguageOptionLabel("system", "zh-CN"), "跟随系统");
});

test("SSR UI exposes language selectors and renders English cleanly when settings.language='en'", () => {
  const defaultHtml = renderFullAppHtml();
  assert.ok(defaultHtml.includes('id="setting-language-select"'), "Settings modal must include #setting-language-select");
  assert.ok(defaultHtml.includes('id="onboarding-language-select"'), "Onboarding must include #onboarding-language-select");
  assert.ok(defaultHtml.includes('id="mobile-settings-language-select"'), "Mobile Settings must include #mobile-settings-language-select");
  assert.ok(defaultHtml.includes("跟随系统"));
  assert.ok(defaultHtml.includes("中文"));
  assert.ok(defaultHtml.includes("English"));

  const enHtml = renderAppHtml({
    settings: {
      language: "en",
      theme: "system",
      accentMode: "bot",
      onboardingRequired: true,
    } as any,
  });
  assert.ok(enHtml.includes("Welcome to TwinkleBot"), "English onboarding title must render");
  assert.ok(enHtml.includes("Appearance &amp; Language"), "English General settings heading must render");
  assert.ok(enHtml.includes("Skills Store"), "English Skills Store title must render");
  assert.ok(enHtml.includes("Settings &amp; Workbench"), "English Mobile Settings title must render");
});

test("buildSystemInstruction reflects uiLocale while respecting user message language", () => {
  const enPrompt = buildSystemInstruction({ uiLocale: "en" });
  assert.ok(enPrompt.includes("currently English"));
  assert.ok(enPrompt.includes("Always reply in the same language"));

  const zhPrompt = buildSystemInstruction({ uiLocale: "zh-CN" });
  assert.ok(zhPrompt.includes("currently Simplified Chinese"));
});

test("POST /api/settings validates and persists language preference (system / zh-CN / en)", async (tCtx) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-i18n-"));
  tCtx.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const srv = createServer({
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      deployEnv: "local",
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
      writeRoots: [tmpDir],
      screen: { width: 1440, height: 900 },
    },
    store,
    executor: { health: async () => ({ ok: true }), call: async () => ({ ok: true }) } as any,
    runner: { broadcastGlobal: () => {}, getState: () => ({ status: "idle" }) } as any,
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  tCtx.after(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const init: any = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(init.language, "system");

  const bad = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "klingon" }),
  });
  assert.equal(bad.status, 400);

  const okEn = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "en" }),
  });
  assert.equal(okEn.status, 200);
  assert.equal((await okEn.json()).language, "en");

  const persisted: any = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(persisted.language, "en");

  const backSystem = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "system" }),
  });
  assert.equal(backSystem.status, 200);
  assert.equal((await backSystem.json()).language, "system");
});

test("EN_MESSAGES contains zero unintended CJK and ZH_CN_MESSAGES has zero orphan keys", () => {
  const cjkRe = /[\u4e00-\u9fff]/;
  for (const [key, val] of Object.entries(EN_MESSAGES)) {
    if (key === "lang.zhCN") continue;
    assert.equal(
      cjkRe.test(val),
      false,
      `Unexpected CJK character in EN_MESSAGES["${key}"]: ${val}`
    );
  }

  const srcDir = path.join(PROJECT_ROOT, "src");
  const corpusParts: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(ent.name)) {
        if (full.endsWith("i18n-zh.ts") || full.endsWith("i18n-en.ts")) continue;
        corpusParts.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(srcDir);
  const srcCorpus = corpusParts.join("\n");

  const orphans: string[] = [];
  for (const key of Object.keys(ZH_CN_MESSAGES)) {
    if (key.startsWith("status.") || key.startsWith("source.")) continue;
    if (!srcCorpus.includes(`"${key}"`) && !srcCorpus.includes(`'${key}'`)) {
      orphans.push(key);
    }
  }
  assert.deepEqual(orphans, [], `Found orphan i18n keys unused in src/: ${orphans.join(", ")}`);
});

test("src/web/components/**/*.tsx has zero hardcoded CJK UI literals outside comments", () => {
  const componentsDir = path.join(PROJECT_ROOT, "src", "web", "components");
  const cjkRe = /[\u4e00-\u9fff]/;
  const leaks: string[] = [];

  const stripComments = (source: string): string => {
    // Remove /* ... */ (including {/* ... */}) and trailing // comments
    const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
    return withoutBlock
      .split("\n")
      .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, "$1"))
      .join("\n");
  };

  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.name.endsWith(".tsx")) {
        const cleaned = stripComments(fs.readFileSync(full, "utf8"));
        const lines = cleaned.split("\n");
        lines.forEach((line, idx) => {
          if (cjkRe.test(line)) {
            const rel = path.relative(PROJECT_ROOT, full);
            leaks.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 80)}`);
          }
        });
      }
    }
  };
  walk(componentsDir);
  assert.deepEqual(leaks, [], `Found hardcoded CJK in UI components:\n${leaks.join("\n")}`);
});

test("English SSR sweep across all 7 Settings tabs and open modals leaks zero Chinese chrome", () => {
  const cjkRe = /[\u4e00-\u9fff]/;
  const base = ssr.createInitialState();

  const enFixture = {
    settings: {
      ...base.settings,
      language: "en",
      theme: "system",
      accentMode: "bot",
      onboardingRequired: false,
      profile: { name: "本地用户", color: "slate" },
      providers: [
        {
          id: "prov-gem",
          type: "gemini",
          name: "Google Gemini",
          enabled: true,
          models: ["gemini-4-hydrogen", "gemini-4-argon"],
          imageModels: ["gemini-3.1-flash-image"],
          maskedApiKey: "AIza•••123",
          currency: "USD",
        },
      ],
      modelRouting: {
        enabled: true,
        mode: "balanced",
        fastModel: "gemini-4-hydrogen",
        mediumModel: "gemini-4-argon",
        advancedModel: "gemini-4-hydrogen",
        imageModel: "gemini-3.1-flash-image",
      },
      installedSkills: ["qqmail", "custom-mail", "feishu-bot", "kimi-cu"],
      permissionPolicy: {
        autoAudit: true,
        askRules: [{ tool: "run_shell", pattern: "rm" }],
        allowRules: [{ tool: "write_file", pattern: "/tmp/" }],
      },
    },
    accountsState: {
      activeAccountId: "local",
      accounts: [{ id: "local", type: "local", name: "本地账号", baseUrl: "http://127.0.0.1:3230" }],
    },
    sessions: [
      {
        id: "bot-main",
        type: "bot",
        title: "Nori",
        rolePrompt: "Primary orchestrator",
        avatar: { shape: "bot", color: "indigo" },
      },
    ],
    primarySessionId: "bot-main",
    activeSessionId: "bot-main",
    computerStatus: {
      state: "ready",
      provider: "orbstack",
      online: true,
      latencyMs: 6,
      screen: { width: 1440, height: 900 },
      detail: "Connected",
      hostComputer: { hostname: "MacBook-Pro", platform: "darwin", executionMode: "ask" },
    },
    diagnostics: {
      deployEnv: "local",
      appVersion: "1.0.4",
      nodeVersion: "v24.0.0",
      sessionCount: 1,
      llmReady: true,
      executorOnline: true,
      executorUrl: "http://127.0.0.1:7300",
      executorLatencyMs: 6,
      writeRoots: ["/tmp"],
      apiCapabilities: ["cron-schedules"],
    },
  };

  const assertCleanEnglishHtml = (label: string, overrides: Record<string, any>) => {
    const html = renderAppHtml({ ...enFixture, ...overrides });
    const stripped = html
      .replace(/<option[^>]*value="zh-CN"[^>]*>中文<\/option>/g, "")
      .replace(/<option[^>]*>中文<\/option>/g, "");
    const match = stripped.match(/[^\x00-\xff]*[\u4e00-\u9fff][^\n<]*/);
    assert.equal(
      cjkRe.test(stripped),
      false,
      `CJK leaked in English SSR [${label}]: ${match ? match[0] : ""}`
    );
  };

  const tabs = ["general", "models", "computer", "permissions", "vault", "usage", "updates"] as const;
  for (const tab of tabs) {
    assertCleanEnglishHtml(`settings:${tab}`, {
      settingsModal: {
        open: true,
        tab,
        standaloneBotSessionId: null,
        openNewMemoryOnMount: false,
      },
    });
  }

  assertCleanEnglishHtml("skills:store", { appsModalOpen: true, skillsView: "store" });
  assertCleanEnglishHtml("skills:manage", {
    appsModalOpen: true,
    skillsView: "manage",
    customSkillEditorOpen: true,
  });
  for (const skillId of ["qqmail", "custom-mail", "feishu-bot", "kimi-cu"] as const) {
    assertCleanEnglishHtml(`skills:detail:${skillId}`, {
      appsModalOpen: true,
      skillsView: "detail",
      detailSkillId: skillId,
      detailFrom: "store",
    });
  }

  assertCleanEnglishHtml("modal:schedule", { scheduleModalOpen: true });
  assertCleanEnglishHtml("modal:bot-memory", {
    botMemoryModal: {
      open: true,
      sessionId: "bot-main",
      memoryId: null,
      name: "",
      content: "",
    },
  });
  assertCleanEnglishHtml("modal:search", { searchModalOpen: true });
  assertCleanEnglishHtml("modal:shortcuts", { shortcutsDialogOpen: true });
  assertCleanEnglishHtml("mobile:sheets", {
    mobileSheets: {
      ...base.mobileSheets,
      settingsOpen: true,
      nodeOpen: true,
      inspectorOpen: true,
    },
  });
});

test("shared domain helpers return localized English output when locale='en'", () => {
  const cjkRe = /[\u4e00-\u9fff]/;

  const cronDesc = describeCronExpression("0 10 */3 * *", "en");
  assert.equal(cjkRe.test(cronDesc), false, `Unexpected CJK in cronDesc: ${cronDesc}`);
  assert.ok(cronDesc.toLowerCase().includes("10:00"));

  const cronBad = parseCronExpression("not-a-cron", "en");
  assert.equal(cronBad.ok, false);
  assert.equal(cjkRe.test(cronBad.error || ""), false);

  const skillMeta = getLocalizedSkillMeta({ id: "qqmail" }, "en");
  assert.equal(skillMeta.name, "QQ Mail");
  assert.equal(cjkRe.test(skillMeta.desc), false);

  const onlineStatus = resolveBotComputerStatusDisplay(
    { state: "ready", online: true, latencyMs: 12 },
    { locale: "en" }
  );
  assert.equal(onlineStatus.cardStatusText, "Running");
  assert.equal(cjkRe.test(onlineStatus.mobileSubText), false);

  const offlineStatus = resolveBotComputerStatusDisplay(
    { state: "offline", online: false, error: "timeout" },
    { locale: "en" }
  );
  assert.equal(cjkRe.test(offlineStatus.cardStatusText), false);
  assert.equal(cjkRe.test(offlineStatus.settingsOfflineReason), false);

  const manifest: VersionManifest = {
    schemaVersion: 1,
    generatedAt: "2026-11-25T00:00:00.000Z",
    releaseTag: "v1.0.4",
    webBuild: "20261125.000000-aaabbb",
    coreBuild: "20261125.000000-aaabbb",
    shells: {
      desktop: {
        latestVersion: "1.0.4",
        minVersionForOta: "1.0.0",
        minVersionForCoreOta: "1.0.4",
      },
    },
    bundles: {
      desktopCore: {
        target: "desktop",
        fileName: "twinklebot-core-desktop.tar.gz",
        coreBuild: "20261125.000000-aaabbb",
        coreVersion: "1.0.4",
        webBuild: "20261125.000000-aaabbb",
        bundleUrl: "https://github.com/caixy-plus/twinklebot/releases/download/ota-1/twinklebot-core-desktop.tar.gz",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
      } as any,
    },
  };
  const decision = evaluateUpdateCompatibility(manifest, {
    platform: "desktop",
    desktopArch: "darwin-arm64",
    nativeVersion: "1.0.4",
    activeWebBuild: "20261124.000000-111111",
    supportsCoreOta: true,
    activeCoreBuild: "20261124.000000-111111",
    locale: "en",
  });
  assert.equal(decision.status, "ota-available");
  assert.equal(cjkRe.test(decision.reason || ""), false);
});
