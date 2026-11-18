/**
 * Per-Provider Balance & Live Billing Summary (DeepSeek Live API + Local Calibration).
 * Calculations follow each provider's native currency (`USD` or `CNY`);
 * all UI/summary outputs and merged totals are normalized to RMB (¥).
 */
import type { BillingCurrency, ProviderEntry } from "../shared/config.js";
import type { ProviderBillingEntry, ProviderBillingMode } from "../shared/entities.js";
import {
  fromCny,
  getProviderBillingCurrency,
  toCny,
  type ProviderUsageSummaryItem,
} from "../agent/pricing.js";
import { resolveProviderApiKey } from "../agent/providers/registry.js";
import { normalizeGoogleBillingSettings } from "./gcp-billing.js";

export const AUTO_REFRESH_MINUTES_OPTIONS = [0, 5, 15, 30, 60] as const;
export const DEFAULT_LIVE_REFRESH_MINUTES = 15;

export type CalibrationMode = "set" | "add" | "sub";

function roundVal(val: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((Number(val) || 0) * factor) / factor;
}

export function supportsLiveBalance(provider: Pick<ProviderEntry, "type"> | null | undefined): boolean {
  return provider?.type === "deepseek";
}

export function resolveDeepSeekBalanceUrl(baseUrl = ""): string {
  const clean = String(baseUrl || "").trim();
  if (!clean) {
    return "https://api.deepseek.com/user/balance";
  }
  try {
    const u = new URL(clean);
    const strippedPath = u.pathname.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
    return `${u.origin}${strippedPath}/user/balance`;
  } catch {
    return `${clean.replace(/\/v1\/?$/i, "").replace(/\/+$/, "")}/user/balance`;
  }
}

export async function fetchDeepSeekBalance(
  provider: ProviderEntry,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    resolveApiKeyFn = resolveProviderApiKey,
  }: {
    fetchImpl?: typeof globalThis.fetch;
    timeoutMs?: number;
    resolveApiKeyFn?: (raw?: string) => string;
  } = {}
): Promise<{
  available: boolean;
  currency: BillingCurrency;
  totalNative: number;
  grantedNative: number;
  toppedUpNative: number;
}> {
  if (!provider || provider.type !== "deepseek") {
    throw new Error("当前供应商不支持实时余额查询接口");
  }
  const apiKey = resolveApiKeyFn(provider.apiKey);
  if (!apiKey) {
    throw new Error(`供应商「${provider.name || provider.id}」未配置有效 API Key，无法查询余额`);
  }
  const url = resolveDeepSeekBalanceUrl(provider.baseUrl);
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      (text ? text.slice(0, 160) : `HTTP ${res.status}`);
    throw new Error(`DeepSeek 余额接口返回 ${res.status}: ${msg}`);
  }
  const infos: any[] = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const preferredCurrency = getProviderBillingCurrency(provider);
  const info =
    infos.find((item) => String(item?.currency || "").toUpperCase() === preferredCurrency) ||
    infos[0] ||
    null;
  if (!info) {
    throw new Error("DeepSeek 余额响应缺少 balance_infos 字段");
  }
  const respCurr = String(info.currency || preferredCurrency).toUpperCase() === "USD" ? "USD" : "CNY";
  return {
    available: Boolean(data?.is_available),
    currency: respCurr,
    totalNative: Math.max(0, Number(info.total_balance) || 0),
    grantedNative: Math.max(0, Number(info.granted_balance) || 0),
    toppedUpNative: Math.max(0, Number(info.topped_up_balance) || 0),
  };
}

export function normalizeAutoRefreshMinutes(
  raw: unknown,
  fallback = DEFAULT_LIVE_REFRESH_MINUTES
): number {
  const n = Number(raw);
  if ((AUTO_REFRESH_MINUTES_OPTIONS as readonly number[]).includes(n)) {
    return n;
  }
  return fallback;
}

export function normalizeProviderBillingEntry(
  raw: any = {},
  provider: ProviderEntry
): ProviderBillingEntry {
  const src = raw && typeof raw === "object" ? raw : {};
  const live = supportsLiveBalance(provider);
  const mode: ProviderBillingMode = live ? "live_api" : "local_calibrated";
  const currency = getProviderBillingCurrency(provider);

  const remNum = Number(src.baselineRemainingNative);
  const totNum = Number(src.baselineTotalCreditsNative);
  const spentNum = Number(src.baselineProviderSpentNative);
  const calNum = Number(src.calibratedAt);
  const liveTotalNum = Number(src.liveTotalNative);
  const liveGrantedNum = Number(src.liveGrantedNative);
  const liveToppedNum = Number(src.liveToppedUpNative);
  const lastRefNum = Number(src.lastRefreshedAt);
  const lastUpdNum = Number(src.lastUpdatedAt);

  return {
    mode,
    currency,
    baselineRemainingNative:
      src.baselineRemainingNative !== null &&
      src.baselineRemainingNative !== undefined &&
      Number.isFinite(remNum) &&
      remNum >= 0
        ? remNum
        : null,
    baselineTotalCreditsNative:
      src.baselineTotalCreditsNative !== null &&
      src.baselineTotalCreditsNative !== undefined &&
      Number.isFinite(totNum) &&
      totNum > 0
        ? totNum
        : null,
    baselineProviderSpentNative:
      Number.isFinite(spentNum) && spentNum >= 0 ? spentNum : 0,
    calibratedAt:
      src.calibratedAt !== null &&
      src.calibratedAt !== undefined &&
      Number.isFinite(calNum) &&
      calNum > 0
        ? calNum
        : null,
    note: typeof src.note === "string" ? src.note.trim().slice(0, 120) : "",
    autoRefreshMinutes: live
      ? normalizeAutoRefreshMinutes(src.autoRefreshMinutes, DEFAULT_LIVE_REFRESH_MINUTES)
      : 0,
    liveAvailable: typeof src.liveAvailable === "boolean" ? src.liveAvailable : null,
    liveTotalNative:
      src.liveTotalNative !== null &&
      src.liveTotalNative !== undefined &&
      Number.isFinite(liveTotalNum)
        ? Math.max(0, liveTotalNum)
        : null,
    liveGrantedNative:
      src.liveGrantedNative !== null &&
      src.liveGrantedNative !== undefined &&
      Number.isFinite(liveGrantedNum)
        ? Math.max(0, liveGrantedNum)
        : null,
    liveToppedUpNative:
      src.liveToppedUpNative !== null &&
      src.liveToppedUpNative !== undefined &&
      Number.isFinite(liveToppedNum)
        ? Math.max(0, liveToppedNum)
        : null,
    liveCurrency:
      src.liveCurrency === "USD" || src.liveCurrency === "CNY"
        ? src.liveCurrency
        : null,
    lastRefreshedAt:
      src.lastRefreshedAt !== null &&
      src.lastRefreshedAt !== undefined &&
      Number.isFinite(lastRefNum) &&
      lastRefNum > 0
        ? lastRefNum
        : null,
    lastError: typeof src.lastError === "string" && src.lastError ? src.lastError : null,
    lastUpdatedAt:
      src.lastUpdatedAt !== null &&
      src.lastUpdatedAt !== undefined &&
      Number.isFinite(lastUpdNum) &&
      lastUpdNum > 0
        ? lastUpdNum
        : null,
  };
}

function findLegacyMigrationTarget(providers: ProviderEntry[]): ProviderEntry | null {
  const nonLive = providers.filter((p) => !supportsLiveBalance(p));
  return (
    nonLive.find((p) => p.enabled !== false && p.type === "gemini") ||
    nonLive.find((p) => p.type === "gemini") ||
    nonLive.find((p) => p.enabled !== false) ||
    nonLive[0] ||
    null
  );
}

/**
 * Loads `settings.providerBilling` for all providers, performing an automatic
 * one-time migration from legacy `settings.googleBilling` when `providerBilling` is empty.
 */
export function normalizeProviderBillingMap(
  rawSettings: Record<string, any> = {},
  providers: ProviderEntry[] = []
): Record<string, ProviderBillingEntry> {
  const rawMap =
    rawSettings?.providerBilling && typeof rawSettings.providerBilling === "object"
      ? rawSettings.providerBilling
      : {};
  const map: Record<string, ProviderBillingEntry> = {};

  for (const p of providers) {
    map[p.id] = normalizeProviderBillingEntry(rawMap[p.id], p);
  }

  const hasExplicitEntries = Object.keys(rawMap).length > 0;
  if (!hasExplicitEntries && rawSettings?.googleBilling) {
    const legacy = normalizeGoogleBillingSettings(rawSettings.googleBilling);
    if (legacy.baselineRemainingUsd !== null) {
      const target = findLegacyMigrationTarget(providers);
      if (target) {
        const spentCny = toCny(legacy.baselineWorkspaceSpentUsd, "USD");
        const remCny = toCny(legacy.baselineRemainingUsd, "USD");
        const totCny =
          legacy.baselineTotalCreditsUsd !== null
            ? toCny(legacy.baselineTotalCreditsUsd, "USD")
            : null;
        const curr = getProviderBillingCurrency(target);
        map[target.id] = normalizeProviderBillingEntry(
          {
            baselineRemainingNative: roundVal(fromCny(remCny, curr), 4),
            baselineTotalCreditsNative:
              totCny !== null ? roundVal(fromCny(totCny, curr), 4) : null,
            baselineProviderSpentNative: roundVal(fromCny(spentCny, curr), 4),
            calibratedAt: legacy.calibratedAt,
            note: typeof (legacy as any).note === "string" ? (legacy as any).note : "",
            lastUpdatedAt: legacy.calibratedAt,
          },
          target
        );
      }
    }
  }

  return map;
}

export function computeProviderCalibratedBalance(
  entry: ProviderBillingEntry,
  providerSpentCny: number
) {
  const spentNative = fromCny(Math.max(0, Number(providerSpentCny) || 0), entry.currency);
  const spentCny = Math.max(0, Number(providerSpentCny) || 0);
  if (entry.baselineRemainingNative === null) {
    return {
      calibrated: false,
      spentNative: roundVal(spentNative, 4),
      spentCny: roundVal(spentCny, 4),
      baselineRemainingNative: null as number | null,
      baselineRemainingCny: null as number | null,
      deltaSinceCalibrationNative: 0,
      deltaSinceCalibrationCny: 0,
      estimatedRemainingNative: null as number | null,
      estimatedRemainingCny: null as number | null,
      totalCreditsNative: entry.baselineTotalCreditsNative,
      totalCreditsCny:
        entry.baselineTotalCreditsNative !== null
          ? roundVal(toCny(entry.baselineTotalCreditsNative, entry.currency), 2)
          : null,
      remainingPct: null as number | null,
    };
  }

  const deltaNative = Math.max(0, spentNative - entry.baselineProviderSpentNative);
  const deltaCny = toCny(deltaNative, entry.currency);
  const remNative = Math.max(0, entry.baselineRemainingNative - deltaNative);
  const remCny = toCny(remNative, entry.currency);
  const totalCreditsNative = entry.baselineTotalCreditsNative;
  const totalCreditsCny =
    totalCreditsNative !== null && totalCreditsNative > 0
      ? toCny(totalCreditsNative, entry.currency)
      : null;
  const remainingPct =
    totalCreditsNative && totalCreditsNative > 0
      ? Math.min(100, Math.max(0, Math.round((remNative / totalCreditsNative) * 1000) / 10))
      : null;

  return {
    calibrated: true,
    spentNative: roundVal(spentNative, 4),
    spentCny: roundVal(spentCny, 4),
    baselineRemainingNative: roundVal(entry.baselineRemainingNative, 4),
    baselineRemainingCny: roundVal(toCny(entry.baselineRemainingNative, entry.currency), 2),
    deltaSinceCalibrationNative: roundVal(deltaNative, 4),
    deltaSinceCalibrationCny: roundVal(deltaCny, 4),
    estimatedRemainingNative: roundVal(remNative, 4),
    estimatedRemainingCny: roundVal(remCny, 2),
    totalCreditsNative: totalCreditsNative !== null ? roundVal(totalCreditsNative, 4) : null,
    totalCreditsCny: totalCreditsCny !== null ? roundVal(totalCreditsCny, 2) : null,
    remainingPct,
  };
}

export function applyProviderCalibration({
  entry,
  provider,
  providerSpentCny = 0,
  mode = "set",
  amountCny,
  amountNative,
  totalCreditsCny,
  note,
  clear = false,
  now = Date.now(),
}: {
  entry?: ProviderBillingEntry;
  provider: ProviderEntry;
  providerSpentCny?: number;
  mode?: CalibrationMode;
  amountCny?: number;
  amountNative?: number;
  totalCreditsCny?: number;
  note?: string;
  clear?: boolean;
  now?: number;
}): ProviderBillingEntry {
  const cur = entry ? normalizeProviderBillingEntry(entry, provider) : normalizeProviderBillingEntry({}, provider);
  if (clear) {
    return {
      ...cur,
      baselineRemainingNative: null,
      baselineTotalCreditsNative: null,
      baselineProviderSpentNative: 0,
      calibratedAt: null,
      note: "",
      lastUpdatedAt: now,
    };
  }

  const normalizedMode: CalibrationMode =
    mode === "add" || mode === "sub" ? mode : "set";
  const nativeAmount =
    amountNative !== undefined && Number.isFinite(Number(amountNative))
      ? Number(amountNative)
      : amountCny !== undefined && Number.isFinite(Number(amountCny))
        ? fromCny(Number(amountCny), cur.currency)
        : NaN;

  if (!Number.isFinite(nativeAmount) || nativeAmount < 0) {
    throw new Error("请输入合法的非负金额");
  }
  if ((normalizedMode === "add" || normalizedMode === "sub") && nativeAmount === 0) {
    throw new Error("调整金额必须大于 0");
  }

  const currentBal = computeProviderCalibratedBalance(cur, providerSpentCny);
  let nextRemainingNative: number;
  if (normalizedMode === "set") {
    nextRemainingNative = nativeAmount;
  } else if (!currentBal.calibrated || currentBal.estimatedRemainingNative === null) {
    if (normalizedMode === "sub") {
      throw new Error("请先设置初始余额后再使用扣减校准");
    }
    nextRemainingNative = nativeAmount;
  } else if (normalizedMode === "add") {
    nextRemainingNative = currentBal.estimatedRemainingNative + nativeAmount;
  } else {
    nextRemainingNative = Math.max(0, currentBal.estimatedRemainingNative - nativeAmount);
  }

  const spentNative = fromCny(Math.max(0, Number(providerSpentCny) || 0), cur.currency);
  let nextTotalCreditsNative = cur.baselineTotalCreditsNative;
  if (totalCreditsCny !== undefined && totalCreditsCny !== null && Number.isFinite(Number(totalCreditsCny))) {
    const tcNative = fromCny(Number(totalCreditsCny), cur.currency);
    nextTotalCreditsNative = tcNative > 0 ? roundVal(tcNative, 4) : null;
  } else if (normalizedMode === "add" && nextTotalCreditsNative !== null) {
    nextTotalCreditsNative = roundVal(nextTotalCreditsNative + nativeAmount, 4);
  }

  return {
    ...cur,
    baselineRemainingNative: roundVal(nextRemainingNative, 4),
    baselineTotalCreditsNative: nextTotalCreditsNative,
    baselineProviderSpentNative: roundVal(spentNative, 4),
    calibratedAt: now,
    note: typeof note === "string" ? note.trim().slice(0, 120) : cur.note || "",
    lastUpdatedAt: now,
  };
}

export function updateProviderRefreshSchedule(
  entry: ProviderBillingEntry | undefined,
  provider: ProviderEntry,
  autoRefreshMinutes: unknown,
  now = Date.now()
): ProviderBillingEntry {
  if (!supportsLiveBalance(provider)) {
    throw new Error("该供应商暂不支持自动刷新余额接口");
  }
  const parsed = Number(autoRefreshMinutes);
  if (!(AUTO_REFRESH_MINUTES_OPTIONS as readonly number[]).includes(parsed)) {
    throw new Error(
      `自动刷新周期仅支持: ${AUTO_REFRESH_MINUTES_OPTIONS.join(" / ")} 分钟`
    );
  }
  const cur = normalizeProviderBillingEntry(entry, provider);
  return {
    ...cur,
    autoRefreshMinutes: parsed,
    lastUpdatedAt: now,
  };
}

export async function refreshProviderLiveBalance(
  entry: ProviderBillingEntry | undefined,
  provider: ProviderEntry,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    resolveApiKeyFn = resolveProviderApiKey,
    now = Date.now(),
  }: {
    fetchImpl?: typeof globalThis.fetch;
    timeoutMs?: number;
    resolveApiKeyFn?: (raw?: string) => string;
    now?: number;
  } = {}
): Promise<{ ok: boolean; entry: ProviderBillingEntry; error: string | null }> {
  const cur = normalizeProviderBillingEntry(entry, provider);
  if (!supportsLiveBalance(provider)) {
    return {
      ok: false,
      entry: cur,
      error: "该供应商暂不支持实时余额查询接口",
    };
  }
  try {
    const fetched = await fetchDeepSeekBalance(provider, {
      fetchImpl,
      timeoutMs,
      resolveApiKeyFn,
    });
    return {
      ok: true,
      error: null,
      entry: {
        ...cur,
        liveAvailable: fetched.available,
        liveCurrency: fetched.currency,
        liveTotalNative: roundVal(fetched.totalNative, 4),
        liveGrantedNative: roundVal(fetched.grantedNative, 4),
        liveToppedUpNative: roundVal(fetched.toppedUpNative, 4),
        lastRefreshedAt: now,
        lastError: null,
        lastUpdatedAt: now,
      },
    };
  } catch (err: any) {
    const error = String(err?.message || "余额查询失败");
    return {
      ok: false,
      error,
      entry: {
        ...cur,
        lastError: error,
        lastUpdatedAt: now,
      },
    };
  }
}

export function isProviderDueForRefresh(
  entry: ProviderBillingEntry | undefined,
  provider: ProviderEntry,
  now = Date.now()
): boolean {
  if (!provider || provider.enabled === false || !supportsLiveBalance(provider)) {
    return false;
  }
  const normalized = normalizeProviderBillingEntry(entry, provider);
  if (!normalized.autoRefreshMinutes || normalized.autoRefreshMinutes <= 0) {
    return false;
  }
  if (!normalized.lastRefreshedAt) return true;
  return now - normalized.lastRefreshedAt >= normalized.autoRefreshMinutes * 60_000;
}

export function buildWorkspaceProviderBillingSummary({
  settings = {},
  providers = [],
  byProviderUsage = [],
  includeDisabled = false,
}: {
  settings?: Record<string, any>;
  providers?: ProviderEntry[];
  byProviderUsage?: ProviderUsageSummaryItem[];
  includeDisabled?: boolean;
}) {
  const billingMap = normalizeProviderBillingMap(settings, providers);
  const usageById = new Map<string, ProviderUsageSummaryItem>(
    (Array.isArray(byProviderUsage) ? byProviderUsage : []).map((u) => [u.providerId, u])
  );

  const visibleProviders = providers.filter(
    (p) => includeDisabled || p.enabled !== false
  );

  let mergedRemainingCny = 0;
  let providersWithBalanceCount = 0;
  let liveProviderCount = 0;
  let latestRefreshedAt: number | null = null;
  const mergedTags: Array<{
    providerId: string;
    providerName: string;
    remainingCny: number;
    mode: ProviderBillingMode;
  }> = [];

  const cards = visibleProviders.map((provider) => {
    const entry = normalizeProviderBillingEntry(billingMap[provider.id], provider);
    const live = supportsLiveBalance(provider);
    if (live) liveProviderCount += 1;

    const u = usageById.get(provider.id);
    const spentCny = u?.costCny || 0;
    const spentNative = roundVal(fromCny(spentCny, entry.currency), 4);

    if (live) {
      const liveCurr = entry.liveCurrency || entry.currency;
      const hasLive = entry.liveTotalNative !== null;
      const remainingNative = hasLive ? roundVal(entry.liveTotalNative || 0, 4) : null;
      const remainingCny = hasLive
        ? roundVal(toCny(entry.liveTotalNative || 0, liveCurr), 2)
        : null;
      const grantedCny =
        entry.liveGrantedNative !== null
          ? roundVal(toCny(entry.liveGrantedNative, liveCurr), 2)
          : null;
      const toppedUpCny =
        entry.liveToppedUpNative !== null
          ? roundVal(toCny(entry.liveToppedUpNative, liveCurr), 2)
          : null;

      if (remainingCny !== null && provider.enabled !== false) {
        mergedRemainingCny += remainingCny;
        providersWithBalanceCount += 1;
        mergedTags.push({
          providerId: provider.id,
          providerName: provider.name || provider.id,
          remainingCny,
          mode: "live_api",
        });
      }
      if (entry.lastRefreshedAt && (!latestRefreshedAt || entry.lastRefreshedAt > latestRefreshedAt)) {
        latestRefreshedAt = entry.lastRefreshedAt;
      }

      const status = entry.lastError
        ? "live_error"
        : hasLive
          ? "live_ok"
          : "live_unfetched";

      return {
        providerId: provider.id,
        providerName: provider.name || provider.id,
        providerType: provider.type,
        enabled: provider.enabled !== false,
        billingCurrency: entry.currency,
        mode: "live_api" as ProviderBillingMode,
        supportsLiveBalance: true,
        status,
        spentCny: roundVal(spentCny, 4),
        spentNative,
        remainingCny,
        remainingNative,
        grantedCny,
        toppedUpCny,
        liveAvailable: entry.liveAvailable,
        totalCreditsCny: null as number | null,
        remainingPct: null as number | null,
        baselineRemainingCny: null as number | null,
        deltaSinceCalibrationCny: 0,
        calibratedAt: null as number | null,
        note: "",
        autoRefreshMinutes: entry.autoRefreshMinutes,
        lastRefreshedAt: entry.lastRefreshedAt,
        lastError: entry.lastError,
        lastUpdatedAt: entry.lastUpdatedAt,
      };
    }

    const cal = computeProviderCalibratedBalance(entry, spentCny);
    if (cal.calibrated && cal.estimatedRemainingCny !== null && provider.enabled !== false) {
      mergedRemainingCny += cal.estimatedRemainingCny;
      providersWithBalanceCount += 1;
      mergedTags.push({
        providerId: provider.id,
        providerName: provider.name || provider.id,
        remainingCny: cal.estimatedRemainingCny,
        mode: "local_calibrated",
      });
    }

    return {
      providerId: provider.id,
      providerName: provider.name || provider.id,
      providerType: provider.type,
      enabled: provider.enabled !== false,
      billingCurrency: entry.currency,
      mode: "local_calibrated" as ProviderBillingMode,
      supportsLiveBalance: false,
      status: cal.calibrated ? "calibrated" : "uncalibrated",
      spentCny: cal.spentCny,
      spentNative: cal.spentNative,
      remainingCny: cal.estimatedRemainingCny,
      remainingNative: cal.estimatedRemainingNative,
      grantedCny: null as number | null,
      toppedUpCny: null as number | null,
      liveAvailable: null as boolean | null,
      totalCreditsCny: cal.totalCreditsCny,
      remainingPct: cal.remainingPct,
      baselineRemainingCny: cal.baselineRemainingCny,
      deltaSinceCalibrationCny: roundVal(cal.deltaSinceCalibrationCny, 4),
      calibratedAt: entry.calibratedAt,
      note: entry.note || "",
      autoRefreshMinutes: 0,
      lastRefreshedAt: null as number | null,
      lastError: null as string | null,
      lastUpdatedAt: entry.lastUpdatedAt,
    };
  });

  return {
    merged: {
      remainingCny: roundVal(mergedRemainingCny, 2),
      hasAnyBalance: providersWithBalanceCount > 0,
      providersWithBalanceCount,
      totalEnabledProviders: visibleProviders.filter((p) => p.enabled !== false).length,
      liveProviderCount,
      supportsAnyLiveRefresh: liveProviderCount > 0,
      lastRefreshedAt: latestRefreshedAt,
      providersWithBalance: mergedTags,
    },
    providers: cards,
    billingMap,
  };
}
