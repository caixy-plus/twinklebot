export interface CronPreset {
  label: string;
  expr: string;
  hint?: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { label: "每30分钟", expr: "*/30 * * * *" },
  { label: "每3天 10:00", expr: "0 10 */3 * *" },
  { label: "工作日 09:00", expr: "0 9 * * 1-5" },
  { label: "每周一 09:00", expr: "0 9 * * 1" },
  { label: "每月1日 09:00", expr: "0 9 1 * *" },
];

export interface ParsedCronExpression {
  raw: string;
  normalized: string;
  minutes: boolean[];
  hours: boolean[];
  daysOfMonth: boolean[];
  months: boolean[];
  daysOfWeek: boolean[];
  domWildcard: boolean;
  dowWildcard: boolean;
}

export type ParseCronResult =
  | { ok: true; value: ParsedCronExpression; normalized: string }
  | { ok: false; error: string };

const CRON_ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const DOW_LABELS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function parseFieldAtom(
  rawToken: string,
  min: number,
  max: number,
  names?: Record<string, number>
): number | null {
  const token = rawToken.trim().toUpperCase();
  if (!token) return null;
  if (names && Object.prototype.hasOwnProperty.call(names, token)) {
    return names[token];
  }
  if (!/^\d+$/.test(token)) return null;
  const num = Number(token);
  if (!Number.isInteger(num) || num < min || num > max) return null;
  return num;
}

function parseCronField(
  fieldRaw: string,
  min: number,
  max: number,
  fieldLabel: string,
  opts: { names?: Record<string, number>; isDow?: boolean } = {}
): { ok: true; mask: boolean[]; wildcard: boolean } | { ok: false; error: string } {
  const token = String(fieldRaw || "").trim();
  if (!token) {
    return { ok: false, error: `Cron「${fieldLabel}」字段不能为空` };
  }

  const mask = new Array<boolean>(opts.isDow ? 7 : max + 1).fill(false);
  const wildcard = token === "*";
  const parts = token.split(",");

  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) {
      return { ok: false, error: `Cron「${fieldLabel}」存在空的逗号分隔项` };
    }

    const slashIdx = part.indexOf("/");
    let base = part;
    let step = 1;
    if (slashIdx !== -1) {
      if (part.indexOf("/", slashIdx + 1) !== -1) {
        return { ok: false, error: `Cron「${fieldLabel}」包含无效步长写法：${part}` };
      }
      base = part.slice(0, slashIdx).trim();
      const stepStr = part.slice(slashIdx + 1).trim();
      if (!/^\d+$/.test(stepStr)) {
        return { ok: false, error: `Cron「${fieldLabel}」步长必须是正整数：${part}` };
      }
      step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        return { ok: false, error: `Cron「${fieldLabel}」步长必须大于 0：${part}` };
      }
    }

    let rangeStart = min;
    let rangeEnd = max;
    if (base === "*") {
      rangeStart = min;
      rangeEnd = opts.isDow ? 6 : max;
    } else if (base.includes("-")) {
      const dashParts = base.split("-");
      if (dashParts.length !== 2) {
        return { ok: false, error: `Cron「${fieldLabel}」范围格式无效：${part}` };
      }
      const s = parseFieldAtom(dashParts[0], min, max, opts.names);
      const e = parseFieldAtom(dashParts[1], min, max, opts.names);
      if (s === null || e === null) {
        return { ok: false, error: `Cron「${fieldLabel}」数值超出范围（允许 ${min}-${max}）：${part}` };
      }
      if (s > e) {
        return { ok: false, error: `Cron「${fieldLabel}」起始值不能大于结束值：${part}` };
      }
      rangeStart = s;
      rangeEnd = e;
    } else {
      const v = parseFieldAtom(base, min, max, opts.names);
      if (v === null) {
        return { ok: false, error: `Cron「${fieldLabel}」数值无效（允许 ${min}-${max}）：${part}` };
      }
      rangeStart = v;
      rangeEnd = slashIdx !== -1 ? (opts.isDow ? 6 : max) : v;
      if (slashIdx !== -1 && rangeStart > rangeEnd) {
        rangeEnd = max;
      }
    }

    for (let v = rangeStart; v <= rangeEnd; v += step) {
      const normalizedVal = opts.isDow && v === 7 ? 0 : v;
      mask[normalizedVal] = true;
    }
  }

  return { ok: true, mask, wildcard };
}

function hasAnyValidCalendarDate(parsed: ParsedCronExpression): boolean {
  if (parsed.domWildcard || !parsed.dowWildcard) {
    return true;
  }
  const monthMaxDays = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 1; m <= 12; m++) {
    if (!parsed.months[m]) continue;
    for (let d = 1; d <= monthMaxDays[m]; d++) {
      if (parsed.daysOfMonth[d]) return true;
    }
  }
  return false;
}

export function parseCronExpression(expr: string): ParseCronResult {
  const raw = String(expr || "").trim();
  if (!raw) {
    return { ok: false, error: "请输入 5 段式 Cron 表达式（分 时 日 月 周）" };
  }
  const aliasResolved = CRON_ALIASES[raw.toLowerCase()];
  const expanded = aliasResolved || raw;
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `Cron 表达式必须包含 5 个空格分隔字段（分 时 日 月 周），当前有 ${parts.length} 段`,
    };
  }

  const minRes = parseCronField(parts[0], 0, 59, "分");
  if (!minRes.ok) return minRes;
  const hourRes = parseCronField(parts[1], 0, 23, "时");
  if (!hourRes.ok) return hourRes;
  const domRes = parseCronField(parts[2], 1, 31, "日");
  if (!domRes.ok) return domRes;
  const monthRes = parseCronField(parts[3], 1, 12, "月", { names: MONTH_NAMES });
  if (!monthRes.ok) return monthRes;
  const dowRes = parseCronField(parts[4], 0, 7, "周", { names: DOW_NAMES, isDow: true });
  if (!dowRes.ok) return dowRes;

  const value: ParsedCronExpression = {
    raw,
    normalized: parts.join(" "),
    minutes: minRes.mask,
    hours: hourRes.mask,
    daysOfMonth: domRes.mask,
    months: monthRes.mask,
    daysOfWeek: dowRes.mask,
    domWildcard: domRes.wildcard,
    dowWildcard: dowRes.wildcard,
  };

  if (!hasAnyValidCalendarDate(value)) {
    return { ok: false, error: "该 Cron 表达式对应的月份与日期在日历上永远不会出现" };
  }

  return { ok: true, value, normalized: value.normalized };
}

export function isValidCronExpression(expr: string): boolean {
  return parseCronExpression(expr).ok;
}

function advanceParsedCron(parsed: ParsedCronExpression, fromDate: Date): Date | null {
  const cur = new Date(fromDate.getTime());
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);

  const maxYear = cur.getFullYear() + 5;
  while (cur.getFullYear() <= maxYear) {
    const month = cur.getMonth() + 1;
    if (!parsed.months[month]) {
      let foundMonth = -1;
      for (let m = month + 1; m <= 12; m++) {
        if (parsed.months[m]) {
          foundMonth = m;
          break;
        }
      }
      if (foundMonth !== -1) {
        cur.setMonth(foundMonth - 1, 1);
        cur.setHours(0, 0, 0, 0);
      } else {
        cur.setFullYear(cur.getFullYear() + 1, 0, 1);
        cur.setHours(0, 0, 0, 0);
      }
      continue;
    }

    const dom = cur.getDate();
    const dow = cur.getDay();
    const domMatch = parsed.daysOfMonth[dom];
    const dowMatch = parsed.daysOfWeek[dow];
    const dayMatches =
      !parsed.domWildcard && !parsed.dowWildcard
        ? domMatch || dowMatch
        : domMatch && dowMatch;

    if (!dayMatches) {
      cur.setDate(dom + 1);
      cur.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = cur.getHours();
    if (!parsed.hours[hour]) {
      cur.setHours(hour + 1, 0, 0, 0);
      continue;
    }

    const minute = cur.getMinutes();
    if (!parsed.minutes[minute]) {
      cur.setMinutes(minute + 1, 0, 0);
      continue;
    }

    return new Date(cur.getTime());
  }

  return null;
}

export function getNextCronDate(expr: string, fromDate = new Date()): Date | null {
  const parsed = parseCronExpression(expr);
  if (!parsed.ok) return null;
  return advanceParsedCron(parsed.value, fromDate);
}

export function getNextCronDates(
  expr: string,
  count = 3,
  fromDate = new Date()
): Date[] {
  const parsed = parseCronExpression(expr);
  if (!parsed.ok) return [];
  const cap = Math.min(Math.max(Number(count) || 1, 1), 12);
  const out: Date[] = [];
  let cursor = new Date(fromDate.getTime());
  for (let i = 0; i < cap; i++) {
    const next = advanceParsedCron(parsed.value, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export function describeCronExpression(expr: string): string {
  const parsed = parseCronExpression(expr);
  if (!parsed.ok) return String(expr || "").trim() || "自定义 Cron";
  const [m, h, dom, mon, dow] = parsed.normalized.split(" ");
  const pad2 = (n: string) => String(Number(n)).padStart(2, "0");

  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "每分钟执行";
  }
  const mStep = m.match(/^\*\/(\d+)$/);
  if (mStep && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `每 ${Number(mStep[1])} 分钟`;
  }
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return Number(m) === 0 ? "每小时整点" : `每小时第 ${pad2(m)} 分`;
  }
  const hStep = h.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(m) && hStep && dom === "*" && mon === "*" && dow === "*") {
    return Number(m) === 0
      ? `每 ${Number(hStep[1])} 小时整点`
      : `每 ${Number(hStep[1])} 小时第 ${pad2(m)} 分`;
  }

  if (/^\d+$/.test(m) && /^\d+$/.test(h) && mon === "*") {
    const clock = `${pad2(h)}:${pad2(m)}`;
    if (dom === "*" && dow === "*") {
      return `每天 ${clock}`;
    }
    const domStep = dom.match(/^\*\/(\d+)$/);
    if (domStep && dow === "*") {
      return `每 ${Number(domStep[1])} 天 ${clock}`;
    }
    if (dom === "*") {
      if (dow === "1-5") return `每周一至周五 ${clock}`;
      if (dow === "0,6" || dow === "6,0" || dow === "6-7") return `每周末 ${clock}`;
      if (/^[0-7]$/.test(dow)) {
        const idx = Number(dow) === 7 ? 0 : Number(dow);
        return `每${DOW_LABELS_ZH[idx]} ${clock}`;
      }
      const dowUpper = dow.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(DOW_NAMES, dowUpper)) {
        return `每${DOW_LABELS_ZH[DOW_NAMES[dowUpper]]} ${clock}`;
      }
    }
    if (/^\d+$/.test(dom) && dow === "*") {
      return `每月 ${Number(dom)} 日 ${clock}`;
    }
  }

  return `Cron: ${parsed.normalized}`;
}
