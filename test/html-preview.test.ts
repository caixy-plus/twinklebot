import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectPreviewableMarkup,
  extractMessageSegments,
  splitIntoMessageChunksWithMarkup,
  buildPreviewSrcdoc,
} from "../public/dist/preview-utils.js";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";

test("detectPreviewableMarkup identifies html, htm, svg, xml-svg, and unlabeled markup while rejecting code langs", () => {
  assert.deepEqual(detectPreviewableMarkup("<div>Hello</div>", "html"), {
    previewable: true,
    kind: "html",
    badgeLabel: "HTML 预览",
    lang: "html",
  });

  assert.deepEqual(detectPreviewableMarkup("<h1>Legacy HTM</h1>", "htm"), {
    previewable: true,
    kind: "html",
    badgeLabel: "HTM 预览",
    lang: "htm",
  });

  assert.deepEqual(
    detectPreviewableMarkup('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>', "svg"),
    {
      previewable: true,
      kind: "svg",
      badgeLabel: "SVG 预览",
      lang: "svg",
    }
  );

  assert.deepEqual(
    detectPreviewableMarkup(
      '<?xml version="1.0"?><svg viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>',
      "xml"
    ),
    {
      previewable: true,
      kind: "svg",
      badgeLabel: "SVG 预览",
      lang: "svg",
    }
  );

  // Unlabeled code fence with valid HTML or SVG
  assert.equal(detectPreviewableMarkup("<div class='box'><p>Hi</p></div>", "").previewable, true);
  assert.equal(
    detectPreviewableMarkup('<svg width="40" height="40"><rect width="40" height="40"/></svg>', "")
      .kind,
    "svg"
  );

  // Non-previewable languages must stay as code blocks
  assert.equal(detectPreviewableMarkup("const el = <div>Hello</div>;", "jsx").previewable, false);
  assert.equal(detectPreviewableMarkup("const x: Array<string> = [];", "ts").previewable, false);
  assert.equal(detectPreviewableMarkup(".card { color: red; }", "css").previewable, false);
});

test("extractMessageSegments parses unfenced raw HTML, pure HTM fragments (<style>+<div>+<script>), and raw SVG", () => {
  const mixedText = [
    "下面是一段纯 HTM 交互片段：",
    "",
    "<style>",
    "  .demo-card { padding: 14px; background: #eff6ff; border-radius: 12px; }",
    "</style>",
    "",
    '<div class="demo-card">',
    "  <h3>纯 HTM 卡片</h3>",
    '  <button id="btn">点击计数</button>',
    "</div>",
    "<script>",
    "  for (let i = 0; i < 3; i++) { console.log(i); }",
    "</script>",
    "",
    "再附带一个纯 SVG 图标片段：",
    "",
    '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">',
    "",
    '  <circle cx="60" cy="60" r="48" fill="#10b981" />',
    "</svg>",
    "",
    "提示：日常正文中提到 <div> 标签不会被误判为预览卡片。",
  ].join("\n");

  const segs: any[] = extractMessageSegments(mixedText);
  assert.equal(segs.length, 5);
  assert.equal(segs[0].type, "prose");
  assert.match(segs[0].text, /纯 HTM 交互片段/);

  // <style> + <div> + <script> merged into ONE single HTML preview segment
  assert.equal(segs[1].type, "raw_markup");
  assert.equal(segs[1].kind, "html");
  assert.match(segs[1].code, /<style>/);
  assert.match(segs[1].code, /demo-card/);
  assert.match(segs[1].code, /i < 3/);

  assert.equal(segs[2].type, "prose");
  assert.equal(segs[3].type, "raw_markup");
  assert.equal(segs[3].kind, "svg");
  assert.match(segs[3].code, /<circle/);

  assert.equal(segs[4].type, "prose");
  assert.match(segs[4].text, /提到 <div> 标签/);
});

test("splitIntoMessageChunksWithMarkup keeps unfenced HTML and SVG blocks with blank lines atomic", () => {
  const botReply = [
    "已为你生成徽章：",
    "",
    '<svg viewBox="0 0 100 40">',
    "",
    '  <rect width="100" height="40" rx="8" fill="#3b82f6"/>',
    "</svg>",
    "",
    "需要调整配色请随时告诉我。",
  ].join("\n");

  const chunks = splitIntoMessageChunksWithMarkup(botReply);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0], "已为你生成徽章：");
  assert.match(chunks[1], /^<svg[\s\S]*<\/svg>$/);
  assert.equal(chunks[2], "需要调整配色请随时告诉我。");
});

test("buildPreviewSrcdoc wraps HTML fragments, full HTML docs, and SVGs with resize postMessage", () => {
  const svgDoc = buildPreviewSrcdoc('<svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg>', {
    kind: "svg",
    instanceId: "gb-prev-1",
    canvasBg: "grid",
  });
  assert.match(svgDoc, /<!DOCTYPE html>/i);
  assert.match(svgDoc, /class="svg-stage"/);
  assert.match(svgDoc, /__twinklebotPreviewResize/);
  assert.match(svgDoc, /gb-prev-1/);

  const fullDoc = buildPreviewSrcdoc("<!doctype html><html><head></head><body><h1>Hi</h1></body></html>", {
    kind: "html",
    instanceId: "gb-prev-2",
  });
  assert.match(fullDoc, /<meta charset="utf-8">/i);
  assert.match(fullDoc, /<h1>Hi<\/h1>/);
  assert.match(fullDoc, /gb-prev-2/);
});

test("server serves .htm MIME type and applies sandbox CSP header on /api/workspace/file for html/htm/svg", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-html-prev-"));
  const store = createStore(tmpDir);
  const sampleHtm = path.join(tmpDir, "widget.htm");
  fs.writeFileSync(sampleHtm, "<div>Pure HTM File</div>", "utf8");

  const srv = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      geminiApiKey: "k",
      executorUrl: "http://ubuntu.orb.local:7300",
      executorToken: "t",
      novncUrl: "http://ubuntu.orb.local:6080/vnc.html",
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
      maxSteps: 60,
      keepScreenshots: 3,
      shellTimeoutSec: 120,
      screen: { width: 1440, height: 900 },
      writeRoots: [tmpDir],
      dataDir: tmpDir,
    },
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle", activeSessions: {} }),
      subscribe: () => () => {},
    },
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as any;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/workspace/file?path=${encodeURIComponent(sampleHtm)}`
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      res.headers.get("content-security-policy"),
      "sandbox allow-scripts allow-forms"
    );
    const body = await res.text();
    assert.equal(body, "<div>Pure HTM File</div>");
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("preview iframes inject media/AudioContext teardown hooks and tear down cleanly on Bot switch", async () => {
  const fullGameDoc = `<!DOCTYPE html><html><head><title>Game</title></head><body><script>new AudioContext();</script></body></html>`;
  const wrappedFull = buildPreviewSrcdoc(fullGameDoc, { instanceId: "g1" });
  const teardownIdx = wrappedFull.indexOf("__twinklebotPreviewTeardown");
  const gameScriptIdx = wrappedFull.indexOf("new AudioContext()");
  assert.ok(teardownIdx > 0, "full HTML preview must include media teardown script");
  assert.ok(teardownIdx < gameScriptIdx, "AudioContext wrapper must execute before game scripts");
  assert.match(wrappedFull, /__twinklebotPreviewPause/);
  assert.match(wrappedFull, /ctx\.close/);

  const fragmentDoc = `<div class="game">Play</div>`;
  const wrappedFrag = buildPreviewSrcdoc(fragmentDoc, { instanceId: "g2" });
  assert.match(wrappedFrag, /__twinklebotPreviewTeardown/);

  const { readWebSourceTs } = await import("./helpers/react-test-helpers.js");
  const appJs = readWebSourceTs();
  assert.match(appJs, /function teardownAllPreviewFrames/);
  assert.match(appJs, /function resetActiveSessionViewState\([^)]*\)\s*\{\s*teardownAllPreviewFrames\(\{\s*includeModal:\s*true\s*\}\)/);
  assert.match(appJs, /async function selectSession\(sessionId(?::\s*[^)]+)?\)\s*\{(?:(?!\n(?:export )?(?:async )?function )[\s\S])*?if \(!isSilentReconnectSync\)\s*\{\s*resetActiveSessionViewState\(sessionId/);
  assert.match(appJs, /function renderEmptyState\(\)\s*\{\s*teardownAllPreviewFrames\(\{\s*includeModal:\s*false\s*\}\)/);
  assert.match(appJs, /previewFrameRegistry\.delete\(instanceId\)/);
});
