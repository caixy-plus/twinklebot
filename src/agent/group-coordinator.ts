/**
 * Group Chat Coordinator for Multi-Bot Conversations (`type: "group"`).
 * Resolves @Bot mentions, scores member relevance when unmentioned, and bounds turn chains.
 */

import {
  formatLocalTimestampWithOffset,
  formatMessageSourceHeader,
  formatMessageTimeHeader,
} from "../lib/channel-integrations.js";

export const MAX_GROUP_TURNS = 3;

export interface GroupMemberBot {
  id: string;
  title?: string;
  rolePrompt?: string;
  isAdmin?: boolean;
}

export function extractMentionedBots(
  text = "",
  memberBots: GroupMemberBot[] = []
): GroupMemberBot[] {
  const content = String(text || "");
  if (!content.includes("@")) return [];

  const matched: Array<{ bot: GroupMemberBot; pos: number }> = [];
  const seen = new Set<string>();
  let maskedContent = content;

  // Sort longest title first so `@谷歌账号管家` matches before `@谷歌`
  const sorted = [...memberBots].sort(
    (a, b) => String(b.title || "").length - String(a.title || "").length
  );

  for (const bot of sorted) {
    const name = String(bot.title || "").trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionRe = new RegExp(
      `(?:^|[^a-zA-Z0-9_.-])(@${escaped})(?=$|[\\s,，。、；;：:!?！？)）\\]】"'\\\`]|\\.(?![a-zA-Z0-9])|[^a-zA-Z0-9_.\\u4e00-\\u9fff-])`,
      "i"
    );
    const m = mentionRe.exec(maskedContent);
    if (m && !seen.has(bot.id)) {
      const mentionToken = m[1];
      const mentionPos = m.index + (m[0].length - mentionToken.length);
      seen.add(bot.id);
      matched.push({ bot, pos: mentionPos });
      maskedContent =
        maskedContent.slice(0, mentionPos) +
        " ".repeat(mentionToken.length) +
        maskedContent.slice(mentionPos + mentionToken.length);
    }
  }

  matched.sort((a, b) => a.pos - b.pos);
  return matched.map((m) => m.bot);
}

function scoreBotRelevance(text = "", bot: Partial<GroupMemberBot> = {}): number {
  const lower = String(text || "").toLowerCase();
  let score = 0;
  const title = String(bot.title || "").toLowerCase();
  const role = String(bot.rolePrompt || "").toLowerCase();

  if (title && lower.includes(title)) score += 5;

  const rawTokens = `${title} ${role}`
    .split(/[\s,，。、；;：:/()（）-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  // Split continuous CJK phrases on common Chinese connectors (与/和/及/的/负责/擅长/专精/等)
  const expandedTokens = new Set<string>();
  const cjkChunksForNgrams: string[] = [];
  for (const tok of rawTokens) {
    expandedTokens.add(tok);
    if (/[\u4e00-\u9fff]/.test(tok)) {
      const subParts = tok
        .split(/(?:负责|擅长|专精|精通|处理|编写|以及|或者|[与和及的为对在中并等])/)
        .map((p) => p.trim())
        .filter((p) => p.length >= 2);
      for (const p of subParts) {
        expandedTokens.add(p);
        if (p.length >= 3 && /^[\u4e00-\u9fff]+$/.test(p)) {
          cjkChunksForNgrams.push(p);
        }
      }
    }
  }

  const matchedTokens = new Set<string>();
  for (const tok of expandedTokens) {
    if (lower.includes(tok)) {
      score += 2;
      matchedTokens.add(tok);
    }
  }

  // Fallback CJK 2-gram overlap for long unspaced Chinese phrases that didn't match verbatim
  const seenBigrams = new Set<string>();
  for (const chunk of cjkChunksForNgrams) {
    if (matchedTokens.has(chunk)) continue;
    for (let i = 0; i <= chunk.length - 2; i++) {
      const bi = chunk.slice(i, i + 2);
      if (seenBigrams.has(bi)) continue;
      seenBigrams.add(bi);
      if (lower.includes(bi)) {
        score += 0.5;
      }
    }
  }

  return score;
}

/**
 * Selects which member Bot(s) should respond to a message in a group chat.
 */
export function selectGroupSpeakers({
  text = "",
  memberBots = [],
  excludeBotId = null,
  replyToBotId = null,
  maxSpeakers = 2,
}: {
  text?: string;
  memberBots?: GroupMemberBot[];
  excludeBotId?: string | null;
  replyToBotId?: string | null;
  maxSpeakers?: number;
} = {}): GroupMemberBot[] {
  const candidates = memberBots.filter((b) => b && b.id !== excludeBotId);
  if (candidates.length === 0) return [];

  const allMentioned = extractMentionedBots(text, memberBots);
  const mentioned = excludeBotId
    ? allMentioned.filter((b) => b.id !== excludeBotId)
    : allMentioned;

  // GrokBot Reply Routing: replying directly to a specific Bot's message in a group chat prioritizes that Bot first
  if (replyToBotId) {
    const repliedBot = candidates.find((b) => b.id === replyToBotId);
    if (repliedBot) {
      const rest = mentioned.filter((b) => b.id !== repliedBot.id);
      return [repliedBot, ...rest].slice(0, maxSpeakers);
    }
  }

  if (mentioned.length > 0) {
    return mentioned.slice(0, maxSpeakers);
  }

  // Score by role/title relevance; if nobody stands out, pick Admin Bot (or 1 fallback) instead of spraying multiple bots
  const scored = candidates.map((bot, index) => ({
    bot,
    score: scoreBotRelevance(text, bot),
    index,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  const hasPositiveMatch = scored[0].score > 0;
  if (hasPositiveMatch) {
    return scored
      .filter((s) => s.score > 0)
      .slice(0, maxSpeakers)
      .map((s) => s.bot);
  }

  const adminCandidate = scored.find((s) => s.bot.isAdmin);
  return adminCandidate ? [adminCandidate.bot] : [scored[0].bot];
}

function summarizeGroupAttachments(attachments: any): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const names = attachments
    .map((a) => String(a?.name || a?.title || a?.path || a?.url || "file").trim())
    .filter(Boolean)
    .slice(0, 4);
  return names.length > 0 ? ` [Attachments: ${names.join(", ")}]` : "";
}

function formatGroupToolResultSummary(ev: any): string {
  const res = ev?.result;
  if (!res || typeof res !== "object") return "";
  const toolName = String(ev.name || "").trim();
  if (!toolName) return "";
  const isDeliverable =
    toolName === "send_file" ||
    toolName === "generate_image" ||
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "host_edit_file";
  const pathOrUrl = res.path || res.source_path || res.url || "";
  const errText = res.error ? String(res.error).replace(/\s+/g, " ").slice(0, 100) : "";
  if (!isDeliverable && !pathOrUrl && !errText) return "";
  const speaker = ev.botName || "Bot";
  const detail = errText
    ? `error: ${errText}`
    : pathOrUrl
      ? `${res.title || res.name || pathOrUrl} (${pathOrUrl})`
      : "ok";
  return `[Tool ${speaker} · ${toolName}]: ${detail.slice(0, 160)}`;
}

/**
 * Builds a concise textual transcript from recent group events so each Bot
 * clearly sees what the user and other Bots just said, including deliverables and attachments.
 */
export function buildGroupPromptContext(
  events: any[] = [],
  currentUserText = "",
  limit = 14
): string {
  const relevant = events
    .filter(
      (e) =>
        e &&
        (e.type === "user" ||
          e.type === "answer" ||
          (e.type === "result" && Boolean(formatGroupToolResultSummary(e))))
    )
    .slice(-limit);

  if (relevant.length === 0) {
    return `[User]: ${currentUserText}`;
  }

  const lines: string[] = [];
  for (const ev of relevant) {
    if (ev.type === "user") {
      const sourceHeader = formatMessageSourceHeader(ev);
      const timeHeader = formatMessageTimeHeader(ev);
      const prefix = [sourceHeader, timeHeader].filter(Boolean).join(" ");
      const body = `${ev.text || ""}${summarizeGroupAttachments(ev.attachments)}`;
      lines.push(prefix ? `[User] ${prefix} ${body}` : `[User]: ${body}`);
    } else if (ev.type === "result") {
      const summary = formatGroupToolResultSummary(ev);
      if (summary) lines.push(summary);
    } else {
      const speaker = ev.botName || "Bot";
      const body = `${ev.text || ""}${summarizeGroupAttachments(ev.attachments)}`;
      const replyRawTs = ev.at || ev.sentAt;
      const replyTs = replyRawTs
        ? formatLocalTimestampWithOffset(replyRawTs, ev.clientTimeZone)
        : "";
      lines.push(replyTs ? `[${speaker} · ${replyTs}]: ${body}` : `[${speaker}]: ${body}`);
    }
  }

  return `Recent group conversation:\n${lines.join("\n")}\n\nRespond now in character to the latest message.`;
}
