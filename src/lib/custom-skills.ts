import fs from "node:fs";
import path from "node:path";

const SAFE_SLUG_RE = /^[a-z0-9\u4e00-\u9fa5][a-z0-9\u4e00-\u9fa5_-]{0,63}$/i;

export interface CustomSkill {
  id: string;
  name: string;
  icon: string;
  description: string;
  instructions: string;
  enabled: boolean;
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
      else meta[key] = unquoteYamlScalar(val);
    }
    body = String(fmMatch[2] || "").trim();
  }

  const id = isValidCustomSkillId(meta.id)
    ? String(meta.id)
    : isValidCustomSkillId(fallbackId)
      ? String(fallbackId)
      : normalizeCustomSkillSlug(meta.name || fallbackId);

  return {
    id,
    name: String(meta.name || id).trim().slice(0, 64) || id,
    icon: String(meta.icon || "🧩").trim().slice(0, 8) || "🧩",
    description: String(meta.description || "").trim().slice(0, 240),
    instructions: body,
    enabled: meta.enabled !== false,
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
 * Creates a file-backed custom skills repository stored under `customSkillsDir/<slug>.md`.
 */
export function createCustomSkillsRepo(
  customSkillsDir: string,
  { getIsoNow = () => new Date().toISOString() }: { getIsoNow?: () => string } = {}
) {
  const rootDir = path.resolve(customSkillsDir);

  function skillFilePath(id: string): string {
    if (!isValidCustomSkillId(id)) {
      throw new Error("无效的自定义技能标识（id）");
    }
    const target = path.resolve(rootDir, `${id}.md`);
    if (!target.startsWith(rootDir + path.sep)) {
      throw new Error("非法的技能文件路径");
    }
    return target;
  }

  function listCustomSkills({
    query = "",
    enabledOnly = false,
  }: { query?: string; enabledOnly?: boolean } = {}): CustomSkill[] {
    if (!fs.existsSync(rootDir)) return [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const list: CustomSkill[] = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const slug = ent.name.slice(0, -3);
      if (!isValidCustomSkillId(slug)) continue;
      try {
        const raw = fs.readFileSync(path.join(rootDir, ent.name), "utf-8");
        const parsed = parseCustomSkillMarkdown(raw, slug);
        const stat = fs.statSync(path.join(rootDir, ent.name));
        if (!parsed.createdAt) parsed.createdAt = stat.mtime.toISOString();
        if (!parsed.updatedAt) parsed.updatedAt = stat.mtime.toISOString();
        parsed.filePath = `custom-skills/${slug}.md`;
        list.push(parsed);
      } catch {
        // Skip unreadable skill files
      }
    }
    list.sort(
      (a, b) => (Date.parse(b.updatedAt || "0") || 0) - (Date.parse(a.updatedAt || "0") || 0)
    );

    let filtered = enabledOnly ? list.filter((s) => s.enabled !== false) : list;
    const q = String(query || "").trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((s) =>
        `${s.id} ${s.name} ${s.description} ${s.instructions} ${s.createdByBotName || ""}`
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
      createdBy: existing?.createdBy || (input.createdBy === "bot" ? "bot" : "user"),
      createdByBotId: existing?.createdByBotId || String(input.createdByBotId || "").trim(),
      createdByBotName: existing?.createdByBotName || String(input.createdByBotName || "").trim(),
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

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
    writeTextAtomic(skillFilePath(existing.id), serializeCustomSkillMarkdown(updated));
    return {
      ...updated,
      filePath: `custom-skills/${existing.id}.md`,
    };
  }

  function deleteCustomSkill(selector: unknown): CustomSkill | null {
    const existing = getCustomSkill(selector);
    if (!existing) return null;
    const targetPath = skillFilePath(existing.id);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    return existing;
  }

  return {
    listCustomSkills,
    getCustomSkill,
    saveCustomSkill,
    toggleCustomSkill,
    deleteCustomSkill,
  };
}
