import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveTokensInText } from "../lib/channel-integrations.js";
import { createCustomSkillsRepo } from "../lib/custom-skills.js";
import { createLocalCrypto } from "../lib/local-crypto.js";

function redactPersistedValue(val: unknown): any {
  if (typeof val === "string") {
    return val.length > 0 ? redactSensitiveTokensInText(val) : val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactPersistedValue(item));
  }
  if (val && typeof val === "object" && !Buffer.isBuffer(val)) {
    const obj = val as Record<string, any>;
    // Never scan or mutate inline base64 screenshot/image blobs
    if (obj.type === "image" && typeof obj.data === "string") {
      return obj;
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "data" && typeof v === "string" && v.length > 512) {
        out[k] = v;
      } else {
        out[k] = redactPersistedValue(v);
      }
    }
    return out;
  }
  return val;
}

export function normalizeLegacyMemoryList(list: unknown): {
  list: any[];
  changed: boolean;
} {
  if (!Array.isArray(list)) {
    return { list: [], changed: false };
  }
  let changed = false;
  const out = list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    const rec = item as Record<string, any>;
    const hasLegacy = "desc" in rec || "instruction" in rec;
    if (!hasLegacy) return item;
    changed = true;
    const canonicalContent = String(
      rec.content || rec.instruction || rec.desc || ""
    ).trim();
    const { desc: _d, instruction: _i, ...rest } = rec;
    return {
      ...rest,
      content: canonicalContent,
    };
  });
  return { list: out, changed };
}

export function stripVaultItemSecret(item: any): Record<string, any> {
  if (!item || typeof item !== "object") return {};
  const { password, ...rest } = item;
  const hasPassword = typeof password === "string" && password.length > 0;
  return {
    ...rest,
    hasPassword,
  };
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  usage: { input: number; output: number; [key: string]: any };
  type?: string;
  avatar?: Record<string, any>;
  rolePrompt?: string;
  browserMode?: string;
  memories?: Array<Record<string, any>>;
  memberBotIds?: string[];
  createdByBotId?: string;
  isAdmin?: boolean;
  pinned?: boolean;
  unreadCount?: number;
  subtitle?: string;
  [key: string]: any;
}

function isSafeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("..")
  );
}

function writeJsonAtomic(
  filePath: string,
  data: unknown,
  { mode, compact = false }: { mode?: number; compact?: boolean } = {}
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const unique =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${unique}.tmp`;
  fs.writeFileSync(
    tmpFile,
    compact ? JSON.stringify(data) : JSON.stringify(data, null, 2),
    mode !== undefined ? { encoding: "utf-8", mode } : "utf-8"
  );
  if (mode !== undefined) {
    try {
      fs.chmodSync(tmpFile, mode);
    } catch {
      // ignore on platforms without POSIX chmod
    }
  }
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup failures
    }
    throw err;
  }
}

function getLastSeq(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return 0;
    let maxSeq = 0;
    let validCount = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        validCount++;
        if (typeof parsed?.seq === "number" && Number.isFinite(parsed.seq)) {
          maxSeq = Math.max(maxSeq, parsed.seq);
        }
      } catch {
        // skip corrupted line when computing seq high-water mark
      }
    }
    return Math.max(maxSeq, validCount);
  } catch {
    return 0;
  }
}

const INTERRUPTIBLE_STATUSES = new Set([
  "running",
  "paused",
  "awaiting_approval",
  "awaiting_choice",
]);

export function createStore(dataDir: string) {
  const rootDir = path.resolve(dataDir);
  const sessionsDir = path.join(rootDir, "sessions");
  const screensDir = path.join(rootDir, "screens");
  const exchangesDir = path.join(rootDir, "exchanges");
  const customSkillsDir = path.join(rootDir, "custom-skills");
  const settingsFile = path.join(rootDir, "settings.json");
  const settingsBackupFile = path.join(rootDir, "settings.json.bak");
  const schedulesFile = path.join(rootDir, "schedules.json");
  const vaultFile = path.join(rootDir, "vault.json");
  const mailAuthFile = path.join(rootDir, "mail-auth.json");
  const channelsAuthFile = path.join(rootDir, "channels-auth.json");
  const relayAuthFile = path.join(rootDir, "relay-auth.json");
  const accountsAuthFile = path.join(rootDir, "accounts-auth.json");
  const routeStatsFile = path.join(rootDir, "route-stats.ndjson");
  const experienceProposalsFile = path.join(rootDir, "experience-proposals.json");
  const memoryBackupsFile = path.join(rootDir, "memory-backups.json");

  const customSkillsRepo = createCustomSkillsRepo(customSkillsDir, {
    getIsoNow: () => getMonotonicIso(),
  });
  const localCrypto = createLocalCrypto(rootDir);

  const seqMap = new Map<string, number>();
  const eventsCache = new Map<string, Array<Record<string, any>>>();
  let lastTimestamp = 0;

  function getMonotonicIso(prevIso?: string): string {
    const now = Date.now();
    const prevTime = prevIso ? Date.parse(prevIso) : 0;
    const nextTime = Math.max(now, prevTime + 1, lastTimestamp + 1);
    lastTimestamp = nextTime;
    return new Date(nextTime).toISOString();
  }

  function createSession(opts: Record<string, any> = {}): SessionRecord {
    const {
      title,
      type,
      avatar,
      rolePrompt,
      browserMode,
      memories,
      memberBotIds,
      createdByBotId,
      pinned,
      unreadCount,
      subtitle,
    } = opts || {};

    const id = crypto.randomUUID();
    const now = getMonotonicIso();
    const session: SessionRecord = {
      id,
      title: title || "New Session",
      createdAt: now,
      updatedAt: now,
      status: "idle",
      usage: { input: 0, output: 0 },
      ...(type ? { type } : {}),
      ...(avatar ? { avatar } : {}),
      ...(rolePrompt !== undefined ? { rolePrompt } : {}),
      ...(typeof browserMode === "string" && browserMode ? { browserMode } : {}),
      ...(Array.isArray(memories) ? { memories: memories.map((m) => ({ ...m })) } : {}),
      ...(Array.isArray(memberBotIds) ? { memberBotIds } : {}),
      ...(createdByBotId ? { createdByBotId } : {}),
      ...(opts?.isAdmin === true ? { isAdmin: true, pinned: true } : {}),
      ...(opts?.isAdmin !== true && pinned !== undefined ? { pinned: false } : {}),
      ...(typeof unreadCount === "number" ? { unreadCount } : {}),
      ...(subtitle ? { subtitle } : {}),
    };

    const filePath = path.join(sessionsDir, `${id}.json`);
    writeJsonAtomic(filePath, session);
    return session;
  }

  function getSession(id: string): SessionRecord | null {
    if (!isSafeId(id)) return null;
    const filePath = path.join(sessionsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (parsed && Array.isArray(parsed.memories)) {
        const normalized = normalizeLegacyMemoryList(parsed.memories);
        if (normalized.changed) {
          parsed.memories = normalized.list;
          try {
            writeJsonAtomic(filePath, parsed);
          } catch {
            // ignore best-effort lazy migration write
          }
        }
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function updateSession(id: string, patch: Record<string, any>): SessionRecord {
    if (!isSafeId(id)) throw new Error(`Invalid session id: ${id}`);
    const prev = getSession(id);
    if (!prev) throw new Error(`Session not found: ${id}`);

    const updatedAt =
      patch?.touch === false ? prev.updatedAt : getMonotonicIso(prev.updatedAt);

    const cleanPatch = { ...patch };
    delete cleanPatch.touch;
    delete cleanPatch.isAdmin;

    if (prev.isAdmin === true) {
      if (cleanPatch.pinned === false) {
        throw new Error("管理员 Bot 独占置顶位，不可取消置顶");
      }
      cleanPatch.pinned = true;
    } else if (cleanPatch.pinned === true) {
      throw new Error("仅管理员 Bot 可置顶，普通 Bot 不支持置顶");
    } else if (cleanPatch.pinned !== undefined) {
      cleanPatch.pinned = false;
    }

    const usage = cleanPatch.usage
      ? { ...prev.usage, ...cleanPatch.usage }
      : prev.usage;

    if (Array.isArray(cleanPatch.memories)) {
      cleanPatch.memories = normalizeLegacyMemoryList(cleanPatch.memories).list;
    }

    const avatar = cleanPatch.avatar
      ? { ...(prev.avatar || {}), ...cleanPatch.avatar }
      : prev.avatar;

    const updated: SessionRecord = {
      ...prev,
      ...cleanPatch,
      ...(prev.isAdmin === true ? { isAdmin: true, pinned: true } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      id: prev.id,
      createdAt: prev.createdAt,
      updatedAt,
      usage,
    };

    const filePath = path.join(sessionsDir, `${id}.json`);
    writeJsonAtomic(filePath, updated);
    return updated;
  }

  function deleteSession(id: string): boolean {
    if (!isSafeId(id)) return false;
    const prev = getSession(id);
    if (!prev) return false;
    if (prev.isAdmin === true) {
      throw new Error("管理员 Bot 不可删除");
    }
    const jsonPath = path.join(sessionsDir, `${id}.json`);
    if (!fs.existsSync(jsonPath)) return false;

    for (const p of [
      jsonPath,
      path.join(sessionsDir, `${id}.history.json`),
      path.join(sessionsDir, `${id}.ndjson`),
    ]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
    try {
      const sDir = path.join(screensDir, id);
      if (fs.existsSync(sDir)) fs.rmSync(sDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    seqMap.delete(id);
    eventsCache.delete(id);
    return true;
  }

  function clearSession(id: string): SessionRecord | null {
    if (!isSafeId(id)) return null;
    const prev = getSession(id);
    if (!prev) return null;

    for (const p of [
      path.join(sessionsDir, `${id}.history.json`),
      path.join(sessionsDir, `${id}.ndjson`),
    ]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
    try {
      const sDir = path.join(screensDir, id);
      if (fs.existsSync(sDir)) fs.rmSync(sDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    seqMap.delete(id);
    eventsCache.delete(id);
    return updateSession(id, {
      status: "idle",
      lastMessagePreview: "",
      stepCount: 0,
      unreadCount: 0,
      lastMessageAt: undefined,
    });
  }

  function cloneSession(id: string, overrides: Record<string, any> = {}): SessionRecord | null {
    const src = getSession(id);
    if (!src) return null;
    return createSession({
      title: overrides.title || `${src.title || "Bot"} 副本`,
      type: src.type || "dm",
      avatar: overrides.avatar
        ? { ...overrides.avatar }
        : src.avatar
          ? { ...src.avatar }
          : undefined,
      rolePrompt:
        overrides.rolePrompt !== undefined ? overrides.rolePrompt : src.rolePrompt || "",
      memories: Array.isArray(src.memories)
        ? src.memories.map((m) => ({ ...m }))
        : undefined,
      memberBotIds: Array.isArray(src.memberBotIds)
        ? [...src.memberBotIds]
        : undefined,
    });
  }

  function listSessions(): SessionRecord[] {
    if (!fs.existsSync(sessionsDir)) return [];
    try {
      const files = fs.readdirSync(sessionsDir);
      const sessions: SessionRecord[] = [];
      for (const file of files) {
        if (file.endsWith(".json") && !file.endsWith(".history.json")) {
          const filePath = path.join(sessionsDir, file);
          try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            if (parsed && typeof parsed === "object" && parsed.id) {
              sessions.push(parsed);
            }
          } catch {
            // ignore corrupted or unreadable files
          }
        }
      }

      sessions.sort((a, b) => {
        if (Boolean(a.isAdmin) !== Boolean(b.isAdmin)) {
          return a.isAdmin ? -1 : 1;
        }
        const timeA = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const timeB = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        if (timeB !== timeA) return timeB - timeA;
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      });

      return sessions;
    } catch {
      return [];
    }
  }

  function ensureAdminBot(defaults: Record<string, any> = {}): SessionRecord {
    const defaultRolePrompt =
      typeof defaults.rolePrompt === "string" && defaults.rolePrompt.trim()
        ? defaults.rolePrompt
        : "你是用户的主控与全局协调 Bot（Admin Bot），负责日常全能协作、协调并调度其他专属 Bot、管理外部通道配对与定时任务，以及维护并诊断 TwinkleBot 运行环境与电脑沙箱；执行文件/命令操作时严守最小权限与凭据安全边界。";

    const existing = listSessions();
    const currentAdmin = existing.find((s) => s.isAdmin === true && s.type !== "group");
    if (currentAdmin) {
      if (currentAdmin.pinned !== true) {
        return updateSession(currentAdmin.id, { pinned: true, touch: false });
      }
      return currentAdmin;
    }

    const dmBots = existing.filter((s) => s.type !== "group");
    const legacyCandidate =
      dmBots.find((s) => s.pinned === true) ||
      dmBots.find((s) => {
        const t = String(s.title || "").trim().toLowerCase();
        return t === "twinkle" || t === "nori";
      }) ||
      dmBots.find((s) => !s.createdByBotId) ||
      dmBots[0];

    if (legacyCandidate) {
      const promoted: SessionRecord = {
        ...legacyCandidate,
        isAdmin: true,
        pinned: true,
        ...(String(legacyCandidate.rolePrompt || "").trim() ? {} : { rolePrompt: defaultRolePrompt }),
      };
      writeJsonAtomic(path.join(sessionsDir, `${legacyCandidate.id}.json`), promoted);
      return promoted;
    }

    return createSession({
      title: defaults.title || "Twinkle",
      type: "dm",
      avatar: defaults.avatar || { color: "black" },
      rolePrompt: defaultRolePrompt,
      isAdmin: true,
      pinned: true,
    });
  }

  function appendEvent(id: string, event: Record<string, any>) {
    if (!isSafeId(id)) throw new Error(`Invalid session id: ${id}`);
    const ndjsonPath = path.join(sessionsDir, `${id}.ndjson`);
    if (!seqMap.has(id)) {
      seqMap.set(id, getLastSeq(ndjsonPath));
    }
    const seq = (seqMap.get(id) ?? 0) + 1;
    seqMap.set(id, seq);
    const at = new Date().toISOString();
    const safeEvent = redactPersistedValue(event);
    const storedEvent = { ...safeEvent, seq, at };

    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.appendFileSync(ndjsonPath, JSON.stringify(storedEvent) + "\n", "utf-8");
    const cached = eventsCache.get(id);
    if (cached) {
      cached.push(storedEvent);
    }
    return storedEvent;
  }

  function readEvents(id: string): Array<Record<string, any>> {
    if (!isSafeId(id)) return [];
    const cached = eventsCache.get(id);
    if (cached) {
      return cached.slice();
    }
    const ndjsonPath = path.join(sessionsDir, `${id}.ndjson`);
    if (!fs.existsSync(ndjsonPath)) return [];
    try {
      const content = fs.readFileSync(ndjsonPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const events: Array<Record<string, any>> = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // skip truncated/corrupted NDJSON line without dropping the rest of history
        }
      }
      eventsCache.set(id, events);
      return events.slice();
    } catch {
      return [];
    }
  }

  function readEventsTail(id: string, limit = 50): Array<Record<string, any>> {
    const n = Math.max(0, Math.floor(Number(limit) || 0));
    if (n === 0) return [];
    const all = readEvents(id);
    return all.length <= n ? all : all.slice(-n);
  }

  function extractUserStepText(step: any): string {
    if (step?.type !== "user_input" || !Array.isArray(step.content)) return "";
    return step.content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text.trim())
      .join("\n")
      .trim();
  }

  function isRealHistoryUserStep(step: any): boolean {
    if (step?.type !== "user_input" || !Array.isArray(step.content)) return false;
    if (step?.skipUserEvent === true) return false;
    const text = extractUserStepText(step);
    if (!text) return false;
    if (text === "Current screen:" || text === "Current desktop screen:") return false;
    if (
      text.startsWith("[Inter-Bot Handoff") ||
      text.startsWith("[Auto Context Summary]") ||
      text.startsWith("[System Notice]") ||
      text.startsWith("[System Notice:") ||
      text.startsWith("[The user sent new follow-up instructions") ||
      text.startsWith("[自动上下文压缩摘要]") ||
      text.startsWith("[系统提示]") ||
      text.startsWith("[系统提示：") ||
      text.startsWith("[用户在你当前处理过程中发来了新的补充/指令")
    ) {
      return false;
    }
    return true;
  }

  function truncateSessionFromSeq(
    id: string,
    targetSeq: number
  ): {
    session: SessionRecord;
    targetEvent: Record<string, any>;
    keptEvents: Array<Record<string, any>>;
  } | null {
    if (!isSafeId(id)) return null;
    const prev = getSession(id);
    if (!prev) return null;
    const events = readEvents(id);
    const targetIdx = events.findIndex(
      (e) =>
        Number(e.seq) === Number(targetSeq) &&
        (e.type === "user" || e.type === "user_message")
    );
    if (targetIdx === -1) return null;

    const targetEvent = events[targetIdx];
    const isCountedUserEvent = (e: any) =>
      (e.type === "user" || e.type === "user_message") && e.skipUserEvent !== true;
    const totalUserEvents = events.filter(isCountedUserEvent).length;
    const targetUserOrdinal = events.slice(0, targetIdx).filter(isCountedUserEvent).length;
    const turnsFromEnd = totalUserEvents - targetUserOrdinal;

    const keptEvents = events.slice(0, targetIdx);
    const ndjsonPath = path.join(sessionsDir, `${id}.ndjson`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const unique =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    const tmpPath = `${ndjsonPath}.${process.pid}.${Date.now()}.${unique}.tmp`;
    const body = keptEvents.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(tmpPath, body ? `${body}\n` : "", "utf-8");
    fs.renameSync(tmpPath, ndjsonPath);
    eventsCache.set(id, keptEvents.slice());

    let maxSeq = 0;
    for (const ev of keptEvents) {
      const n = Number(ev.seq);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
    seqMap.set(id, maxSeq);

    const history = loadHistory(id);
    const realUserIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      if (isRealHistoryUserStep(history[i])) {
        realUserIndices.push(i);
      }
    }

    let nextHistory: any[];
    const targetTextNorm = String(targetEvent?.text || "").trim();
    let matchedCutIdx: number | null = null;
    if (realUserIndices.length === totalUserEvents && targetUserOrdinal < realUserIndices.length) {
      matchedCutIdx = realUserIndices[targetUserOrdinal];
    } else if (targetTextNorm && realUserIndices.length > 0) {
      const expectedOccurrenceFromStart = events
        .slice(0, targetIdx)
        .filter((e) => isCountedUserEvent(e) && String(e.text || "").trim() === targetTextNorm).length;
      const matchingIndices = realUserIndices.filter(
        (idx) => extractUserStepText(history[idx]) === targetTextNorm
      );
      if (expectedOccurrenceFromStart < matchingIndices.length) {
        matchedCutIdx = matchingIndices[expectedOccurrenceFromStart];
      }
    }
    if (matchedCutIdx !== null) {
      nextHistory = history.slice(0, matchedCutIdx);
    } else if (turnsFromEnd > 0 && realUserIndices.length >= turnsFromEnd) {
      const cutIdx = realUserIndices[realUserIndices.length - turnsFromEnd];
      nextHistory = history.slice(0, cutIdx);
    } else {
      nextHistory = [];
      for (const ev of keptEvents) {
        const text = String(ev.text || "").trim();
        if (!text) continue;
        if (ev.type === "user" || ev.type === "user_message") {
          nextHistory.push({
            type: "user_input",
            content: [{ type: "text", text }],
          });
        } else if (
          ev.type === "assistant" ||
          ev.type === "assistant_message" ||
          ev.type === "assistant_text"
        ) {
          nextHistory.push({ type: "text", text });
        }
      }
    }
    saveHistory(id, nextHistory);

    let lastPreview = "";
    let stepCount = 0;
    for (const ev of keptEvents) {
      if (ev.type === "tool_call") stepCount += 1;
      if (
        (ev.type === "user" ||
          ev.type === "user_message" ||
          ev.type === "assistant" ||
          ev.type === "assistant_message" ||
          ev.type === "assistant_text") &&
        typeof ev.text === "string" &&
        ev.text.trim()
      ) {
        lastPreview = ev.text.trim().slice(0, 120);
      }
    }

    const updated =
      updateSession(id, {
        status: "idle",
        lastMessagePreview: lastPreview,
        stepCount,
      }) || prev;

    return { session: updated, targetEvent, keptEvents };
  }

  function saveHistory(id: string, input: unknown): void {
    if (!isSafeId(id)) throw new Error(`Invalid session id: ${id}`);
    const historyPath = path.join(sessionsDir, `${id}.history.json`);
    writeJsonAtomic(historyPath, redactPersistedValue(input), { compact: true });
  }

  function loadHistory(id: string): any[] {
    if (!isSafeId(id)) return [];
    const historyPath = path.join(sessionsDir, `${id}.history.json`);
    if (!fs.existsSync(historyPath)) return [];
    try {
      const content = fs.readFileSync(historyPath, "utf-8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveScreenshot(id: string, stepNo: number, png: Buffer): string {
    if (!isSafeId(id)) throw new Error(`Invalid session id: ${id}`);
    const fileName = `${String(stepNo).padStart(4, "0")}.png`;
    const dir = path.join(screensDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), png);
    return fileName;
  }

  function screenshotPath(id: string, file: string): string {
    return path.resolve(screensDir, id, file);
  }

  function listScreenshots(id: string) {
    if (!isSafeId(id)) return [];
    const dir = path.join(screensDir, id);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".png"))
        .sort()
        .reverse()
        .map((file) => {
          const full = path.join(dir, file);
          const stat = fs.statSync(full);
          return {
            file,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            url: `/api/screens/${id}/${file}`,
          };
        });
    } catch {
      return [];
    }
  }

  function search(rawQuery = "") {
    const q = String(rawQuery || "").trim().toLowerCase();
    const sessions = listSessions();
    if (!q) {
      return { bots: sessions.slice(0, 12), messages: [] };
    }

    const bots = sessions.filter((s) => {
      const title = String(s.title || "").toLowerCase();
      const role = String(s.rolePrompt || "").toLowerCase();
      return title.includes(q) || role.includes(q);
    });

    const messages: Array<Record<string, any>> = [];
    for (const s of sessions) {
      const events = readEvents(s.id);
      for (const ev of events) {
        if (ev.type !== "user" && ev.type !== "answer") continue;
        const text = String(ev.text || "");
        const idx = text.toLowerCase().indexOf(q);
        if (idx !== -1) {
          const start = Math.max(0, idx - 24);
          const snippet =
            (start > 0 ? "…" : "") +
            text.slice(start, idx + q.length + 44).replace(/\s+/g, " ") +
            (idx + q.length + 44 < text.length ? "…" : "");
          messages.push({
            sessionId: s.id,
            sessionTitle: s.title,
            avatar: s.avatar || null,
            role: ev.type,
            snippet,
            seq: ev.seq,
            at: ev.at,
          });
          if (messages.length >= 25) break;
        }
      }
      if (messages.length >= 25) break;
    }

    return { bots, messages };
  }

  // --- Inter-Bot Exchange Transcripts (`Bot 交流记录`) ---
  function pairExchangeId(botIdA: string, botIdB: string): string {
    const sorted = [String(botIdA), String(botIdB)].sort();
    const hash = crypto
      .createHash("sha1")
      .update(sorted.join("::"))
      .digest("hex")
      .slice(0, 16);
    return `ex_${hash}`;
  }

  function recordExchangeMessage({
    exchangeId,
    fromBot,
    toBot,
    text,
  }: {
    exchangeId?: string;
    fromBot: { id: string; title?: string; avatar?: any };
    toBot: { id: string; title?: string; avatar?: any };
    text: string;
  }) {
    const id = exchangeId || pairExchangeId(fromBot.id, toBot.id);
    if (!isSafeId(id)) throw new Error("Invalid exchange id");
    const filePath = path.join(exchangesDir, `${id}.json`);
    let existing: any = null;
    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        existing = null;
      }
    }

    const now = new Date().toISOString();
    const participantsMap = new Map<string, any>();
    for (const p of existing?.participants || []) {
      if (p?.id) participantsMap.set(p.id, p);
    }
    participantsMap.set(fromBot.id, {
      id: fromBot.id,
      title: fromBot.title || "Bot",
      avatar: fromBot.avatar || null,
    });
    participantsMap.set(toBot.id, {
      id: toBot.id,
      title: toBot.title || "Bot",
      avatar: toBot.avatar || null,
    });

    const msg = {
      id: crypto.randomUUID(),
      fromBotId: fromBot.id,
      fromBotName: fromBot.title || "Bot",
      fromAvatar: fromBot.avatar || null,
      toBotId: toBot.id,
      toBotName: toBot.title || "Bot",
      text: String(text || ""),
      at: now,
    };

    const next = {
      id,
      updatedAt: now,
      participants: [...participantsMap.values()],
      messages: [...(existing?.messages || []), msg],
    };

    writeJsonAtomic(filePath, next);
    return next;
  }

  function getExchange(exchangeId: string) {
    if (!isSafeId(exchangeId)) return null;
    const filePath = path.join(exchangesDir, `${exchangeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  function tryParseSettingsFile(
    filePath: string
  ):
    | { ok: true; data: Record<string, any> }
    | { ok: false; missing?: boolean; error?: unknown } {
    if (!fs.existsSync(filePath)) return { ok: false, missing: true };
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.trim()) return { ok: false, error: new Error("empty settings file") };
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, data: parsed };
      }
      return { ok: false, error: new Error("invalid settings object") };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function migrateSettingsLegacyMemories(
    data: Record<string, any>,
    fileToUpdate?: string
  ): Record<string, any> {
    if (!data || !Array.isArray(data.globalMemories)) return data;
    const normalized = normalizeLegacyMemoryList(data.globalMemories);
    if (!normalized.changed) return data;
    const next = { ...data, globalMemories: normalized.list };
    if (fileToUpdate) {
      try {
        writeJsonAtomic(fileToUpdate, next);
      } catch {
        // ignore best-effort lazy migration write
      }
    }
    return next;
  }

  function readSettings(): Record<string, any> {
    const primary = tryParseSettingsFile(settingsFile);
    if (primary.ok) return migrateSettingsLegacyMemories(primary.data, settingsFile);
    const backup = tryParseSettingsFile(settingsBackupFile);
    if (backup.ok) return migrateSettingsLegacyMemories(backup.data);
    return {};
  }

  function writeSettings(patch: Record<string, any>): Record<string, any> {
    const primary = tryParseSettingsFile(settingsFile);
    let existing: Record<string, any>;
    if (primary.ok) {
      existing = primary.data;
    } else if (primary.missing) {
      const backup = tryParseSettingsFile(settingsBackupFile);
      existing = backup.ok ? backup.data : {};
    } else {
      const backup = tryParseSettingsFile(settingsBackupFile);
      if (backup.ok) {
        try {
          fs.copyFileSync(settingsFile, `${settingsFile}.corrupt.${Date.now()}`);
        } catch {
          // ignore backup copy failures
        }
        existing = backup.data;
      } else {
        throw new Error(
          `Refusing to overwrite unreadable settings.json: ${
            (primary.error as Error)?.message || "parse error"
          }`
        );
      }
    }

    const cleanPatch = { ...patch };
    if (Array.isArray(cleanPatch.globalMemories)) {
      cleanPatch.globalMemories = normalizeLegacyMemoryList(cleanPatch.globalMemories).list;
    }
    const updated = migrateSettingsLegacyMemories({ ...existing, ...cleanPatch });
    if (primary.ok) {
      try {
        writeJsonAtomic(settingsBackupFile, existing);
      } catch {
        // best-effort backup before atomic replace
      }
    }
    writeJsonAtomic(settingsFile, updated);
    return updated;
  }

  function readSchedules(): any[] {
    if (!fs.existsSync(schedulesFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(schedulesFile, "utf-8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeSchedules(schedules: any[]): any[] {
    const list = Array.isArray(schedules) ? schedules : [];
    writeJsonAtomic(schedulesFile, list);
    return list;
  }

  const MAX_PENDING_PROPOSALS_PER_SESSION = 10;
  const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

  function readAllExperienceProposals(): any[] {
    if (!fs.existsSync(experienceProposalsFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(experienceProposalsFile, "utf-8"));
      if (!Array.isArray(parsed)) return [];
      const cutoff = Date.now() - PROPOSAL_TTL_MS;
      const pruned = parsed.filter((p) => {
        if (!p || typeof p !== "object") return false;
        if (p.status !== "pending") return true;
        const createdMs = Date.parse(String(p.createdAt || "")) || Date.now();
        return createdMs >= cutoff;
      });
      if (pruned.length !== parsed.length) {
        writeJsonAtomic(experienceProposalsFile, pruned);
      }
      return pruned;
    } catch {
      return [];
    }
  }

  function listExperienceProposals({
    sessionId = "",
    status = "",
  }: { sessionId?: string; status?: string } = {}): any[] {
    const all = readAllExperienceProposals();
    return all
      .filter((p) => {
        if (sessionId && p.sessionId !== sessionId) return false;
        if (status && status !== "all" && p.status !== status) return false;
        return true;
      })
      .sort(
        (a, b) =>
          (Date.parse(String(b.createdAt || "0")) || 0) -
          (Date.parse(String(a.createdAt || "0")) || 0)
      );
  }

  function addExperienceProposal(proposal: Record<string, any>): Record<string, any> {
    const all = readAllExperienceProposals();
    const sid = String(proposal?.sessionId || "").trim();
    const record = {
      ...proposal,
      id: String(proposal?.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      status: proposal?.status === "accepted" || proposal?.status === "dismissed" ? proposal.status : "pending",
      createdAt: String(proposal?.createdAt || getMonotonicIso()),
    };
    const next = [record, ...all];
    if (sid) {
      let pendingForSession = 0;
      const trimmed: any[] = [];
      for (const item of next) {
        if (item.sessionId === sid && item.status === "pending") {
          pendingForSession += 1;
          if (pendingForSession > MAX_PENDING_PROPOSALS_PER_SESSION) continue;
        }
        trimmed.push(item);
      }
      writeJsonAtomic(experienceProposalsFile, trimmed);
      return record;
    }
    writeJsonAtomic(experienceProposalsFile, next);
    return record;
  }

  function resolveExperienceProposal(
    id: string,
    status: "accepted" | "dismissed",
    meta: Record<string, any> = {}
  ): Record<string, any> | null {
    const all = readAllExperienceProposals();
    const idx = all.findIndex((p) => p && p.id === id);
    if (idx === -1) return null;
    const updated = {
      ...all[idx],
      status,
      resolvedAt: getMonotonicIso(),
      ...meta,
    };
    all[idx] = updated;
    writeJsonAtomic(experienceProposalsFile, all);
    return updated;
  }

  function readAllMemoryBackups(): Array<Record<string, any>> {
    if (!fs.existsSync(memoryBackupsFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(memoryBackupsFile, "utf-8"));
      return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === "object") : [];
    } catch {
      return [];
    }
  }

  function saveMemoryBackup({
    scope,
    sessionId = "",
    botName = "",
    reason = "auto",
    memories = [],
  }: {
    scope: "bot" | "global";
    sessionId?: string;
    botName?: string;
    reason?: string;
    memories: any[];
  }): Record<string, any> {
    const cleanMemories = Array.isArray(memories)
      ? normalizeLegacyMemoryList(memories).list.map((m) =>
          m && typeof m === "object" ? { ...m } : m
        )
      : [];
    const record = {
      id: `membak-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      scope: scope === "global" ? "global" : "bot",
      sessionId: scope === "bot" ? String(sessionId || "").trim() : "",
      botName: scope === "bot" ? String(botName || "").trim() : "",
      reason: String(reason || "auto").trim().slice(0, 80) || "auto",
      count: cleanMemories.length,
      createdAt: getMonotonicIso(),
      memories: cleanMemories,
    };
    const next = [record, ...readAllMemoryBackups()].slice(0, 30);
    writeJsonAtomic(memoryBackupsFile, next);
    const { memories: _m, ...meta } = record;
    return meta;
  }

  function listMemoryBackups(
    opts: { scope?: "bot" | "global"; sessionId?: string; limit?: number } = {}
  ): Array<Record<string, any>> {
    const limit = Math.max(1, Math.min(30, Number(opts.limit) || 10));
    return readAllMemoryBackups()
      .filter((b) => {
        if (opts.scope && b.scope !== opts.scope) return false;
        if (opts.sessionId && b.sessionId !== opts.sessionId) return false;
        return true;
      })
      .slice(0, limit)
      .map(({ memories: _m, ...meta }) => meta);
  }

  function getMemoryBackup(backupId: string): Record<string, any> | null {
    const id = String(backupId || "").trim();
    if (!id) return null;
    return readAllMemoryBackups().find((b) => b && b.id === id) || null;
  }

  function readVault(): any[] {
    if (!fs.existsSync(vaultFile)) {
      return [];
    }
    const parsed = localCrypto.readEncryptedJsonFile<unknown>(vaultFile, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  function readVaultPublic(): any[] {
    return readVault().map(stripVaultItemSecret);
  }

  function writeVault(items: any[]): any[] {
    const list = Array.isArray(items) ? items : [];
    localCrypto.writeEncryptedJsonFile(vaultFile, list);
    return list;
  }

  // --- Smart Router v2 outcome stats (`data/route-stats.ndjson`) ---
  function appendRouteStat(entry: unknown): void {
    if (!entry || typeof entry !== "object") return;
    fs.mkdirSync(rootDir, { recursive: true });
    fs.appendFileSync(routeStatsFile, JSON.stringify(entry) + "\n", "utf-8");
  }

  function readRouteStats({ limit = 500 }: { limit?: number } = {}): any[] {
    if (!fs.existsSync(routeStatsFile)) return [];
    try {
      const lines = fs.readFileSync(routeStatsFile, "utf-8").split("\n").filter(Boolean);
      const out: any[] = [];
      for (const line of lines.slice(-Math.max(1, limit))) {
        try {
          out.push(JSON.parse(line));
        } catch {
          // skip corrupt line
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  function readEncryptedObjectFile(filePath: string): Record<string, any> {
    if (!fs.existsSync(filePath)) return {};
    const parsed = localCrypto.readEncryptedJsonFile<unknown>(filePath, {});
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {};
  }

  function writeEncryptedObjectFile(filePath: string, nextData: unknown): Record<string, any> {
    const clean =
      nextData && typeof nextData === "object" && !Array.isArray(nextData)
        ? (nextData as Record<string, any>)
        : {};
    localCrypto.writeEncryptedJsonFile(filePath, clean);
    return clean;
  }

  function readMailAuth(): Record<string, any> {
    return readEncryptedObjectFile(mailAuthFile);
  }

  function writeMailAuth(nextData: unknown): Record<string, any> {
    return writeEncryptedObjectFile(mailAuthFile, nextData);
  }

  function readChannelsAuth(): Record<string, any> {
    return readEncryptedObjectFile(channelsAuthFile);
  }

  function writeChannelsAuth(nextData: unknown): Record<string, any> {
    return writeEncryptedObjectFile(channelsAuthFile, nextData);
  }

  function readRelayAuth(): Record<string, any> {
    return readEncryptedObjectFile(relayAuthFile);
  }

  function writeRelayAuth(nextData: unknown): Record<string, any> {
    return writeEncryptedObjectFile(relayAuthFile, nextData);
  }

  function readAccountsAuth(): Record<string, any> {
    return readEncryptedObjectFile(accountsAuthFile);
  }

  function writeAccountsAuth(nextData: unknown): Record<string, any> {
    return writeEncryptedObjectFile(accountsAuthFile, nextData);
  }

  function markInterrupted(): number {
    const sessions = listSessions();
    let count = 0;
    for (const session of sessions) {
      if (INTERRUPTIBLE_STATUSES.has(session.status)) {
        updateSession(session.id, { status: "interrupted" });
        appendEvent(session.id, { type: "status", status: "interrupted" });
        count++;
      }
    }
    return count;
  }

  return {
    dataDir: rootDir,
    createSession,
    getSession,
    updateSession,
    deleteSession,
    clearSession,
    truncateSessionFromSeq,
    cloneSession,
    listSessions,
    ensureAdminBot,
    appendEvent,
    readEvents,
    readEventsTail,
    saveHistory,
    loadHistory,
    saveScreenshot,
    screenshotPath,
    listScreenshots,
    search,
    pairExchangeId,
    recordExchangeMessage,
    getExchange,
    readSettings,
    writeSettings,
    readSchedules,
    writeSchedules,
    readVault,
    readVaultPublic,
    writeVault,
    appendRouteStat,
    readRouteStats,
    readMailAuth,
    writeMailAuth,
    readChannelsAuth,
    writeChannelsAuth,
    readRelayAuth,
    writeRelayAuth,
    readAccountsAuth,
    writeAccountsAuth,
    listCustomSkills: customSkillsRepo.listCustomSkills,
    getCustomSkill: customSkillsRepo.getCustomSkill,
    saveCustomSkill: customSkillsRepo.saveCustomSkill,
    toggleCustomSkill: customSkillsRepo.toggleCustomSkill,
    deleteCustomSkill: customSkillsRepo.deleteCustomSkill,
    saveCustomSkillScript: customSkillsRepo.saveCustomSkillScript,
    readCustomSkillScript: customSkillsRepo.readCustomSkillScript,
    deleteCustomSkillScript: customSkillsRepo.deleteCustomSkillScript,
    listExperienceProposals,
    addExperienceProposal,
    resolveExperienceProposal,
    saveMemoryBackup,
    listMemoryBackups,
    getMemoryBackup,
    markInterrupted,
  };
}

export default { createStore };
