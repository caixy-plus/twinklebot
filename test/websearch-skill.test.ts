import test from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORM_SKILLS,
  isPlatformSkill,
  isBuiltinPlatformSkill,
  isInstallableSkill,
} from "../src/shared/skills-catalog.js";
import {
  buildNeutralUserAgent,
  isSafePublicWebUrl,
  isRealTimeQuery,
  resolveSearchEngineOrder,
  searchWeb,
  fetchWebPage,
  resetSearchReachabilityCacheForTests,
} from "../src/lib/web-search.js";
import {
  BOT_COLLAB_TOOL_DECLARATIONS,
  runBotCollabTool,
} from "../src/agent/bot-tools.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";

test("websearch is registered as a hidden built-in skill in skills catalog", () => {
  const entry = PLATFORM_SKILLS.find((s) => s.id === "websearch");
  assert.ok(entry);
  assert.equal(entry.category, "builtin");
  assert.equal(entry.builtin, true);
  assert.equal(entry.removable, false);
  assert.equal(entry.toolCount, 2);
  assert.equal(isPlatformSkill("websearch"), true);
  assert.equal(isBuiltinPlatformSkill("websearch"), true);
  assert.equal(isInstallableSkill("websearch"), false);
});

test("isSafePublicWebUrl blocks loopback, link-local, RFC1918 private IPs, and non-http schemes", () => {
  assert.equal(isSafePublicWebUrl("https://example.com/news"), true);
  assert.equal(isSafePublicWebUrl("http://docs.python.org/3/"), true);

  for (const unsafe of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://127.0.0.1:3230/api/settings",
    "http://localhost:7300/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.5/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]:3230/api/settings",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[0:0:0:0:0:ffff:192.168.1.1]/",
  ]) {
    assert.equal(isSafePublicWebUrl(unsafe), false, `expected blocked: ${unsafe}`);
  }
});

test("searchWeb routes Google -> Bing -> DuckDuckGo -> Baidu by reachability/proxy, supports freshness & dates, and uses platform-neutral UA", async () => {
  resetSearchReachabilityCacheForTests();

  // Platform-aware UA must not hardcode Macintosh on Windows/Linux
  assert.match(buildNeutralUserAgent("win32"), /Windows NT/);
  assert.ok(!buildNeutralUserAgent("win32").includes("Macintosh"));
  assert.match(buildNeutralUserAgent("linux"), /Linux/);
  assert.ok(!buildNeutralUserAgent("linux").includes("Macintosh"));
  assert.match(buildNeutralUserAgent("darwin"), /Macintosh/);

  // 1. Google reachable -> prioritizes Google and passes tbs=qdr:d freshness param + extracts date
  const googleHtml = `
    <div>
      <a href="/url?q=https%3A%2F%2Fnodejs.org%2Fen&amp;sa=U"><h3>Node.js Official</h3></a>
      <div class="VwiC3b">2026-11-23 — Node.js is a free, open-source JavaScript runtime.</div>
    </div>
  `;
  let capturedGoogleUrl = "";
  const gRes = await searchWeb("nodejs runtime", {
    maxResults: 5,
    freshness: "day",
    googleReachable: true,
    fetchImpl: async (url) => {
      capturedGoogleUrl = String(url);
      return new Response(googleHtml, { status: 200 });
    },
  });
  assert.equal(gRes.ok, true);
  assert.equal(gRes.engine, "google");
  assert.match(capturedGoogleUrl, /google\.com\/search/);
  assert.match(capturedGoogleUrl, /tbs=qdr%3Ad/);
  assert.equal(gRes.results![0].url, "https://nodejs.org/en");
  assert.equal(gRes.results![0].publishedAt, "2026-11-23");
  assert.ok(gRes.fetchedAt);

  // 2. Google blocked/captcha -> automatically falls back to Bing (preferred over DDG/Baidu)
  const bingHtml = `
    <li class="b_algo">
      <h2><a href="https://bing-hit.example.com/post">Bing Result Title</a></h2>
      <div class="b_caption"><p>2 hours ago · Fresh search snippet from Bing.</p></div>
    </li>
  `;
  const fbBing = await searchWeb("比特币 实时价格", {
    googleReachable: true,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("google.com")) {
        return new Response("Our systems have detected unusual traffic", { status: 200 });
      }
      assert.match(u, /bing\.com\/search/);
      assert.match(u, /filters=/);
      return new Response(bingHtml, { status: 200 });
    },
  });
  assert.equal(fbBing.ok, true);
  assert.equal(fbBing.engine, "bing");
  assert.equal(fbBing.freshness, "day");
  assert.ok(fbBing.freshnessNote && fbBing.freshnessNote.includes("web_fetch"));
  assert.equal(isRealTimeQuery("比特币 实时价格"), true);
  assert.equal(fbBing.results![0].url, "https://bing-hit.example.com/post");
  assert.equal(fbBing.results![0].publishedAt, "2 hours ago");

  // 3. No proxy / domestic direct (hasProxy: false) -> skips Google, tries Bing -> DuckDuckGo -> Baidu
  const visitedDirect: string[] = [];
  const ddgHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen&amp;rut=1">Node.js Official</a>
      <a class="result__snippet">Node.js is a free, open-source JavaScript runtime.</a>
    </div>
  `;
  const ddgFallback = await searchWeb("nodejs runtime", {
    hasProxy: false,
    fetchImpl: async (url) => {
      const u = String(url);
      visitedDirect.push(u);
      if (u.includes("bing.com")) return new Response("blocked", { status: 403 });
      return new Response(ddgHtml, { status: 200 });
    },
  });
  assert.equal(ddgFallback.ok, true);
  assert.equal(ddgFallback.engine, "duckduckgo");
  assert.ok(visitedDirect.every((u) => !u.includes("google.com")), "no-proxy must skip Google");
  assert.equal(ddgFallback.results![0].url, "https://nodejs.org/en");

  // 4. All international engines fail -> falls back to Baidu as final engine
  const baiduHtml = `
    <div class="result c-container">
      <h3><a href="https://example.cn/news/1">国内资讯标题</a></h3>
      <span class="c-color-gray2">2026年11月23日</span>
      <span class="content-right_8Zs40">百度兜底摘要内容。</span>
    </div>
  `;
  const baiduRes = await searchWeb("国内新闻", {
    hasProxy: false,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("baidu.com")) return new Response(baiduHtml, { status: 200 });
      return new Response("timeout", { status: 503 });
    },
  });
  assert.equal(baiduRes.ok, true);
  assert.equal(baiduRes.engine, "baidu");
  assert.equal(baiduRes.results![0].title, "国内资讯标题");
  assert.equal(baiduRes.results![0].publishedAt, "2026年11月23日");
});

test("fetchWebPage extracts title and readable text while stripping scripts/styles and guarding SSRF", async () => {
  const blocked = await fetchWebPage("http://127.0.0.1:3230/api/settings");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /unsafe|blocked|private/i);

  const html = `
    <html>
      <head>
        <title>Test Article &amp; Notes</title>
        <style>body { color: red; }</style>
        <script>console.log("secret");</script>
      </head>
      <body>
        <h1>Main Heading</h1>
        <p>Hello world from TwinkleBot websearch.</p>
      </body>
    </html>
  `;
  const okRes = await fetchWebPage("https://example.com/article", {
    maxChars: 2000,
    fetchImpl: async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.title, "Test Article & Notes");
  assert.match(okRes.content!, /Main Heading/);
  assert.match(okRes.content!, /Hello world from TwinkleBot websearch/);
  assert.ok(!okRes.content!.includes("console.log"));
  assert.ok(!okRes.content!.includes("color: red"));

  // Redirect SSRF guard: 302 redirect from public URL to 127.0.0.1 must be blocked!
  const redirectBlocked = await fetchWebPage("https://example.com/jump", {
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:3230/api/settings" },
      }),
  });
  assert.equal(redirectBlocked.ok, false);
  assert.match(redirectBlocked.error!, /unsafe redirect|blocked/i);

  // Binary Content-Type rejection + out-of-range numeric HTML entity resilience (no RangeError)
  const pdfBlocked = await fetchWebPage("https://example.com/file.pdf", {
    fetchImpl: async () =>
      new Response("binary", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
  });
  assert.equal(pdfBlocked.ok, false);
  assert.match(pdfBlocked.error!, /binary content-type/i);

  const entityRes = await fetchWebPage("https://example.com/entities", {
    fetchImpl: async () =>
      new Response("<html><title>Bad &#9999999; &#xFFFFFF; Entity</title><body>Safe text &#65;</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  });
  assert.equal(entityRes.ok, true);
  assert.match(entityRes.content!, /Safe text A/);
});

test("BOT_COLLAB_TOOL_DECLARATIONS, runBotCollabTool, and prompt expose web_search and web_fetch", async () => {
  const names = BOT_COLLAB_TOOL_DECLARATIONS.map((d) => d.name);
  assert.ok(names.includes("web_search"));
  assert.ok(names.includes("web_fetch"));

  const searchRes = await runBotCollabTool(
    "web_search",
    { query: "twinklebot" },
    {
      fetchImpl: async () =>
        new Response(
          `<a class="result__a" href="https://example.com">Example</a><a class="result__snippet">Demo</a>`,
          { status: 200 }
        ),
    }
  );
  assert.equal(searchRes.ok, true);
  assert.equal(searchRes.results[0].url, "https://example.com/");

  const fetchRes = await runBotCollabTool(
    "web_fetch",
    { url: "https://example.com" },
    {
      fetchImpl: async () =>
        new Response("<html><title>Ex</title><body>Hi there</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    }
  );
  assert.equal(fetchRes.ok, true);
  assert.match(fetchRes.content, /Hi there/);

  const sys = buildSystemInstruction({ enableBotTools: true, installedSkills: [] });
  assert.match(sys, /web_search/);
  assert.match(sys, /web_fetch/);
});

test("Phase 3 P2-3: Chinese freshness search prefers baidu when Google unreachable and demotes static encyclopedias", async () => {
  resetSearchReachabilityCacheForTests();
  const zhOrder = await resolveSearchEngineOrder({
    googleReachable: false,
    query: "今日黄金价格走势",
    freshness: "day",
  });
  assert.deepEqual(zhOrder, ["baidu", "bing", "duckduckgo"]);

  const enOrder = await resolveSearchEngineOrder({
    googleReachable: false,
    query: "nodejs runtime",
  });
  assert.deepEqual(enOrder, ["bing", "duckduckgo", "baidu"]);

  const baiduHtmlWithBaikeFirst = `
    <div class="result c-container">
      <h3><a href="https://baike.baidu.com/item/黄金">黄金_百度百科</a></h3>
      <span class="content-right_8Zs40">静态词条介绍内容。</span>
    </div>
    <div class="result c-container">
      <h3><a href="https://news.example.com/gold-2026">2026年11月27日现货黄金最新报价</a></h3>
      <span class="c-color-gray2">2026年11月27日</span>
      <span class="content-right_8Zs40">今日国际金价最新实时行情。</span>
    </div>
  `;
  const hitUrls: string[] = [];
  const res = await searchWeb("今日黄金价格", {
    googleReachable: false,
    freshness: "day",
    fetchImpl: async (url) => {
      const u = String(url);
      hitUrls.push(u);
      if (u.includes("baidu.com")) return new Response(baiduHtmlWithBaikeFirst, { status: 200 });
      return new Response("unexpected", { status: 503 });
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.engine, "baidu");
  assert.equal(hitUrls.length, 1);
  assert.equal(res.results![0].url, "https://news.example.com/gold-2026");
  assert.equal(res.results![1].url, "https://baike.baidu.com/item/黄金");
});
