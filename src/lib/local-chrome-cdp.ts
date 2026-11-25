import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_BROWSER_DEBUG_PORT,
  normalizeBrowserAutomationSettings,
  type BrowserAutomationMode,
  type BrowserAutomationSettings,
  type LocalBrowserStatusInfo,
} from "../shared/browser-automation.js";

const IDLE_HEADLESS_TTL_MS = 5 * 60 * 1000;
const CDP_CALL_TIMEOUT_MS = 15_000;
const CHROME_READY_TIMEOUT_MS = 12_000;

export interface LocalBrowserExecutionOptions {
  mode: Exclude<BrowserAutomationMode, "bot_computer">;
  sessionKey: string;
  settings?: Partial<BrowserAutomationSettings>;
  dataDir?: string;
  blockedLocalPorts?: number[];
  signal?: AbortSignal;
}

interface CdpTargetInfo {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface ManagedBrowserSession {
  key: string;
  mode: "local_headless" | "local_debug";
  port: number;
  targetId: string | null;
  callerTargets: Map<string, string>;
  child: ChildProcess | null;
  profileDir: string | null;
  ephemeralProfile: boolean;
  lastUsedAt: number;
}

function getCandidateChromePaths(platform = process.platform): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";
    return [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(localAppData
        ? [path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")]
        : []),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function detectLocalChromeExecutable(
  customPath?: string,
  platform = process.platform
): string {
  const explicit = String(customPath || "").trim();
  if (explicit) {
    if (isRegularFile(explicit)) {
      return explicit;
    }
    // macOS convenience: if user points to "/Applications/Google Chrome.app" bundle directory, resolve inner binary
    if (platform === "darwin" && explicit.toLowerCase().endsWith(".app")) {
      const appBase = path.basename(explicit, path.extname(explicit));
      const bundleCandidates = [
        path.join(explicit, "Contents", "MacOS", appBase),
        path.join(explicit, "Contents", "MacOS", "Google Chrome"),
        path.join(explicit, "Contents", "MacOS", "Chromium"),
        path.join(explicit, "Contents", "MacOS", "Brave Browser"),
        path.join(explicit, "Contents", "MacOS", "Microsoft Edge"),
      ];
      for (const bc of bundleCandidates) {
        if (isRegularFile(bc)) return bc;
      }
    }
    // If customPath was explicitly configured to an invalid/directory path, do not spawn it
    return "";
  }
  for (const candidate of getCandidateChromePaths(platform)) {
    if (candidate && isRegularFile(candidate)) {
      return candidate;
    }
  }
  return "";
}

export function resolveDebugProfileDir(dataDir?: string): string {
  const base = dataDir && String(dataDir).trim()
    ? path.resolve(dataDir)
    : path.join(os.tmpdir(), "twinklebot-data");
  return path.join(base, "chrome-debug-profile");
}

function normalizeElementRef(raw: unknown): string {
  const s = String(raw || "")
    .trim()
    .replace(/^\[|\]$/g, "");
  if (!/^e\d+$/i.test(s)) {
    throw new Error(`invalid element ref: "${String(raw || "")}" (expected e1, e2, ...)`);
  }
  return s.toLowerCase();
}

function validateHttpUrl(rawUrl: unknown, blockedLocalPorts: number[] = [3230, 7300]): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("url must be a non-empty string");
  }
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid url: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid url scheme: ${parsed.protocol} (only http/https allowed)`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "169.254.169.254" ||
    host === "::ffff:169.254.169.254" ||
    host === "::ffff:a9fe:a9fe"
  ) {
    throw new Error(`blocked cloud metadata url: ${trimmed}`);
  }
  const isLoopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host === "::ffff:7f00:1" ||
    host.startsWith("::ffff:127.");
  if (isLoopback && blockedLocalPorts.length > 0) {
    const portNum = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (blockedLocalPorts.includes(portNum)) {
      throw new Error(`blocked internal service port on loopback (${portNum})`);
    }
  }
  return parsed.toString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function allocateFreeLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("failed to allocate local port"));
      });
    });
  });
}

async function fetchJsonWithTimeout(
  url: string,
  opts: { method?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const resp = await fetch(url, {
      method: opts.method || "GET",
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onParentAbort);
  }
}

async function isCdpPortReachable(port: number, timeoutMs = 450): Promise<boolean> {
  try {
    const info = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/version`, {
      timeoutMs,
    });
    return Boolean(info && typeof info === "object" && (info.webSocketDebuggerUrl || info.Browser));
  } catch {
    return false;
  }
}

async function waitForCdpReady(port: number, timeoutMs = CHROME_READY_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    if (await isCdpPortReachable(port, 500)) return;
    await sleep(150, signal);
  }
  throw new Error(`Timed out waiting for local Chrome CDP on 127.0.0.1:${port}`);
}

async function listPageTargets(port: number, signal?: AbortSignal): Promise<CdpTargetInfo[]> {
  const raw = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/list`, {
    timeoutMs: 3000,
    signal,
  });
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t: any) =>
      t &&
      t.type === "page" &&
      typeof t.id === "string" &&
      typeof t.webSocketDebuggerUrl === "string" &&
      !String(t.url || "").startsWith("devtools://")
  );
}

async function createPageTarget(
  port: number,
  url = "about:blank",
  signal?: AbortSignal
): Promise<CdpTargetInfo> {
  const encoded = encodeURIComponent(url);
  for (const method of ["PUT", "GET"] as const) {
    try {
      const target = await fetchJsonWithTimeout(
        `http://127.0.0.1:${port}/json/new?${encoded}`,
        { method, timeoutMs: 4000, signal }
      );
      if (target && target.id && target.webSocketDebuggerUrl) {
        return target;
      }
    } catch {
      // Chrome >=111 prefers PUT /json/new; older Chromium accepts GET
    }
  }
  throw new Error(`Failed to open new Chrome tab on 127.0.0.1:${port}`);
}

type CdpCaller = (method: string, params?: Record<string, any>) => Promise<any>;

async function withCdpSocket<T>(
  wsUrl: string,
  fn: (call: CdpCaller) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const WSImpl = globalThis.WebSocket;
  if (typeof WSImpl !== "function") {
    throw new Error("Node.js WebSocket API is unavailable (requires Node 22+)");
  }
  return await new Promise<T>((resolve, reject) => {
    const ws = new WSImpl(wsUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map<
      number,
      {
        resolve: (val: any) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
      }
      pending.clear();
      try {
        ws.close();
      } catch {
        // ignore close error
      }
    };

    const failAll = (err: Error) => {
      if (settled) return;
      settled = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(err);
      }
      pending.clear();
      cleanup();
      reject(err);
    };

    const onAbort = () => failAll(new Error("aborted"));
    if (signal?.aborted) {
      failAll(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const call: CdpCaller = (method, params = {}) =>
      new Promise((resCall, rejCall) => {
        if (ws.readyState !== 1) {
          rejCall(new Error(`CDP socket not open while calling ${method}`));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejCall(new Error(`CDP call timed out: ${method}`));
        }, CDP_CALL_TIMEOUT_MS);
        pending.set(id, { resolve: resCall, reject: rejCall, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err: any) {
          clearTimeout(timer);
          pending.delete(id);
          rejCall(err instanceof Error ? err : new Error(String(err)));
        }
      });

    ws.addEventListener("message", (evt: any) => {
      let msg: any;
      try {
        msg = JSON.parse(String(evt?.data ?? ""));
      } catch {
        return;
      }
      if (typeof msg?.id !== "number") return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result || {});
      }
    });

    ws.addEventListener("error", () => {
      failAll(new Error(`CDP WebSocket connection failed (${wsUrl})`));
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        failAll(new Error("CDP WebSocket closed unexpectedly"));
      }
    });

    ws.addEventListener("open", () => {
      Promise.resolve(fn(call))
        .then((result) => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(result);
          }
        })
        .catch((err) => {
          failAll(err instanceof Error ? err : new Error(String(err)));
        });
    });
  });
}

async function evalCdpJson(call: CdpCaller, expression: string): Promise<any> {
  const res = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res?.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ||
      res.exceptionDetails.text ||
      "JavaScript evaluation failed";
    throw new Error(desc);
  }
  return res?.result?.value;
}

const JS_SNAPSHOT_HELPER = `
function collectTbSnapshot(maxElements, maxText) {
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const isInteractive = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select', 'summary', 'option'].includes(tag)) {
      return !(tag === 'input' && (el.type || '').toLowerCase() === 'hidden');
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'switch'].includes(role)) {
      return true;
    }
    if (el.isContentEditable) return true;
    const tabIdx = el.getAttribute('tabindex');
    return tabIdx !== null && tabIdx !== '-1';
  };
  const visited = new Set();
  const elements = [];
  let seq = 1;
  const walkRoot = (root) => {
    if (!root || visited.has(root)) return;
    visited.add(root);
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      if (el.shadowRoot) walkRoot(el.shadowRoot);
      if ((el.tagName || '').toLowerCase() === 'iframe') {
        try {
          if (el.contentDocument) walkRoot(el.contentDocument);
        } catch {}
      }
      if (elements.length >= maxElements) continue;
      const tag = (el.tagName || '').toLowerCase();
      const isFileInput = tag === 'input' && (el.type || '').toLowerCase() === 'file';
      if (!isInteractive(el)) continue;
      if (!isFileInput && !isVisible(el)) continue;
      const ref = 'e' + seq++;
      try { el.setAttribute('data-tb-ref', ref); } catch {}
      const r = el.getBoundingClientRect();
      const inputType = tag === 'input' ? (el.type || 'text').toLowerCase() : '';
      const isSensitive =
        inputType === 'password' ||
        Boolean(el.dataset && el.dataset.tbSensitive === '1');
      const rawName =
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.innerText ||
        el.textContent ||
        (!isSensitive ? el.value : '') ||
        '';
      const item = {
        ref,
        tag,
        name: String(rawName).replace(/\\s+/g, ' ').trim().slice(0, 100),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
      const role = el.getAttribute('role');
      if (role) item.role = role;
      if (tag === 'input') item.type = inputType;
      if (tag === 'a' && el.href) item.href = String(el.href).slice(0, 180);
      if (['input', 'textarea', 'select'].includes(tag) && !isSensitive) {
        const val = String(el.value || '').slice(0, 100);
        if (val) item.value = val;
      }
      if (el.disabled) item.disabled = true;
      elements.push(item);
    }
  };
  walkRoot(document);
  const rawText = (document.body && (document.body.innerText || document.body.textContent)) || '';
  const text = String(rawText).replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, maxText);
  return {
    ok: true,
    url: String(location.href || ''),
    title: String(document.title || ''),
    viewport: {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0,
      scrollY: Math.round(window.scrollY || 0),
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
    },
    text,
    elements,
    element_count: elements.length,
  };
}
`;

const JS_FIND_REF_HELPER = `
function findTbRef(ref) {
  const visited = new Set();
  const search = (root) => {
    if (!root || visited.has(root)) return null;
    visited.add(root);
    if (root.querySelector) {
      const direct = root.querySelector('[data-tb-ref="' + ref + '"]');
      if (direct) return direct;
    }
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      if (el.shadowRoot) {
        const hit = search(el.shadowRoot);
        if (hit) return hit;
      }
      if ((el.tagName || '').toLowerCase() === 'iframe') {
        try {
          if (el.contentDocument) {
            const hit = search(el.contentDocument);
            if (hit) return hit;
          }
        } catch {}
      }
    }
    return null;
  };
  return search(document);
}
`;

const DENIED_UPLOAD_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  "keychains",
  "chrome-debug-profile",
]);

function isSensitiveLocalUploadPath(rawPath: string): boolean {
  const resolved = path.resolve(rawPath);
  const segs = resolved.split(path.sep);
  if (segs.some((s) => DENIED_UPLOAD_SEGMENTS.has(s.toLowerCase()))) return true;
  const base = path.basename(resolved).toLowerCase();
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "accounts.json" ||
    base === "desktop-config.json" ||
    base === "devices.json" ||
    base === "vault.json" ||
    base === ".vault.key" ||
    base === ".vault.dpapi" ||
    base === "frpc.toml" ||
    base === "frps.toml" ||
    base === "relay-token" ||
    /.*auth.*\.json$/i.test(base)
  );
}

export class LocalChromeManager {
  private sessions = new Map<string, ManagedBrowserSession>();
  private inflightLaunches = new Map<string, Promise<ManagedBrowserSession>>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.reaperTimer = setInterval(() => {
      void this.reapIdleSessions();
    }, 60_000);
    this.reaperTimer.unref?.();
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [key, sess] of this.sessions.entries()) {
      if (sess.mode === "local_headless" && now - sess.lastUsedAt > IDLE_HEADLESS_TTL_MS) {
        await this.closeSession(key);
      }
    }
  }

  async closeSession(key: string, immediateCleanup = false): Promise<void> {
    const sess = this.sessions.get(key);
    if (!sess) return;
    this.sessions.delete(key);
    if (sess.child && !sess.child.killed) {
      try {
        sess.child.kill(immediateCleanup ? "SIGKILL" : "SIGTERM");
      } catch {
        // ignore
      }
    }
    if (sess.ephemeralProfile && sess.profileDir) {
      const dir = sess.profileDir;
      if (immediateCleanup) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      } else {
        setTimeout(() => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }, 250).unref?.();
      }
    }
  }

  async closeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map((k) => this.closeSession(k, true)));
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  private async ensureSession(
    opts: LocalBrowserExecutionOptions
  ): Promise<ManagedBrowserSession> {
    const norm = normalizeBrowserAutomationSettings(opts.settings);
    const key = opts.mode === "local_debug"
      ? `debug:${norm.debugPort}`
      : `headless:${opts.sessionKey || "default"}`;

    const existing = this.sessions.get(key);
    if (existing) {
      if (await isCdpPortReachable(existing.port, 500)) {
        existing.lastUsedAt = Date.now();
        return existing;
      }
      await this.closeSession(key, true);
    }

    const inflight = this.inflightLaunches.get(key);
    if (inflight) {
      return await inflight;
    }

    const launchPromise = this.launchSessionInternal(key, norm, opts).finally(() => {
      this.inflightLaunches.delete(key);
    });
    this.inflightLaunches.set(key, launchPromise);
    return await launchPromise;
  }

  private async spawnChromeAndWaitReady(
    chromePath: string,
    args: string[],
    port: number,
    signal?: AbortSignal
  ): Promise<ChildProcess> {
    const child = spawn(chromePath, args, {
      stdio: "ignore",
      detached: false,
    });
    let spawnErr: Error | null = null;
    child.on("error", (err) => {
      spawnErr = err instanceof Error ? err : new Error(String(err));
    });
    child.unref?.();

    const deadline = Date.now() + CHROME_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("aborted");
      if (spawnErr) {
        throw new Error(`启动本机 Chrome 失败 (${chromePath}): ${(spawnErr as Error).message}`);
      }
      if (child.exitCode !== null) {
        throw new Error(`本机 Chrome 进程提前退出 (exitCode=${child.exitCode})`);
      }
      if (await isCdpPortReachable(port, 450)) {
        return child;
      }
      await sleep(140, signal);
    }
    try {
      child.kill("SIGTERM");
    } catch {}
    throw new Error(`Timed out waiting for local Chrome CDP on 127.0.0.1:${port}`);
  }

  private async launchSessionInternal(
    key: string,
    norm: BrowserAutomationSettings,
    opts: LocalBrowserExecutionOptions
  ): Promise<ManagedBrowserSession> {
    if (opts.mode === "local_debug") {
      const port = norm.debugPort || DEFAULT_BROWSER_DEBUG_PORT;
      const alreadyListening = await isCdpPortReachable(port, 500);
      if (alreadyListening) {
        const attached: ManagedBrowserSession = {
          key,
          mode: "local_debug",
          port,
          targetId: null,
          callerTargets: new Map(),
          child: null,
          profileDir: resolveDebugProfileDir(opts.dataDir),
          ephemeralProfile: false,
          lastUsedAt: Date.now(),
        };
        this.sessions.set(key, attached);
        return attached;
      }

      const chromePath = detectLocalChromeExecutable(norm.executablePath);
      if (!chromePath) {
        throw new Error(
          norm.executablePath
            ? `配置的 Chrome 可执行文件路径无效或不存在：${norm.executablePath}`
            : "未检测到本机 Chrome/Chromium 可执行文件；请在「设置 → 电脑 → 浏览器自动化引擎」中填写 Chrome 路径，或切回「Bot 电脑 Chrome」模式。"
        );
      }
      const profileDir = resolveDebugProfileDir(opts.dataDir);
      fs.mkdirSync(profileDir, { recursive: true });
      const child = await this.spawnChromeAndWaitReady(
        chromePath,
        [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--window-size=1360,900",
          "about:blank",
        ],
        port,
        opts.signal
      );
      const sess: ManagedBrowserSession = {
        key,
        mode: "local_debug",
        port,
        targetId: null,
        callerTargets: new Map(),
        child,
        profileDir,
        ephemeralProfile: false,
        lastUsedAt: Date.now(),
      };
      this.sessions.set(key, sess);
      return sess;
    }

    // local_headless: always ephemeral clean profile, native GPU/compositor, zero SwiftShader CPU overhead
    const chromePath = detectLocalChromeExecutable(norm.executablePath);
    if (!chromePath) {
      throw new Error(
        norm.executablePath
          ? `配置的 Chrome 可执行文件路径无效或不存在：${norm.executablePath}`
          : "未检测到本机 Chrome/Chromium 可执行文件；请在「设置 → 电脑 → 浏览器自动化引擎」中填写 Chrome 路径，或切回「Bot 电脑 Chrome」模式。"
      );
    }
    const port = await allocateFreeLocalPort();
    const safeSessionSlug = String(opts.sessionKey || "bot")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 24);
    const profileDir = path.join(
      os.tmpdir(),
      `twinklebot-chrome-headless-${safeSessionSlug}-${crypto.randomBytes(4).toString("hex")}`
    );
    fs.mkdirSync(profileDir, { recursive: true });
    let child: ChildProcess;
    try {
      child = await this.spawnChromeAndWaitReady(
        chromePath,
        [
          "--headless=new",
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-sync",
          "--disable-extensions",
          "--window-size=1440,900",
          "about:blank",
        ],
        port,
        opts.signal
      );
    } catch (err) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {}
      throw err;
    }
    const sess: ManagedBrowserSession = {
      key,
      mode: "local_headless",
      port,
      targetId: null,
      callerTargets: new Map(),
      child,
      profileDir,
      ephemeralProfile: true,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(key, sess);
    return sess;
  }

  private getSessionTargetId(sess: ManagedBrowserSession, callerKey: string): string | null {
    if (sess.mode === "local_debug" && callerKey) {
      return sess.callerTargets.get(callerKey) || sess.targetId;
    }
    return sess.targetId;
  }

  private setSessionTargetId(sess: ManagedBrowserSession, callerKey: string, targetId: string | null): void {
    sess.targetId = targetId;
    if (sess.mode === "local_debug" && callerKey) {
      if (targetId) sess.callerTargets.set(callerKey, targetId);
      else sess.callerTargets.delete(callerKey);
    }
  }

  private async resolveActiveTarget(
    sess: ManagedBrowserSession,
    callerKey: string,
    signal?: AbortSignal
  ): Promise<CdpTargetInfo> {
    const targets = await listPageTargets(sess.port, signal);
    const preferredId = this.getSessionTargetId(sess, callerKey);
    if (preferredId) {
      const matched = targets.find((t) => t.id === preferredId);
      if (matched) return matched;
    }
    if (sess.mode === "local_debug" && callerKey && targets.length > 0 && sess.callerTargets.size > 0) {
      const usedByOthers = new Set(
        [...sess.callerTargets.entries()]
          .filter(([k]) => k !== callerKey)
          .map(([, tid]) => tid)
      );
      const freeTab = targets.find((t) => !usedByOthers.has(t.id));
      if (freeTab) {
        this.setSessionTargetId(sess, callerKey, freeTab.id);
        return freeTab;
      }
      const dedicated = await createPageTarget(sess.port, "about:blank", signal);
      this.setSessionTargetId(sess, callerKey, dedicated.id);
      return dedicated;
    }
    if (targets.length > 0) {
      this.setSessionTargetId(sess, callerKey, targets[0].id);
      return targets[0];
    }
    const created = await createPageTarget(sess.port, "about:blank", signal);
    this.setSessionTargetId(sess, callerKey, created.id);
    return created;
  }

  private async waitForSettle(call: CdpCaller, signal?: AbortSignal, maxPolls = 20): Promise<void> {
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const state = await evalCdpJson(
          call,
          `({ readyState: document.readyState, len: (document.body && document.body.innerText || '').length })`
        );
        if (state && (state.readyState === "complete" || (state.readyState === "interactive" && state.len > 0))) {
          return;
        }
      } catch {
        // page mid-navigation
      }
      await sleep(200, signal);
    }
  }

  private async collectSnapshotOnCall(
    call: CdpCaller,
    sess: ManagedBrowserSession,
    maxElements = 80,
    maxText = 3000
  ): Promise<Record<string, any>> {
    const safeMaxEl = Math.max(1, Math.min(200, Math.round(Number(maxElements) || 80)));
    const safeMaxText = Math.max(100, Math.min(20000, Math.round(Number(maxText) || 3000)));
    const snap = await evalCdpJson(
      call,
      `(function(){ ${JS_SNAPSHOT_HELPER} return collectTbSnapshot(${safeMaxEl}, ${safeMaxText}); })()`
    );
    return {
      ...(snap && typeof snap === "object" ? snap : { ok: false, error: "empty snapshot" }),
      target_id: sess.targetId,
      browser_engine: sess.mode,
    };
  }

  async executeTool(
    toolName: string,
    args: Record<string, any> | undefined,
    opts: LocalBrowserExecutionOptions
  ): Promise<Record<string, any>> {
    const params = args || {};
    const callerKey = String(opts.sessionKey || "default");
    const blockedPorts = opts.blockedLocalPorts ?? [3230, 7300];
    const sess = await this.ensureSession(opts);
    sess.lastUsedAt = Date.now();

    if (toolName === "browser_tabs") {
      const action = String(params.action || "list").trim().toLowerCase();
      const curTargetId = this.getSessionTargetId(sess, callerKey);
      if (action === "list") {
        const targets = await listPageTargets(sess.port, opts.signal);
        return {
          ok: true,
          browser_engine: sess.mode,
          active_target_id: curTargetId || targets[0]?.id || null,
          tabs: targets.map((t, idx) => ({
            index: idx,
            id: t.id,
            title: t.title || "",
            url: t.url || "",
            active: t.id === curTargetId,
          })),
        };
      }
      if (action === "new") {
        const targetUrl = params.url ? validateHttpUrl(params.url, blockedPorts) : "about:blank";
        const created = await createPageTarget(sess.port, targetUrl, opts.signal);
        this.setSessionTargetId(sess, callerKey, created.id);
        return await withCdpSocket(
          created.webSocketDebuggerUrl!,
          async (call) => {
            if (targetUrl !== "about:blank") {
              await this.waitForSettle(call, opts.signal);
            }
            return await this.collectSnapshotOnCall(call, sess);
          },
          opts.signal
        );
      }
      if (action === "switch") {
        const tid = String(params.target_id || "").trim();
        const idx = typeof params.index === "number" && Number.isInteger(params.index) ? params.index : -1;
        const targets = await listPageTargets(sess.port, opts.signal);
        const hit = tid ? targets.find((t) => t.id === tid) : idx >= 0 ? targets[idx] : undefined;
        if (!hit) return { ok: false, error: `tab ${tid || idx} not found` };
        this.setSessionTargetId(sess, callerKey, hit.id);
        try {
          await fetchJsonWithTimeout(`http://127.0.0.1:${sess.port}/json/activate/${encodeURIComponent(hit.id)}`, {
            timeoutMs: 2000,
            signal: opts.signal,
          });
        } catch {
          // ignore activate error on headless
        }
        return await withCdpSocket(
          hit.webSocketDebuggerUrl!,
          async (call) => await this.collectSnapshotOnCall(call, sess),
          opts.signal
        );
      }
      if (action === "close") {
        const targets = await listPageTargets(sess.port, opts.signal);
        const idx = typeof params.index === "number" && Number.isInteger(params.index) ? params.index : -1;
        const tid = String(
          params.target_id || (idx >= 0 ? targets[idx]?.id : "") || curTargetId || ""
        ).trim();
        if (!tid) return { ok: false, error: "target_id or index is required to close a tab" };
        if (targets.length <= 1 && targets.some((t) => t.id === tid)) {
          return { ok: false, error: "cannot close the last tab" };
        }
        try {
          await fetchJsonWithTimeout(`http://127.0.0.1:${sess.port}/json/close/${encodeURIComponent(tid)}`, {
            timeoutMs: 2000,
            signal: opts.signal,
          });
        } catch {
          // ignore
        }
        if (curTargetId === tid) this.setSessionTargetId(sess, callerKey, null);
        const remaining = await listPageTargets(sess.port, opts.signal);
        this.setSessionTargetId(sess, callerKey, remaining[0]?.id || null);
        return {
          ok: true,
          closed_target_id: tid,
          active_target_id: this.getSessionTargetId(sess, callerKey),
          browser_engine: sess.mode,
        };
      }
      return { ok: false, error: `unknown browser_tabs action: ${action}` };
    }

    const target = await this.resolveActiveTarget(sess, callerKey, opts.signal);
    const wsUrl = target.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error("Local Chrome target is missing webSocketDebuggerUrl");
    }

    if (toolName === "browser_snapshot") {
      const urlToOpen = params.url ? validateHttpUrl(params.url, blockedPorts) : null;
      return await withCdpSocket(
        wsUrl,
        async (call) => {
          await call("Page.enable");
          if (urlToOpen) {
            await call("Page.navigate", { url: urlToOpen });
            await sleep(250, opts.signal);
            await this.waitForSettle(call, opts.signal);
          }
          return await this.collectSnapshotOnCall(
            call,
            sess,
            params.max_elements,
            params.max_text
          );
        },
        opts.signal
      );
    }

    if (toolName === "browser_click") {
      const ref = normalizeElementRef(params.ref);
      const beforeIds = new Set(
        (await listPageTargets(sess.port, opts.signal)).map((t) => t.id)
      );
      const clickOutcome = await withCdpSocket(
        wsUrl,
        async (call) => {
          await call("Page.enable");
          const located = await evalCdpJson(
            call,
            `(function(){
              ${JS_FIND_REF_HELPER}
              const el = findTbRef(${JSON.stringify(ref)});
              if (!el) return { ok: false, error: 'element ' + ${JSON.stringify(ref)} + ' not found (call browser_snapshot to refresh refs)' };
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              const r = el.getBoundingClientRect();
              return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: (el.tagName || '').toLowerCase() };
            })()`
          );
          if (!located?.ok) return located;
          if (Number.isFinite(located.x) && Number.isFinite(located.y) && located.x > 0 && located.y > 0) {
            await call("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: located.x,
              y: located.y,
            });
            await call("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: located.x,
              y: located.y,
              button: "left",
              clickCount: 1,
            });
            await call("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: located.x,
              y: located.y,
              button: "left",
              clickCount: 1,
            });
          } else {
            await evalCdpJson(
              call,
              `(function(){ ${JS_FIND_REF_HELPER} const el = findTbRef(${JSON.stringify(ref)}); if (el) el.click(); return true; })()`
            );
          }
          await sleep(300, opts.signal);
          await this.waitForSettle(call, opts.signal, 12);
          return { ok: true, clicked: ref };
        },
        opts.signal
      );
      if (!clickOutcome?.ok) return clickOutcome;

      // Auto-follow newly opened popup tab if click triggered target="_blank" / window.open
      const afterTargets = await listPageTargets(sess.port, opts.signal);
      const newTab = afterTargets.find((t) => !beforeIds.has(t.id));
      const activeAfter = newTab || (await this.resolveActiveTarget(sess, callerKey, opts.signal));
      if (newTab) this.setSessionTargetId(sess, callerKey, newTab.id);
      return await withCdpSocket(
        activeAfter.webSocketDebuggerUrl!,
        async (call) => {
          await this.waitForSettle(call, opts.signal, 12);
          const snap = await this.collectSnapshotOnCall(call, sess);
          return { ...snap, clicked: ref, ...(newTab ? { switched_to_new_tab: newTab.id } : {}) };
        },
        opts.signal
      );
    }

    if (toolName === "browser_type") {
      const ref = normalizeElementRef(params.ref);
      const text = String(params.text ?? "");
      const clear = params.clear !== false;
      const submit = Boolean(params.submit);
      const sensitive = Boolean(params.sensitive);
      return await withCdpSocket(
        wsUrl,
        async (call) => {
          const typed = await evalCdpJson(
            call,
            `(function(){
              ${JS_FIND_REF_HELPER}
              const el = findTbRef(${JSON.stringify(ref)});
              if (!el) return { ok: false, error: 'element ' + ${JSON.stringify(ref)} + ' not found (call browser_snapshot to refresh refs)' };
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              el.focus();
              if (${JSON.stringify(sensitive)} && el.dataset) {
                el.dataset.tbSensitive = '1';
              }
              const val = ${JSON.stringify(text)};
              const shouldClear = ${JSON.stringify(clear)};
              if (el.isContentEditable) {
                el.textContent = shouldClear ? val : ((el.textContent || '') + val);
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val }));
              } else {
                const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                const nextVal = shouldClear ? val : (String(el.value || '') + val);
                if (setter) setter.call(el, nextVal);
                else el.value = nextVal;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return { ok: true };
            })()`
          );
          if (!typed?.ok) return typed;
          if (submit) {
            await call("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            });
            await call("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            });
            await sleep(300, opts.signal);
            await this.waitForSettle(call, opts.signal, 12);
          }
          const snap = await this.collectSnapshotOnCall(call, sess);
          return { ...snap, typed_ref: ref, submitted: submit };
        },
        opts.signal
      );
    }

    if (toolName === "browser_scroll") {
      const direction = String(params.direction || "down").toLowerCase();
      const amount = Math.max(50, Math.min(5000, Math.round(Number(params.amount) || 600)));
      const ref = params.ref ? normalizeElementRef(params.ref) : null;
      return await withCdpSocket(
        wsUrl,
        async (call) => {
          await evalCdpJson(
            call,
            `(function(){
              ${JS_FIND_REF_HELPER}
              const dir = ${JSON.stringify(direction)};
              const amt = ${amount};
              const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
              const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
              const target = ${ref ? `findTbRef(${JSON.stringify(ref)})` : "null"};
              if (target && typeof target.scrollBy === 'function') target.scrollBy(dx, dy);
              else window.scrollBy(dx, dy);
              return true;
            })()`
          );
          await sleep(180, opts.signal);
          return await this.collectSnapshotOnCall(call, sess);
        },
        opts.signal
      );
    }

    if (toolName === "browser_wait") {
      const ms = Math.max(0, Math.min(30_000, Math.round(Number(params.ms) || 1500)));
      const text = typeof params.text === "string" && params.text.trim() ? params.text.trim() : null;
      const ref = params.ref ? normalizeElementRef(params.ref) : null;
      const timeoutMs = Math.max(500, Math.min(30_000, Math.round((Number(params.timeout) || 10) * 1000)));
      return await withCdpSocket(
        wsUrl,
        async (call) => {
          if (!text && !ref) {
            await sleep(ms, opts.signal);
            return await this.collectSnapshotOnCall(call, sess);
          }
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const matched = await evalCdpJson(
              call,
              `(function(){
                ${JS_FIND_REF_HELPER}
                if (${JSON.stringify(ref)}) {
                  if (findTbRef(${JSON.stringify(ref)})) return true;
                }
                if (${JSON.stringify(text)}) {
                  const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || '';
                  if (bodyText.includes(${JSON.stringify(text)})) return true;
                }
                return false;
              })()`
            );
            if (matched) break;
            await sleep(250, opts.signal);
          }
          return await this.collectSnapshotOnCall(call, sess);
        },
        opts.signal
      );
    }

    if (toolName === "browser_select") {
      const ref = normalizeElementRef(params.ref);
      const value = params.value !== undefined ? String(params.value) : null;
      const label = params.label !== undefined ? String(params.label) : null;
      return await withCdpSocket(
        wsUrl,
        async (call) => {
          const sel = await evalCdpJson(
            call,
            `(function(){
              ${JS_FIND_REF_HELPER}
              const el = findTbRef(${JSON.stringify(ref)});
              if (!el || (el.tagName || '').toLowerCase() !== 'select') {
                return { ok: false, error: 'select element ' + ${JSON.stringify(ref)} + ' not found' };
              }
              const targetVal = ${JSON.stringify(value)};
              const targetLabel = ${JSON.stringify(label)};
              const opt = Array.from(el.options || []).find((o) =>
                (targetVal !== null && o.value === targetVal) ||
                (targetLabel !== null && String(o.textContent || '').trim() === targetLabel)
              );
              if (!opt) return { ok: false, error: 'matching option not found in ' + ${JSON.stringify(ref)} };
              el.value = opt.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, selectedValue: opt.value, selectedLabel: String(opt.textContent || '').trim() };
            })()`
          );
          if (!sel?.ok) return sel;
          const snap = await this.collectSnapshotOnCall(call, sess);
          return { ...snap, selectedValue: sel.selectedValue, selectedLabel: sel.selectedLabel };
        },
        opts.signal
      );
    }

    if (toolName === "browser_upload_file") {
      const ref = normalizeElementRef(params.ref);
      const rawPaths = Array.isArray(params.paths)
        ? params.paths
        : typeof params.paths === "string"
          ? [params.paths]
          : typeof params.path === "string"
            ? [params.path]
            : [];
      for (const candidate of rawPaths) {
        const trimmed = String(candidate || "").trim();
        if (trimmed && isSensitiveLocalUploadPath(trimmed)) {
          return { ok: false, error: `denied uploading sensitive local path: ${trimmed}` };
        }
      }
      const files = rawPaths
        .map((p: any) => String(p || "").trim())
        .filter((p: string) => p && isRegularFile(p));
      if (files.length === 0) {
        return { ok: false, error: "no existing local file paths provided for browser_upload_file" };
      }
      return await withCdpSocket(
        wsUrl,
        async (call) => {
          await call("DOM.enable");
          await call("DOM.getDocument", { depth: 1 });
          const evalRes = await call("Runtime.evaluate", {
            expression: `(function(){ ${JS_FIND_REF_HELPER} return findTbRef(${JSON.stringify(ref)}); })()`,
            returnByValue: false,
          });
          const objectId = evalRes?.result?.objectId;
          if (!objectId) {
            return { ok: false, error: `file input element ${ref} not found` };
          }
          const desc = await call("DOM.describeNode", { objectId });
          const backendNodeId = desc?.node?.backendNodeId;
          if (!backendNodeId) {
            return { ok: false, error: `unable to resolve DOM node for ${ref}` };
          }
          await call("DOM.setFileInputFiles", {
            backendNodeId,
            files,
          });
          await sleep(200, opts.signal);
          const snap = await this.collectSnapshotOnCall(call, sess);
          return { ...snap, uploaded_files: files };
        },
        opts.signal
      );
    }

    return { ok: false, error: `unsupported local browser tool: ${toolName}` };
  }
}

let defaultManager: LocalChromeManager | null = null;

export function getDefaultLocalChromeManager(): LocalChromeManager {
  if (!defaultManager) {
    defaultManager = new LocalChromeManager();
  }
  return defaultManager;
}

export async function closeAllLocalBrowsers(): Promise<void> {
  if (!defaultManager) return;
  await defaultManager.closeAll();
  defaultManager = null;
}

export async function probeLocalChromeStatus(
  rawSettings?: Partial<BrowserAutomationSettings> | null,
  dataDir?: string
): Promise<LocalBrowserStatusInfo> {
  const settings = normalizeBrowserAutomationSettings(rawSettings);
  const executablePath = detectLocalChromeExecutable(settings.executablePath);
  const debugReachable = await isCdpPortReachable(settings.debugPort, 350);
  return {
    available: Boolean(executablePath || debugReachable),
    executablePath,
    debugPort: settings.debugPort,
    debugReachable,
    activeSessions: defaultManager?.getActiveSessionCount() || 0,
    profileDir: resolveDebugProfileDir(dataDir),
  };
}
