import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface KnowledgeSection {
  heading: string;
  body: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  platforms: string[];
  sections: KnowledgeSection[];
  body: string;
  raw: string;
  fileName: string;
}

export interface KnowledgeTopicSummary {
  topic: string;
  title: string;
  summary: string;
  platforms: string[];
  keywords: string[];
  sections: string[];
}

export interface KnowledgeSearchHit {
  topic: string;
  title: string;
  summary: string;
  platforms: string[];
  matchedSection?: string;
  snippet: string;
  score: number;
}

let cachedDocs: KnowledgeDocument[] | null = null;

function resolveKnowledgeDir(): string {
  const candidates = [
    path.join(MODULE_DIR, "knowledge"),
    path.resolve(MODULE_DIR, "..", "..", "..", "src", "agent", "knowledge"),
    path.resolve(process.cwd(), "src", "agent", "knowledge"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  throw new Error(`Knowledge directory not found (checked ${candidates.join(", ")})`);
}

function parseListValue(raw: string): string[] {
  const trimmed = String(raw || "").trim();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return unwrapped
    .split(/[,，]/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(rawText: string, fileName: string): {
  meta: Record<string, string>;
  body: string;
} {
  const text = String(rawText || "").replace(/\r\n/g, "\n");
  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!fmMatch) {
    return {
      meta: { id: fileName.replace(/\.md$/i, "") },
      body: text.trim(),
    };
  }
  const meta: Record<string, string> = {};
  for (const line of fmMatch[1].split("\n")) {
    const m = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) {
      meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return {
    meta,
    body: fmMatch[2].trim(),
  };
}

function splitMarkdownSections(body: string): KnowledgeSection[] {
  const lines = String(body || "").split("\n");
  const sections: KnowledgeSection[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (currentHeading || content) {
      sections.push({
        heading: currentHeading || "Overview",
        body: content,
      });
    }
  };

  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

export function loadKnowledgeDocuments(): KnowledgeDocument[] {
  if (cachedDocs) return cachedDocs;
  const dir = resolveKnowledgeDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const docs: KnowledgeDocument[] = [];
  for (const fileName of files) {
    const raw = fs.readFileSync(path.join(dir, fileName), "utf-8");
    const { meta, body } = parseFrontmatter(raw, fileName);
    const id = String(meta.id || fileName.replace(/\.md$/i, "")).trim();
    const sections = splitMarkdownSections(body);
    const h1TitleMatch = /^#\s+(.+?)\s*$/m.exec(body);
    const title = String(meta.title || h1TitleMatch?.[1] || id).trim();
    const summary = String(meta.summary || "").trim();
    const keywords = parseListValue(meta.keywords || "");
    const platforms = parseListValue(meta.platforms || "desktop,mobile,web");

    docs.push({
      id,
      title,
      summary,
      keywords,
      platforms,
      sections,
      body,
      raw,
      fileName,
    });
  }
  cachedDocs = docs;
  return docs;
}

export function clearKnowledgeCache(): void {
  cachedDocs = null;
}

export function listKnowledgeTopics(): KnowledgeTopicSummary[] {
  return loadKnowledgeDocuments().map((doc) => ({
    topic: doc.id,
    title: doc.title,
    summary: doc.summary,
    platforms: doc.platforms,
    keywords: doc.keywords,
    sections: doc.sections.map((s) => s.heading),
  }));
}

function buildSearchTerms(rawQuery: string): string[] {
  const clean = String(rawQuery || "").trim().toLowerCase();
  if (!clean) return [];
  const terms = new Set<string>([clean]);

  const tokens = clean
    .split(/[\s,，。、；;：:！？!?/()（）\[\]【】"“”'‘’`·\-—_]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const tok of tokens) {
    if (tok.length >= 2) terms.add(tok);
    // Add CJK 2-char bigrams for phrases >= 3 chars so natural Chinese questions match cleanly
    if (/[\u4e00-\u9fff]/.test(tok)) {
      const cjkRuns = tok.match(/[\u4e00-\u9fff]{2,}/g) || [];
      for (const run of cjkRuns) {
        terms.add(run);
        if (run.length >= 3) {
          for (let i = 0; i <= run.length - 2; i += 1) {
            terms.add(run.slice(i, i + 2));
          }
        }
      }
      const latinRuns = tok.match(/[a-z0-9._-]{2,}/g) || [];
      for (const lr of latinRuns) terms.add(lr);
    }
  }
  return Array.from(terms);
}

function extractSnippet(text: string, terms: string[], maxLen = 360): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;

  const lower = normalized.toLowerCase();
  let bestIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }
  if (bestIdx < 0) return `${normalized.slice(0, maxLen)}…`;
  const start = Math.max(0, bestIdx - 80);
  const end = Math.min(normalized.length, start + maxLen);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

export function searchKnowledge(
  query: string,
  { limit = 3 }: { limit?: number } = {}
): { ok: boolean; query: string; results: KnowledgeSearchHit[]; availableTopics: string[] } {
  const docs = loadKnowledgeDocuments();
  const cleanQuery = String(query || "").trim();
  const cappedLimit = Math.min(6, Math.max(1, Number(limit) || 3));
  const availableTopics = docs.map((d) => d.id);

  if (!cleanQuery) {
    return {
      ok: true,
      query: "",
      results: docs.slice(0, cappedLimit).map((d) => ({
        topic: d.id,
        title: d.title,
        summary: d.summary,
        platforms: d.platforms,
        snippet: d.summary,
        score: 1,
      })),
      availableTopics,
    };
  }

  const terms = buildSearchTerms(cleanQuery);
  const fullLower = cleanQuery.toLowerCase();
  const scored: KnowledgeSearchHit[] = [];

  for (const doc of docs) {
    let score = 0;
    const idLower = doc.id.toLowerCase();
    const titleLower = doc.title.toLowerCase();
    const summaryLower = doc.summary.toLowerCase();
    const keywordsLower = doc.keywords.map((k) => k.toLowerCase());
    const bodyLower = doc.body.toLowerCase();

    if (idLower === fullLower) score += 40;
    if (titleLower.includes(fullLower)) score += 20;
    if (summaryLower.includes(fullLower)) score += 12;
    if (keywordsLower.some((k) => k === fullLower)) score += 24;
    else if (keywordsLower.some((k) => k.includes(fullLower) || fullLower.includes(k))) score += 14;
    if (bodyLower.includes(fullLower)) score += 8;

    for (const term of terms) {
      const w = term.length >= 4 ? 1.5 : 1;
      if (idLower.includes(term)) score += 6 * w;
      if (titleLower.includes(term)) score += 6 * w;
      if (summaryLower.includes(term)) score += 4 * w;
      if (keywordsLower.some((k) => k === term)) score += 9 * w;
      else if (keywordsLower.some((k) => k.includes(term))) score += 5 * w;
      if (bodyLower.includes(term)) score += 2 * w;
    }

    if (score <= 0) continue;

    // Pick best matching ## section for targeted snippet
    let bestSec: KnowledgeSection | null = null;
    let bestSecScore = 0;
    for (const sec of doc.sections) {
      const secText = `${sec.heading}\n${sec.body}`.toLowerCase();
      let secScore = 0;
      if (sec.heading.toLowerCase().includes(fullLower)) secScore += 18;
      if (secText.includes(fullLower)) secScore += 10;
      for (const term of terms) {
        if (sec.heading.toLowerCase().includes(term)) secScore += 5;
        if (secText.includes(term)) secScore += 2;
      }
      if (secScore > bestSecScore) {
        bestSecScore = secScore;
        bestSec = sec;
      }
    }

    const snippetSource = bestSec ? `${bestSec.heading}：${bestSec.body}` : doc.summary || doc.body;
    scored.push({
      topic: doc.id,
      title: doc.title,
      summary: doc.summary,
      platforms: doc.platforms,
      ...(bestSec ? { matchedSection: bestSec.heading } : {}),
      snippet: extractSnippet(snippetSource, terms),
      score: Math.round(score * 10) / 10,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    ok: true,
    query: cleanQuery,
    results: scored.slice(0, cappedLimit),
    availableTopics,
  };
}

export function readKnowledgeTopic(
  topic: string,
  { section }: { section?: string } = {}
): Record<string, any> {
  const docs = loadKnowledgeDocuments();
  const cleanTopic = String(topic || "").trim().toLowerCase().replace(/\.md$/i, "");
  const availableTopics = docs.map((d) => ({ topic: d.id, title: d.title }));

  if (!cleanTopic) {
    return {
      ok: false,
      error: "请提供要读取的主题 ID（topic），例如 ui-navigation-desktop。",
      availableTopics,
    };
  }

  let doc = docs.find((d) => d.id.toLowerCase() === cleanTopic);
  if (!doc) {
    const partial = docs.filter(
      (d) =>
        d.id.toLowerCase().includes(cleanTopic) ||
        d.title.toLowerCase().includes(cleanTopic)
    );
    if (partial.length === 1) {
      doc = partial[0];
    }
  }

  if (!doc) {
    return {
      ok: false,
      error: `未找到自知文档主题「${topic}」。`,
      availableTopics,
    };
  }

  const cleanSection = String(section || "").trim().toLowerCase();
  if (cleanSection) {
    const headingMatched = doc.sections.filter((s) =>
      s.heading.toLowerCase().includes(cleanSection)
    );
    const matched =
      headingMatched.length > 0
        ? headingMatched
        : doc.sections.filter((s) => s.body.toLowerCase().includes(cleanSection));
    if (matched.length > 0) {
      return {
        ok: true,
        topic: doc.id,
        title: doc.title,
        summary: doc.summary,
        platforms: doc.platforms,
        filteredSection: section,
        content: matched.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n"),
        allSections: doc.sections.map((s) => s.heading),
      };
    }
  }

  return {
    ok: true,
    topic: doc.id,
    title: doc.title,
    summary: doc.summary,
    platforms: doc.platforms,
    sections: doc.sections.map((s) => s.heading),
    content: doc.body,
  };
}
