import { USD_TO_CNY } from "../agent/pricing.js";

const MAX_USD_AMOUNT = 100_000;

export interface GoogleBillingSettings {
  baselineRemainingUsd: number | null;
  baselineTotalCreditsUsd: number | null;
  baselineWorkspaceSpentUsd: number;
  calibratedAt: number | null;
}

export interface CalibratedBalance {
  calibrated: boolean;
  estimatedRemainingUsd: number | null;
  estimatedRemainingCny: number | null;
  deltaSinceCalibrationUsd: number;
  remainingPct: number | null;
}

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundUsd(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Normalizes persisted local API balance / credit calibration settings.
 */
export function normalizeGoogleBillingSettings(raw: any = {}): GoogleBillingSettings {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rem = parseNum(src.baselineRemainingUsd);
  const tot = parseNum(src.baselineTotalCreditsUsd);
  const baseSpent = parseNum(src.baselineWorkspaceSpentUsd);
  const calAt = parseNum(src.calibratedAt);
  return {
    baselineRemainingUsd: rem !== null && rem >= 0 ? roundUsd(rem) : null,
    baselineTotalCreditsUsd: tot !== null && tot > 0 ? roundUsd(tot) : null,
    baselineWorkspaceSpentUsd: baseSpent !== null && baseSpent >= 0 ? roundUsd(baseSpent) : 0,
    calibratedAt: calAt !== null && calAt > 0 ? Math.round(calAt) : null,
  };
}

/**
 * Computes current estimated remaining balance by deducting TwinkleBot workspace
 * spend accumulated since the latest calibration snapshot.
 */
export function computeCalibratedBalance(
  calibration: unknown,
  workspaceEstimatedCostUsd = 0
): CalibratedBalance {
  const cal = normalizeGoogleBillingSettings(calibration);
  const totalEst = Math.max(0, Number(workspaceEstimatedCostUsd) || 0);
  if (cal.baselineRemainingUsd === null) {
    return {
      calibrated: false,
      estimatedRemainingUsd: null,
      estimatedRemainingCny: null,
      deltaSinceCalibrationUsd: 0,
      remainingPct: null,
    };
  }
  const delta = Math.max(0, totalEst - (cal.baselineWorkspaceSpentUsd || 0));
  const remUsd = Math.max(0, roundUsd(cal.baselineRemainingUsd - delta));
  const remCny = Math.round(remUsd * USD_TO_CNY * 100) / 100;
  const remainingPct =
    cal.baselineTotalCreditsUsd && cal.baselineTotalCreditsUsd > 0
      ? Math.round(
          Math.min(100, Math.max(0, (remUsd / cal.baselineTotalCreditsUsd) * 100)) * 10
        ) / 10
      : null;

  return {
    calibrated: true,
    estimatedRemainingUsd: remUsd,
    estimatedRemainingCny: remCny,
    deltaSinceCalibrationUsd: roundUsd(delta),
    remainingPct,
  };
}

/**
 * Applies a calibration operation ("set" | "add" | "sub" | clear) and snapshots
 * current workspace spend as the new deduction baseline.
 */
export function applyBalanceCalibration({
  currentSettings = {},
  workspaceEstimatedCostUsd = 0,
  clear = false,
  mode = "set",
  amountUsd,
  baselineRemainingUsd,
  baselineTotalCreditsUsd,
  now = Date.now(),
}: {
  currentSettings?: unknown;
  workspaceEstimatedCostUsd?: number;
  clear?: boolean;
  mode?: string;
  amountUsd?: unknown;
  baselineRemainingUsd?: unknown;
  baselineTotalCreditsUsd?: unknown;
  now?: number;
} = {}): GoogleBillingSettings {
  if (clear) {
    return normalizeGoogleBillingSettings({});
  }

  const cur = normalizeGoogleBillingSettings(currentSettings);
  const curSpent = Math.max(0, Number(workspaceEstimatedCostUsd) || 0);
  const curBalance = computeCalibratedBalance(cur, curSpent);

  const normalizedMode = String(mode || "set").trim().toLowerCase();
  if (!["set", "add", "sub"].includes(normalizedMode)) {
    throw new Error("不支持的校准方式，请使用直接修改、+ 或 -");
  }

  let nextTotalCredits = cur.baselineTotalCreditsUsd;
  if (baselineTotalCreditsUsd !== undefined) {
    if (baselineTotalCreditsUsd === null || baselineTotalCreditsUsd === "") {
      nextTotalCredits = null;
    } else {
      const t = Number(baselineTotalCreditsUsd);
      if (!Number.isFinite(t) || t <= 0 || t > MAX_USD_AMOUNT) {
        throw new Error(`总额度必须为 0 ~ ${MAX_USD_AMOUNT} 之间的正数`);
      }
      nextTotalCredits = roundUsd(t);
    }
  }

  const rawInput = amountUsd !== undefined ? amountUsd : baselineRemainingUsd;
  const hasAmountInput = rawInput !== undefined && rawInput !== null && rawInput !== "";

  if (!hasAmountInput) {
    if (normalizedMode !== "set") {
      throw new Error(normalizedMode === "add" ? "请输入要增加的 USD 金额" : "请输入要扣减的 USD 金额");
    }
    if (baselineTotalCreditsUsd !== undefined && cur.calibratedAt !== null) {
      return normalizeGoogleBillingSettings({
        ...cur,
        baselineTotalCreditsUsd: nextTotalCredits,
      });
    }
    throw new Error("请输入当前剩余余额（USD）");
  }

  const parsedAmount = Number(rawInput);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > MAX_USD_AMOUNT) {
    throw new Error(`金额必须为 0 ~ ${MAX_USD_AMOUNT} 之间的有效 USD 数值`);
  }

  let nextRemainingUsd: number;
  if (normalizedMode === "set") {
    nextRemainingUsd = roundUsd(parsedAmount);
  } else if (normalizedMode === "add") {
    if (parsedAmount <= 0) {
      throw new Error("增加金额必须大于 0");
    }
    const base = curBalance.calibrated ? (curBalance.estimatedRemainingUsd ?? 0) : 0;
    nextRemainingUsd = Math.min(MAX_USD_AMOUNT, roundUsd(base + parsedAmount));
  } else {
    if (!curBalance.calibrated) {
      throw new Error("尚未设置初始余额，请先使用「直接修改」或「+」设置额度");
    }
    if (parsedAmount <= 0) {
      throw new Error("扣减金额必须大于 0");
    }
    nextRemainingUsd = Math.max(
      0,
      roundUsd((curBalance.estimatedRemainingUsd ?? 0) - parsedAmount)
    );
  }

  return normalizeGoogleBillingSettings({
    baselineRemainingUsd: nextRemainingUsd,
    baselineTotalCreditsUsd: nextTotalCredits,
    baselineWorkspaceSpentUsd: roundUsd(curSpent),
    calibratedAt: Math.round(Number(now) || Date.now()),
  });
}

/**
 * Builds the instant local API balance summary using persisted calibration and
 * TwinkleBot's own computed workspace cost.
 */
export function buildBillingBalanceSummary({
  settings = {},
  workspaceEstimatedCostUsd = 0,
}: {
  settings?: any;
  workspaceEstimatedCostUsd?: number;
} = {}) {
  const calibration = normalizeGoogleBillingSettings(settings?.googleBilling);
  const spent = roundUsd(Math.max(0, Number(workspaceEstimatedCostUsd) || 0));
  return {
    mode: "local_calibrated" as const,
    calibration,
    balance: computeCalibratedBalance(calibration, spent),
    workspaceEstimatedCostUsd: spent,
    consoleUrl: "https://console.cloud.google.com/billing",
  };
}
