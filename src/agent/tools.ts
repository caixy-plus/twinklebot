import crypto from "node:crypto";
import type { ExecutorClient } from "../shared/config.js";

const RISK_PROPERTY = {
  type: "string",
  enum: ["low", "high"],
  description:
    "Always use 'low' for normal clicks, navigation, filling drafts, or routine sandbox operations. Set to 'high' ONLY when the action causes irreversible external side effects: paying, submitting real orders, sending messages/emails, publishing public posts, or deleting important online/local data.",
};

const SECRET_PLACEHOLDER_RE = /\{\{secret:(cred_[a-f0-9]+)\}\}/g;
const SECRET_INJECTABLE_TOOLS = new Set(["browser_type", "type_text"]);
const MAX_EPHEMERAL_SECRETS = 256;
const ephemeralSecrets = new Map<string, { value: string; expiresAt: number }>();

function pruneExpiredSecrets(now = Date.now()): void {
  for (const [k, entry] of ephemeralSecrets.entries()) {
    if (entry.expiresAt <= now) {
      ephemeralSecrets.delete(k);
    }
  }
}

/**
 * Stores a sensitive credential strictly in host memory and returns an opaque placeholder
 * token (`{{secret:cred_...}}`) safe to place in LLM context and session logs.
 */
export function registerEphemeralSecret(value: string, ttlMs = 30 * 60_000): string {
  const now = Date.now();
  pruneExpiredSecrets(now);
  while (ephemeralSecrets.size >= MAX_EPHEMERAL_SECRETS) {
    const oldest = ephemeralSecrets.keys().next().value;
    if (oldest === undefined) break;
    ephemeralSecrets.delete(oldest);
  }
  const key = `cred_${crypto.randomBytes(8).toString("hex")}`;
  ephemeralSecrets.set(key, { value: String(value), expiresAt: now + Math.max(1000, ttlMs) });
  return `{{secret:${key}}}`;
}

export function resolveEphemeralSecretPlaceholders(text: string): {
  resolved: string;
  hadSecret: boolean;
  missingSecret: boolean;
} {
  if (typeof text !== "string" || !text.includes("{{secret:")) {
    return { resolved: text, hadSecret: false, missingSecret: false };
  }
  const now = Date.now();
  pruneExpiredSecrets(now);
  let hadSecret = false;
  let missingSecret = false;
  const resolved = text.replace(SECRET_PLACEHOLDER_RE, (full, key) => {
    hadSecret = true;
    const entry = ephemeralSecrets.get(key);
    if (!entry || entry.expiresAt <= now) {
      missingSecret = true;
      return full;
    }
    return entry.value;
  });
  return { resolved, hadSecret, missingSecret };
}

export function clearEphemeralSecrets(): void {
  ephemeralSecrets.clear();
}

export function hashScreenshot(buf: Buffer | null | undefined): string | null {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  return crypto.createHash("sha1").update(buf).digest("hex");
}

export const TOOL_DECLARATIONS = [
  {
    type: "function",
    name: "screenshot",
    description: "Take a screenshot of the current desktop display (1440x900).",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "click",
    description: "Click mouse at the specified desktop coordinates (x, y).",
    parameters: {
      type: "object",
      properties: {
        x: {
          type: "integer",
          description: "X coordinate (0-1439).",
        },
        y: {
          type: "integer",
          description: "Y coordinate (0-899).",
        },
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
          description: "Mouse button to click (default: 'left').",
        },
        double: {
          type: "boolean",
          description: "Whether to double click (default: false).",
        },
        risk: RISK_PROPERTY,
      },
      required: ["x", "y"],
    },
  },
  {
    type: "function",
    name: "type_text",
    description:
      "Type text into the focused desktop window (direct keystrokes for short single-line ASCII, clipboard paste for Unicode/multiline/credentials). Optionally presses Enter after typing. Use run_shell instead inside terminal windows.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text string to type/paste.",
        },
        press_enter: {
          type: "boolean",
          description: "Optional: press Return/Enter right after typing (default: false).",
        },
        risk: RISK_PROPERTY,
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "key",
    description: "Press a key or key combination (e.g. 'ctrl+l', 'Return', 'BackSpace').",
    parameters: {
      type: "object",
      properties: {
        combo: {
          type: "string",
          description: "Key combo to press.",
        },
        risk: RISK_PROPERTY,
      },
      required: ["combo"],
    },
  },
  {
    type: "function",
    name: "scroll",
    description: "Scroll the mouse wheel at the specified coordinates.",
    parameters: {
      type: "object",
      properties: {
        x: {
          type: "integer",
          description: "X coordinate (0-1439).",
        },
        y: {
          type: "integer",
          description: "Y coordinate (0-899).",
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction.",
        },
        amount: {
          type: "integer",
          description: "Number of scroll clicks (1-20, default: 3).",
        },
      },
      required: ["x", "y", "direction"],
    },
  },
  {
    type: "function",
    name: "drag",
    description: "Click and drag from (x1, y1) to (x2, y2).",
    parameters: {
      type: "object",
      properties: {
        x1: {
          type: "integer",
          description: "Start X coordinate (0-1439).",
        },
        y1: {
          type: "integer",
          description: "Start Y coordinate (0-899).",
        },
        x2: {
          type: "integer",
          description: "End X coordinate (0-1439).",
        },
        y2: {
          type: "integer",
          description: "End Y coordinate (0-899).",
        },
        risk: RISK_PROPERTY,
      },
      required: ["x1", "y1", "x2", "y2"],
    },
  },
  {
    type: "function",
    name: "list_windows",
    description: "List all open desktop windows with their IDs and titles.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "focus_window",
    description: "Bring a window to focus by its window ID.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Window ID from list_windows.",
        },
      },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "run_shell",
    description: "Execute a bash shell command in the Ubuntu desktop environment.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to execute.",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 120).",
        },
        risk: RISK_PROPERTY,
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read content from a file (up to 200,000 characters).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute file path to read.",
        },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Write content to a file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute file path to write.",
        },
        content: {
          type: "string",
          description: "Content to write to the file.",
        },
        risk: RISK_PROPERTY,
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
    name: "open_url",
    description: "Open a URL in this Bot's dedicated Google Chrome tab (sharing the Primary Profile login state via CDP).",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "HTTP or HTTPS URL to open.",
        },
        risk: RISK_PROPERTY,
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "browser_snapshot",
    description:
      "Inspect the active tab in this Bot's dedicated Google Chrome window via Chrome DevTools Protocol (CDP) WITHOUT taking a screenshot. Optionally opens/navigates to `url` first. Traverses Open Shadow DOM and same-origin iframes, prioritizes in-viewport interactive elements (`[e1]..[eN]`), and reports `iframes`, `challenge_detected`, and `focused` metadata.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Optional HTTP/HTTPS URL to open or navigate to before taking the DOM snapshot.",
        },
        max_elements: {
          type: "integer",
          description: "Maximum number of interactive elements to return (1-200, default: 80).",
        },
        max_text: {
          type: "integer",
          description: "Maximum characters of visible page text to return (100-20000, default: 3000).",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "browser_click",
    description:
      "Click an interactive browser element by its `[eN]` ref (e.g. 'e1', 'e3') returned by `browser_snapshot` WITHOUT taking a screenshot or guessing pixel coordinates. Automatically handles Shadow DOM / same-origin iframe refs, sticky-header occlusion fallback, post-click page navigation settle, and new tabs (`target=\"_blank\"` / `window.open`).",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Element reference ID from `browser_snapshot` (e.g. 'e1', 'e5').",
        },
        risk: RISK_PROPERTY,
      },
      required: ["ref"],
    },
  },
  {
    type: "function",
    name: "browser_type",
    description:
      "Type or fill text into an input/textarea/contenteditable browser element by its `[eN]` ref (e.g. 'e2') returned by `browser_snapshot` WITHOUT taking a screenshot. Optionally submits (`submit: true`). For `<select>` dropdowns, use `browser_select` instead. Automatically returns the updated page snapshot.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Element reference ID from `browser_snapshot` (e.g. 'e2').",
        },
        text: {
          type: "string",
          description: "Text string to fill into the element.",
        },
        submit: {
          type: "boolean",
          description: "Whether to press Enter / submit the form after typing (default: false).",
        },
        clear: {
          type: "boolean",
          description: "Whether to clear existing input value before typing (default: true).",
        },
        risk: RISK_PROPERTY,
      },
      required: ["ref", "text"],
    },
  },
  {
    type: "function",
    name: "browser_tabs",
    description:
      "Manage tabs strictly inside this Bot's own dedicated Google Chrome window (`list`, `new`, `switch`, `close`). Never touches other Bots' windows or tabs.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "new", "switch", "close"],
          description: "Tab operation: 'list' open tabs in this Bot's window, 'new' to open a tab in this window, 'switch' to another tab by target_id/index, or 'close' a tab (cannot close the last tab).",
        },
        url: {
          type: "string",
          description: "Optional HTTP/HTTPS URL when `action` is 'new' (defaults to about:blank).",
        },
        target_id: {
          type: "string",
          description: "Target tab ID (from `browser_tabs(action='list')`) for 'switch' or 'close'.",
        },
        index: {
          type: "integer",
          description: "0-based tab index in this Bot's window for 'switch' or 'close'.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "browser_scroll",
    description:
      "Scroll the active page (or a specific scrollable container by `ref`) inside this Bot's dedicated Chrome tab via CDP WITHOUT taking a screenshot or grabbing X11 focus, and return the refreshed DOM snapshot.",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction (default: 'down').",
        },
        amount: {
          type: "integer",
          description: "Scroll distance in CSS pixels (50-5000, default: 600).",
        },
        ref: {
          type: "string",
          description: "Optional `[eN]` ref inside a scrollable container (e.g. modal or list) to scroll that container instead of the main window.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "browser_wait",
    description:
      "Wait in this Bot's dedicated Chrome tab until specified `text` appears, a `ref` exists, or `ms` elapses (or the SPA finishes rendering), then return a fresh DOM snapshot WITHOUT taking a screenshot.",
    parameters: {
      type: "object",
      properties: {
        ms: {
          type: "integer",
          description: "Milliseconds to wait when neither `text` nor `ref` is given (200-15000, default: 1500).",
        },
        text: {
          type: "string",
          description: "Optional visible text substring to wait for on the page before returning.",
        },
        ref: {
          type: "string",
          description: "Optional `[eN]` ref to wait for.",
        },
        timeout: {
          type: "number",
          description: "Max wait timeout in seconds when polling for `text`/`ref` (1-20, default: 10).",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "browser_select",
    description:
      "Select an option in a native `<select>` dropdown element by its `[eN]` ref (matching `value` or visible `label`), firing full `input` and `change` events and returning the updated snapshot WITHOUT taking a screenshot.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Element reference ID of the `<select>` from `browser_snapshot` (e.g. 'e4').",
        },
        value: {
          type: "string",
          description: "Option `value` attribute to select.",
        },
        label: {
          type: "string",
          description: "Visible option text label to select (used when `value` is omitted or does not match).",
        },
        risk: RISK_PROPERTY,
      },
      required: ["ref"],
    },
  },
  {
    type: "function",
    name: "browser_upload_file",
    description:
      "Attach one or more local files inside Bot's Computer directly to an `<input type=\"file\">` element by its `[eN]` ref via CDP `DOM.setFileInputFiles`, bypassing OS file picker dialogs completely and returning the updated snapshot WITHOUT taking a screenshot.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Element reference ID of the `<input type=\"file\">` from `browser_snapshot` (including hidden file inputs).",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of absolute file paths inside Bot's Ubuntu computer to upload.",
        },
        risk: RISK_PROPERTY,
      },
      required: ["ref", "paths"],
    },
  },
];

export const SCREEN_CHANGING = new Set([
  "click",
  "type_text",
  "key",
  "scroll",
  "drag",
  "focus_window",
  "open_url",
]);

const ROUTE_MAP: Record<string, string> = {
  screenshot: "/screenshot",
  click: "/click",
  type_text: "/type",
  key: "/key",
  scroll: "/scroll",
  drag: "/drag",
  list_windows: "/windows",
  focus_window: "/focus",
  run_shell: "/shell",
  read_file: "/read",
  write_file: "/write",
  open_url: "/open_url",
  browser_snapshot: "/browser/snapshot",
  browser_click: "/browser/click",
  browser_type: "/browser/type",
  browser_tabs: "/browser/tabs",
  browser_scroll: "/browser/scroll",
  browser_wait: "/browser/wait",
  browser_select: "/browser/select",
  browser_upload_file: "/browser/upload",
};

export interface RunToolOptions {
  settleMs?: number;
  signal?: AbortSignal;
  prevScreenshotSha1?: string | null;
}

export async function runTool(
  name: string,
  args: Record<string, any> | undefined,
  client: ExecutorClient,
  { settleMs = 150, signal, prevScreenshotSha1 = null }: RunToolOptions = {}
): Promise<{ result: any; screenshot: Buffer | null }> {
  const route = ROUTE_MAP[name];
  if (!route) {
    return {
      result: { error: `unknown tool: ${name}` },
      screenshot: null,
    };
  }

  const { risk: _risk, ...cleanArgs } = args || {};
  const hasSecretArg = Object.values(cleanArgs).some(
    (v) => typeof v === "string" && v.includes("{{secret:")
  );
  if (hasSecretArg && !SECRET_INJECTABLE_TOOLS.has(name)) {
    return {
      result: {
        error:
          "Refusing to inject credential secret_ref outside browser_type / type_text; pass secret_ref directly as `text` to browser_type(ref, text) or OS-level type_text(text) instead.",
      },
      screenshot: null,
    };
  }
  let execArgs = cleanArgs;
  if (
    SECRET_INJECTABLE_TOOLS.has(name) &&
    typeof cleanArgs.text === "string" &&
    cleanArgs.text.includes("{{secret:")
  ) {
    const { resolved, missingSecret } = resolveEphemeralSecretPlaceholders(cleanArgs.text);
    if (missingSecret) {
      return {
        result: {
          error:
            "credential secret_ref expired or not found in host memory; call request_credential again",
        },
        screenshot: null,
      };
    }
    execArgs =
      name === "type_text"
        ? { ...cleanArgs, text: resolved, sensitive: true }
        : { ...cleanArgs, text: resolved };
  }
  const callOptions = signal ? { signal } : undefined;

  try {
    const res: any = callOptions
      ? await client.call(route, execArgs, callOptions)
      : await client.call(route, execArgs);

    if (name === "screenshot") {
      const screenshot = res?.png_base64
        ? Buffer.from(res.png_base64, "base64")
        : null;
      return {
        result: {
          ok: true,
          width: res?.width ?? 1440,
          height: res?.height ?? 900,
        },
        screenshot,
      };
    }

    let screenshot: Buffer | null = null;
    if (SCREEN_CHANGING.has(name)) {
      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      if (signal?.aborted) {
        return { result: res, screenshot: null };
      }
      const shot: any = callOptions
        ? await client.call("/screenshot", {}, callOptions)
        : await client.call("/screenshot", {});
      if (shot?.png_base64) {
        screenshot = Buffer.from(shot.png_base64, "base64");
        if (prevScreenshotSha1 && res && typeof res === "object") {
          const nextSha1 = hashScreenshot(screenshot);
          const changed = Boolean(nextSha1 && nextSha1 !== prevScreenshotSha1);
          res.screen_changed = changed;
          if (!changed) {
            res.screen_note = "Screen pixels did not change after this action";
          }
        }
      }
    }

    return { result: res, screenshot };
  } catch (err: any) {
    return {
      result: { error: err?.message || String(err) },
      screenshot: null,
    };
  }
}
