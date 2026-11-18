import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES_DIR = path.join(PROJECT_ROOT, "src", "web", "styles");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

const ENTRY_TARGETS = [
  {
    entry: path.join(STYLES_DIR, "style.entry.css"),
    output: path.join(PUBLIC_DIR, "style.css"),
  },
  {
    entry: path.join(STYLES_DIR, "mobile.entry.css"),
    output: path.join(PUBLIC_DIR, "mobile.css"),
  },
];

function collectAllCssFiles(dir, out = new Set()) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      collectAllCssFiles(full, out);
    } else if (ent.isFile() && ent.name.endsWith(".css")) {
      out.add(path.resolve(full));
    }
  }
  return out;
}

function indentBlock(text, indent) {
  if (!indent) return text;
  return text
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : ""))
    .join("\n");
}

function countBracesOutsideCommentsAndStrings(css) {
  let depth = 0;
  let inComment = false;
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (ch === "*" && next === "/") {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

function resolveImports(filePath, seenFiles, stack = []) {
  const absPath = path.resolve(filePath);
  if (stack.includes(absPath)) {
    throw new Error(`Circular CSS @import detected: ${[...stack, absPath].join(" -> ")}`);
  }
  seenFiles.add(absPath);
  const raw = fs.readFileSync(absPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const m = line.match(
      /^([ \t]*)@import\s+["']([^"']+)["'](?:\s+layer\(([a-zA-Z0-9_-]+)\))?\s*;\s*$/
    );
    if (!m) {
      out.push(line);
      continue;
    }
    const [, indent, relImport, layerName] = m;
    const childPath = path.resolve(path.dirname(absPath), relImport);
    if (!fs.existsSync(childPath)) {
      throw new Error(`Missing CSS @import target "${relImport}" in ${absPath}`);
    }
    const relDisplay = path.relative(PROJECT_ROOT, childPath).replace(/\\/g, "/");
    let body = resolveImports(childPath, seenFiles, [...stack, absPath]).trimEnd();
    if (layerName) {
      body = `@layer ${layerName} {\n${indentBlock(body, "  ")}\n}`;
    }
    const section = `/* === ${relDisplay} === */\n${body}`;
    out.push(indentBlock(section, indent));
  }

  return out.join("\n");
}

export function buildStyles() {
  const visited = new Set();
  const results = [];

  for (const target of ENTRY_TARGETS) {
    if (!fs.existsSync(target.entry)) {
      throw new Error(`Missing CSS entry file: ${target.entry}`);
    }
    const header = `/* GENERATED FILE — DO NOT EDIT DIRECTLY. Edit src/web/styles/** and run \`npm run build:css\`. */`;
    const compiled = `${header}\n\n${resolveImports(target.entry, visited).trimEnd()}\n`;
    const braceBalance = countBracesOutsideCommentsAndStrings(compiled);
    if (braceBalance !== 0) {
      throw new Error(
        `Unbalanced CSS braces (${braceBalance}) in generated ${path.relative(PROJECT_ROOT, target.output)}`
      );
    }
    fs.mkdirSync(path.dirname(target.output), { recursive: true });
    fs.writeFileSync(target.output, compiled, "utf8");
    results.push({
      entry: path.relative(PROJECT_ROOT, target.entry),
      output: path.relative(PROJECT_ROOT, target.output),
      lines: compiled.split("\n").length,
      bytes: Buffer.byteLength(compiled, "utf8"),
    });
  }

  const allCssFiles = collectAllCssFiles(STYLES_DIR);
  const orphans = [...allCssFiles]
    .filter((f) => !visited.has(f))
    .map((f) => path.relative(PROJECT_ROOT, f));
  if (orphans.length > 0) {
    throw new Error(`Orphan CSS module(s) not imported by any entry: ${orphans.join(", ")}`);
  }

  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const results = buildStyles();
  for (const r of results) {
    console.log(`[build-css] ${r.entry} -> ${r.output} (${r.lines} lines, ${r.bytes} bytes)`);
  }
  if (process.argv.includes("--watch")) {
    let timer = null;
    fs.watch(STYLES_DIR, { recursive: true }, (_evt, filename) => {
      if (!filename || !String(filename).endsWith(".css")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const next = buildStyles();
          for (const r of next) {
            console.log(`[build-css:watch] rebuilt ${r.output} (${r.lines} lines)`);
          }
        } catch (err) {
          console.error(`[build-css:watch] error:`, err?.message || err);
        }
      }, 60);
    });
  }
}
