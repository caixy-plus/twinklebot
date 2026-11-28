import fs from "node:fs";
import path from "node:path";

const SAFE_SLUG_RE = /^[a-z0-9\u4e00-\u9fa5][a-z0-9\u4e00-\u9fa5_-]{0,63}$/i;
export const SAFE_SCRIPT_NAME_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.(py|mjs|js|sh|ts)$/i;
const MAX_SCRIPT_BYTES = 128 * 1024;

export interface CustomSkillScriptMeta {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface CustomSkill {
  id: string;
  name: string;
  icon: string;
  description: string;
  instructions: string;
  enabled: boolean;
  scope?: string;
  triggers?: string[];
  scripts?: CustomSkillScriptMeta[];
  isPackage?: boolean;
  createdBy: "bot" | "user";
  createdByBotId: string;
  createdByBotName: string;
  createdAt: string;
  updatedAt: string;
  filePath?: string;
}

function writeTextAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmpFile, String(content || ""), "utf-8");
  fs.renameSync(tmpFile, filePath);
}

/**
 * Normalizes a human skill name or slug into a safe filename slug without
 * path separators or traversal sequences.
 */
export function normalizeCustomSkillSlug(raw = "", fallback = "custom-skill"): string {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\/\\?%*:|"<>.\s]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  return cleaned;
}

export function isValidCustomSkillId(id: unknown = ""): boolean {
  const s = String(id || "").trim();
  return Boolean(s) && SAFE_SLUG_RE.test(s) && !s.includes("..");
}

export function isValidCustomSkillScriptName(name: unknown = ""): boolean {
  const s = String(name || "").trim();
  return (
    Boolean(s) &&
    SAFE_SCRIPT_NAME_RE.test(s) &&
    !s.includes("..") &&
    !s.includes("/") &&
    !s.includes("\\")
  );
}

function normalizeTriggers(raw: unknown): string[] {
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.map((x) => String(x || "").trim());
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          list = parsed.map((x) => String(x || "").trim());
        }
      } catch {
        list = trimmed.slice(1, -1).split(/[,，]/).map((x) => x.trim());
      }
    } else if (trimmed) {
      list = trimmed.split(/[,，]/).map((x) => x.trim());
    }
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const clean = item.slice(0, 48);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
    if (unique.length >= 12) break;
  }
  return unique;
}

function normalizeScope(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!s || s.toLowerCase() === "global") return "global";
  return s.slice(0, 80);
}

function unquoteYamlScalar(raw = ""): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    if (s.startsWith('"')) {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * Parses a SKILL.md document containing optional YAML frontmatter and Markdown body.
 */
export function parseCustomSkillMarkdown(rawText = "", fallbackId = ""): CustomSkill {
  const text = String(rawText || "").replace(/\r\n/g, "\n");
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  const meta: Record<string, any> = {};
  let body = text.trim();

  if (fmMatch) {
    const fmLines = fmMatch[1].split("\n");
    for (const line of fmLines) {
      const m = line.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim();
      if (val === "true") meta[key] = true;
      else if (val === "false") meta[key] = false;
      else if (val.startsWith("[") && val.endsWith("]")) {
        try {
          meta[key] = JSON.parse(val);
        } catch {
          meta[key] = val;
        }
      } else {
        meta[key] = unquoteYamlScalar(val);
      }
    }
    body = String(fmMatch[2] || "").trim();
  }

  const id = isValidCustomSkillId(meta.id)
    ? String(meta.id)
    : isValidCustomSkillId(fallbackId)
      ? String(fallbackId)
      : normalizeCustomSkillSlug(meta.name || fallbackId);

  const scope = normalizeScope(meta.scope);
  const triggers = normalizeTriggers(meta.triggers);

  return {
    id,
    name: String(meta.name || id).trim().slice(0, 64) || id,
    icon: String(meta.icon || "🧩").trim().slice(0, 8) || "🧩",
    description: String(meta.description || "").trim().slice(0, 240),
    instructions: body,
    enabled: meta.enabled !== false,
    ...(scope !== "global" ? { scope } : { scope: "global" }),
    ...(triggers.length > 0 ? { triggers } : {}),
    createdBy: meta.createdBy === "bot" ? "bot" : "user",
    createdByBotId: String(meta.createdByBotId || "").trim(),
    createdByBotName: String(meta.createdByBotName || "").trim(),
    createdAt: String(meta.createdAt || "").trim(),
    updatedAt: String(meta.updatedAt || "").trim(),
  };
}

/**
 * Serializes a custom skill object to standard SKILL.md text (YAML frontmatter + Markdown body).
 */
export function serializeCustomSkillMarkdown(skill: Partial<CustomSkill> = {}): string {
  const id = normalizeCustomSkillSlug(skill.id || skill.name);
  const name = String(skill.name || id).trim().slice(0, 64) || id;
  const icon = String(skill.icon || "🧩").trim().slice(0, 8) || "🧩";
  const description = String(skill.description || "").trim().slice(0, 240);
  const instructions = String(skill.instructions || "").replace(/\r\n/g, "\n").trim();
  const enabled = skill.enabled !== false;
  const scope = normalizeScope(skill.scope);
  const triggers = normalizeTriggers(skill.triggers);
  const createdBy = skill.createdBy === "bot" ? "bot" : "user";
  const createdByBotId = String(skill.createdByBotId || "").trim();
  const createdByBotName = String(skill.createdByBotName || "").trim();
  const createdAt = String(skill.createdAt || new Date().toISOString());
  const updatedAt = String(skill.updatedAt || createdAt);

  const lines = [
    "---",
    `id: ${JSON.stringify(id)}`,
    `name: ${JSON.stringify(name)}`,
    `icon: ${JSON.stringify(icon)}`,
    `description: ${JSON.stringify(description)}`,
    `enabled: ${enabled ? "true" : "false"}`,
    `createdBy: ${JSON.stringify(createdBy)}`,
  ];
  if (scope !== "global") lines.push(`scope: ${JSON.stringify(scope)}`);
  if (triggers.length > 0) lines.push(`triggers: ${JSON.stringify(triggers)}`);
  if (createdByBotId) lines.push(`createdByBotId: ${JSON.stringify(createdByBotId)}`);
  if (createdByBotName) lines.push(`createdByBotName: ${JSON.stringify(createdByBotName)}`);
  lines.push(`createdAt: ${JSON.stringify(createdAt)}`);
  lines.push(`updatedAt: ${JSON.stringify(updatedAt)}`);
  lines.push("---", "");
  if (instructions) lines.push(instructions, "");
  return lines.join("\n");
}

function findMatchingSkill(skills: CustomSkill[], selector: unknown): CustomSkill | null {
  const needle = String(selector || "").trim().toLowerCase();
  if (!needle) return null;
  const byId = skills.find((s) => s.id.toLowerCase() === needle);
  if (byId) return byId;
  const byName = skills.find((s) => s.name.trim().toLowerCase() === needle);
  if (byName) return byName;
  const matches = skills.filter(
    (s) =>
      s.id.toLowerCase().includes(needle) ||
      s.name.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle)
  );
  return matches.length === 1 ? matches[0] : matches[0] || null;
}

/**
 * Creates a file-backed custom skills repository stored under:
 * - `custom-skills/<slug>.md` (plain skill)
 * - `custom-skills/<slug>/SKILL.md` + `scripts/<name>` (skill package with scripts)
 */
export function createCustomSkillsRepo(
  customSkillsDir: string,
  { getIsoNow = () => new Date().toISOString() }: { getIsoNow?: () => string } = {}
) {
  const rootDir = path.resolve(customSkillsDir);

  function assertValidId(id: string): void {
    if (!isValidCustomSkillId(id)) {
      throw new Error("无效的自定义技能标识（id）");
    }
  }

  function skillFilePath(id: string): string {
    assertValidId(id);
    const target = path.resolve(rootDir, `${id}.md`);
    if (!target.startsWith(rootDir + path.sep)) {
      throw new Error("非法的技能文件路径");
    }
    return target;
  }

  function packageDirPath(id: string): string {
    assertValidId(id);
    const target = path.resolve(rootDir, id);
    if (!target.startsWith(rootDir + path.sep)) {
      throw new Error("非法的技能目录路径");
    }
    return target;
  }

  function packageSkillFilePath(id: string): string {
    return path.join(packageDirPath(id), "SKILL.md");
  }

  function packageScriptsDir(id: string): string {
    return path.join(packageDirPath(id), "scripts");
  }

  function packageScriptPath(id: string, scriptName: string): string {
    const cleanName = String(scriptName || "").trim();
    if (!isValidCustomSkillScriptName(cleanName)) {
      throw new Error(
        "无效的脚本文件名（仅允许字母/数字开头，扩展名为 .py/.mjs/.js/.sh/.ts，且不允许路径符号）"
      );
    }
    const scriptsDir = packageScriptsDir(id);
    const target = path.resolve(scriptsDir, cleanName);
    if (!target.startsWith(scriptsDir + path.sep)) {
      throw new Error("非法的技能脚本路径");
    }
    return target;
  }

  function scanPackageScripts(id: string): CustomSkillScriptMeta[] {
    const dir = packageScriptsDir(id);
    if (!fs.existsSync(dir)) return [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const scripts: CustomSkillScriptMeta[] = [];
      for (const ent of entries) {
        if (!ent.isFile() || !isValidCustomSkillScriptName(ent.name)) continue;
        const fullPath = path.join(dir, ent.name);
        const st = fs.statSync(fullPath);
        scripts.push({
          name: ent.name,
          path: fullPath,
          sizeBytes: st.size,
        });
      }
      scripts.sort((a, b) => a.name.localeCompare(b.name));
      return scripts;
    } catch {
      return [];
    }
  }

  function readSkillEntry(slug: string, isPkg: boolean): CustomSkill | null {
    const filePath = isPkg ? packageSkillFilePath(slug) : skillFilePath(slug);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseCustomSkillMarkdown(raw, slug);
      const stat = fs.statSync(filePath);
      if (!parsed.createdAt) parsed.createdAt = stat.mtime.toISOString();
      if (!parsed.updatedAt) parsed.updatedAt = stat.mtime.toISOString();
      parsed.filePath = isPkg
        ? `custom-skills/${slug}/SKILL.md`
        : `custom-skills/${slug}.md`;
      parsed.isPackage = isPkg;
      if (isPkg) {
        const scripts = scanPackageScripts(slug);
        if (scripts.length > 0) {
          parsed.scripts = scripts;
        }
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function listCustomSkills({
    query = "",
    enabledOnly = false,
    botId = "",
  }: { query?: string; enabledOnly?: boolean; botId?: string } = {}): CustomSkill[] {
    if (!fs.existsSync(rootDir)) return [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const byId = new Map<string, CustomSkill>();

    // Scan directory packages first (canonical when both exist), then single .md files
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const slug = ent.name;
      if (!isValidCustomSkillId(slug)) continue;
      const parsed = readSkillEntry(slug, true);
      if (parsed) byId.set(parsed.id, parsed);
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const slug = ent.name.slice(0, -3);
      if (!isValidCustomSkillId(slug)) continue;
      if (byId.has(slug)) continue;
      const parsed = readSkillEntry(slug, false);
      if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, parsed);
    }

    const list = Array.from(byId.values());
    list.sort(
      (a, b) => (Date.parse(b.updatedAt || "0") || 0) - (Date.parse(a.updatedAt || "0") || 0)
    );

    let filtered = enabledOnly ? list.filter((s) => s.enabled !== false) : list;
    const scopeBotId = String(botId || "").trim();
    if (scopeBotId) {
      filtered = filtered.filter(
        (s) => !s.scope || s.scope === "global" || s.scope === scopeBotId
      );
    }
    const q = String(query || "").trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((s) =>
        `${s.id} ${s.name} ${s.description} ${s.instructions} ${(s.triggers || []).join(" ")} ${s.createdByBotName || ""}`
          .toLowerCase()
          .includes(q)
      );
    }
    return filtered;
  }

  function getCustomSkill(selector: unknown): CustomSkill | null {
    const all = listCustomSkills();
    return findMatchingSkill(all, selector);
  }

  function saveCustomSkill(input: Record<string, any> = {}): CustomSkill & { updated: boolean } {
    const all = listCustomSkills();
    const existing = input.id
      ? all.find((s) => s.id === input.id) || findMatchingSkill(all, input.id)
      : null;
    const isUpdate = Boolean(existing && input.mode !== "create");

    const name = String(
      input.name !== undefined ? input.name : existing?.name || ""
    )
      .trim()
      .slice(0, 64);
    const description = String(
      input.description !== undefined
        ? input.description
        : input.desc !== undefined
          ? input.desc
          : existing?.description || ""
    )
      .trim()
      .slice(0, 240);
    const instructions = String(
      input.instructions !== undefined
        ? input.instructions
        : input.content !== undefined
          ? input.content
          : existing?.instructions || ""
    ).trim();

    if (!name) throw new Error("请填写技能名称（name）");
    if (!description) throw new Error("请填写技能触发场景或简介（description）");
    if (!instructions) throw new Error("请填写技能操作步骤正文（instructions）");

    let targetId: string;
    if (isUpdate && existing) {
      if (input.newId !== undefined && /[\/\\]|\.\./.test(String(input.newId))) {
        throw new Error("非法的技能标识，不允许包含路径符号");
      }
      const requestedNewId =
        input.newId !== undefined ? normalizeCustomSkillSlug(input.newId, "") : existing.id;
      if (!requestedNewId || !isValidCustomSkillId(requestedNewId)) {
        throw new Error("无效的技能标识（slug）");
      }
      if (requestedNewId !== existing.id && all.some((s) => s.id === requestedNewId)) {
        throw new Error(`技能标识「${requestedNewId}」已存在，请换一个标识`);
      }
      targetId = requestedNewId;
    } else {
      const explicitSlug = input.newId || input.slug || input.id;
      if (explicitSlug && /[\/\\]|\.\./.test(String(explicitSlug))) {
        throw new Error("非法的技能标识，不允许包含路径符号");
      }
      const baseSlug = normalizeCustomSkillSlug(explicitSlug || name);
      if (explicitSlug && all.some((s) => s.id === baseSlug)) {
        throw new Error(`技能标识「${baseSlug}」已存在`);
      }
      let candidate = baseSlug;
      let idx = 2;
      while (all.some((s) => s.id === candidate)) {
        candidate = `${baseSlug.slice(0, 56)}-${idx++}`;
      }
      targetId = candidate;
    }

    const scope =
      input.scope !== undefined
        ? normalizeScope(input.scope)
        : normalizeScope(existing?.scope);
    const triggers =
      input.triggers !== undefined
        ? normalizeTriggers(input.triggers)
        : existing?.triggers || [];

    const nowIso = getIsoNow();
    const nextSkill: CustomSkill = {
      id: targetId,
      name,
      icon:
        String(input.icon !== undefined ? input.icon : existing?.icon || "🧩")
          .trim()
          .slice(0, 8) || "🧩",
      description,
      instructions,
      enabled:
        input.enabled !== undefined
          ? Boolean(input.enabled)
          : existing
            ? existing.enabled !== false
            : true,
      scope,
      ...(triggers.length > 0 ? { triggers } : {}),
      createdBy: existing?.createdBy || (input.createdBy === "bot" ? "bot" : "user"),
      createdByBotId: existing?.createdByBotId || String(input.createdByBotId || "").trim(),
      createdByBotName: existing?.createdByBotName || String(input.createdByBotName || "").trim(),
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    const isPackage = Boolean(isUpdate && existing?.isPackage);
    if (isPackage && existing) {
      if (existing.id !== targetId) {
        fs.renameSync(packageDirPath(existing.id), packageDirPath(targetId));
      }
      writeTextAtomic(packageSkillFilePath(targetId), serializeCustomSkillMarkdown(nextSkill));
      const scripts = scanPackageScripts(targetId);
      return {
        ...nextSkill,
        isPackage: true,
        ...(scripts.length > 0 ? { scripts } : {}),
        filePath: `custom-skills/${targetId}/SKILL.md`,
        updated: true,
      };
    }

    const nextPath = skillFilePath(targetId);
    writeTextAtomic(nextPath, serializeCustomSkillMarkdown(nextSkill));

    if (isUpdate && existing && existing.id !== targetId) {
      const oldPath = skillFilePath(existing.id);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    return {
      ...nextSkill,
      isPackage: false,
      filePath: `custom-skills/${targetId}.md`,
      updated: isUpdate,
    };
  }

  function toggleCustomSkill(selector: unknown, enabled?: boolean): CustomSkill {
    const existing = getCustomSkill(selector);
    if (!existing) {
      throw new Error(`未找到自定义技能「${String(selector)}」`);
    }
    const nextEnabled =
      enabled !== undefined ? Boolean(enabled) : !(existing.enabled !== false);
    const updated: CustomSkill = {
      ...existing,
      enabled: nextEnabled,
      updatedAt: getIsoNow(),
    };
    const isPkg = Boolean(existing.isPackage);
    const targetPath = isPkg
      ? packageSkillFilePath(existing.id)
      : skillFilePath(existing.id);
    writeTextAtomic(targetPath, serializeCustomSkillMarkdown(updated));
    return {
      ...updated,
      isPackage: isPkg,
      filePath: isPkg
        ? `custom-skills/${existing.id}/SKILL.md`
        : `custom-skills/${existing.id}.md`,
    };
  }

  function deleteCustomSkill(selector: unknown): CustomSkill | null {
    const existing = getCustomSkill(selector);
    if (!existing) return null;
    if (existing.isPackage) {
      const pkgDir = packageDirPath(existing.id);
      if (fs.existsSync(pkgDir)) {
        fs.rmSync(pkgDir, { recursive: true, force: true });
      }
    }
    const targetPath = skillFilePath(existing.id);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    return existing;
  }

  function saveCustomSkillScript(
    selector: unknown,
    scriptName: unknown,
    content: unknown
  ): { skill: CustomSkill; script: CustomSkillScriptMeta } {
    const existing = getCustomSkill(selector);
    if (!existing) {
      throw new Error(`未找到自定义技能「${String(selector)}」`);
    }
    const cleanName = String(scriptName || "").trim();
    const targetPath = packageScriptPath(existing.id, cleanName);
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("脚本内容（script_content）不能为空");
    }
    const byteLen = Buffer.byteLength(content, "utf-8");
    if (byteLen > MAX_SCRIPT_BYTES) {
      throw new Error(`脚本体积超过上限（最大 ${MAX_SCRIPT_BYTES} 字节）`);
    }

    // Promote plain <id>.md skill to directory package <id>/SKILL.md + scripts/
    if (!existing.isPackage) {
      const nowIso = getIsoNow();
      const promoted: CustomSkill = {
        ...existing,
        updatedAt: nowIso,
      };
      writeTextAtomic(
        packageSkillFilePath(existing.id),
        serializeCustomSkillMarkdown(promoted)
      );
      const legacyFile = skillFilePath(existing.id);
      if (fs.existsSync(legacyFile)) {
        fs.unlinkSync(legacyFile);
      }
    }

    writeTextAtomic(targetPath, content);
    const st = fs.statSync(targetPath);
    const updatedSkill = getCustomSkill(existing.id)!;
    return {
      skill: updatedSkill,
      script: {
        name: cleanName,
        path: targetPath,
        sizeBytes: st.size,
      },
    };
  }

  function readCustomSkillScript(
    selector: unknown,
    scriptName: unknown
  ): { skillId: string; name: string; path: string; content: string; sizeBytes: number } {
    const existing = getCustomSkill(selector);
    if (!existing) {
      throw new Error(`未找到自定义技能「${String(selector)}」`);
    }
    const cleanName = String(scriptName || "").trim();
    const targetPath = packageScriptPath(existing.id, cleanName);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`技能「${existing.id}」中不存在脚本「${cleanName}」`);
    }
    const content = fs.readFileSync(targetPath, "utf-8");
    const st = fs.statSync(targetPath);
    return {
      skillId: existing.id,
      name: cleanName,
      path: targetPath,
      content,
      sizeBytes: st.size,
    };
  }

  function deleteCustomSkillScript(
    selector: unknown,
    scriptName: unknown
  ): { deleted: boolean; skill: CustomSkill } {
    const existing = getCustomSkill(selector);
    if (!existing) {
      throw new Error(`未找到自定义技能「${String(selector)}」`);
    }
    const cleanName = String(scriptName || "").trim();
    const targetPath = packageScriptPath(existing.id, cleanName);
    let deleted = false;
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      deleted = true;
    }
    const updatedSkill = getCustomSkill(existing.id)!;
    return { deleted, skill: updatedSkill };
  }

  return {
    listCustomSkills,
    getCustomSkill,
    saveCustomSkill,
    toggleCustomSkill,
    deleteCustomSkill,
    saveCustomSkillScript,
    readCustomSkillScript,
    deleteCustomSkillScript,
  };
}
