import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HeadlessChromeSession } from "./cdp-browser-harness.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _UP_TWO = path.resolve(_HERE, "..", "..");
export const PROJECT_ROOT =
  path.basename(_UP_TWO) === "dist-server" ? path.dirname(_UP_TWO) : _UP_TWO;

export const TEST_RESULTS_DIR = path.join(PROJECT_ROOT, "test-results");
export const CASES_DIR = path.join(TEST_RESULTS_DIR, "cases");
export const EVIDENCE_DIR = path.join(TEST_RESULTS_DIR, "evidence");

export type PriorityTier = "P0" | "P1" | "P2" | "P3";
export type FeatureTier = "F1" | "F2" | "F3";
export type DifficultyTier = "D1" | "D2" | "D3";
export type CaseOutcome = "PASS" | "BUG" | "UX_DESIGN" | "ENV_SKIP";

export interface AtomicCaseMeta {
  id: string;
  suite: string;
  priority: PriorityTier;
  featureTier: FeatureTier;
  difficulty: DifficultyTier;
  title: string;
  module: string;
}

export interface AtomicCaseRecord extends AtomicCaseMeta {
  status: CaseOutcome;
  durationMs: number;
  error?: string;
  stack?: string;
  reproCommand?: string;
  evidenceDir?: string;
  screenshotPath?: string;
  pageErrors?: string[];
  consoleErrors?: string[];
  extraEvidence?: Record<string, any>;
  recordedAt: string;
}

function parseCaseFilter(): string[] {
  const raw = String(process.env.TWINKLEBOT_E2E_CASES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function matchesCaseFilter(caseId: string): boolean {
  const filters = parseCaseFilter();
  if (filters.length === 0) return true;
  const upper = caseId.toUpperCase();
  return filters.some((pat) => {
    if (!pat.includes("*")) return upper === pat;
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(upper);
  });
}

export class EnvSkipSignal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EnvSkipSignal";
  }
}

export class UxDesignIssueSignal extends Error {
  detail?: Record<string, any>;
  constructor(message: string, detail?: Record<string, any>) {
    super(message);
    this.name = "UxDesignIssueSignal";
    this.detail = detail;
  }
}

export function saveSuiteRecords(suiteName: string, records: AtomicCaseRecord[]): string {
  fs.mkdirSync(CASES_DIR, { recursive: true });
  const safeName = suiteName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const outPath = path.join(CASES_DIR, `${safeName}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ suite: suiteName, updatedAt: new Date().toISOString(), records }, null, 2), "utf8");
  return outPath;
}

export function createSuiteCollector(suiteName: string) {
  const records: AtomicCaseRecord[] = [];
  // Wipe stale per-suite JSON upfront so setup crashes never leave yesterday's PASS behind
  try {
    const safeName = suiteName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const stalePath = path.join(CASES_DIR, `${safeName}.json`);
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  } catch {}

  const shouldRun = (caseId: string): boolean => matchesCaseFilter(caseId);

  async function runCase(
    t: any,
    meta: Omit<AtomicCaseMeta, "suite">,
    fn: (ctx: {
      setEvidence: (key: string, value: any) => void;
      getChrome?: () => HeadlessChromeSession | null;
    }) => Promise<void>,
    opts: { getChrome?: () => HeadlessChromeSession | null } = {}
  ): Promise<void> {
    if (!matchesCaseFilter(meta.id)) {
      return;
    }
    const fullMeta: AtomicCaseMeta = { ...meta, suite: suiteName };
    const extraEvidence: Record<string, any> = {};
    const label = `${fullMeta.id} [${fullMeta.featureTier}×${fullMeta.difficulty}] ${fullMeta.title}`;

    await t.test(label, async (subT: any) => {
      const start = Date.now();
      const chrome = opts.getChrome?.() || null;
      const pageErrArr = chrome ? (chrome.allPageErrors || chrome.pageErrors) : null;
      const consoleErrArr = chrome ? (chrome.allConsoleErrors || chrome.consoleErrors) : null;
      const prevPageErrLen = pageErrArr ? pageErrArr.length : 0;
      const prevConsoleErrLen = consoleErrArr ? consoleErrArr.length : 0;
      if (chrome) {
        await chrome.setHudStatus({
          id: fullMeta.id,
          priority: fullMeta.priority,
          title: fullMeta.title,
          state: "running",
        });
      }

      try {
        await fn({
          setEvidence: (k, v) => {
            extraEvidence[k] = v;
          },
          getChrome: opts.getChrome,
        });

        const activeChrome = opts.getChrome?.() || chrome || null;
        const activePageErrs = activeChrome ? (activeChrome.allPageErrors || activeChrome.pageErrors) : pageErrArr;
        const activeConsoleErrs = activeChrome ? (activeChrome.allConsoleErrors || activeChrome.consoleErrors) : consoleErrArr;
        const newPageErrors = activePageErrs ? activePageErrs.slice(prevPageErrLen) : [];
        const newConsoleErrors = activeConsoleErrs ? activeConsoleErrs.slice(prevConsoleErrLen) : [];
        if (newPageErrors.length > 0) {
          throw new Error(`Uncaught browser pageErrors: ${newPageErrors.join(" | ")}`);
        }
        if (activeChrome) {
          await activeChrome.setHudStatus({
            id: fullMeta.id,
            priority: fullMeta.priority,
            title: fullMeta.title,
            state: "pass",
          });
        }

        const rec: AtomicCaseRecord = {
          ...fullMeta,
          status: "PASS",
          durationMs: Date.now() - start,
          reproCommand: `node scripts/run-e2e.mjs --case=${fullMeta.id}`,
          ...(newConsoleErrors.length > 0 ? { consoleErrors: newConsoleErrors } : {}),
          ...(Object.keys(extraEvidence).length > 0 ? { extraEvidence } : {}),
          recordedAt: new Date().toISOString(),
        };
        records.push(rec);
        saveSuiteRecords(suiteName, records);
      } catch (err: any) {
        const durationMs = Date.now() - start;
        if (err instanceof EnvSkipSignal) {
          const rec: AtomicCaseRecord = {
            ...fullMeta,
            status: "ENV_SKIP",
            durationMs,
            error: err.message,
            reproCommand: `node scripts/run-e2e.mjs --case=${fullMeta.id}`,
            recordedAt: new Date().toISOString(),
          };
          records.push(rec);
          saveSuiteRecords(suiteName, records);
          subT.skip(err.message);
          return;
        }

        const status: CaseOutcome = err instanceof UxDesignIssueSignal ? "UX_DESIGN" : "BUG";
        const evDir = path.join(EVIDENCE_DIR, fullMeta.id);
        fs.mkdirSync(evDir, { recursive: true });

        let screenshotPath: string | undefined;
        let domExcerpt: string | undefined;
        const activeChrome = opts.getChrome?.() || chrome || null;
        if (activeChrome) {
          await activeChrome.setHudStatus({
            id: fullMeta.id,
            priority: fullMeta.priority,
            title: fullMeta.title,
            state: "fail",
          });
          try {
            const shotFile = path.join(evDir, "failure.png");
            await activeChrome.captureScreenshot(shotFile);
            screenshotPath = shotFile;
          } catch {}
          try {
            domExcerpt = await activeChrome.evalJs<string>(
              `document.body ? document.body.innerText.slice(0, 2000) : ""`
            );
          } catch {}
        }

        const activePageErrs = activeChrome ? (activeChrome.allPageErrors || activeChrome.pageErrors) : pageErrArr;
        const activeConsoleErrs = activeChrome ? (activeChrome.allConsoleErrors || activeChrome.consoleErrors) : consoleErrArr;
        const newPageErrors = activePageErrs ? activePageErrs.slice(prevPageErrLen) : [];
        const newConsoleErrors = activeConsoleErrs ? activeConsoleErrs.slice(prevConsoleErrLen) : [];

        const rec: AtomicCaseRecord = {
          ...fullMeta,
          status,
          durationMs,
          error: String(err?.message || err),
          stack: String(err?.stack || ""),
          reproCommand: `node scripts/run-e2e.mjs --case=${fullMeta.id}`,
          evidenceDir: evDir,
          ...(screenshotPath ? { screenshotPath } : {}),
          ...(newPageErrors.length > 0 ? { pageErrors: newPageErrors } : {}),
          ...(newConsoleErrors.length > 0 ? { consoleErrors: newConsoleErrors } : {}),
          extraEvidence: {
            ...extraEvidence,
            ...(err instanceof UxDesignIssueSignal && err.detail ? { uxDetail: err.detail } : {}),
            ...(domExcerpt ? { domExcerpt } : {}),
          },
          recordedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(evDir, "details.json"), JSON.stringify(rec, null, 2), "utf8");
        records.push(rec);
        saveSuiteRecords(suiteName, records);
        throw err;
      }
    });
  }

  return { records, runCase, shouldRun };
}
