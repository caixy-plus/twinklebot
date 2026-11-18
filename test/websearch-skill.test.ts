import test from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORM_SKILLS,
  isPlatformSkill,
  isBuiltinPlatformSkill,
  isInstallableSkill,
} from "../src/shared/skills-catalog.js";
import {
  isSafePublicWebUrl,
  searchWeb,
  fetchWebPage,
} from "../src/lib/web-search.js";
import {
  BOT_COLLAB_TOOL_DECLARATIONS,
  runBotCollabTool,
} from "../src/agent/bot-tools.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";

test("websearch is registered as a built-in platform skill in skills catalog", () => {
  const entry = PLATFORM_SKILLS.find((s) => s.id === "websearch");
  assert.ok(entry);
  assert.equal(entry.category, "platform");
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
  ]) {
    assert.equal(isSafePublicWebUrl(unsafe), false, `expected blocked: ${unsafe}`);
  }
});

test("searchWeb parses DuckDuckGo HTML redirect links and falls back to Bing on empty/error", async () => {
  const ddgHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen&amp;rut=1">Node.js Official</a>
      <a class="result__snippet">Node.js is a free, open-source JavaScript runtime.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.org/guide">Guide &amp; Docs</a>
      <span class="result__snippet">Complete <b>reference</b> guide.</span>
    </div>
  `;
  const res = await searchWeb("nodejs runtime", {
    maxResults: 5,
    fetchImpl: async (url) => {
      assert.match(String(url), /duckduckgo\.com/);
      return new Response(ddgHtml, { status: 200 });
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.engine, "duckduckgo");
  assert.equal(res.results!.length, 2);
  assert.equal(res.results![0].title, "Node.js Official");
  assert.equal(res.results![0].url, "https://nodejs.org/en");
  assert.match(res.results![0].snippet, /JavaScript runtime/);
  assert.equal(res.results![1].title, "Guide & Docs");
  assert.equal(res.results![1].snippet, "Complete reference guide.");

  // Fallback to Bing when DuckDuckGo fails
  const bingHtml = `
    <li class="b_algo">
      <h2><a href="https://bing-hit.example.com/post">Bing Result Title</a></h2>
      <div class="b_caption"><p>Fresh search snippet from Bing.</p></div>
    </li>
  `;
  const fbRes = await searchWeb("test fallback", {
    fetchImpl: async (url) => {
      if (String(url).includes("duckduckgo.com")) {
        return new Response("blocked", { status: 403 });
      }
      return new Response(bingHtml, { status: 200 });
    },
  });
  assert.equal(fbRes.ok, true);
  assert.equal(fbRes.engine, "bing");
  assert.equal(fbRes.results!.length, 1);
  assert.equal(fbRes.results![0].url, "https://bing-hit.example.com/post");
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
