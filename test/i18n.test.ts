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
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import { renderAppHtml, renderFullAppHtml } from "./helpers/react-test-helpers.js";

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
