import crypto from "node:crypto";
import type { ExecutorClient } from "../shared/config.js";

const RISK_PROPERTY = {
  type: "string",
  enum: ["low", "high"],
  description: "Set to 'high' if this action pays, sends messages, submits orders, posts publicly, or deletes data.",
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
      properties: {
        risk: RISK_PROPERTY,
      },
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
    description: "Type text via clipboard paste. Use run_shell instead inside terminal windows.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text string to type/paste.",
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
        risk: RISK_PROPERTY,
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
      properties: {
        risk: RISK_PROPERTY,
      },
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
        risk: RISK_PROPERTY,
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
        risk: RISK_PROPERTY,
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
      "Inspect this Bot's dedicated Google Chrome tab via Chrome DevTools Protocol (CDP) WITHOUT taking a screenshot. Optionally opens/navigates to `url` first. Returns the page URL, title, visible text excerpt, and interactive elements tagged with `[e1]..[eN]` refs for `browser_click` and `browser_type`.",
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
        risk: RISK_PROPERTY,
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "browser_click",
    description:
      "Click an interactive browser element by its `[eN]` ref (e.g. 'e1', 'e3') returned by `browser_snapshot` WITHOUT taking a screenshot or guessing pixel coordinates. Automatically returns the updated page snapshot.",
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
      "Type or fill text into an input/textarea/editable browser element by its `[eN]` ref (e.g. 'e2') returned by `browser_snapshot` WITHOUT taking a screenshot. Optionally submits the form (`submit: true`). Automatically returns the updated page snapshot.",
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
