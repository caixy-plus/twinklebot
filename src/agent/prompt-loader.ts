import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const templateCache = new Map<string, string>();

function resolvePromptPath(fileName: string): string {
  const candidates = [
    path.join(MODULE_DIR, "prompts", fileName),
    // Fallback when running tsx/source tests or packaged layouts
    path.resolve(MODULE_DIR, "..", "..", "..", "src", "agent", "prompts", fileName),
    path.resolve(process.cwd(), "src", "agent", "prompts", fileName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Prompt template not found: ${fileName} (checked ${candidates.join(", ")})`);
}

export function loadPromptTemplate(fileName: string): string {
  const cached = templateCache.get(fileName);
  if (cached !== undefined) return cached;
  const raw = fs.readFileSync(resolvePromptPath(fileName), "utf-8").trimEnd();
  templateCache.set(fileName, raw);
  return raw;
}

export function renderPromptTemplate(
  fileName: string,
  vars: Record<string, string | number | undefined> = {}
): string {
  const template = loadPromptTemplate(fileName);
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
    const val = vars[key];
    return val === undefined || val === null ? "" : String(val);
  });
}

export function clearPromptTemplateCache(): void {
  templateCache.clear();
}
