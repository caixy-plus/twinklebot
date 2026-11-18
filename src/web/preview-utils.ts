/**
 * HTML / HTM / SVG Snippet Detection, Unfenced Markup Extraction,
 * and Sandboxed `srcdoc` Builder for TwinkleBot Chat Dialog.
 */

const NON_PREVIEW_FENCE_LANGS = new Set([
  "js",
  "javascript",
  "mjs",
  "cjs",
  "ts",
  "typescript",
  "jsx",
  "tsx",
  "py",
  "python",
  "sh",
  "bash",
  "zsh",
  "shell",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "sql",
  "go",
  "rust",
  "rs",
  "java",
  "kt",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "c++",
  "cs",
  "csharp",
  "php",
  "rb",
  "ruby",
  "css",
  "scss",
  "less",
  "md",
  "markdown",
  "diff",
  "patch",
  "dockerfile",
  "makefile",
]);

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const STRUCTURAL_HTML_START_RE =
  /^<(?:!doctype\s+html|html|head|body|style|div|section|article|main|header|footer|nav|aside|table|form|canvas|details|dialog|figure|fieldset|picture|video|audio|ul|ol|dl)\b/i;

const INLINE_RICH_HTML_START_RE =
  /^<(?:button|h[1-6]|p|span|a|label|input|select|textarea|progress|meter)\b(?:\s+[^>\n]*?(?:style|class|id|onclick|type|href|value|placeholder)\s*=|>[^<\n]*<\/)/i;

const CONTINUATION_HTML_LINE_RE =
  /^<(?:!--|style|script|div|section|article|main|header|footer|nav|aside|table|form|canvas|details|dialog|figure|fieldset|ul|ol|dl|button|h[1-6]|p|span|a|label|img|hr|input|select|textarea|progress|meter|svg)\b/i;

const SVG_START_RE = /^(?:<\?xml[^>]*\?>\s*)?<svg\b/i;

/**
 * Determines whether a code snippet (from a code fence or raw block) is previewable HTML/HTM or SVG.
 */
export function detectPreviewableMarkup(code = "", fenceLang = "") {
  const trimmed = String(code || "").trim();
  const lang = String(fenceLang || "")
    .trim()
    .toLowerCase();

  if (!trimmed) {
    return { previewable: false, kind: null, badgeLabel: "", lang };
  }

  if (NON_PREVIEW_FENCE_LANGS.has(lang)) {
    return { previewable: false, kind: null, badgeLabel: "", lang };
  }

  const isExplicitSvg = lang === "svg";
  const isExplicitHtml =
    lang === "html" || lang === "htm" || lang === "xhtml" || lang === "html5";
  const isXml = lang === "xml";

  const looksPureSvg =
    SVG_START_RE.test(trimmed) &&
    (/<\/svg>\s*$/i.test(trimmed) || /\/>\s*$/i.test(trimmed)) &&
    !/^<!doctype\s+html\b/i.test(trimmed) &&
    !/^<html\b/i.test(trimmed);

  if (isExplicitSvg || (isXml && looksPureSvg) || (!isExplicitHtml && looksPureSvg)) {
    return {
      previewable: true,
      kind: "svg",
      badgeLabel: "SVG 预览",
      lang: "svg",
    };
  }

  if (isExplicitHtml) {
    return {
      previewable: true,
      kind: "html",
      badgeLabel: lang === "htm" ? "HTM 预览" : "HTML 预览",
      lang: lang === "htm" ? "htm" : "html",
    };
  }

  // Unlabeled fence or raw block: check if it is genuine HTML / HTM
  if (!lang || lang === "text" || lang === "raw") {
    const isFullDoc = /^(?:<!--[\s\S]*?-->\s*)?(?:<!doctype\s+html\b|<html\b)/i.test(trimmed);
    const hasHtmlBlockPair =
      /<(div|section|article|main|header|footer|nav|aside|table|form|canvas|style|button|details|dialog|figure|fieldset|ul|ol|dl|h[1-6])\b[^>]*>[\s\S]*<\/\1>/i.test(
        trimmed
      );
    const hasSvgInsideHtml = /<svg\b[^>]*>[\s\S]*<\/svg>/i.test(trimmed);

    if (isFullDoc || hasHtmlBlockPair || hasSvgInsideHtml) {
      return {
        previewable: true,
        kind: looksPureSvg ? "svg" : "html",
        badgeLabel: looksPureSvg ? "SVG 预览" : "HTML 预览",
        lang: looksPureSvg ? "svg" : "html",
      };
    }
  }

  return { previewable: false, kind: null, badgeLabel: "", lang };
}

/**
 * Advances tag balance state across a single line of HTML/SVG,
 * respecting raw `<script>` and `<style>` text sections so `<` operators inside JS don't break tag counting.
 */
function scanMarkupLineState(line: string, state: any) {
  let i = 0;
  const n = line.length;

  while (i < n) {
    if (state.inComment) {
      const endComment = line.indexOf("-->", i);
      if (endComment === -1) return;
      state.inComment = false;
      i = endComment + 3;
      continue;
    }

    if (state.rawTextTag) {
      const closeRe = new RegExp(`<\\/${state.rawTextTag}\\s*>`, "ig");
      closeRe.lastIndex = i;
      const m = closeRe.exec(line);
      if (!m) return;
      state.rawTextTag = null;
      if (state.depth > 0) state.depth -= 1;
      state.sawClosingOrSelfClose = true;
      i = m.index + m[0].length;
      continue;
    }

    if (state.openTagPending) {
      // Inside a multi-line `<tag \n attr="val">` header waiting for `>`
      const gtIdx = findTagCloseBracket(line, i);
      if (gtIdx === -1) return;
      const selfClosed = gtIdx > 0 && line[gtIdx - 1] === "/";
      const tagName = state.openTagPending;
      state.openTagPending = null;
      if (selfClosed || VOID_HTML_TAGS.has(tagName)) {
        state.sawClosingOrSelfClose = true;
      } else {
        state.depth += 1;
        if (tagName === "script" || tagName === "style") {
          state.rawTextTag = tagName;
        }
      }
      i = gtIdx + 1;
      continue;
    }

    const lt = line.indexOf("<", i);
    if (lt === -1) return;

    if (line.startsWith("<!--", lt)) {
      const endC = line.indexOf("-->", lt + 4);
      if (endC === -1) {
        state.inComment = true;
        return;
      }
      i = endC + 3;
      continue;
    }

    if (line.startsWith("<!", lt) || line.startsWith("<?", lt)) {
      const gt = line.indexOf(">", lt + 2);
      if (gt === -1) return;
      i = gt + 1;
      continue;
    }

    const closeMatch = line.slice(lt).match(/^<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>/);
    if (closeMatch) {
      if (state.depth > 0) state.depth -= 1;
      state.sawClosingOrSelfClose = true;
      i = lt + closeMatch[0].length;
      continue;
    }

    const openMatch = line.slice(lt).match(/^<([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s/>]|$)/);
    if (openMatch) {
      const tagName = openMatch[1].toLowerCase();
      state.sawAnyOpenTag = true;
      const afterName = lt + openMatch[0].length;
      const gtIdx = findTagCloseBracket(line, afterName);
      if (gtIdx === -1) {
        state.openTagPending = tagName;
        return;
      }
      const selfClosed = gtIdx > lt && line[gtIdx - 1] === "/";
      if (selfClosed || VOID_HTML_TAGS.has(tagName)) {
        state.sawClosingOrSelfClose = true;
      } else {
        state.depth += 1;
        if (tagName === "script" || tagName === "style") {
          state.rawTextTag = tagName;
        }
      }
      i = gtIdx + 1;
      continue;
    }

    i = lt + 1;
  }
}

function findTagCloseBracket(str: string, startIdx: number) {
  let quote: string | null = null;
  for (let i = startIdx; i < str.length; i += 1) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function isRawMarkupStartLine(trimmedLine: string) {
  if (!trimmedLine || !trimmedLine.startsWith("<")) return null;
  if (SVG_START_RE.test(trimmedLine)) return "svg";
  if (/^(?:<!doctype\s+html\b|<html\b)/i.test(trimmedLine)) return "html_doc";
  if (STRUCTURAL_HTML_START_RE.test(trimmedLine) || INLINE_RICH_HTML_START_RE.test(trimmedLine)) {
    return "html_fragment";
  }
  return null;
}

function extractRawBlocksFromProseLines(lines: string[]) {
  const out: any[] = [];
  let proseBuf: string[] = [];

  const flushProse = () => {
    if (proseBuf.length > 0) {
      const text = proseBuf.join("\n");
      if (text.trim()) {
        out.push({ type: "prose", text });
      }
      proseBuf = [];
    }
  };

  let idx = 0;
  while (idx < lines.length) {
    const trimmed = lines[idx].trim();
    const startKind = isRawMarkupStartLine(trimmed);
    if (!startKind) {
      proseBuf.push(lines[idx]);
      idx += 1;
      continue;
    }

    if (startKind === "html_doc") {
      // Consume through </html> (or end of lines for minimal .htm documents omitting </html>)
      let endIdx = idx;
      let closedHtml = false;
      for (let j = idx; j < lines.length; j += 1) {
        endIdx = j;
        if (/<\/html\s*>/i.test(lines[j])) {
          closedHtml = true;
          break;
        }
      }
      const snippet = lines.slice(idx, endIdx + 1).join("\n").trim();
      if (closedHtml || /<[a-z][\s\S]*>/i.test(snippet)) {
        flushProse();
        const isMinimalHtm = !closedHtml && !/<html\b/i.test(snippet);
        out.push({
          type: "raw_markup",
          kind: "html",
          lang: isMinimalHtm ? "htm" : "html",
          code: snippet,
        });
        idx = endIdx + 1;
        continue;
      }
    }

    // SVG or HTML fragment: scan balanced tags and merge adjacent top-level HTML sibling tags (<style> + <div> + <script>)
    const scanState = {
      depth: 0,
      inComment: false,
      rawTextTag: null,
      openTagPending: null,
      sawAnyOpenTag: false,
      sawClosingOrSelfClose: false,
    };

    let endIdx = idx;
    let j = idx;
    while (j < lines.length) {
      scanMarkupLineState(lines[j], scanState);
      endIdx = j;

      const balancedNow =
        scanState.sawAnyOpenTag &&
        scanState.depth === 0 &&
        !scanState.inComment &&
        !scanState.rawTextTag &&
        !scanState.openTagPending;

      if (balancedNow) {
        if (startKind === "svg") {
          // Peek ahead: if an <svg> is immediately followed by prose, stop right at </svg>
          break;
        }
        // For HTML/HTM fragments, peek past blank lines to see if another sibling HTML tag (<div, <script, <style...) continues the snippet
        let nextNonEmpty = j + 1;
        while (nextNonEmpty < lines.length && lines[nextNonEmpty].trim() === "") {
          nextNonEmpty += 1;
        }
        if (
          nextNonEmpty < lines.length &&
          CONTINUATION_HTML_LINE_RE.test(lines[nextNonEmpty].trim())
        ) {
          j = nextNonEmpty;
          continue;
        }
        break;
      }
      j += 1;
    }

    const candidate = lines.slice(idx, endIdx + 1).join("\n").trim();
    const detected = detectPreviewableMarkup(
      candidate,
      startKind === "svg" ? "svg" : "htm"
    );
    const validBalanced =
      scanState.sawAnyOpenTag &&
      scanState.sawClosingOrSelfClose &&
      !scanState.openTagPending &&
      !scanState.rawTextTag &&
      detected.previewable;

    if (validBalanced) {
      flushProse();
      const pureSvg =
        SVG_START_RE.test(candidate) &&
        (/<\/svg>\s*$/i.test(candidate) || /\/>\s*$/i.test(candidate)) &&
        !/<(?:div|style|script|html|body|table|form)\b/i.test(candidate);
      out.push({
        type: "raw_markup",
        kind: pureSvg ? "svg" : "html",
        lang: pureSvg ? "svg" : "htm",
        code: candidate,
      });
      idx = endIdx + 1;
      continue;
    }

    proseBuf.push(lines[idx]);
    idx += 1;
  }

  flushProse();
  return out;
}

/**
 * Tokenizes message text into ordered `{ type: "prose" | "fence" | "raw_markup" }` segments.
 * Supports variable-length backtick fences (` ``` `, ```` ```` ````) and tilde fences (`~~~`),
 * so outer 4-backtick blocks containing inner 3-backtick blocks are never closed prematurely.
 */
export function extractMessageSegments(rawText = "") {
  const text = String(rawText || "");
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const coarse: any[] = [];
  let proseLines: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLang = "";
  let fenceBody: string[] = [];
  let fenceRaw: string[] = [];

  for (const line of lines) {
    if (!inFence) {
      const openMatch = line.match(/^\s*(`{3,}|~{3,})([^\s`~]*).*$/);
      if (openMatch) {
        if (proseLines.length > 0) {
          coarse.push({ type: "prose_lines", lines: proseLines });
          proseLines = [];
        }
        inFence = true;
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        fenceLang = (openMatch[2] || "").trim();
        fenceBody = [];
        fenceRaw = [line];
        continue;
      }
      proseLines.push(line);
    } else {
      const closeMatch = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (
        closeMatch &&
        closeMatch[1][0] === fenceChar &&
        closeMatch[1].length >= fenceLen
      ) {
        fenceRaw.push(line);
        coarse.push({
          type: "fence",
          lang: fenceLang,
          code: fenceBody.join("\n"),
          raw: fenceRaw.join("\n"),
        });
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        fenceLang = "";
        fenceBody = [];
        fenceRaw = [];
        continue;
      }
      fenceBody.push(line);
      fenceRaw.push(line);
    }
  }

  if (inFence && fenceRaw.length > 0) {
    const closingFence = (fenceChar || "`").repeat(fenceLen || 3);
    coarse.push({
      type: "fence",
      lang: fenceLang,
      code: fenceBody.join("\n"),
      raw: `${fenceRaw.join("\n")}\n${closingFence}`,
    });
  }
  if (proseLines.length > 0) {
    coarse.push({ type: "prose_lines", lines: proseLines });
  }

  const segments: any[] = [];
  for (const item of coarse) {
    if (item.type === "fence") {
      segments.push(item);
    } else {
      segments.push(...extractRawBlocksFromProseLines(item.lines));
    }
  }
  return segments;
}

/**
 * Splits assistant messages into multi-bubble chunks while keeping BOTH fenced code blocks,
 * GFM tables, AND unfenced HTML / HTM / SVG snippets atomic across blank lines.
 */
export function splitIntoMessageChunksWithMarkup(rawText = "") {
  const segments = extractMessageSegments(rawText);
  if (segments.length === 0) return [];

  const rawChunks: string[] = [];
  for (const seg of segments) {
    if (seg.type === "fence") {
      rawChunks.push(seg.raw.trim());
    } else if (seg.type === "raw_markup") {
      rawChunks.push(seg.code.trim());
    } else {
      const parts = seg.text
        .split(/\n\s*\n/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      rawChunks.push(...parts);
    }
  }

  if (rawChunks.length <= 1) return rawChunks;

  const merged: string[] = [];
  for (let i = 0; i < rawChunks.length; i += 1) {
    const cur = rawChunks[i];
    // Merge standalone headings (`#`..`######`) or short intro label ending with `:`/`:` right before a table/code block
    const isStandaloneHeading = /^#{1,6}\s+[^\n]+$/.test(cur);
    const nextChunk = i + 1 < rawChunks.length ? rawChunks[i + 1] : "";
    const nextIsTableOrFence =
      nextChunk &&
      (/^\|.+\|\s*\n\s*\|[\s:-]+\|/m.test(nextChunk) ||
        /^(?:`{3,}|~{3,})/.test(nextChunk));
    const isShortIntroBeforeTable =
      nextIsTableOrFence &&
      !cur.includes("\n") &&
      cur.length <= 90 &&
      /[:：]$/.test(cur);

    if ((isStandaloneHeading || isShortIntroBeforeTable) && i + 1 < rawChunks.length) {
      merged.push(`${cur}\n\n${rawChunks[i + 1]}`);
      i += 1;
    } else {
      merged.push(cur);
    }
  }

  if (merged.length > 5) {
    return [...merged.slice(0, 4), merged.slice(4).join("\n\n")];
  }
  return merged;
}

/**
 * Builds a complete, isolated HTML5 `srcdoc` string for `<iframe sandbox="allow-scripts allow-forms">`.
 */
export function buildPreviewSrcdoc(
  code = "",
  { kind = "html", instanceId = "", canvasBg = "light", fullscreen = false } = {}
) {
  const raw = String(code || "").trim();
  const safeId = JSON.stringify(String(instanceId || ""));

  const bgCss =
    canvasBg === "dark"
      ? "background: #0f172a; color: #f8fafc;"
      : canvasBg === "grid"
        ? "background-color: #f8fafc; background-image: linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; color: #0f172a;"
        : "background: #ffffff; color: #111827;";

  const mediaLifecycleScript = `<script>
(function () {
  var audioCtxs = [];
  function wrapAudioCtx(Orig) {
    if (typeof Orig !== "function" || Orig.__twinklebotTracked) return Orig;
    try {
      var Wrapped = new Proxy(Orig, {
        construct: function (target, args, newTarget) {
          var inst = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
          audioCtxs.push(inst);
          return inst;
        }
      });
      Wrapped.__twinklebotTracked = true;
      return Wrapped;
    } catch (e) {
      return Orig;
    }
  }
  if (typeof window !== "undefined") {
    if (window.AudioContext) window.AudioContext = wrapAudioCtx(window.AudioContext);
    if (window.webkitAudioContext) window.webkitAudioContext = wrapAudioCtx(window.webkitAudioContext);
  }
  function stopAllMedia(closeAudioCtx) {
    for (var i = 0; i < audioCtxs.length; i++) {
      var ctx = audioCtxs[i];
      if (!ctx) continue;
      try {
        if (closeAudioCtx && typeof ctx.close === "function" && ctx.state !== "closed") {
          ctx.close().catch(function () {});
        } else if (typeof ctx.suspend === "function" && ctx.state === "running") {
          ctx.suspend().catch(function () {});
        }
      } catch (e) {}
    }
    var mediaEls = document.querySelectorAll ? document.querySelectorAll("audio, video") : [];
    for (var j = 0; j < mediaEls.length; j++) {
      try {
        mediaEls[j].pause();
        if (closeAudioCtx) {
          mediaEls[j].muted = true;
          mediaEls[j].removeAttribute("src");
          if (typeof mediaEls[j].load === "function") mediaEls[j].load();
        }
      } catch (e) {}
    }
    try {
      if (closeAudioCtx && window.speechSynthesis && typeof window.speechSynthesis.cancel === "function") {
        window.speechSynthesis.cancel();
      }
    } catch (e) {}
  }
  function resumeAllAudio() {
    for (var i = 0; i < audioCtxs.length; i++) {
      var ctx = audioCtxs[i];
      if (!ctx) continue;
      try {
        if (typeof ctx.resume === "function" && ctx.state === "suspended") {
          ctx.resume().catch(function () {});
        }
      } catch (e) {}
    }
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var d = event.data;
    if (!d || typeof d !== "object") return;
    if (d.__twinklebotPreviewTeardown === true) stopAllMedia(true);
    else if (d.__twinklebotPreviewPause === true) stopAllMedia(false);
    else if (d.__twinklebotPreviewResume === true) resumeAllAudio();
  });
  window.addEventListener("pagehide", function () { stopAllMedia(true); });
  window.addEventListener("beforeunload", function () { stopAllMedia(true); });
})();
</script>`;

  const resizeScript = `<script>
(function () {
  var id = ${safeId};
  if (!id || !window.parent) return;
  var lastH = 0;
  function report() {
    var root = document.documentElement;
    var body = document.body;
    var h = Math.ceil(Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root ? root.scrollHeight : 0
    ));
    if (h > 0 && Math.abs(h - lastH) > 1) {
      lastH = h;
      window.parent.postMessage({ __twinklebotPreviewResize: true, id: id, height: h }, "*");
    }
  }
  window.addEventListener("DOMContentLoaded", report);
  window.addEventListener("load", function () {
    report();
    setTimeout(report, 120);
  });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(report).observe(document.documentElement);
  }
})();
</script>`;

  if (kind === "svg") {
    const svgMaxH = fullscreen ? "calc(100vh - 48px)" : "360px";
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { margin: 0; padding: 0; ${bgCss} }
  .svg-stage {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: ${fullscreen ? "calc(100vh - 32px)" : "136px"};
    padding: 16px;
    box-sizing: border-box;
  }
  .svg-stage > svg {
    max-width: 100%;
    max-height: ${svgMaxH};
    height: auto;
    display: block;
  }
</style>
</head>
<body>
<div class="svg-stage">${raw}</div>
${resizeScript}
</body>
</html>`;
  }

  // Full HTML document (`<!DOCTYPE html>` or `<html>`)
  if (/^(?:<!--[\s\S]*?-->\s*)?(?:<!doctype\s+html\b|<html\b)/i.test(raw)) {
    let doc = raw;
    if (!/<meta\s+[^>]*charset=/i.test(doc)) {
      if (/<head\b[^>]*>/i.test(doc)) {
        doc = doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n<meta charset="utf-8">`);
      } else {
        doc = `<meta charset="utf-8">\n${doc}`;
      }
    }
    if (/<head\b[^>]*>/i.test(doc)) {
      doc = doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${mediaLifecycleScript}`);
    } else if (/<html\b[^>]*>/i.test(doc)) {
      doc = doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${mediaLifecycleScript}</head>`);
    } else {
      doc = `${mediaLifecycleScript}\n${doc}`;
    }
    if (canvasBg !== "light") {
      const overrideStyle = `<style>html { ${bgCss} }</style>`;
      if (/<\/head\s*>/i.test(doc)) {
        doc = doc.replace(/<\/head\s*>/i, `${overrideStyle}\n$&`);
      } else {
        doc = `${overrideStyle}\n${doc}`;
      }
    }
    if (/<\/body\s*>/i.test(doc)) {
      return doc.replace(/<\/body\s*>/i, `${resizeScript}\n$&`);
    }
    if (/<\/html\s*>/i.test(doc)) {
      return doc.replace(/<\/html\s*>/i, `${resizeScript}\n$&`);
    }
    return `${doc}\n${resizeScript}`;
  }

  // Raw HTML / HTM fragment (`<div>...`, `<style>...`, etc.)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${mediaLifecycleScript}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    ${bgCss}
  }
  body { padding: 14px; }
</style>
</head>
<body>
${raw}
${resizeScript}
</body>
</html>`;
}
