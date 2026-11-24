export type SearchEngine = "google" | "bing" | "duckduckgo" | "baidu";
export type SearchFreshness = "day" | "week" | "month" | "year";

export function buildNeutralUserAgent(platform: string = process.platform): string {
  if (platform === "win32") {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
  if (platform === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
  return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface SearchWebResponse {
  ok: boolean;
  query?: string;
  engine?: SearchEngine;
  attemptedEngines?: SearchEngine[];
  freshness?: SearchFreshness;
  fetchedAt?: string;
  freshnessNote?: string;
  results?: WebSearchResult[];
  error?: string;
}

export interface FetchWebPageResponse {
  ok: boolean;
  url?: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
}

const GOOGLE_PROBE_TTL_MS = 5 * 60 * 1000;
let googleProbeCache: { reachable: boolean; checkedAt: number } | null = null;

export function resetSearchReachabilityCacheForTests(): void {
  googleProbeCache = null;
}

export function detectProxyConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  const keys = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ];
  return keys.some((k) => Boolean(String(env?.[k] || "").trim()));
}

const REALTIME_QUERY_RE =
  /(实时|最新价格|当前价格|今日报价|现价|股价|币价|比特币.*价格|以太坊.*价格|汇率|实时天气|今日天气|比分|开奖|live\s+price|real[-\s]?time|current\s+price|stock\s+price|exchange\s+rate|weather\s+today|btc\s+price|eth\s+price|bitcoin\s+price)/i;

export function isRealTimeQuery(query = ""): boolean {
  return REALTIME_QUERY_RE.test(String(query || ""));
}

function normalizeFreshness(raw?: unknown): SearchFreshness | undefined {
  const val = String(raw || "").trim().toLowerCase();
  if (val === "day" || val === "d" || val === "24h" || val === "today") return "day";
  if (val === "week" || val === "w" || val === "7d") return "week";
  if (val === "month" || val === "m" || val === "30d") return "month";
  if (val === "year" || val === "y" || val === "365d") return "year";
  return undefined;
}

function decodeHtmlEntities(str = ""): string {
  return String(str || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function stripTags(html = ""): string {
  return decodeHtmlEntities(String(html || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const DATE_HINT_RE =
  /(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d+\s*(?:minutes?|hours?|days?|weeks?|months?)\s+ago|\d+\s*(?:分钟|小时|天|周|个月)前|昨天|前天|刚刚)/i;

export function extractDateHint(raw = ""): string | undefined {
  const text = stripTags(raw);
  if (!text) return undefined;
  const m = text.match(DATE_HINT_RE);
  return m ? m[1].trim() : undefined;
}

function isPrivateIpv4(host = ""): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function isSafePublicWebUrl(rawUrl = ""): boolean {
  const s = String(rawUrl || "").trim();
  if (!s) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "::" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    isPrivateIpv4(host)
  ) {
    return false;
  }
  return true;
}

function unwrapGoogleHref(rawHref = ""): string {
  const clean = decodeHtmlEntities(String(rawHref || "").trim());
  if (!clean) return "";
  try {
    const full = clean.startsWith("/") ? `https://www.google.com${clean}` : clean;
    const u = new URL(full);
    if (u.hostname.includes("google.") && u.pathname === "/url") {
      const target = u.searchParams.get("q") || u.searchParams.get("url") || "";
      return isSafePublicWebUrl(target) ? target : "";
    }
    if (u.hostname.includes("google.") && (u.pathname.startsWith("/search") || u.pathname.startsWith("/imgres"))) {
      return "";
    }
    return isSafePublicWebUrl(u.toString()) ? u.toString() : "";
  } catch {
    return "";
  }
}

export function parseGoogleHtml(html = "", maxResults = 6): WebSearchResult[] {
  const src = String(html || "");
  if (
    /detected unusual traffic|\/sorry\/index|g-recaptcha|id="captcha-form"|Please click here if you are not redirected/i.test(
      src
    )
  ) {
    return [];
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  // Pattern 1: Standard desktop/basic Google results (`<a href="/url?q=..."><h3 ...>Title</h3></a>` or `<h3><a ...>`)
  const blockPatterns = [
    /<a\b[^>]*href="([^"]*\/url\?[^"]*q=https?[^"]+)"[^>]*>[\s\S]*?(?:<h3[^>]*>([\s\S]*?)<\/h3>|<div\b[^>]*class="[^"]*BNeawe[^"]*vvjwJb[^"]*"[^>]*>([\s\S]*?)<\/div>)[\s\S]*?<\/a>/gi,
    /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<\/a>/gi,
  ];

  for (const re of blockPatterns) {
    for (const m of src.matchAll(re)) {
      if (results.length >= maxResults) break;
      const url = unwrapGoogleHref(m[1]);
      const title = stripTags(m[2] || m[3] || "");
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const tailWindow = src.slice((m.index || 0) + m[0].length, (m.index || 0) + m[0].length + 1400);
      const snipMatch =
        tailWindow.match(/<div\b[^>]*class="[^"]*(?:VwiC3b|BNeawe\s+s3v9rd|s3v9rd)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
        tailWindow.match(/<span\b[^>]*class="[^"]*(?:aCOpRe|st)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const snippet = snipMatch ? stripTags(snipMatch[1]).slice(0, 320) : "";
      const publishedAt = extractDateHint(snippet || tailWindow.slice(0, 300));
      results.push({
        title,
        url,
        snippet,
        ...(publishedAt ? { publishedAt } : {}),
      });
    }
    if (results.length >= maxResults) break;
  }

  return results;
}

function unwrapDuckDuckGoHref(rawHref = ""): string {
  const clean = decodeHtmlEntities(String(rawHref || "").trim());
  if (!clean) return "";
  const full = clean.startsWith("//") ? `https:${clean}` : clean;
  try {
    const u = new URL(full);
    const uddg = u.searchParams.get("uddg");
    if (u.hostname.includes("duckduckgo.com") && uddg) {
      return isSafePublicWebUrl(uddg) ? uddg : "";
    }
    return isSafePublicWebUrl(u.toString()) ? u.toString() : "";
  } catch {
    return "";
  }
}

export function parseDuckDuckGoHtml(html = "", maxResults = 6): WebSearchResult[] {
  const src = String(html || "");
  if (/anomaly-modal|Unfortunately, bots use DuckDuckGo|challenge-form/i.test(src)) {
    return [];
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const linkRe =
    /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<(?:a|span|div)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gi;

  const links = [...src.matchAll(linkRe)];
  const snippets = [...src.matchAll(snippetRe)];

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const url = unwrapDuckDuckGoHref(links[i][1]);
    const title = stripTags(links[i][2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const snippet = snippets[i] ? stripTags(snippets[i][1]) : "";
    const publishedAt = extractDateHint(snippet);
    results.push({
      title,
      url,
      snippet,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return results;
}

export function parseBingHtml(html = "", maxResults = 6): WebSearchResult[] {
  const src = String(html || "");
  if (/id="b_captcha"|class="[^"]*captcha[^"]*"/i.test(src)) {
    return [];
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const blockRe = /<li\b[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const m of src.matchAll(blockRe)) {
    if (results.length >= maxResults) break;
    const block = m[1];
    const linkMatch = block.match(/<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeHtmlEntities(linkMatch[1].trim());
    const title = stripTags(linkMatch[2]);
    if (!isSafePublicWebUrl(url) || !title || seen.has(url)) continue;
    seen.add(url);
    const capMatch =
      block.match(/<div\b[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const dateMatch = block.match(/<span\b[^>]*class="[^"]*(?:news_dt|b_factrow)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const snippet = capMatch ? stripTags(capMatch[1]) : "";
    const publishedAt = extractDateHint(dateMatch ? dateMatch[1] : snippet);
    results.push({
      title,
      url,
      snippet,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return results;
}

export function parseBaiduHtml(html = "", maxResults = 6): WebSearchResult[] {
  const src = String(html || "");
  if (/wappass\.baidu\.com|百度安全验证|sec_captcha/i.test(src)) {
    return [];
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const containerRe =
    /<div\b[^>]*class="[^"]*\b(?:result|result-op)\b[^"]*\bc-container\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*class="[^"]*\b(?:result|result-op)\b[^"]*\bc-container\b|<div\s+id="page"|$)/gi;

  for (const m of src.matchAll(containerRe)) {
    if (results.length >= maxResults) break;
    const block = m[1];
    const linkMatch = block.match(/<h3[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i);
    if (!linkMatch) continue;
    let url = decodeHtmlEntities(linkMatch[1].trim());
    if (url.startsWith("//")) url = `https:${url}`;
    const title = stripTags(linkMatch[2]);
    if (!isSafePublicWebUrl(url) || !title || seen.has(url)) continue;
    seen.add(url);
    const snipMatch =
      block.match(/<span\b[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
      block.match(/<div\b[^>]*class="[^"]*(?:c-abstract|c-span-last)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const dateMatch = block.match(/<span\b[^>]*class="[^"]*c-color-gray2[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]).slice(0, 320) : "";
    const publishedAt = extractDateHint(dateMatch ? dateMatch[1] : snippet);
    results.push({
      title,
      url,
      snippet,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return results;
}

export async function probeGoogleReachability({
  fetchImpl = fetch,
  timeoutMs = 2500,
  forceRefresh = false,
  signal,
  env = process.env,
}: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
} = {}): Promise<boolean> {
  const isDefaultFetch = fetchImpl === fetch;
  if (
    isDefaultFetch &&
    !forceRefresh &&
    googleProbeCache &&
    Date.now() - googleProbeCache.checkedAt < GOOGLE_PROBE_TTL_MS
  ) {
    return googleProbeCache.reachable;
  }

  const probeTimeout = Math.min(Math.max(Number(timeoutMs) || 2500, 300), 6000);
  const timeoutSig =
    typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(probeTimeout) : null;
  const combinedSignal =
    signal && timeoutSig && typeof AbortSignal?.any === "function"
      ? AbortSignal.any([signal, timeoutSig])
      : signal || timeoutSig;

  let reachable = false;
  try {
    const res = await fetchImpl("https://www.google.com/generate_204", {
      method: "HEAD",
      headers: {
        "User-Agent": buildNeutralUserAgent(),
      },
      ...(combinedSignal ? { signal: combinedSignal } : {}),
    });
    reachable = res.status === 204 || res.status === 200;
  } catch {
    reachable = false;
  }

  // If no proxy is configured and probe failed, cache quickly so domestic direct users skip Google
  void env;
  if (isDefaultFetch) {
    googleProbeCache = { reachable, checkedAt: Date.now() };
  }
  return reachable;
}

function buildEngineUrl(
  engine: SearchEngine,
  query: string,
  freshness?: SearchFreshness
): string {
  const q = encodeURIComponent(query);
  if (engine === "google") {
    const tbsMap: Record<SearchFreshness, string> = {
      day: "qdr:d",
      week: "qdr:w",
      month: "qdr:m",
      year: "qdr:y",
    };
    const tbs = freshness ? `&tbs=${encodeURIComponent(tbsMap[freshness])}` : "";
    return `https://www.google.com/search?q=${q}&gbv=1&hl=zh-CN&num=10${tbs}`;
  }
  if (engine === "bing") {
    const ezMap: Record<SearchFreshness, string> = {
      day: 'ex1:"ez1"',
      week: 'ex1:"ez2"',
      month: 'ex1:"ez3"',
      year: 'ex1:"ez5_365"',
    };
    const filters = freshness ? `&filters=${encodeURIComponent(ezMap[freshness])}` : "";
    return `https://www.bing.com/search?q=${q}${filters}`;
  }
  if (engine === "duckduckgo") {
    const dfMap: Record<SearchFreshness, string> = {
      day: "d",
      week: "w",
      month: "m",
      year: "y",
    };
    const df = freshness ? `&df=${dfMap[freshness]}` : "";
    return `https://html.duckduckgo.com/html/?q=${q}${df}`;
  }
  // baidu
  let gpc = "";
  if (freshness) {
    const nowSec = Math.floor(Date.now() / 1000);
    const spanMap: Record<SearchFreshness, number> = {
      day: 86400,
      week: 7 * 86400,
      month: 30 * 86400,
      year: 365 * 86400,
    };
    const startSec = nowSec - spanMap[freshness];
    gpc = `&gpc=${encodeURIComponent(`stf=${startSec},${nowSec}|stftype=1`)}`;
  }
  return `https://www.baidu.com/s?wd=${q}&rn=10${gpc}`;
}

function parseEngineHtml(
  engine: SearchEngine,
  html: string,
  limit: number
): WebSearchResult[] {
  switch (engine) {
    case "google":
      return parseGoogleHtml(html, limit);
    case "bing":
      return parseBingHtml(html, limit);
    case "duckduckgo":
      return parseDuckDuckGoHtml(html, limit);
    case "baidu":
      return parseBaiduHtml(html, limit);
  }
}

export async function resolveSearchEngineOrder({
  engines,
  googleReachable,
  hasProxy,
  fetchImpl = fetch,
  probeTimeoutMs = 2500,
  signal,
  env = process.env,
}: {
  engines?: SearchEngine[];
  googleReachable?: boolean;
  hasProxy?: boolean;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
} = {}): Promise<SearchEngine[]> {
  if (Array.isArray(engines) && engines.length > 0) {
    const valid: SearchEngine[] = [];
    for (const eng of engines) {
      if (
        (eng === "google" || eng === "bing" || eng === "duckduckgo" || eng === "baidu") &&
        !valid.includes(eng)
      ) {
        valid.push(eng);
      }
    }
    if (valid.length > 0) return valid;
  }

  let canReachGoogle: boolean;
  if (typeof googleReachable === "boolean") {
    canReachGoogle = googleReachable;
  } else if (hasProxy === false) {
    canReachGoogle = false;
  } else {
    canReachGoogle = await probeGoogleReachability({
      fetchImpl,
      timeoutMs: probeTimeoutMs,
      signal,
      env,
    });
  }

  // Priority: Google (when reachable) -> Bing -> DuckDuckGo -> Baidu (Bing always preferred over Baidu)
  return canReachGoogle
    ? ["google", "bing", "duckduckgo", "baidu"]
    : ["bing", "duckduckgo", "baidu"];
}

export async function searchWeb(
  query = "",
  {
    maxResults = 6,
    freshness,
    engines,
    googleReachable,
    hasProxy,
    fetchImpl = fetch,
    timeoutMs = 12_000,
    probeTimeoutMs = 2500,
    signal,
    platform = process.platform,
    env = process.env,
  }: {
    maxResults?: number;
    freshness?: SearchFreshness | string;
    engines?: SearchEngine[];
    googleReachable?: boolean;
    hasProxy?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    probeTimeoutMs?: number;
    signal?: AbortSignal;
    platform?: string;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<SearchWebResponse> {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return { ok: false, error: "web_search requires a non-empty query" };
  }
  const limit = Math.min(Math.max(Number(maxResults) || 6, 1), 10);
  const realtime = isRealTimeQuery(cleanQuery);
  const effectiveFreshness = normalizeFreshness(freshness) || (realtime ? "day" : undefined);
  const fetchedAt = new Date().toISOString();
  const freshnessNote = realtime
    ? "注意：检测到强时效/实时类查询，搜索结果摘要可能存在缓存延迟；请优先调用 web_fetch 读取权威来源页面的最新数据再给出最终数值，勿直接将旧摘要当作实时值。"
    : undefined;

  const engineOrder = await resolveSearchEngineOrder({
    engines,
    googleReachable,
    hasProxy,
    fetchImpl,
    probeTimeoutMs,
    signal,
    env,
  });

  const headers = {
    "User-Agent": buildNeutralUserAgent(platform),
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };

  const attemptedEngines: SearchEngine[] = [];
  const errors: string[] = [];

  for (const engine of engineOrder) {
    attemptedEngines.push(engine);
    const perEngineTimeout = Math.min(timeoutMs, engine === "google" ? 6000 : timeoutMs);
    const timeoutSig =
      typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(perEngineTimeout) : null;
    const combinedSignal =
      signal && timeoutSig && typeof AbortSignal?.any === "function"
        ? AbortSignal.any([signal, timeoutSig])
        : signal || timeoutSig;

    try {
      const targetUrl = buildEngineUrl(engine, cleanQuery, effectiveFreshness);
      const res = await fetchImpl(targetUrl, {
        method: "GET",
        headers,
        ...(combinedSignal ? { signal: combinedSignal } : {}),
      });
      if (!res.ok) {
        errors.push(`${engine}: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const results = parseEngineHtml(engine, html, limit);
      if (results.length > 0) {
        return {
          ok: true,
          query: cleanQuery,
          engine,
          attemptedEngines,
          ...(effectiveFreshness ? { freshness: effectiveFreshness } : {}),
          fetchedAt,
          ...(freshnessNote ? { freshnessNote } : {}),
          results,
        };
      }
      errors.push(`${engine}: empty`);
    } catch (err: any) {
      errors.push(`${engine}: ${err?.message || "network error"}`);
    }
  }

  return {
    ok: false,
    query: cleanQuery,
    attemptedEngines,
    ...(effectiveFreshness ? { freshness: effectiveFreshness } : {}),
    fetchedAt,
    error: `Search failed (${errors.join(", ") || "no results"})`,
  };
}

export async function fetchWebPage(
  rawUrl = "",
  {
    maxChars = 12_000,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    signal,
    platform = process.platform,
  }: {
    maxChars?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
    platform?: string;
  } = {}
): Promise<FetchWebPageResponse> {
  const url = String(rawUrl || "").trim();
  if (!isSafePublicWebUrl(url)) {
    return {
      ok: false,
      error: "Blocked unsafe or private URL: only public http(s) URLs are allowed",
    };
  }
  const limit = Math.min(Math.max(Number(maxChars) || 12_000, 500), 40_000);
  const timeoutSig =
    typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  const combinedSignal =
    signal && timeoutSig && typeof AbortSignal?.any === "function"
      ? AbortSignal.any([signal, timeoutSig])
      : signal || timeoutSig;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": buildNeutralUserAgent(platform),
        Accept: "text/html,application/xhtml+xml,text/plain,application/json",
      },
      ...(combinedSignal ? { signal: combinedSignal } : {}),
    });
    if (!res.ok) {
      return { ok: false, url, error: `HTTP ${res.status}` };
    }
    const contentType = String(res.headers?.get?.("content-type") || "").toLowerCase();
    const rawText = await res.text();

    let title = "";
    let bodyText = "";
    if (
      contentType.includes("json") ||
      contentType.includes("text/plain") ||
      !/<html|<body/i.test(rawText)
    ) {
      bodyText = rawText.trim();
    } else {
      const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? stripTags(titleMatch[1]) : "";
      const cleaned = rawText
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n");
      bodyText = decodeHtmlEntities(cleaned.replace(/<[^>]+>/g, " "))
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const truncated = bodyText.length > limit;
    return {
      ok: true,
      url: res.url || url,
      title,
      content: truncated ? `${bodyText.slice(0, limit)}\n...[truncated]` : bodyText,
      truncated,
    };
  } catch (err: any) {
    return { ok: false, url, error: err?.message || "fetch failed" };
  }
}
