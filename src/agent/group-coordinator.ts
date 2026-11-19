/**
 * Group Chat Coordinator for Multi-Bot Conversations (`type: "group"`).
 * Resolves @Bot mentions, scores member relevance when unmentioned, and bounds turn chains.
 */

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

  // Sort longest title first so `@谷歌账号管家` matches before `@谷歌`
  const sorted = [...memberBots].sort(
    (a, b) => String(b.title || "").length - String(a.title || "").length
  );

  for (const bot of sorted) {
    const name = String(bot.title || "").trim();
    if (!name) continue;
    const idx = content.toLowerCase().indexOf(`@${name.toLowerCase()}`);
    if (idx !== -1 && !seen.has(bot.id)) {
      seen.add(bot.id);
      matched.push({ bot, pos: idx });
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

  const mentioned = extractMentionedBots(text, candidates);

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

  // Score by role/title relevance; if nobody stands out, pick up to maxSpeakers (or first 2)
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

  return scored.slice(0, Math.min(maxSpeakers, 2)).map((s) => s.bot);
}

/**
 * Builds a concise textual transcript from recent group events so each Bot
 * clearly sees what the user and other Bots just said.
 */
export function buildGroupPromptContext(
  events: any[] = [],
  currentUserText = "",
  limit = 14
): string {
  const relevant = events
    .filter((e) => e && (e.type === "user" || e.type === "answer"))
    .slice(-limit);

  if (relevant.length === 0) {
    return `[User]: ${currentUserText}`;
  }

  const lines = relevant.map((ev) => {
    if (ev.type === "user") {
      return `[User]: ${ev.text || ""}`;
    }
    const speaker = ev.botName || "Bot";
    return `[${speaker}]: ${ev.text || ""}`;
  });

  return `Recent group conversation:\n${lines.join("\n")}\n\nRespond now in character to the latest message.`;
}
