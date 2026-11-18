/**
 * Pure, browser-safe GFM Markdown block & inline parser for TwinkleBot chat bubbles.
 * Zero Node.js dependencies; shared between `public/app.js`, `public/preview-utils.js`, and `node:test`.
 */

/**
 * Checks whether a URL is safe to use as an `<a href="...">` target.
 * Blocks `javascript:`, `vbscript:`, `data:`, and unknown schemes.
 */
export function isSafeMarkdownUrl(rawUrl = "") {
  const cleaned = String(rawUrl || "")
    .trim()
    .replace(/[\u0000-\u001F\u007F-\u009F\s]+/g, "");
  if (!cleaned) return false;
  if (cleaned.startsWith("/api/workspace/file") || cleaned.startsWith("#")) {
    return true;
  }
  if (/^https?:\/\/[^/]+\/api\/workspace\/file(?:[?#]|$)/i.test(cleaned)) {
    return true;
  }
  return /^(?:https?:\/\/|mailto:)/i.test(cleaned);
}

/**
 * Extracts a safe decoded POSIX/host path from a `file:///...` link.
 */
export function parseLocalFileUrl(rawUrl = "") {
  const cleaned = String(rawUrl || "").trim();
  if (!/^file:\/\/(?:localhost)?\//i.test(cleaned)) return "";
  if (/[\u0000-\u001F\u007F]/.test(cleaned)) return "";
  const withoutScheme = cleaned.replace(/^file:\/\/(?:localhost)?/i, "");
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

/**
 * Splits a single GFM table line into cell strings while respecting `\|` escapes
 * and pipes inside inline code spans (`` `a|b` ``).
 */
export function splitTableRowCells(rawLine = "") {
  let line = String(rawLine || "").trim();
  if (!line.includes("|")) return [];
  if (line.startsWith("|")) line = line.slice(1);
  if (line.endsWith("|") && !line.endsWith("\\|")) line = line.slice(0, -1);

  const cells: string[] = [];
  let buf = "";
  let inCode = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length && (line[i + 1] === "|" || line[i + 1] === "\\")) {
      buf += line[i + 1];
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      buf += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

/**
 * Checks if a line is a valid GFM table alignment separator row (e.g. `| --- | :---: | ---: |`).
 * Returns an array of `"left" | "center" | "right"` alignments, or `null` if invalid.
 */
export function parseTableSeparatorRow(rawLine = "") {
  const line = String(rawLine || "").trim();
  if (!line.includes("|")) return null;
  const cells = splitTableRowCells(line);
  if (cells.length === 0) return null;
  const alignments: string[] = [];
  for (const cell of cells) {
    if (!/^:?-{2,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) alignments.push("center");
    else if (right) alignments.push("right");
    else alignments.push("left");
  }
  return alignments;
}

/**
 * Checks whether `lines[idx]` and `lines[idx + 1]` start a valid GFM table.
 */
export function isTableStartAt(lines: string[], idx: number) {
  if (!Array.isArray(lines) || idx < 0 || idx + 1 >= lines.length) return false;
  const headerLine = String(lines[idx] || "").trim();
  const sepLine = String(lines[idx + 1] || "").trim();
  if (!headerLine || !sepLine) return false;
  if (!headerLine.includes("|") || !sepLine.includes("|")) return false;
  if (/^(?:>\s|#{1,6}\s|[-*+•]\s|\d+[.)]\s)/.test(headerLine)) return false;

  const headers = splitTableRowCells(headerLine);
  const alignments = parseTableSeparatorRow(sepLine);
  if (!alignments || headers.length === 0) return false;
  // Require at least 2 columns OR explicit leading & trailing pipes
  const hasOuterPipes = headerLine.startsWith("|") && headerLine.endsWith("|");
  if (headers.length < 2 && !hasOuterPipes) return false;
  return headers.length === alignments.length;
}

const HR_RE = /^(?:\*\s*\*\s*\*[\s*]*|-\s*-\s*-[\s-]*|_\s*_\s*_[\s_]*)$/;
const WORKSPACE_PATH_HINT_RE = /^\(工作区路径:\s*.+\)$/;
const IMG_ATTACH_RE = /^\[图片附件:\s*([^\]]+)\]\(([^)]+)\)$/;
const MD_IMG_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;
const FILE_ATTACH_RE = /^\[文件附件:\s*([^\]]+?)\s*·\s*路径:\s*([^\]]+)\]$/;
const FILE_URL_LINE_RE = /^\[([^\]]+)\]\((file:\/\/(?:localhost)?\/[^)\s]+)\)$/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/;
const QUOTE_RE = /^>\s?(.*)$/;
const UL_ITEM_RE = /^(\s*)(?:[-*+•])\s+(.+)$/;
const OL_ITEM_RE = /^(\s*)(\d+)[.)]\s+(.+)$/;
const TASK_BOX_RE = /^\[([ xX])\]\s+(.+)$/;

/**
 * Parses prose Markdown text into structured block nodes:
 * - `table`: `{ type: "table", headers, alignments, rows, tsv, raw }`
 * - `heading`: `{ type: "heading", level: 1..6, text }`
 * - `hr`: `{ type: "hr" }`
 * - `blockquote`: `{ type: "blockquote", lines: string[] }`
 * - `list`: `{ type: "list", ordered: boolean, start: number, items: Array<{ text, task, checked, children }> }`
 * - `attachment_image`: `{ type: "attachment_image", name, url }`
 * - `attachment_file`: `{ type: "attachment_file", name, path }`
 * - `paragraph`: `{ type: "paragraph", text }`
 */
export function parseMarkdownBlocks(rawText = "") {
  const lines = Array.isArray(rawText)
    ? rawText.map((l) => String(l ?? ""))
    : String(rawText || "").split("\n");

  const blocks: any[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || WORKSPACE_PATH_HINT_RE.test(trimmed)) {
      i += 1;
      continue;
    }

    // 1. GFM Table (must check BEFORE HR so `| --- | --- |` is never misread)
    if (isTableStartAt(lines, i)) {
      const rawTableLines = [lines[i], lines[i + 1]];
      const headers = splitTableRowCells(lines[i]);
      const alignments = parseTableSeparatorRow(lines[i + 1]) || headers.map(() => "left");
      const colCount = headers.length;
      const rows: string[][] = [];
      i += 2;

      while (i < lines.length) {
        const rowTrim = String(lines[i] || "").trim();
        if (!rowTrim || !rowTrim.includes("|")) break;
        if (
          HR_RE.test(rowTrim) ||
          HEADING_RE.test(rowTrim) ||
          IMG_ATTACH_RE.test(rowTrim) ||
          FILE_ATTACH_RE.test(rowTrim)
        ) {
          break;
        }
        rawTableLines.push(lines[i]);
        const rawCells = splitTableRowCells(rowTrim);
        const normalizedRow: string[] = [];
        for (let c = 0; c < colCount; c += 1) {
          normalizedRow.push(rawCells[c] !== undefined ? rawCells[c] : "");
        }
        rows.push(normalizedRow);
        i += 1;
      }

      const tsvLines = [
        headers.join("\t"),
        ...rows.map((r) => r.join("\t")),
      ];
      blocks.push({
        type: "table",
        headers,
        alignments,
        rows,
        tsv: tsvLines.join("\n"),
        raw: rawTableLines.join("\n"),
      });
      continue;
    }

    // 2. Horizontal Rule (`---`, `***`, `___`)
    if (HR_RE.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // 3. Image attachment (`[图片附件: ...](url)` or `![alt](url)`)
    const imgMatch = trimmed.match(IMG_ATTACH_RE) || trimmed.match(MD_IMG_RE);
    if (imgMatch) {
      blocks.push({
        type: "attachment_image",
        name: (imgMatch[1] || "AI 生成图片").trim(),
        url: imgMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    // 4. File attachment (`[文件附件: name · 路径: path]` or standalone `[name](file:///...)`)
    const fileMatch = trimmed.match(FILE_ATTACH_RE);
    if (fileMatch) {
      blocks.push({
        type: "attachment_file",
        name: fileMatch[1].trim(),
        path: fileMatch[2].trim(),
      });
      i += 1;
      continue;
    }
    const fileUrlMatch = trimmed.match(FILE_URL_LINE_RE);
    if (fileUrlMatch) {
      const localPath = parseLocalFileUrl(fileUrlMatch[2]);
      if (localPath) {
        blocks.push({
          type: "attachment_file",
          name: fileUrlMatch[1].trim() || localPath.split("/").pop() || "文件",
          path: localPath,
        });
        i += 1;
        continue;
      }
    }

    // 5. Blockquote (`> ...`)
    const quoteMatch = trimmed.match(QUOTE_RE);
    if (quoteMatch) {
      const quoteLines = [quoteMatch[1]];
      i += 1;
      while (i < lines.length) {
        const nextTrim = String(lines[i] || "").trim();
        const nextQuote = nextTrim.match(QUOTE_RE);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1]);
        i += 1;
      }
      blocks.push({
        type: "blockquote",
        lines: quoteLines,
      });
      continue;
    }

    // 6. Lists (Unordered `- / * / + / •`, Ordered `1. / 1)`, Task list `- [x]`, and 2-level nested items)
    const ulMatch = rawLine.match(UL_ITEM_RE);
    const olMatch = !ulMatch ? rawLine.match(OL_ITEM_RE) : null;
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const startNum = isOrdered ? Number(olMatch![2]) || 1 : 1;
      const items: any[] = [];

      const parseItemPayload = (rawContent: any) => {
        const taskMatch = String(rawContent || "").match(TASK_BOX_RE);
        if (taskMatch) {
          return {
            text: taskMatch[2].trim(),
            task: true,
            checked: taskMatch[1].toLowerCase() === "x",
            children: [] as any[],
          };
        }
        return {
          text: String(rawContent || "").trim(),
          task: false,
          checked: null,
          children: [] as any[],
        };
      };

      while (i < lines.length) {
        const curRaw = lines[i];
        const curTrim = curRaw.trim();
        if (!curTrim) break;
        if (isTableStartAt(lines, i) || HR_RE.test(curTrim)) break;

        const u = curRaw.match(UL_ITEM_RE);
        const o = !u ? curRaw.match(OL_ITEM_RE) : null;
        if (!u && !o) break;

        const indentLen = (u ? u[1] : o![1]).replace(/\t/g, "  ").length;
        const itemOrdered = Boolean(o);
        const contentStr = u ? u[2] : o![3];

        // Nested sub-item (`indent >= 2`) attaches to the most recent top-level item
        if (indentLen >= 2 && items.length > 0) {
          const parentItem = items[items.length - 1];
          parentItem.children.push({
            ...parseItemPayload(contentStr),
            ordered: itemOrdered,
          });
          i += 1;
          continue;
        }

        // Top-level list type switched (`ul` <-> `ol`): end current list block so a new one starts
        if (itemOrdered !== isOrdered && items.length > 0) {
          break;
        }

        items.push(parseItemPayload(contentStr));
        i += 1;
      }

      blocks.push({
        type: "list",
        ordered: isOrdered,
        start: startNum,
        items,
      });
      continue;
    }

    // 7. Heading (`#` .. `######`)
    const headingMatch = trimmed.match(HEADING_RE);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: Math.min(Math.max(headingMatch[1].length, 1), 6),
        text: headingMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    // 8. Paragraph
    blocks.push({
      type: "paragraph",
      text: rawLine,
    });
    i += 1;
  }

  return blocks;
}

/**
 * Tokenizes inline Markdown into safe AST nodes without `innerHTML`.
 * Supported token types:
 * - `{ type: "code", text }`
 * - `{ type: "link", text, href, children }`
 * - `{ type: "strong", text, children }`
 * - `{ type: "del", text, children }`
 * - `{ type: "em", text, children }`
 * - `{ type: "text", text }`
 *
 * Includes `snake_case` protection so identifiers like `schedule_manage` are not split into `<em>`.
 */
export function tokenizeInlineMarkdown(input = "", depth = 0) {
  const str = String(input ?? "");
  if (!str) return [];
  if (depth > 3) return [{ type: "text", text: str }];

  const tokens: any[] = [];
  let textBuf = "";
  const flushText = () => {
    if (textBuf) {
      tokens.push({ type: "text", text: textBuf });
      textBuf = "";
    }
  };

  let i = 0;
  const len = str.length;

  while (i < len) {
    const ch = str[i];

    // 1. Escaped punctuation (`\|`, `\*`, `\_`, `` \` ``, `\[`, `\~`)
    if (ch === "\\" && i + 1 < len && /[\\`*_{}[\]()#+\-.!|~]/.test(str[i + 1])) {
      textBuf += str[i + 1];
      i += 2;
      continue;
    }

    // 2. Inline code (`` `...` `` or ``` ``...`` ```)
    if (ch === "`") {
      let tickCount = 1;
      while (i + tickCount < len && str[i + tickCount] === "`") {
        tickCount += 1;
      }
      const delim = "`".repeat(tickCount);
      const closeIdx = str.indexOf(delim, i + tickCount);
      if (closeIdx !== -1) {
        flushText();
        let codeContent = str.slice(i + tickCount, closeIdx);
        if (
          tickCount > 1 &&
          codeContent.startsWith(" ") &&
          codeContent.endsWith(" ") &&
          codeContent.trim().length > 0
        ) {
          codeContent = codeContent.slice(1, -1);
        }
        tokens.push({ type: "code", text: codeContent });
        i = closeIdx + tickCount;
        continue;
      }
      textBuf += delim;
      i += tickCount;
      continue;
    }

    // 3. Markdown Link `[label](url)`
    if (ch === "[") {
      const rest = str.slice(i);
      const linkMatch = rest.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if (linkMatch) {
        const label = linkMatch[1];
        const rawHref = linkMatch[2].trim();
        if (isSafeMarkdownUrl(rawHref)) {
          flushText();
          tokens.push({
            type: "link",
            text: label,
            href: rawHref,
            children: tokenizeInlineMarkdown(label, depth + 1),
          });
          i += linkMatch[0].length;
          continue;
        }
        const localPath = parseLocalFileUrl(rawHref);
        if (localPath) {
          flushText();
          tokens.push({
            type: "file_link",
            text: label,
            href: rawHref,
            path: localPath,
            children: tokenizeInlineMarkdown(label, depth + 1),
          });
          i += linkMatch[0].length;
          continue;
        }
      }
    }

    // 4. Bare URL `https://...` or `http://...`
    if (
      (ch === "h" || ch === "H") &&
      /^https?:\/\/[^\s<>"'`，。！？；：、（）【】《》“”‘’]+/i.test(str.slice(i)) &&
      (i === 0 || /[\s([（【:：,，;；]/.test(str[i - 1]))
    ) {
      const urlMatch = str
        .slice(i)
        .match(/^https?:\/\/[^\s<>"'`，。！？；：、（）【】《》“”‘’]+/i);
      if (urlMatch) {
        let rawUrl = urlMatch[0];
        // Strip trailing sentence punctuation that is not part of the URL
        while (/[.,;:!?。，；：！？）》】\]]$/.test(rawUrl)) {
          rawUrl = rawUrl.slice(0, -1);
        }
        while (rawUrl.endsWith(")") && (rawUrl.match(/\(/g) || []).length < (rawUrl.match(/\)/g) || []).length) {
          rawUrl = rawUrl.slice(0, -1);
        }
        if (isSafeMarkdownUrl(rawUrl)) {
          flushText();
          tokens.push({
            type: "link",
            text: rawUrl,
            href: rawUrl,
            children: [{ type: "text", text: rawUrl }],
          });
          i += rawUrl.length;
          continue;
        }
      }
    }

    // 5. Bold `**...**` or `__...__`
    if (
      (ch === "*" && str[i + 1] === "*") ||
      (ch === "_" &&
        str[i + 1] === "_" &&
        (i === 0 || !/[a-zA-Z0-9]/.test(str[i - 1])))
    ) {
      const delim = ch + ch;
      const closeIdx = str.indexOf(delim, i + 2);
      if (closeIdx > i + 2) {
        const inner = str.slice(i + 2, closeIdx);
        if (inner.trim().length > 0) {
          flushText();
          tokens.push({
            type: "strong",
            text: inner,
            children: tokenizeInlineMarkdown(inner, depth + 1),
          });
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // 6. Strikethrough `~~...~~`
    if (ch === "~" && str[i + 1] === "~") {
      const closeIdx = str.indexOf("~~", i + 2);
      if (closeIdx > i + 2) {
        const inner = str.slice(i + 2, closeIdx);
        if (inner.trim().length > 0) {
          flushText();
          tokens.push({
            type: "del",
            text: inner,
            children: tokenizeInlineMarkdown(inner, depth + 1),
          });
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // 7. Italic `*...*` or `_..._` (with strict snake_case & whitespace protection)
    if (ch === "*" || ch === "_") {
      const prevChar = i > 0 ? str[i - 1] : "";
      const nextChar = i + 1 < len ? str[i + 1] : "";
      const blockedByWordBoundary =
        ch === "_" && /[a-zA-Z0-9]/.test(prevChar);
      if (!blockedByWordBoundary && nextChar && nextChar !== ch && !/\s/.test(nextChar)) {
        // Find matching single delimiter not preceded by whitespace and (for `_`) not followed by word char
        let searchFrom = i + 1;
        let foundClose = -1;
        while (searchFrom < len) {
          const candidate = str.indexOf(ch, searchFrom);
          if (candidate === -1) break;
          // Skip double delimiters (`**` or `__`)
          if (str[candidate + 1] === ch) {
            searchFrom = candidate + 2;
            continue;
          }
          const beforeClose = str[candidate - 1];
          const afterClose = candidate + 1 < len ? str[candidate + 1] : "";
          const validBefore = beforeClose && !/\s/.test(beforeClose);
          const validAfter = ch !== "_" || !/[a-zA-Z0-9]/.test(afterClose);
          if (validBefore && validAfter) {
            foundClose = candidate;
            break;
          }
          searchFrom = candidate + 1;
        }
        if (foundClose > i + 1) {
          const inner = str.slice(i + 1, foundClose);
          if (!inner.includes("\n") && inner.trim().length > 0) {
            flushText();
            tokens.push({
              type: "em",
              text: inner,
              children: tokenizeInlineMarkdown(inner, depth + 1),
            });
            i = foundClose + 1;
            continue;
          }
        }
      }
    }

    textBuf += ch;
    i += 1;
  }

  flushText();
  return tokens;
}
