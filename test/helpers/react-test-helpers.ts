import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _UP_TWO = path.resolve(_HERE, "..", "..");
export const PROJECT_ROOT =
  path.basename(_UP_TWO) === "dist-server" ? path.dirname(_UP_TWO) : _UP_TWO;

export interface SsrTestModule {
  createInitialState: () => any;
  getState: () => any;
  setState: (patch: any) => void;
  resetStoreForTest: (overrides?: Record<string, any>) => void;
  apiFetch: (url: string, options?: any) => Promise<Response>;
  triggerLanUnreachableFallback: (err?: unknown, opts?: { forceModal?: boolean; suppressModal?: boolean }) => void;
  dismissLanOfflineModal: () => void;
  dismissSessionErrorCard: (
    itemId: string,
    dismissKey?: string,
    seq?: number,
    clientOnly?: boolean
  ) => void;
  handleRealtimePayload: (payload: any) => void;
  markLanReachable: () => void;
  retryActiveLanConnection: (epoch?: number) => Promise<boolean>;
  reloadWorkspaceForActiveAccount: (epoch?: number) => Promise<void>;
  reduceSessionEvent: (
    prev: any,
    evt: any,
    options?: { replay?: boolean }
  ) => any;
  renderAppToStaticMarkup: (overrides?: Record<string, any>) => string;
  renderStreamItemToStaticMarkup: (
    item: any,
    overrides?: Record<string, any>
  ) => string;
  renderMarkdownToStaticMarkup: (text: string) => string;
  renderMarkupPreviewToStaticMarkup: (props: {
    code: string;
    kind?: "html" | "svg";
    badgeLabel?: string;
    lang?: string;
    sourceLabel?: string;
    downloadUrl?: string;
  }) => string;
}

const ssrEntryPath = path.join(
  PROJECT_ROOT,
  "dist-server",
  "web-ssr",
  "ssr-entry.js"
);
export const ssr: SsrTestModule = (await import(
  pathToFileURL(ssrEntryPath).href
)) as SsrTestModule;

export function renderAppHtml(overrides?: Record<string, any>): string {
  return ssr.renderAppToStaticMarkup(overrides);
}

export function renderFullAppHtml(overrides?: Record<string, any>): string {
  const shellHtml = fs.readFileSync(
    path.join(PROJECT_ROOT, "public", "index.html"),
    "utf8"
  );
  const appMarkup = ssr.renderAppToStaticMarkup(overrides);
  return shellHtml.replace(
    '<div id="root"></div>',
    `<div id="root">${appMarkup}</div>`
  );
}

export function readWebDistJs(): string {
  const distDir = path.join(PROJECT_ROOT, "public", "dist");
  const parts: string[] = [];
  if (fs.existsSync(path.join(distDir, "app.js"))) {
    parts.push(fs.readFileSync(path.join(distDir, "app.js"), "utf8"));
  }
  const chunksDir = path.join(distDir, "chunks");
  if (fs.existsSync(chunksDir)) {
    for (const file of fs.readdirSync(chunksDir).sort()) {
      if (file.endsWith(".js") && !file.startsWith("vendor-react")) {
        parts.push(fs.readFileSync(path.join(chunksDir, file), "utf8"));
      }
    }
  }
  return parts.join("\n");
}

function collectSourceFiles(dir: string, acc: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (
      ent.isFile() &&
      (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx"))
    ) {
      acc.push(fs.readFileSync(full, "utf8"));
    }
  }
}

export function readWebSourceTs(): string {
  const acc: string[] = [];
  collectSourceFiles(path.join(PROJECT_ROOT, "src", "web"), acc);
  return acc.join("\n");
}
