import { ZH_CN_MESSAGES, type I18nKey } from "./i18n-zh.js";
import { EN_MESSAGES } from "./i18n-en.js";

export { ZH_CN_MESSAGES, EN_MESSAGES };
export type { I18nKey };

export type LanguagePreference = "system" | "zh-CN" | "en";
export type ResolvedLocale = "zh-CN" | "en";

export const VALID_LANGUAGE_PREFERENCES: readonly LanguagePreference[] = [
  "system",
  "zh-CN",
  "en",
] as const;

export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = "system";

export function normalizeLanguagePreference(raw: unknown): LanguagePreference {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "en" || s.startsWith("en-")) return "en";
  if (s === "zh" || s === "zh-cn" || s === "zh-hans" || s.startsWith("zh-")) return "zh-CN";
  return "system";
}

export function isExplicitLanguagePreference(raw: unknown): boolean {
  const s = String(raw || "").trim().toLowerCase();
  return s === "system" || s === "zh-cn" || s === "zh" || s === "en";
}

export function detectSystemLocale(hint?: string | readonly string[] | null): ResolvedLocale {
  const candidates: string[] = [];
  if (typeof hint === "string" && hint.trim()) {
    candidates.push(hint.trim());
  } else if (Array.isArray(hint)) {
    for (const item of hint) {
      if (typeof item === "string" && item.trim()) candidates.push(item.trim());
    }
  }

  if (candidates.length === 0) {
    if (typeof window !== "undefined") {
      const nav = window.navigator;
      if (Array.isArray(nav?.languages)) {
        for (const l of nav.languages) {
          if (typeof l === "string" && l.trim()) candidates.push(l.trim());
        }
      }
      if (typeof nav?.language === "string" && nav.language.trim()) {
        candidates.push(nav.language.trim());
      }
      try {
        const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (intlLocale) candidates.push(intlLocale);
      } catch {
        // ignore
      }
    } else {
      const envDefault = (globalThis as any)?.process?.env?.TWINKLEBOT_DEFAULT_LOCALE || "";
      if (envDefault && String(envDefault).trim()) {
        candidates.push(String(envDefault).trim());
      } else {
        // SSR / headless Node fallback without browser navigator context
        return "zh-CN";
      }
    }
  }

  const first = String(candidates[0] || "").trim().toLowerCase();
  if (!first) return "zh-CN";
  if (first === "zh" || first.startsWith("zh-") || first.startsWith("zh_")) {
    return "zh-CN";
  }
  return "en";
}

export function resolveEffectiveLocale(
  preference: unknown,
  systemHint?: string | readonly string[] | null
): ResolvedLocale {
  const norm = normalizeLanguagePreference(preference);
  if (norm === "en") return "en";
  if (norm === "zh-CN") return "zh-CN";
  return detectSystemLocale(systemHint);
}

export function t(
  key: I18nKey,
  locale: ResolvedLocale = "zh-CN",
  params?: Record<string, string | number | null | undefined>
): string {
  const dict = locale === "en" ? EN_MESSAGES : ZH_CN_MESSAGES;
  let template = dict[key] ?? ZH_CN_MESSAGES[key] ?? String(key);
  if (params) {
    template = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name) => {
      const val = params[name];
      return val === undefined || val === null ? "" : String(val);
    });
  }
  return template;
}

export function formatLanguageOptionLabel(
  pref: LanguagePreference,
  locale: ResolvedLocale
): string {
  if (pref === "en") return t("lang.en", locale);
  if (pref === "zh-CN") return t("lang.zhCN", locale);
  return t("lang.system", locale);
}

export const STATUS_LABEL_KEYS: Record<string, I18nKey> = {
  idle: "status.idle",
  running: "status.running",
  waiting_screen: "status.waiting_screen",
  paused: "status.paused",
  awaiting_approval: "status.awaiting_approval",
  awaiting_choice: "status.awaiting_choice",
  completed: "status.completed",
  stopped: "status.stopped",
  error: "status.error",
  interrupted: "status.interrupted",
};

export function translateStatusLabel(
  status: string | null | undefined,
  locale: ResolvedLocale = "zh-CN"
): string {
  const key = STATUS_LABEL_KEYS[String(status || "idle")] || "status.idle";
  return t(key, locale);
}
