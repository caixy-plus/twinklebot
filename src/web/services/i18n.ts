import { useEffect, useState } from "react";
import {
  formatLanguageOptionLabel,
  normalizeLanguagePreference,
  resolveEffectiveLocale,
  t as translateKey,
  translateStatusLabel,
  type I18nKey,
  type LanguagePreference,
  type ResolvedLocale,
} from "/shared/i18n.js";
import { getState, setState, useStore } from "../state/store.js";

export const LANGUAGE_STORAGE_KEY = "twinklebot.language";

export function readStoredLanguagePreference(): LanguagePreference | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (!raw) return null;
    return normalizeLanguagePreference(raw);
  } catch {
    return null;
  }
}

export function syncLanguageToDomAndStorage(
  pref: LanguagePreference,
  persistLocal = true
): ResolvedLocale {
  const norm = normalizeLanguagePreference(pref);
  const locale = resolveEffectiveLocale(norm);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
  }
  if (persistLocal && typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, norm);
    } catch {
      // ignore storage quota errors
    }
  }
  return locale;
}

export function getActiveLanguagePreference(): LanguagePreference {
  const statePref = getState().settings?.language;
  if (statePref) return normalizeLanguagePreference(statePref);
  return readStoredLanguagePreference() || "system";
}

export function getActiveLocale(): ResolvedLocale {
  return resolveEffectiveLocale(getActiveLanguagePreference());
}

export function tr(
  key: I18nKey,
  params?: Record<string, string | number | null | undefined>
): string {
  return translateKey(key, getActiveLocale(), params);
}

export function trStatus(status: string | null | undefined): string {
  return translateStatusLabel(status, getActiveLocale());
}

export function useI18n() {
  const rawLanguage = useStore((s) => s.settings?.language);
  const [sysTick, setSysTick] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onLangChange = () => {
      const pref = getActiveLanguagePreference();
      if (pref === "system") {
        syncLanguageToDomAndStorage("system", false);
        setSysTick((n) => n + 1);
      }
    };
    window.addEventListener("languagechange", onLangChange);
    return () => window.removeEventListener("languagechange", onLangChange);
  }, []);

  const language: LanguagePreference = normalizeLanguagePreference(
    rawLanguage || readStoredLanguagePreference() || "system"
  );
  // Reference sysTick so system language changes trigger a fresh resolved locale
  const locale: ResolvedLocale = sysTick >= 0 ? resolveEffectiveLocale(language) : "zh-CN";

  return {
    language,
    locale,
    isEn: locale === "en",
    t: (
      key: I18nKey,
      params?: Record<string, string | number | null | undefined>
    ) => translateKey(key, locale, params),
    tStatus: (status: string | null | undefined) => translateStatusLabel(status, locale),
    formatLanguageLabel: (pref: LanguagePreference) => formatLanguageOptionLabel(pref, locale),
  };
}

export function setLocalLanguageState(pref: LanguagePreference): ResolvedLocale {
  const norm = normalizeLanguagePreference(pref);
  const locale = syncLanguageToDomAndStorage(norm, true);
  setState((prev) => ({
    settings: {
      ...prev.settings,
      language: norm,
    },
  }));
  return locale;
}

export function resolveLocalizedProfileName(
  rawName: string | null | undefined,
  locale: ResolvedLocale,
  fallback?: string
): string {
  const clean = String(rawName || "").trim();
  if (!clean) {
    return fallback || translateKey("sidebar.localUser", locale);
  }
  if (locale === "en" && clean === "本地用户") {
    return translateKey("sidebar.localUser", locale);
  }
  return clean;
}

export function resolveLocalizedAccountName(
  acc: { id?: string; type?: string; name?: string; hostname?: string; baseUrl?: string } | null | undefined,
  locale: ResolvedLocale,
  fallback = ""
): string {
  const raw = String(acc?.name || "").trim();
  if (
    acc?.type === "local" &&
    locale === "en" &&
    (!raw || raw === "本地账号" || raw === "本地电脑")
  ) {
    return translateKey("net.localAccount", locale);
  }
  return raw || String(acc?.hostname || acc?.baseUrl || acc?.id || fallback);
}

const DEFAULT_GLOBAL_MEMORY_EN: Record<string, string> = {
  "工作区整洁约定": "Workspace Hygiene",
  "生成的报告、脚本或下载产物统一存放在当前 Bot 专属工作区目录下并告知绝对路径":
    "Save generated reports, scripts, or downloads in the Bot's dedicated workspace and report the exact path",
  "OrbStack 桌面巡检": "OrbStack Desktop Inspection",
  "检查 :1 桌面窗口与网络连通状态时优先用 run_shell 与 list_windows 配合":
    "Combine run_shell and list_windows first when checking :1 desktop windows and network status",
};

/**
 * Localizes unmodified built-in global memory sample entries for English display
 * while leaving user-authored memories untouched.
 */
export function resolveLocalizedGlobalMemory(
  mem: { name?: string; desc?: string; content?: string; instruction?: string },
  locale: ResolvedLocale
): { name: string; desc: string } {
  const rawName = String(mem?.name || "");
  const rawDesc = String(mem?.instruction || mem?.content || mem?.desc || "");
  if (locale !== "en") {
    return { name: rawName, desc: rawDesc };
  }
  return {
    name: DEFAULT_GLOBAL_MEMORY_EN[rawName] || rawName,
    desc: DEFAULT_GLOBAL_MEMORY_EN[rawDesc] || rawDesc,
  };
}

const DEFAULT_VAULT_TEXT_EN: Record<string, string> = {
  "我的 Google 账号（Gmail 默认连接）": "My Google Account (Default Gmail)",
  "备用邮箱": "Backup Email",
  "本地用户": "Local User",
  "默认工作邮箱": "Default work email",
  "开发测试账号": "Dev & test account",
  "本地主操作人": "Primary local operator",
};

/**
 * Localizes unmodified built-in Vault seed entries for English display
 * while leaving user-edited Vault items untouched.
 */
export function resolveLocalizedVaultItem(
  item: { title?: string; subtitle?: string; notes?: string },
  locale: ResolvedLocale
): { title: string; subtitle: string; notes: string } {
  const rawTitle = String(item?.title || "");
  const rawSub = String(item?.subtitle || "");
  const rawNotes = String(item?.notes || "");
  if (locale !== "en") {
    return { title: rawTitle, subtitle: rawSub, notes: rawNotes };
  }
  return {
    title: DEFAULT_VAULT_TEXT_EN[rawTitle] || rawTitle,
    subtitle: DEFAULT_VAULT_TEXT_EN[rawSub] || rawSub,
    notes: DEFAULT_VAULT_TEXT_EN[rawNotes] || rawNotes,
  };
}
