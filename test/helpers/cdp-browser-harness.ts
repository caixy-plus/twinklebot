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
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            ...(process.env.LOCALAPPDATA
              ? [path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")]
              : []),
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

export interface KeyModifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface ViewportOptions {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  touch?: boolean;
  userAgent?: string;
}

export interface HudBannerState {
  id: string;
  priority: string;
  title: string;
  state: "running" | "pass" | "fail" | "skip";
  progress?: string;
}

export interface NetworkConditionsOptions {
  offline: boolean;
  latencyMs?: number;
  downloadThroughput?: number;
  uploadThroughput?: number;
}

export interface HeadlessChromeSession {
  cdpPort: number;
  headed: boolean;
  pageErrors: string[];
  consoleErrors: string[];
  allPageErrors: string[];
  allConsoleErrors: string[];
  cdpCall: (method: string, params?: Record<string, any>) => Promise<any>;
  navigate: (url: string) => Promise<void>;
  reload: (ignoreCache?: boolean) => Promise<void>;
  evalJs: <T = any>(expression: string) => Promise<T>;
  waitFor: (predicateExpr: string, timeoutMs?: number) => Promise<void>;
  click: (selector: string) => Promise<void>;
  rightClick: (selector: string) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  typeText: (selector: string, text: string, opts?: { clear?: boolean }) => Promise<void>;
  pressKey: (key: string, modifiers?: KeyModifiers) => Promise<void>;
  simulateImeComposition: (selector: string, text: string, pressEnterInWindow?: boolean) => Promise<void>;
  drag: (fromX: number, fromY: number, toX: number, toY: number, steps?: number) => Promise<void>;
  touchSwipe: (fromX: number, fromY: number, toX: number, toY: number, steps?: number) => Promise<void>;
  wheel: (x: number, y: number, deltaX: number, deltaY: number) => Promise<void>;
  setNetworkConditions: (opts: NetworkConditionsOptions) => Promise<void>;
  selectText: (selector: string, startOffset?: number, endOffset?: number) => Promise<void>;
  setFileInputFiles: (selector: string, filePaths: string[]) => Promise<void>;
  pasteFile: (selector: string, opts: { name: string; mimeType: string; bytesBase64: string }) => Promise<void>;
  dropFile: (selector: string, opts: { name: string; mimeType: string; bytesBase64: string }) => Promise<void>;
  setRangeValue: (selector: string, value: number) => Promise<void>;
  selectOption: (selector: string, value: string) => Promise<void>;
  setViewport: (opts: ViewportOptions) => Promise<void>;
  addInitScript: (source: string) => Promise<string>;
  setHudStatus: (banner: HudBannerState) => Promise<void>;
  captureScreenshot: (filePath?: string) => Promise<Buffer>;
  openNewTab: (url?: string) => Promise<HeadlessChromeSession>;
  close: () => Promise<void>;
}

const KEY_CODE_MAP: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  "\\": { key: "\\", code: "Backslash", keyCode: 220 },
  Backslash: { key: "\\", code: "Backslash", keyCode: 220 },
  ",": { key: ",", code: "Comma", keyCode: 188 },
  Comma: { key: ",", code: "Comma", keyCode: 188 },
};

function resolveKeyDescriptor(key: string): { key: string; code: string; keyCode: number; text?: string } {
  if (KEY_CODE_MAP[key]) return KEY_CODE_MAP[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const cc = upper.charCodeAt(0);
    if (cc >= 65 && cc <= 90) {
      return { key, code: `Key${upper}`, keyCode: cc, text: key };
    }
    if (cc >= 48 && cc <= 57) {
      return { key, code: `Digit${key}`, keyCode: cc, text: key };
    }
    return { key, code: key, keyCode: cc, text: key };
  }
  return { key, code: key, keyCode: 0 };
}

function modifierBitmask(m: KeyModifiers = {}): number {
  let bits = 0;
  if (m.alt) bits |= 1;
  if (m.ctrl) bits |= 2;
  if (m.meta) bits |= 4;
  if (m.shift) bits |= 8;
  return bits;
}

async function attachPageTarget(
  cdpPort: number,
  pageWsUrl: string,
  headed: boolean,
  slowMoMs: number,
  onCloseCleanup: () => Promise<void>,
  openTabFn: (url?: string) => Promise<HeadlessChromeSession>,
  sharedErrors: { pageErrors: string[]; consoleErrors: string[] } = { pageErrors: [], consoleErrors: [] },
  tabLabel = "main"
): Promise<HeadlessChromeSession> {
  const ws = new WebSocket(pageWsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP WebSocket open timeout")), 10_000);
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
  const consoleErrors: string[] = [];
  let currentHud: HudBannerState | null = null;
  let networkEnabled = false;

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
      const text = String(desc);
      pageErrors.push(text);
      sharedErrors.pageErrors.push(tabLabel === "main" ? text : `[${tabLabel}] ${text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const parts = (msg.params?.args || []).map((a: any) => a?.value ?? a?.description ?? "").filter(Boolean);
      if (parts.length > 0) {
        const text = parts.join(" ");
        consoleErrors.push(text);
        sharedErrors.consoleErrors.push(tabLabel === "main" ? text : `[${tabLabel}] ${text}`);
      }
    }
  });

  const cdpCall = (method: string, params: Record<string, any> = {}): Promise<any> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, 20_000);
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
  await cdpCall("DOM.enable");
  await cdpCall("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

  const pace = async () => {
    if (slowMoMs > 0) {
      await new Promise((r) => setTimeout(r, slowMoMs));
    }
  };

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

  const renderHudInPage = async (banner: HudBannerState | null) => {
    if (!headed || !banner) return;
    try {
      await evalJs(`(() => {
        const b = ${JSON.stringify(banner)};
        let el = document.getElementById('__tb_e2e_hud__');
        if (!el && document.documentElement) {
          el = document.createElement('div');
          el.id = '__tb_e2e_hud__';
          el.setAttribute('aria-hidden', 'true');
          Object.assign(el.style, {
            position: 'fixed',
            right: '14px',
            bottom: '14px',
            zIndex: '2147483647',
            pointerEvents: 'none',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
            fontSize: '12px',
            lineHeight: '1.35',
            padding: '8px 12px',
            borderRadius: '10px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
            color: '#f8fafc',
            background: 'rgba(15, 23, 42, 0.90)',
            border: '1px solid rgba(148, 163, 184, 0.35)',
            maxWidth: '420px',
            backdropFilter: 'blur(8px)',
          });
          document.documentElement.appendChild(el);
        }
        if (!el) return;
        const icon = b.state === 'pass' ? '✅' : b.state === 'fail' ? '❌' : b.state === 'skip' ? '⏭️' : '🧪';
        const borderColor = b.state === 'pass' ? '#22c55e' : b.state === 'fail' ? '#ef4444' : '#3b82f6';
        el.style.borderColor = borderColor;
        el.textContent = icon + ' [' + b.priority + '] ' + b.id + (b.progress ? ' (' + b.progress + ')' : '') + ' · ' + b.title;
      })()`);
    } catch {}
  };

  const highlightElement = async (selector: string) => {
    if (!headed) return;
    try {
      await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const prev = el.style.outline;
        const prevOffset = el.style.outlineOffset;
        el.style.outline = '2px solid #2563eb';
        el.style.outlineOffset = '2px';
        setTimeout(() => {
          el.style.outline = prev;
          el.style.outlineOffset = prevOffset;
        }, 260);
      })()`);
    } catch {}
  };

  const setHudStatus = async (banner: HudBannerState): Promise<void> => {
    currentHud = banner;
    await renderHudInPage(banner);
  };

  const waitFor = async (predicateExpr: string, timeoutMs = 10_000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await evalJs<boolean>(`Boolean(${predicateExpr})`);
        if (ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms: ${predicateExpr}`);
  };

  const navigate = async (url: string): Promise<void> => {
    const navNonce = `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let shouldAwaitDocSwap = false;
    let isAboutBlank = false;
    try {
      const curHref = await evalJs<string>(`(() => {
        window.__tbNavGuard = ${JSON.stringify(navNonce)};
        return String(window.location.href || "");
      })()`);
      isAboutBlank = curHref === "about:blank";
      if (curHref) {
        try {
          const curUrl = new URL(curHref);
          const nextUrl = new URL(url, curHref);
          const hashOnly =
            curUrl.origin === nextUrl.origin &&
            curUrl.pathname === nextUrl.pathname &&
            curUrl.search === nextUrl.search &&
            curUrl.hash !== nextUrl.hash;
          shouldAwaitDocSwap = !hashOnly;
        } catch {
          shouldAwaitDocSwap = true;
        }
      }
    } catch {}
    if (isAboutBlank && /^https?:\/\//i.test(url)) {
      // Replace initial about:blank in-place so history.length stays 1 and Linux Chrome
      // touch swipe-right gestures cannot accidentally navigate back to about:blank.
      await evalJs(`window.location.replace(${JSON.stringify(url)})`);
    } else {
      await cdpCall("Page.navigate", { url });
    }
    await waitFor(
      shouldAwaitDocSwap
        ? `window.__tbNavGuard !== ${JSON.stringify(navNonce)} && document.readyState === "complete"`
        : `document.readyState === "complete"`,
      15_000
    );
    await renderHudInPage(currentHud);
    await pace();
  };

  const reload = async (ignoreCache = true): Promise<void> => {
    const navNonce = `reload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await evalJs(`window.__tbNavGuard = ${JSON.stringify(navNonce)}`);
    } catch {}
    await cdpCall("Page.reload", { ignoreCache });
    await waitFor(
      `window.__tbNavGuard !== ${JSON.stringify(navNonce)} && document.readyState === "complete"`,
      15_000
    );
    await renderHudInPage(currentHud);
    await pace();
  };

  const click = async (selector: string): Promise<void> => {
    await highlightElement(selector);
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
    await pace();
  };

  const rightClick = async (selector: string): Promise<void> => {
    await highlightElement(selector);
    const rect = await evalJs<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!rect) {
      throw new Error(`rightClick failed: selector ${selector} not found`);
    }
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await cdpCall("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "right", clickCount: 1 });
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "right", clickCount: 1 });
    await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${rect.x}, clientY: ${rect.y}, button: 2 }));
    })()`);
    await pace();
  };

  const fill = async (selector: string, value: string): Promise<void> => {
    await highlightElement(selector);
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) {
      throw new Error(`fill failed: selector ${selector} not found`);
    }
    await pace();
  };

  const typeText = async (
    selector: string,
    text: string,
    opts: { clear?: boolean } = {}
  ): Promise<void> => {
    await highlightElement(selector);
    const before = await evalJs<{ ok: boolean; value: string }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, value: '' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (${JSON.stringify(Boolean(opts.clear))}) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { ok: true, value: String(el.value || '') };
    })()`);
    if (!before?.ok) {
      throw new Error(`typeText failed: selector ${selector} not found`);
    }
    await cdpCall("Input.insertText", { text });
    if (text.length > 0) {
      await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const expected = ${JSON.stringify(before.value + text)};
        if (String(el.value || '') === ${JSON.stringify(before.value)}) {
          el.focus();
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, expected);
          else el.value = expected;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
        }
      })()`);
    }
    // Wait briefly so React controlled inputs commit and Composer's 50ms IME compositionend guard clears.
    await new Promise((r) => setTimeout(r, 65));
    await pace();
  };

  const pressKey = async (key: string, modifiers: KeyModifiers = {}): Promise<void> => {
    const desc = resolveKeyDescriptor(key);
    const mod = modifierBitmask(modifiers);
    const hasModifier = Boolean(modifiers.ctrl || modifiers.meta || modifiers.alt);
    const isShiftEnter = key === "Enter" && Boolean(modifiers.shift) && !hasModifier;
    const beforeTextareaVal = isShiftEnter
      ? await evalJs<string | null>(
          `document.activeElement?.tagName === 'TEXTAREA' ? String(document.activeElement.value || '') : null`
        )
      : null;
    await cdpCall("Input.dispatchKeyEvent", {
      type: !hasModifier && desc.text ? "keyDown" : "rawKeyDown",
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.keyCode,
      nativeVirtualKeyCode: desc.keyCode,
      modifiers: mod,
      ...(!hasModifier && desc.text ? { text: desc.text, unmodifiedText: desc.text } : {}),
      ...(isShiftEnter ? { commands: ["insertNewline"] } : {}),
    });
    if (isShiftEnter && beforeTextareaVal !== null) {
      await evalJs(`(() => {
        const el = document.activeElement;
        if (!el || el.tagName !== 'TEXTAREA') return;
        if (String(el.value || '') === ${JSON.stringify(beforeTextareaVal)}) {
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
          const next = el.value.slice(0, start) + '\\n' + el.value.slice(end);
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(el, next);
          else el.value = next;
          try { el.setSelectionRange(start + 1, start + 1); } catch {}
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '\\n', inputType: 'insertLineBreak' }));
        }
      })()`);
    }
    await cdpCall("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.keyCode,
      nativeVirtualKeyCode: desc.keyCode,
      modifiers: mod,
    });
    await pace();
  };

  const simulateImeComposition = async (
    selector: string,
    text: string,
    pressEnterInWindow = true
  ): Promise<void> => {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const nextVal = (el.value || '') + ${JSON.stringify(text)};
      if (setter) setter.call(el, nextVal);
      else el.value = nextVal;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: ${JSON.stringify(text)} }));
      if (${JSON.stringify(pressEnterInWindow)}) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      }
      return true;
    })()`);
    if (!ok) {
      throw new Error(`simulateImeComposition failed: selector ${selector} not found`);
    }
    await pace();
  };

  const drag = async (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps = 10
  ): Promise<void> => {
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
    await cdpCall("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1 });
    const n = Math.max(2, steps);
    for (let i = 1; i <= n; i += 1) {
      const x = fromX + ((toX - fromX) * i) / n;
      const y = fromY + ((toY - fromY) * i) / n;
      await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await new Promise((r) => setTimeout(r, 15));
    }
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", clickCount: 1 });
    await pace();
  };

  const touchSwipe = async (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps = 8
  ): Promise<void> => {
    try {
      await cdpCall("Page.bringToFront");
    } catch {}
    await cdpCall("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: fromX, y: fromY, id: 1, radiusX: 10, radiusY: 10, force: 1 }],
    });
    const n = Math.max(2, steps);
    for (let i = 1; i <= n; i += 1) {
      const x = fromX + ((toX - fromX) * i) / n;
      const y = fromY + ((toY - fromY) * i) / n;
      await cdpCall("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y, id: 1, radiusX: 10, radiusY: 10, force: 1 }],
      });
      await new Promise((r) => setTimeout(r, 16));
    }
    await cdpCall("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await pace();
  };

  const wheel = async (x: number, y: number, deltaX: number, deltaY: number): Promise<void> => {
    await cdpCall("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
    await pace();
  };

  const setNetworkConditions = async (opts: NetworkConditionsOptions): Promise<void> => {
    if (!networkEnabled) {
      await cdpCall("Network.enable");
      networkEnabled = true;
    }
    await cdpCall("Network.emulateNetworkConditions", {
      offline: Boolean(opts.offline),
      latency: opts.latencyMs ?? 0,
      downloadThroughput: opts.downloadThroughput ?? -1,
      uploadThroughput: opts.uploadThroughput ?? -1,
    });
    await pace();
  };

  const selectText = async (
    selector: string,
    startOffset = 0,
    endOffset = 18
  ): Promise<void> => {
    const rect = await evalJs<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !(node.textContent || '').trim()) {
        node = walker.nextNode();
      }
      if (!node) return null;
      const len = (node.textContent || '').length;
      const s = Math.min(${startOffset}, Math.max(0, len - 1));
      const e = Math.min(${endOffset}, len);
      const range = document.createRange();
      range.setStart(node, s);
      range.setEnd(node, Math.max(s + 1, e));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!rect) {
      throw new Error(`selectText failed: no text node under ${selector}`);
    }
    await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${rect.x}, clientY: ${rect.y} }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${rect.x}, clientY: ${rect.y} }));
    })()`);
    await pace();
  };

  const setFileInputFiles = async (selector: string, filePaths: string[]): Promise<void> => {
    const doc = await cdpCall("DOM.getDocument", { depth: 1 });
    const q = await cdpCall("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!q?.nodeId) {
      throw new Error(`setFileInputFiles failed: selector ${selector} not found`);
    }
    await cdpCall("DOM.setFileInputFiles", {
      nodeId: q.nodeId,
      files: filePaths.map((p) => path.resolve(p)),
    });
    await pace();
  };

  const pasteFile = async (
    selector: string,
    opts: { name: string; mimeType: string; bytesBase64: string }
  ): Promise<void> => {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const raw = atob(${JSON.stringify(opts.bytesBase64)});
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      const file = new File([arr], ${JSON.stringify(opts.name)}, { type: ${JSON.stringify(opts.mimeType)} });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      el.dispatchEvent(ev);
      return true;
    })()`);
    if (!ok) {
      throw new Error(`pasteFile failed: selector ${selector} not found`);
    }
    await pace();
  };

  const dropFile = async (
    selector: string,
    opts: { name: string; mimeType: string; bytesBase64: string }
  ): Promise<void> => {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const raw = atob(${JSON.stringify(opts.bytesBase64)});
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      const file = new File([arr], ${JSON.stringify(opts.name)}, { type: ${JSON.stringify(opts.mimeType)} });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    })()`);
    if (!ok) {
      throw new Error(`dropFile failed: selector ${selector} not found`);
    }
    await pace();
  };

  const setRangeValue = async (selector: string, value: number): Promise<void> => {
    await highlightElement(selector);
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
    await pace();
  };

  const selectOption = async (selector: string, value: string): Promise<void> => {
    await highlightElement(selector);
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
    await pace();
  };

  const setViewport = async (opts: ViewportOptions): Promise<void> => {
    await cdpCall("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
      mobile: Boolean(opts.mobile),
    });
    if (opts.touch !== undefined) {
      await cdpCall("Emulation.setTouchEmulationEnabled", {
        enabled: Boolean(opts.touch),
        maxTouchPoints: opts.touch ? 5 : 0,
      });
    }
    if (opts.userAgent) {
      await cdpCall("Emulation.setUserAgentOverride", {
        userAgent: opts.userAgent,
      });
    }
    try {
      await evalJs(`window.dispatchEvent(new Event('resize'))`);
    } catch {}
    await pace();
  };

  const addInitScript = async (source: string): Promise<string> => {
    const res = await cdpCall("Page.addScriptToEvaluateOnNewDocument", { source });
    return String(res?.identifier || "");
  };

  const captureScreenshot = async (filePath?: string): Promise<Buffer> => {
    const res = await cdpCall("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(res?.data || "", "base64");
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buf);
    }
    return buf;
  };

  const close = async (): Promise<void> => {
    try {
      ws.close();
    } catch {}
    await onCloseCleanup();
  };

  return {
    cdpPort,
    headed,
    pageErrors,
    consoleErrors,
    allPageErrors: sharedErrors.pageErrors,
    allConsoleErrors: sharedErrors.consoleErrors,
    cdpCall,
    navigate,
    reload,
    evalJs,
    waitFor,
    click,
    rightClick,
    fill,
    typeText,
    pressKey,
    simulateImeComposition,
    drag,
    touchSwipe,
    wheel,
    setNetworkConditions,
    selectText,
    setFileInputFiles,
    pasteFile,
    dropFile,
    setRangeValue,
    selectOption,
    setViewport,
    addInitScript,
    setHudStatus,
    captureScreenshot,
    openNewTab: openTabFn,
    close,
  };
}

export async function launchHeadlessChrome(opts: {
  chromeBin?: string;
  headed?: boolean;
  slowMoMs?: number;
} = {}): Promise<HeadlessChromeSession> {
  const chromeBin = opts.chromeBin || findChromeBinary();
  if (!chromeBin) {
    throw new Error("Google Chrome binary not found for UI E2E tests");
  }

  const headed =
    opts.headed ??
    (process.env.TWINKLEBOT_E2E_HEADED === "1" ||
      (process.env.TWINKLEBOT_E2E_HEADLESS !== "1" &&
        process.env.CI !== "true" &&
        process.platform === "darwin"));

  const envSlow = Number(process.env.TWINKLEBOT_E2E_SLOWMO_MS);
  const slowMoMs =
    opts.slowMoMs ??
    (Number.isFinite(envSlow) && envSlow >= 0 ? envSlow : headed ? 110 : 0);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ui-chrome-"));
  const headlessLinux = !headed && process.platform === "linux";
  const chromeArgs = [
    ...(headed ? [] : ["--headless=new"]),
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--overscroll-history-navigation=0",
    `--lang=${(opts as any).lang || "zh-CN"}`,
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    ...(headlessLinux
      ? [
          "--disable-background-networking",
          "--disable-extensions",
          "--disable-sync",
          "--metrics-recording-only",
          "--mute-audio",
        ]
      : []),
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    "--window-position=40,40",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (headlessLinux) {
    // Prevent xvfb-run DISPLAY from slowing down or interfering with headless Chrome on Linux CI
    delete childEnv.DISPLAY;
  }

  const proc: ChildProcess = spawn(chromeBin, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: childEnv,
  });

  let stderrBuf = "";
  proc.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  const devToolsFile = path.join(userDataDir, "DevToolsActivePort");
  let cdpPort = 0;
  const deadline = Date.now() + 45_000;
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
    try {
      if (proc.pid && process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
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
    throw new Error("No CDP page target found in Chrome");
  }

  const sharedErrors = { pageErrors: [] as string[], consoleErrors: [] as string[] };
  let tabSeq = 0;

  const openNewTab = async (url = "about:blank"): Promise<HeadlessChromeSession> => {
    const resp = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" }
    );
    const created: any = await resp.json();
    const tabWs = created?.webSocketDebuggerUrl;
    if (!tabWs) {
      throw new Error(`Failed to open new CDP tab: ${JSON.stringify(created)}`);
    }
    const label = `tab#${++tabSeq}`;
    const session = await attachPageTarget(
      cdpPort,
      tabWs,
      headed,
      slowMoMs,
      async () => {
        try {
          await fetch(`http://127.0.0.1:${cdpPort}/json/close/${created.id}`);
        } catch {}
      },
      openNewTab,
      sharedErrors,
      label
    );
    try {
      await session.cdpCall("Page.bringToFront");
    } catch {}
    if (url && url !== "about:blank") {
      await session.waitFor(`document.readyState === "complete"`, 15_000);
    }
    return session;
  };

  const closeBrowser = async () => {
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

  return attachPageTarget(
    cdpPort,
    pageWsUrl,
    headed,
    slowMoMs,
    closeBrowser,
    openNewTab,
    sharedErrors,
    "main"
  );
}
