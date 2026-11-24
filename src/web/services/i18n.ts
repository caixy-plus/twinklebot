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
