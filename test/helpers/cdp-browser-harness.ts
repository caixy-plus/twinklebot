import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findChromeBinary(): string | null {
  const envCands = [
    process.env.TWINKLEBOT_E2E_CHROME_BIN,
    process.env.CHROME_BIN,
  ].filter(Boolean) as string[];
  const fixedCands =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : [
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];

  for (const cand of [...envCands, ...fixedCands]) {
    if (cand && fs.existsSync(cand)) {
      return cand;
    }
  }
  return null;
}

export interface HeadlessChromeSession {
  cdpPort: number;
  pageErrors: string[];
  navigate: (url: string) => Promise<void>;
  evalJs: <T = any>(expression: string) => Promise<T>;
  waitFor: (predicateExpr: string, timeoutMs?: number) => Promise<void>;
  click: (selector: string) => Promise<void>;
  setRangeValue: (selector: string, value: number) => Promise<void>;
  selectOption: (selector: string, value: string) => Promise<void>;
  close: () => Promise<void>;
}

export async function launchHeadlessChrome(opts: { chromeBin?: string } = {}): Promise<HeadlessChromeSession> {
  const chromeBin = opts.chromeBin || findChromeBinary();
  if (!chromeBin) {
    throw new Error("Google Chrome binary not found for UI E2E tests");
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ui-chrome-"));
  const proc: ChildProcess = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,900",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }
  );

  let stderrBuf = "";
  proc.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  const devToolsFile = path.join(userDataDir, "DevToolsActivePort");
  let cdpPort = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Chrome exited early (${proc.exitCode}): ${stderrBuf}`);
    }
    if (fs.existsSync(devToolsFile)) {
      const lines = fs.readFileSync(devToolsFile, "utf8").trim().split(/\r?\n/);
      const p = Number(lines[0]);
      if (Number.isInteger(p) && p > 0) {
        cdpPort = p;
        break;
      }
    }
    const m = stderrBuf.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools/);
    if (m) {
      cdpPort = Number(m[1]);
      break;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!cdpPort) {
    throw new Error(`Timed out waiting for Chrome DevToolsActivePort: ${stderrBuf}`);
  }

  let pageWsUrl = "";
  const listDeadline = Date.now() + 10_000;
  while (Date.now() < listDeadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = (await resp.json()) as any[];
      const page = targets.find((t) => t && t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        pageWsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!pageWsUrl) {
    throw new Error("No CDP page target found in headless Chrome");
  }

  const ws = new WebSocket(pageWsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP WebSocket open timeout")), 8_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", (ev: any) => {
      clearTimeout(t);
      reject(new Error(`CDP WebSocket error: ${ev?.message || "unknown"}`));
    });
  });

  let nextId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const pageErrors: string[] = [];

  ws.addEventListener("message", (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const desc =
        msg.params?.exceptionDetails?.exception?.description ||
        msg.params?.exceptionDetails?.text ||
        "Uncaught page exception";
      pageErrors.push(String(desc));
    }
  });

  const cdpCall = (method: string, params: Record<string, any> = {}): Promise<any> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, 15_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await cdpCall("Page.enable");
  await cdpCall("Runtime.enable");

  const evalJs = async <T = any>(expression: string): Promise<T> => {
    const res = await cdpCall("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "JS evaluate error";
      throw new Error(desc);
    }
    return res?.result?.value as T;
  };

  const waitFor = async (predicateExpr: string, timeoutMs = 10_000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await evalJs<boolean>(`Boolean(${predicateExpr})`);
        if (ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms: ${predicateExpr}`);
  };

  const navigate = async (url: string): Promise<void> => {
    await cdpCall("Page.navigate", { url });
    await waitFor(`document.readyState === "complete"`);
  };

  const click = async (selector: string): Promise<void> => {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return true;
    })()`);
    if (!ok) {
      throw new Error(`click failed: selector ${selector} not found`);
    }
  };

  const setRangeValue = async (selector: string, value: number): Promise<void> => {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, String(${value}));
      else el.value = String(${value});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`);
    if (!ok) {
      throw new Error(`setRangeValue failed: selector ${selector} not found`);
    }
  };

  const selectOption = async (selector: string, value: string): Promise<void> => {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) {
      throw new Error(`selectOption failed: selector ${selector} not found`);
    }
  };

  const close = async (): Promise<void> => {
    try {
      ws.close();
    } catch {}
    try {
      if (proc.pid && process.platform !== "win32") {
        process.kill(-proc.pid, "SIGKILL");
      } else {
        proc.kill("SIGKILL");
      }
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  };

  return {
    cdpPort,
    pageErrors,
    navigate,
    evalJs,
    waitFor,
    click,
    setRangeValue,
    selectOption,
    close,
  };
}
