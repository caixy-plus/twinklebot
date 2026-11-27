import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpServerConfig {
  type?: string;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
}

export interface McpDiscoveredToolSummary {
  name: string;
  fullName: string;
  description: string;
  params: string[];
  required: string[];
  readOnly: boolean;
}

export interface McpRuntimeProfile {
  serverId: string;
  serverInfo: { name?: string; version?: string } | null;
  capabilities: Record<string, any>;
  runtimeCapabilities: Record<string, any> | null;
  instructions: string;
  tools: McpDiscoveredToolSummary[];
}

export interface McpServerStatus {
  serverId: string;
  configured: boolean;
  command?: string;
  args?: string[];
  binaryExists: boolean;
  connected: boolean;
  unsupportedPlatform?: boolean;
  binaryUpgraded?: boolean;
  serverInfo?: { name?: string; version?: string } | null;
  capabilities?: Record<string, any>;
  runtimeCapabilities?: Record<string, any> | null;
  instructions?: string;
  toolCount?: number;
  tools?: string[];
  error?: string;
}

const KNOWN_READONLY_MCP_TOOLS = new Set([
  "list_apps",
  "list_windows",
  "get_window",
  "get_app_state",
  "get_window_state",
  "subscribe_system_state",
  "get_system_state",
  "unsubscribe_system_state",
]);

const MUTATING_MCP_TOOL_WORDS_RE =
  /(?:^|_)(click|type|paste|press|key|scroll|drag|set|write|edit|delete|remove|drop|send|submit|pay|launch|open|activate|close|kill|quit|stop|run|exec|eval|js|perform|select|tap|focus|move|resize|clear|reset|toggle|create|update|install|uninstall)(?:$|_)/i;

export function inferMcpToolReadOnly(tool: any): boolean {
  if (tool?.annotations?.destructiveHint === true) return false;
  if (typeof tool?.annotations?.readOnlyHint === "boolean") {
    return tool.annotations.readOnlyHint;
  }
  const rawName = String(tool?.name || "").trim();
  if (!rawName) return false;
  if (KNOWN_READONLY_MCP_TOOLS.has(rawName)) return true;
  if (MUTATING_MCP_TOOL_WORDS_RE.test(rawName)) return false;
  return /^(list|get|read|inspect|describe|check|find|query|search)_/i.test(rawName);
}

function resolveBinaryPath(command: unknown): string {
  const cmd = String(command || "").trim();
  if (!cmd) return "";
  if (path.isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return "";
    }
  }
  const pathDirs = String(process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue scanning PATH
    }
  }
  return "";
}

function computeBinaryFingerprint(command: unknown, args?: readonly unknown[]): string {
  const parts: string[] = [];
  const resolved = resolveBinaryPath(command);
  if (resolved) {
    try {
      const st = fs.statSync(resolved);
      parts.push(`${resolved}:${Math.trunc(st.mtimeMs)}:${st.size}`);
    } catch {
      parts.push(resolved);
    }
  }
  if (Array.isArray(args)) {
    const firstArg = typeof args[0] === "string" ? args[0].trim() : "";
    if (firstArg && !firstArg.startsWith("-")) {
      try {
        const st = fs.statSync(firstArg);
        if (st.isFile()) {
          parts.push(`arg0:${Math.trunc(st.mtimeMs)}:${st.size}`);
        }
      } catch {
        // ignore non-file argument
      }
    }
  }
  return parts.join("|");
}

export function isKimiCuSupportedPlatform(platform: string = process.platform): boolean {
  return platform === "darwin";
}

export function getDefaultMcpServers(
  platform: string = process.platform
): Readonly<Record<string, McpServerConfig>> {
  return Object.freeze({
    "kimi-cu": Object.freeze({
      type: "stdio",
      command: isKimiCuSupportedPlatform(platform)
        ? "/Applications/KimiCU.app/Contents/MacOS/kimi-cu"
        : "",
      args: Object.freeze(["mcp", "-s", "user"]),
    }),
  });
}

export const DEFAULT_MCP_SERVERS: Readonly<Record<string, McpServerConfig>> =
  getDefaultMcpServers(process.platform);

const SCRUBBED_ENV_KEYS = [
  "GEMINI_API_KEY",
  "VERTEX_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "CUSTOM_LLM_API_KEY",
  "TWINKLEBOT_CLOUD_TOKEN",
  "TWINKLEBOT_LOCAL_TOKEN",
  "TWINKLEBOT_EXECUTOR_TOKEN",
];

export function sanitizeServerKey(serverId: unknown): string {
  return String(serverId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "_");
}

export function toMcpFunctionName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeServerKey(serverId)}__${String(toolName || "").trim()}`;
}

export function isMcpToolName(name: unknown): name is string {
  return typeof name === "string" && /^mcp__[a-zA-Z0-9_]+__.+$/.test(name);
}

export function parseMcpFunctionName(
  fnName: unknown,
  knownServerIds: string[] = Object.keys(DEFAULT_MCP_SERVERS)
): { serverId: string; toolName: string } | null {
  if (!isMcpToolName(fnName)) return null;
  const rest = fnName.slice("mcp__".length);
  for (const serverId of knownServerIds) {
    const prefix = `${sanitizeServerKey(serverId)}__`;
    if (rest.startsWith(prefix) && rest.length > prefix.length) {
      return {
        serverId,
        toolName: rest.slice(prefix.length),
      };
    }
  }
  const sepIdx = rest.indexOf("__");
  if (sepIdx <= 0 || sepIdx + 2 >= rest.length) return null;
  return {
    serverId: rest.slice(0, sepIdx),
    toolName: rest.slice(sepIdx + 2),
  };
}

export function sanitizeMcpSchemaForGemini(rawSchema: any): Record<string, any> {
  if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
    return { type: "object", properties: {} };
  }

  const out: Record<string, any> = {};

  if (Array.isArray(rawSchema.type)) {
    const nonNull = rawSchema.type.find((t: unknown) => t !== "null") || "string";
    out.type = String(nonNull);
  } else if (typeof rawSchema.type === "string" && rawSchema.type) {
    out.type = rawSchema.type;
  } else if (rawSchema.properties && typeof rawSchema.properties === "object") {
    out.type = "object";
  }

  if (typeof rawSchema.description === "string" && rawSchema.description.trim()) {
    out.description = rawSchema.description;
  }

  if (Array.isArray(rawSchema.enum) && rawSchema.enum.length > 0) {
    out.enum = [...rawSchema.enum];
  }

  if (
    rawSchema.properties &&
    typeof rawSchema.properties === "object" &&
    !Array.isArray(rawSchema.properties)
  ) {
    const cleanProps: Record<string, any> = {};
    for (const [key, propSchema] of Object.entries(rawSchema.properties)) {
      if (!propSchema || typeof propSchema !== "object") continue;
      cleanProps[key] = sanitizeMcpSchemaForGemini(propSchema);
    }
    out.properties = cleanProps;
  } else if (out.type === "object") {
    out.properties = {};
  }

  if (Array.isArray(rawSchema.required) && out.properties) {
    const validRequired = rawSchema.required.filter(
      (k: unknown) =>
        typeof k === "string" && Object.prototype.hasOwnProperty.call(out.properties, k)
    );
    if (validRequired.length > 0) {
      out.required = validRequired;
    }
  }

  if (out.type === "array") {
    out.items =
      rawSchema.items && typeof rawSchema.items === "object" && !Array.isArray(rawSchema.items)
        ? sanitizeMcpSchemaForGemini(rawSchema.items)
        : { type: "string" };
  }

  if (!out.type) {
    out.type = "string";
  }

  return out;
}

export function buildScrubbedEnv(extraEnv: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key];
  }
  if (process.platform !== "win32") {
    const curPath = String(env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin");
    const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"].filter(
      (p) => !curPath.split(path.delimiter).includes(p)
    );
    if (extraPaths.length > 0) {
      env.PATH = [...extraPaths, curPath].join(path.delimiter);
    }
  }
  if (extraEnv && typeof extraEnv === "object") {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (SCRUBBED_ENV_KEYS.includes(k)) continue;
      if (v != null) env[k] = String(v);
    }
  }
  return env;
}

function checkBinaryExists(command: unknown): boolean {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (path.isAbsolute(cmd) || cmd.includes("/")) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathDirs = String(process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      // continue scanning PATH
    }
  }
  return false;
}

interface PendingJsonRpc {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createStdioSession(
  serverId: string,
  serverConfig: McpServerConfig,
  { spawnFn = nodeSpawn }: { spawnFn?: typeof nodeSpawn } = {}
) {
  const command = String(serverConfig?.command || "").trim();
  const args = Array.isArray(serverConfig?.args)
    ? serverConfig.args.map((a) => String(a))
    : [];

  let child: ChildProcessByStdio<Writable, Readable, Readable> | any = null;
  let rl: readline.Interface | null = null;
  let nextId = 1;
  let closed = false;
  let stderrTail = "";
  let serverInfo: any = null;
  let serverCapabilities: Record<string, any> = {};
  let serverInstructions = "";
  let toolsCache: any[] | null = null;
  let toolsStale = false;
  let connectPromise: Promise<void> | null = null;
  const pending = new Map<number, PendingJsonRpc>();

  function rejectAllPending(err: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function cleanupChild(): void {
    if (rl) {
      try {
        rl.close();
      } catch {}
      rl = null;
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {}
      child = null;
    }
    connectPromise = null;
  }

  function sendJson(payload: unknown): void {
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error(`MCP server "${serverId}" stdin is not writable`);
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 20_000,
    signal?: AbortSignal
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!child || child.killed) {
        reject(new Error(`MCP server "${serverId}" is not running`));
        return;
      }
      if (signal?.aborted) {
        reject(signal.reason || new Error("Aborted"));
        return;
      }

      const id = nextId++;
      let onAbort: (() => void) | null = null;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(new Error(`MCP "${serverId}" ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          pending.delete(id);
          reject(signal.reason || new Error("Aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      pending.set(id, {
        resolve: (val) => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve(val);
        },
        reject: (err) => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
      });

      try {
        sendJson({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        });
      } catch (err: any) {
        clearTimeout(timer);
        pending.delete(id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    });
  }

  async function ensureConnected(): Promise<void> {
    if (closed) {
      throw new Error(`MCP session "${serverId}" is closed`);
    }
    if (child && !child.killed && child.exitCode === null && toolsCache) {
      return;
    }
    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = (async () => {
      if (!command) {
        throw new Error(`MCP server "${serverId}" has no command configured`);
      }
      if (!checkBinaryExists(command)) {
        const err: any = new Error(`未找到可执行文件：${command}`);
        err.code = "ENOENT";
        throw err;
      }

      stderrTail = "";
      toolsCache = null;
      toolsStale = false;
      serverCapabilities = {};
      serverInstructions = "";

      const proc = spawnFn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildScrubbedEnv(serverConfig?.env),
      });
      child = proc;

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });

      proc.on("error", (err: Error) => {
        rejectAllPending(err);
        cleanupChild();
      });

      proc.on("exit", (code: number | null, sig: NodeJS.Signals | null) => {
        const suffix = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
        rejectAllPending(
          new Error(
            `MCP server "${serverId}" exited (${code ?? sig ?? "unknown"})${suffix}`
          )
        );
        if (child === proc) {
          child = null;
          rl = null;
          toolsCache = null;
          toolsStale = false;
          connectPromise = null;
        }
      });

      rl = readline.createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) return;
        let msg: any;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (msg.id === undefined || msg.id === null) {
          if (msg.method === "notifications/tools/list_changed") {
            toolsStale = true;
          }
          return;
        }
        const entry = pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(
            new Error(
              msg.error.message || JSON.stringify(msg.error) || "MCP JSON-RPC error"
            )
          );
        } else {
          entry.resolve(msg.result);
        }
      });

      try {
        const initRes = await request(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "twinklebot", version: "1.0.0" },
          },
          12_000
        );
        serverInfo = initRes?.serverInfo || null;
        serverCapabilities =
          initRes?.capabilities && typeof initRes.capabilities === "object"
            ? initRes.capabilities
            : {};
        serverInstructions =
          typeof initRes?.instructions === "string" ? initRes.instructions.trim() : "";
        sendJson({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        const listRes = await request("tools/list", {}, 12_000);
        toolsCache = Array.isArray(listRes?.tools) ? listRes.tools : [];
        toolsStale = false;
      } catch (err) {
        cleanupChild();
        throw err;
      }
    })();

    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  function buildRuntimeProfile(): McpRuntimeProfile {
    const tools = (toolsCache || [])
      .filter((t) => Boolean(t?.name))
      .map((t) => {
        const props =
          t?.inputSchema?.properties && typeof t.inputSchema.properties === "object"
            ? Object.keys(t.inputSchema.properties)
            : [];
        const req = Array.isArray(t?.inputSchema?.required)
          ? t.inputSchema.required.map(String)
          : [];
        return {
          name: String(t.name),
          fullName: toMcpFunctionName(serverId, String(t.name)),
          description: String(t.description || ""),
          params: props,
          required: req,
          readOnly: inferMcpToolReadOnly(t),
        };
      });
    const exp = serverCapabilities?.experimental;
    const runtimeCapabilities =
      exp && typeof exp === "object" && exp["kimi-cu-runtime"] && typeof exp["kimi-cu-runtime"] === "object"
        ? exp["kimi-cu-runtime"]
        : null;
    return {
      serverId,
      serverInfo,
      capabilities: serverCapabilities,
      runtimeCapabilities,
      instructions: serverInstructions,
      tools,
    };
  }

  return {
    isConnected(): boolean {
      return Boolean(child && !child.killed && child.exitCode === null && toolsCache);
    },
    getServerInfo() {
      return serverInfo;
    },
    getCapabilities() {
      return serverCapabilities;
    },
    getInstructions() {
      return serverInstructions;
    },
    getRuntimeProfile(): McpRuntimeProfile {
      return buildRuntimeProfile();
    },
    getCachedTools(): any[] {
      return toolsCache || [];
    },
    async listTools(): Promise<any[]> {
      await ensureConnected();
      if (toolsStale) {
        const listRes = await request("tools/list", {}, 12_000);
        toolsCache = Array.isArray(listRes?.tools) ? listRes.tools : [];
        toolsStale = false;
      }
      return toolsCache || [];
    },
    async callTool(
      toolName: string,
      rawArgs: Record<string, unknown> = {},
      { timeoutMs = 45_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}
    ) {
      await ensureConnected();
      const toolSpec = (toolsCache || []).find((t) => t.name === toolName);
      const schemaHasRisk = Boolean(
        toolSpec?.inputSchema?.properties &&
          Object.prototype.hasOwnProperty.call(toolSpec.inputSchema.properties, "risk")
      );
      const cleanArgs: Record<string, unknown> = {
        ...(rawArgs && typeof rawArgs === "object" ? rawArgs : {}),
      };
      if (!schemaHasRisk) {
        delete cleanArgs.risk;
      }

      const rpcRes = await request(
        "tools/call",
        { name: toolName, arguments: cleanArgs },
        timeoutMs,
        signal
      );

      const contentArr: any[] = Array.isArray(rpcRes?.content) ? rpcRes.content : [];
      const textParts: string[] = [];
      let screenshot: Buffer | null = null;
      let mimeType: string | null = null;

      for (const item of contentArr) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") {
          textParts.push(item.text);
        } else if (item.type === "image" && typeof item.data === "string" && item.data) {
          if (!screenshot) {
            screenshot = Buffer.from(item.data, "base64");
            mimeType = item.mimeType || item.mime_type || "image/png";
          }
        }
      }

      const rawCombinedText = textParts.join("\n").trim();
      const MAX_MCP_TEXT_CHARS = 12_000;
      const combinedText =
        rawCombinedText.length > MAX_MCP_TEXT_CHARS
          ? `${rawCombinedText.slice(0, 6000)}\n...[truncated ${rawCombinedText.length - MAX_MCP_TEXT_CHARS} MCP chars]...\n${rawCombinedText.slice(-6000)}`
          : rawCombinedText;
      let structured =
        rpcRes?.structuredContent && typeof rpcRes.structuredContent === "object"
          ? rpcRes.structuredContent
          : undefined;
      if (structured) {
        try {
          const serialized = JSON.stringify(structured);
          if (serialized.length > MAX_MCP_TEXT_CHARS) {
            structured = {
              _truncated: true,
              originalLength: serialized.length,
              preview: `${serialized.slice(0, 6000)}...${serialized.slice(-2000)}`,
            };
          }
        } catch {
          // keep as-is if non-serializable
        }
      }

      if (rpcRes?.isError) {
        return {
          result: {
            ok: false,
            error: combinedText || "MCP tool returned an error",
            ...(structured ? { structuredContent: structured } : {}),
          },
          screenshot,
          mimeType,
        };
      }

      return {
        result: {
          ok: true,
          ...(combinedText ? { text: combinedText } : {}),
          ...(structured ? { structuredContent: structured } : {}),
        },
        screenshot,
        mimeType,
      };
    },
    async close(): Promise<void> {
      closed = true;
      rejectAllPending(new Error(`MCP server "${serverId}" stopped`));
      cleanupChild();
    },
  };
}

export function createMcpManager({
  getServersConfig,
  spawnFn = nodeSpawn,
  platform = process.platform,
}: {
  getServersConfig?: () => Record<string, McpServerConfig>;
  spawnFn?: typeof nodeSpawn;
  platform?: string;
} = {}) {
  const defaultServers = getDefaultMcpServers(platform);
  const sessions = new Map<
    string,
    { sig: string; session: ReturnType<typeof createStdioSession> }
  >();

  function resolveConfigs(): Record<string, McpServerConfig> {
    const custom = getServersConfig?.() || {};
    const merged: Record<string, McpServerConfig> = {
      ...defaultServers,
      ...(custom && typeof custom === "object" ? custom : {}),
    };
    // Guard against legacy saved Mac .app path leaking onto Windows/Linux hosts
    if (
      !isKimiCuSupportedPlatform(platform) &&
      merged["kimi-cu"]?.command === "/Applications/KimiCU.app/Contents/MacOS/kimi-cu"
    ) {
      merged["kimi-cu"] = {
        ...merged["kimi-cu"],
        command: "",
      };
    }
    return merged;
  }

  function configSignature(cfg: McpServerConfig | undefined): string {
    return JSON.stringify({
      type: cfg?.type || "stdio",
      command: cfg?.command || "",
      args: Array.isArray(cfg?.args) ? cfg.args : [],
      env: cfg?.env || {},
      binaryFingerprint: computeBinaryFingerprint(cfg?.command, cfg?.args),
    });
  }

  async function getOrCreateSession(serverId: string) {
    const configs = resolveConfigs();
    const cfg = configs[serverId];
    if (!cfg) {
      throw new Error(`未配置 MCP 服务 "${serverId}"`);
    }
    const sig = configSignature(cfg);
    const existing = sessions.get(serverId);
    if (existing && existing.sig === sig) {
      return existing.session;
    }
    if (existing) {
      await existing.session.close();
      sessions.delete(serverId);
    }
    const session = createStdioSession(serverId, cfg, { spawnFn });
    sessions.set(serverId, { sig, session });
    return session;
  }

  return {
    getResolvedServersConfig() {
      return resolveConfigs();
    },

    getServerRuntimeProfile(serverId: string): McpRuntimeProfile | null {
      const configs = resolveConfigs();
      const cfg = configs[serverId];
      if (!cfg) return null;
      const existing = sessions.get(serverId);
      if (!existing || existing.sig !== configSignature(cfg) || !existing.session.isConnected()) {
        return null;
      }
      return existing.session.getRuntimeProfile();
    },

    async listGeminiTools(serverIds: string[] = []) {
      const declarations: any[] = [];
      for (const serverId of serverIds) {
        const session = await getOrCreateSession(serverId);
        const rawTools = await session.listTools();
        for (const t of rawTools) {
          if (!t?.name) continue;
          const params = sanitizeMcpSchemaForGemini(t.inputSchema);
          if (!params.properties) params.properties = {};
          const isReadOnly = inferMcpToolReadOnly(t);
          if (!isReadOnly && !params.properties.risk) {
            params.properties.risk = {
              type: "string",
              enum: ["low", "medium", "high"],
              description:
                "Optional (OMIT or use 'low'/'medium' for routine Mac app clicking, typing, searching, saving, or user-requested actions). Set 'high' ONLY for the final irreversible action: sending a message to someone, real payment/order, or permanent deletion.",
            };
          }
          declarations.push({
            type: "function",
            name: toMcpFunctionName(serverId, t.name),
            description: `[Mac MCP:${serverId}] ${t.description || t.name}`,
            parameters: params,
          });
        }
      }
      return declarations;
    },

    async callTool(
      fullToolName: string,
      args: Record<string, unknown> = {},
      options: { timeoutMs?: number; signal?: AbortSignal } = {}
    ) {
      const configs = resolveConfigs();
      const parsed = parseMcpFunctionName(fullToolName, Object.keys(configs));
      if (!parsed) {
        throw new Error(`Invalid MCP tool name: ${fullToolName}`);
      }
      const session = await getOrCreateSession(parsed.serverId);
      return session.callTool(parsed.toolName, args, options);
    },

    async getServerStatus(
      serverId: string,
      { connect = false }: { connect?: boolean } = {}
    ): Promise<McpServerStatus> {
      const configs = resolveConfigs();
      const cfg = configs[serverId];
      if (!cfg) {
        return {
          serverId,
          configured: false,
          binaryExists: false,
          connected: false,
          error: `未配置 MCP 服务 ${serverId}`,
        };
      }
      const commandStr = String(cfg.command || "").trim();
      const kimiUnsupported = serverId === "kimi-cu" && !isKimiCuSupportedPlatform(platform);
      if (!commandStr) {
        return {
          serverId,
          configured: true,
          command: "",
          args: Array.isArray(cfg.args) ? [...cfg.args] : [],
          binaryExists: false,
          connected: false,
          ...(kimiUnsupported ? { unsupportedPlatform: true } : {}),
          toolCount: 0,
          tools: [],
          error: kimiUnsupported
            ? "当前系统暂不支持 KimiCU（仅支持 macOS），或可在配置中指定自定义 MCP 服务路径"
            : `未配置 MCP 服务 ${serverId} 的可执行路径`,
        };
      }
      const binaryExists = checkBinaryExists(commandStr);
      if (!binaryExists) {
        return {
          serverId,
          configured: true,
          command: commandStr,
          args: Array.isArray(cfg.args) ? [...cfg.args] : [],
          binaryExists: false,
          connected: false,
          ...(kimiUnsupported ? { unsupportedPlatform: true } : {}),
          toolCount: 0,
          tools: [],
          error: kimiUnsupported
            ? "未检测到可用的本地 MCP 服务（KimiCU 仅支持 macOS）"
            : `未检测到可执行文件（${commandStr}），请确认已安装或检查配置路径`,
        };
      }

      if (!connect) {
        const existingEntry = sessions.get(serverId);
        const existing = existingEntry?.session;
        const upToDate =
          Boolean(existing && existing.isConnected()) &&
          existingEntry?.sig === configSignature(cfg);
        if (upToDate && existing) {
          const profile = existing.getRuntimeProfile();
          return {
            serverId,
            configured: true,
            command: cfg.command,
            args: Array.isArray(cfg.args) ? [...cfg.args] : [],
            binaryExists: true,
            connected: true,
            serverInfo: profile.serverInfo,
            capabilities: profile.capabilities,
            runtimeCapabilities: profile.runtimeCapabilities,
            ...(profile.instructions ? { instructions: profile.instructions } : {}),
            toolCount: profile.tools.length,
            tools: profile.tools.map((t) => t.name),
          };
        }
        return {
          serverId,
          configured: true,
          command: cfg.command,
          args: Array.isArray(cfg.args) ? [...cfg.args] : [],
          binaryExists: true,
          connected: false,
          ...(existing && existing.isConnected() ? { binaryUpgraded: true } : {}),
          toolCount: 0,
          tools: [],
        };
      }

      try {
        const session = await getOrCreateSession(serverId);
        await session.listTools();
        const profile = session.getRuntimeProfile();
        return {
          serverId,
          configured: true,
          command: cfg.command,
          args: Array.isArray(cfg.args) ? [...cfg.args] : [],
          binaryExists: true,
          connected: true,
          serverInfo: profile.serverInfo,
          capabilities: profile.capabilities,
          runtimeCapabilities: profile.runtimeCapabilities,
          ...(profile.instructions ? { instructions: profile.instructions } : {}),
          toolCount: profile.tools.length,
          tools: profile.tools.map((t) => t.name),
        };
      } catch (err: any) {
        return {
          serverId,
          configured: true,
          command: cfg.command,
          args: Array.isArray(cfg.args) ? [...cfg.args] : [],
          binaryExists,
          connected: false,
          toolCount: 0,
          tools: [],
          error: err.message || String(err),
        };
      }
    },

    async reconnectServer(serverId: string) {
      await this.stopServer(serverId);
      return this.getServerStatus(serverId, { connect: true });
    },

    async stopServer(serverId: string) {
      const existing = sessions.get(serverId);
      if (existing) {
        sessions.delete(serverId);
        await existing.session.close();
      }
    },

    async closeAll() {
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(entries.map((e) => e.session.close()));
    },
  };
}
