const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchWebResponse {
  ok: boolean;
  query?: string;
  engine?: "duckduckgo" | "bing";
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

function unwrapDuckDuckGoHref(rawHref = ""): string {
  const clean = decodeHtmlEntities(String(rawHref || "").trim());
  if (!clean) return "";
  const full = clean.startsWith("//") ? `https:${clean}` : clean;
  try {
    const u = new URL(full);
    const uddg = u.searchParams.get("uddg");
    if (u.hostname.includes("duckduckgo.com") && uddg) {
      return uddg;
    }
    return u.toString();
  } catch {
    return "";
  }
}

export function parseDuckDuckGoHtml(html = "", maxResults = 6): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const linkRe =
    /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<(?:a|span|div)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gi;

  const links = [...String(html || "").matchAll(linkRe)];
  const snippets = [...String(html || "").matchAll(snippetRe)];

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const url = unwrapDuckDuckGoHref(links[i][1]);
    const title = stripTags(links[i][2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const snippet = snippets[i] ? stripTags(snippets[i][1]) : "";
    results.push({ title, url, snippet });
  }
  return results;
}

export function parseBingHtml(html = "", maxResults = 6): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const blockRe = /<li\b[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const m of String(html || "").matchAll(blockRe)) {
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
    const snippet = capMatch ? stripTags(capMatch[1]) : "";
    results.push({ title, url, snippet });
  }
  return results;
}

export async function searchWeb(
  query = "",
  {
    maxResults = 6,
    fetchImpl = fetch,
    timeoutMs = 12_000,
    signal,
  }: {
    maxResults?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<SearchWebResponse> {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return { ok: false, error: "web_search requires a non-empty query" };
  }
  const limit = Math.min(Math.max(Number(maxResults) || 6, 1), 10);

  const timeoutSig =
    typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  const combinedSignal =
    signal && timeoutSig && typeof AbortSignal?.any === "function"
      ? AbortSignal.any([signal, timeoutSig])
      : signal || timeoutSig;

  const headers = {
    "User-Agent": DEFAULT_UA,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };

  let ddgError: string | null = null;
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
    const res = await fetchImpl(ddgUrl, {
      method: "GET",
      headers,
      ...(combinedSignal ? { signal: combinedSignal } : {}),
    });
    if (res.ok) {
      const html = await res.text();
      const results = parseDuckDuckGoHtml(html, limit);
      if (results.length > 0) {
        return { ok: true, query: cleanQuery, engine: "duckduckgo", results };
      }
    } else {
      ddgError = `HTTP ${res.status}`;
    }
  } catch (err: any) {
    ddgError = err?.message || String(err);
  }

  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(cleanQuery)}`;
    const res = await fetchImpl(bingUrl, {
      method: "GET",
      headers,
      ...(combinedSignal ? { signal: combinedSignal } : {}),
    });
    if (res.ok) {
      const html = await res.text();
      const results = parseBingHtml(html, limit);
      return { ok: true, query: cleanQuery, engine: "bing", results };
    }
    return {
      ok: false,
      query: cleanQuery,
      error: `Search failed (duckduckgo: ${ddgError || "empty"}, bing: HTTP ${res.status})`,
    };
  } catch (err: any) {
    return {
      ok: false,
      query: cleanQuery,
      error: `Search failed: ${err?.message || ddgError || "network error"}`,
    };
  }
}

export async function fetchWebPage(
  rawUrl = "",
  {
    maxChars = 12_000,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    signal,
  }: {
    maxChars?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
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
        "User-Agent": DEFAULT_UA,
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
