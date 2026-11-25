import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RelayMode = "off" | "frpc" | "external";
export type RelayTransportProtocol = "wss" | "tcp" | "quic";
export type RelayRuntimeState = "stopped" | "starting" | "connected" | "reconnecting" | "error";

export interface RelayFrpcConfig {
  binaryPath: string;
  serverAddr: string;
  serverPort: number;
  transportProtocol: RelayTransportProtocol;
  wsPath: string;
  tlsEnable: boolean;
  authToken: string;
  proxyName: string;
  remotePort: number;
}

export interface RelayConfig {
  mode: RelayMode;
  enabled: boolean;
  publicUrl: string;
  accessToken: string;
  relayLocalPort: number;
  enforceAuthOnRelayPort: boolean;
  preventIdleSleep: boolean;
  frpc: RelayFrpcConfig;
}

export interface FrpcBinaryInfo {
  available: boolean;
  path: string;
  version: string;
}

export interface LegacyRelayInfo {
  detected: boolean;
  source: "geminibot-frpc" | "twinklebot-frpc" | "";
  configPath: string;
  tokenPath: string;
  plistPath: string;
  plistExists: boolean;
  plistLoaded: boolean;
  hasLegacyToken: boolean;
  serverAddr: string;
  serverPort: number;
  transportProtocol: RelayTransportProtocol;
  wsPath: string;
  tlsEnable: boolean;
  proxyName: string;
  remotePort: number;
  suggestedPublicUrl: string;
}

export interface RelayTestResult {
  ok: boolean;
  checkedAt: string;
  publicUrl: string;
  withTokenStatus: number;
  withTokenLatencyMs: number;
  withoutTokenStatus: number;
  authEnforced: boolean;
  remoteDeployEnv?: string;
  remoteInstanceId?: string;
  instanceMatched?: boolean;
  error?: string;
}

export const DEFAULT_RELAY_LOCAL_PORT = 3231;

function sanitizeSingleLine(raw: unknown, maxLen = 200): string {
  return String(raw || "")
    .replace(/[\r\n\0]+/g, "")
    .trim()
    .slice(0, maxLen);
}

function escapeTomlString(raw: unknown): string {
  return sanitizeSingleLine(raw, 512)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function generateRelayToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function normalizePort(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return fallback;
}

function normalizePublicUrl(raw: unknown): string {
  const cleaned = sanitizeSingleLine(raw, 300).replace(/\/+$/, "");
  if (!cleaned) return "";
  try {
    const u = new URL(cleaned);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin + (u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "");
  } catch {
    return "";
  }
}

export function normalizeRelayConfig(
  raw: unknown,
  { ensureToken = false }: { ensureToken?: boolean } = {}
): RelayConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const rawMode = String(src.mode || "off").trim().toLowerCase();
  const mode: RelayMode =
    rawMode === "frpc" || rawMode === "external" ? rawMode : "off";
  const enabled = mode !== "off" && Boolean(src.enabled);
  const rawFrpc = src.frpc && typeof src.frpc === "object" ? src.frpc : {};
  const protoRaw = String(rawFrpc.transportProtocol || "wss").trim().toLowerCase();
  const transportProtocol: RelayTransportProtocol =
    protoRaw === "tcp" || protoRaw === "quic" ? protoRaw : "wss";
  let wsPath = sanitizeSingleLine(rawFrpc.wsPath || "/~!frp", 120) || "/~!frp";
  if (!wsPath.startsWith("/")) wsPath = `/${wsPath}`;
  let accessToken = sanitizeSingleLine(src.accessToken, 256);
  if (!accessToken && (ensureToken || enabled)) {
    accessToken = generateRelayToken();
  }

  return {
    mode,
    enabled,
    publicUrl: normalizePublicUrl(src.publicUrl),
    accessToken,
    relayLocalPort: normalizePort(src.relayLocalPort, DEFAULT_RELAY_LOCAL_PORT),
    enforceAuthOnRelayPort: src.enforceAuthOnRelayPort !== false,
    preventIdleSleep: Boolean(src.preventIdleSleep),
    frpc: {
      binaryPath: sanitizeSingleLine(rawFrpc.binaryPath, 300),
      serverAddr: sanitizeSingleLine(rawFrpc.serverAddr, 200),
      serverPort: normalizePort(rawFrpc.serverPort, 443),
      transportProtocol,
      wsPath,
      tlsEnable:
        rawFrpc.tlsEnable !== undefined
          ? Boolean(rawFrpc.tlsEnable)
          : transportProtocol !== "wss",
      authToken: sanitizeSingleLine(rawFrpc.authToken, 256),
      proxyName:
        sanitizeSingleLine(rawFrpc.proxyName, 64).replace(/[^a-zA-Z0-9._-]/g, "-") ||
        "twinklebot-relay",
      remotePort: normalizePort(rawFrpc.remotePort, 13230),
    },
  };
}

function unquoteTomlValue(raw = ""): string {
  const s = String(raw || "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

function stripTomlComment(rawLine = ""): string {
  let quote: '"' | "'" | "" = "";
  let escaped = false;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return rawLine.slice(0, i).trim();
    }
  }
  return rawLine.trim();
}

export function parseFrpcToml(rawText = "") {
  const out = {
    serverAddr: "",
    serverPort: 443,
    transportProtocol: "wss" as RelayTransportProtocol,
    wsPath: "/~!frp",
    tlsEnable: false,
    authToken: "",
    proxyName: "twinklebot-relay",
    localIP: "127.0.0.1",
    localPort: 3230,
    remotePort: 13230,
  };

  let section = "";
  const lines = String(rawText || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine);
    if (!line) continue;
    const secMatch = line.match(/^\[+([^\]]+)\]+$/);
    if (secMatch) {
      section = secMatch[1].trim().toLowerCase();
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const rawKey = kvMatch[1].trim();
    const key = section && !rawKey.includes(".") && section !== "proxies" ? `${section}.${rawKey}` : rawKey;
    const val = unquoteTomlValue(kvMatch[2]);

    switch (key) {
      case "serverAddr":
        out.serverAddr = val;
        break;
      case "serverPort": {
        const p = Number(val);
        if (Number.isInteger(p) && p > 0 && p <= 65535) out.serverPort = p;
        break;
      }
      case "auth.token":
        out.authToken = val;
        break;
      case "transport.protocol":
        if (val === "tcp" || val === "quic" || val === "wss") out.transportProtocol = val;
        break;
      case "transport.websocket.path":
        if (val) out.wsPath = val.startsWith("/") ? val : `/${val}`;
        break;
      case "transport.tls.enable":
        out.tlsEnable = val === "true";
        break;
      case "name":
        if (section === "proxies" && val) out.proxyName = val;
        break;
      case "localIP":
        if (section === "proxies" && val) out.localIP = val;
        break;
      case "localPort":
        if (section === "proxies") {
          const p = Number(val);
          if (Number.isInteger(p) && p > 0 && p <= 65535) out.localPort = p;
        }
        break;
      case "remotePort":
        if (section === "proxies") {
          const p = Number(val);
          if (Number.isInteger(p) && p > 0 && p <= 65535) out.remotePort = p;
        }
        break;
    }
  }
  return out;
}

export function renderFrpcToml(cfg: RelayConfig, mainPort = 3230): string {
  const localPort = cfg.enforceAuthOnRelayPort ? cfg.relayLocalPort : normalizePort(mainPort, 3230);
  const lines = [
    `serverAddr = "${escapeTomlString(cfg.frpc.serverAddr)}"`,
    `serverPort = ${normalizePort(cfg.frpc.serverPort, 443)}`,
    `loginFailExit = false`,
    ``,
    `auth.method = "token"`,
    `auth.token = "${escapeTomlString(cfg.frpc.authToken)}"`,
    ``,
    `transport.protocol = "${cfg.frpc.transportProtocol}"`,
    `transport.tcpMux = true`,
    `transport.tls.enable = ${cfg.frpc.tlsEnable ? "true" : "false"}`,
  ];
  if (cfg.frpc.transportProtocol === "wss" && cfg.frpc.wsPath && cfg.frpc.wsPath !== "/~!frp") {
    lines.push(`transport.websocket.path = "${escapeTomlString(cfg.frpc.wsPath)}"`);
  }
  lines.push(
    ``,
    `[[proxies]]`,
    `name = "${escapeTomlString(cfg.frpc.proxyName || "twinklebot-relay")}"`,
    `type = "tcp"`,
    `localIP = "127.0.0.1"`,
    `localPort = ${localPort}`,
    `remotePort = ${normalizePort(cfg.frpc.remotePort, 13230)}`,
    ``
  );
  return lines.join("\n");
}

export function detectFrpcBinary(
  customPath = "",
  execSyncFn: typeof execFileSync = execFileSync
): FrpcBinaryInfo {
  const home = os.homedir();
  const candidates = [
    sanitizeSingleLine(customPath, 300),
    "/opt/homebrew/opt/frpc/bin/frpc",
    "/opt/homebrew/bin/frpc",
    "/usr/local/bin/frpc",
    path.join(home, ".local", "bin", "frpc"),
    process.platform === "win32" ? "frpc.exe" : "frpc",
  ].filter(Boolean);

  for (const cand of candidates) {
    if (path.isAbsolute(cand) && !fs.existsSync(cand)) {
      continue;
    }
    try {
      const out = String(
        execSyncFn(cand, ["--version"], {
          encoding: "utf8",
          timeout: 1800,
          stdio: ["ignore", "pipe", "pipe"],
        }) || ""
      ).trim();
      if (out) {
        return {
          available: true,
          path: cand,
          version: out.split(/\r?\n/)[0].trim().slice(0, 48),
        };
      }
    } catch {
      // try next candidate
    }
  }
  return { available: false, path: "", version: "" };
}

export function generateServerTemplates({
  domain = "bot.example.com",
  pathMode = "subdomain" as "subdomain" | "subpath",
  subpath = "/twinklebot",
  remotePort = 13230,
  wsPath = "/~!frp",
  frpAuthToken = "<FRP_AUTH_TOKEN>",
  caddyStaticToken = "",
  mainDomain = "",
}: {
  domain?: string;
  pathMode?: "subdomain" | "subpath";
  subpath?: string;
  remotePort?: number;
  wsPath?: string;
  frpAuthToken?: string;
  caddyStaticToken?: string;
  mainDomain?: string;
} = {}) {
  const cleanDomain = sanitizeSingleLine(domain, 160) || "bot.example.com";
  const cleanMainDomain = sanitizeSingleLine(mainDomain, 160) || cleanDomain;
  const cleanSubpath = (sanitizeSingleLine(subpath, 80) || "/twinklebot").replace(/\/+$/, "");
  const normSubpath = cleanSubpath.startsWith("/") ? cleanSubpath : `/${cleanSubpath}`;
  const cleanWsPath = sanitizeSingleLine(wsPath, 80) || "/~!frp";
  const port = normalizePort(remotePort, 13230);
  const frpTok = sanitizeSingleLine(frpAuthToken, 200) || "<FRP_AUTH_TOKEN>";

  const frpsToml = [
    `# /etc/frp/frps.toml (VPS)`,
    `bindAddr = "127.0.0.1"`,
    `bindPort = 7000`,
    `auth.method = "token"`,
    `auth.token = "${frpTok}"`,
    ``,
    `# Security: bind tunnel port strictly to loopback; Caddy exposes HTTPS :443`,
    `allowPorts = [{ single = ${port} }]`,
    ``,
  ].join("\n");

  const tokenMatcherBlock = caddyStaticToken
    ? [
        `  # Optional edge token guard (or leave empty to delegate all auth to TwinkleBot :3231)`,
        `  @authed {`,
        `    header Authorization "Bearer ${sanitizeSingleLine(caddyStaticToken, 200)}"`,
        `    query token=${sanitizeSingleLine(caddyStaticToken, 200)}`,
        `    header_regexp cookie (?i)tb_relay_auth=${sanitizeSingleLine(caddyStaticToken, 200)}`,
        `  }`,
        `  handle @authed {`,
        `    reverse_proxy 127.0.0.1:${port}`,
        `  }`,
        `  respond 401`,
      ].join("\n")
    : `  reverse_proxy 127.0.0.1:${port}`;

  const caddySubdomain = [
    `# Recommended: dedicated subdomain (full root-path + /novnc support)`,
    `${cleanDomain} {`,
    tokenMatcherBlock,
    `}`,
    ``,
    `# Add this inside your ${cleanMainDomain}:443 Caddy block for frpc WSS control channel:`,
    `handle ${cleanWsPath}* {`,
    `  reverse_proxy 127.0.0.1:7000`,
    `}`,
    ``,
  ].join("\n");

  const caddySubpath = [
    `# Subpath mode inside ${cleanMainDomain} { ... }`,
    `handle ${cleanWsPath}* {`,
    `  reverse_proxy 127.0.0.1:7000`,
    `}`,
    ``,
    `handle_path ${normSubpath}* {`,
    `  header_up X-Forwarded-Prefix ${normSubpath}`,
    `  ${caddyStaticToken ? tokenMatcherBlock.replace(/^  /gm, "  ") : `reverse_proxy 127.0.0.1:${port}`}`,
    `}`,
    ``,
  ].join("\n");

  const installCmd = [
    `# Run on Ubuntu/Debian VPS as root:`,
    `curl -fsSL https://caddyserver.com/api/download?os=linux\\&arch=amd64 -o /usr/local/bin/caddy && chmod +x /usr/local/bin/caddy`,
    `# Place frps in /usr/local/bin/frps and write /etc/frp/frps.toml, then: systemctl restart frps caddy`,
  ].join("\n");

  return {
    recommendedMode: pathMode,
    frpsToml,
    caddySubdomain,
    caddySubpath,
    installCmd,
  };
}

export interface CreateRelayManagerOptions {
  store?: any;
  dataDir?: string;
  mainPort?: number;
  getInstanceId?: () => string;
  fetchImpl?: typeof globalThis.fetch;
  onStateChange?: () => void;
  legacySearchDirs?: Array<{ source: "geminibot-frpc" | "twinklebot-frpc"; dir: string }>;
  legacyPlistPath?: string;
  execSyncFn?: typeof execFileSync;
  execFileFn?: typeof execFile;
  spawnFn?: typeof spawn;
}

export function createRelayManager({
  store,
  dataDir,
  mainPort = 3230,
  getInstanceId = () => "",
  fetchImpl = globalThis.fetch,
  onStateChange,
  legacySearchDirs,
  legacyPlistPath,
  execSyncFn = execFileSync,
  execFileFn = execFile,
  spawnFn = spawn,
}: CreateRelayManagerOptions = {}) {
  const home = os.homedir();
  const resolvedDataDir = dataDir || store?.dataDir || "";
  const searchDirs = legacySearchDirs || [
    { source: "geminibot-frpc" as const, dir: path.join(home, ".config", "geminibot-frpc") },
    { source: "twinklebot-frpc" as const, dir: path.join(home, ".config", "twinklebot-frpc") },
  ];
  const defaultPlistPath =
    legacyPlistPath || path.join(home, "Library", "LaunchAgents", "com.geminibot.frpc.plist");

  let runtimeState: RelayRuntimeState = "stopped";
  let pid: number | null = null;
  let connectedAt: string | null = null;
  let lastError = "";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let frpcChild: ChildProcess | null = null;
  let caffeinateChild: ChildProcess | null = null;
  let stopping = false;
  let logs: string[] = [];

  function readConfig(): RelayConfig {
    const raw = store?.readRelayAuth?.() || {};
    return normalizeRelayConfig(raw);
  }

  function writeConfig(nextRaw: unknown, { ensureToken = true }: { ensureToken?: boolean } = {}): RelayConfig {
    const normalized = normalizeRelayConfig(nextRaw, { ensureToken });
    store?.writeRelayAuth?.(normalized);
    return normalized;
  }

  function pushLog(rawLine: string) {
    const cfg = readConfig();
    let line = String(rawLine || "").trimEnd();
    if (!line) return;
    for (const secret of [cfg.accessToken, cfg.frpc.authToken]) {
      if (secret && secret.length >= 6) {
        line = line.split(secret).join("***REDACTED***");
      }
    }
    line = line.replace(/(token[=:]\s*["']?)[^\s"',]+(["']?)/gi, "$1***REDACTED***$2");
    logs.push(line);
    if (logs.length > 200) {
      logs = logs.slice(-200);
    }
  }

  function notifyChanged() {
    try {
      onStateChange?.();
    } catch {}
  }

  function checkPlistLoaded(plistPath: string): boolean {
    if (process.platform !== "darwin" || !plistPath || !fs.existsSync(plistPath)) return false;
    try {
      const label = path.basename(plistPath, ".plist");
      const out = String(
        execSyncFn("launchctl", ["list"], {
          encoding: "utf8",
          timeout: 1500,
          stdio: ["ignore", "pipe", "pipe"],
        }) || ""
      );
      return out.includes(label);
    } catch {
      return false;
    }
  }

  function detectLegacyRelay(): LegacyRelayInfo {
    for (const cand of searchDirs) {
      const cfgPath = path.join(cand.dir, "frpc.toml");
      if (!fs.existsSync(cfgPath)) continue;
      let raw = "";
      try {
        raw = fs.readFileSync(cfgPath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseFrpcToml(raw);
      const tokenPath = path.join(cand.dir, "relay-token");
      const hasLegacyToken = fs.existsSync(tokenPath);
      const plistExists =
        cand.source === "geminibot-frpc" && fs.existsSync(defaultPlistPath);
      const plistLoaded = plistExists ? checkPlistLoaded(defaultPlistPath) : false;
      const suggestedPublicUrl =
        parsed.serverAddr
          ? parsed.proxyName === "geminibot-relay"
            ? `https://${parsed.serverAddr}/geminibot`
            : `https://${parsed.serverAddr}`
          : "";
      return {
        detected: true,
        source: cand.source,
        configPath: cfgPath,
        tokenPath: hasLegacyToken ? tokenPath : "",
        plistPath: plistExists ? defaultPlistPath : "",
        plistExists,
        plistLoaded,
        hasLegacyToken,
        serverAddr: parsed.serverAddr,
        serverPort: parsed.serverPort,
        transportProtocol: parsed.transportProtocol,
        wsPath: parsed.wsPath,
        tlsEnable: parsed.tlsEnable,
        proxyName: parsed.proxyName,
        remotePort: parsed.remotePort,
        suggestedPublicUrl,
      };
    }
    return {
      detected: false,
      source: "",
      configPath: "",
      tokenPath: "",
      plistPath: "",
      plistExists: false,
      plistLoaded: false,
      hasLegacyToken: false,
      serverAddr: "",
      serverPort: 443,
      transportProtocol: "wss",
      wsPath: "/~!frp",
      tlsEnable: false,
      proxyName: "twinklebot-relay",
      remotePort: 13230,
      suggestedPublicUrl: "",
    };
  }

  async function unloadLegacyLaunchAgent(plistPath: string): Promise<boolean> {
    if (process.platform !== "darwin" || !plistPath || !fs.existsSync(plistPath)) {
      return false;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const label = path.basename(plistPath, ".plist");
    return new Promise((resolve) => {
      execFileFn(
        "launchctl",
        ["bootout", `gui/${uid}/${label}`],
        { timeout: 3000 },
        (err) => {
          if (!err) {
            resolve(true);
            return;
          }
          execFileFn("launchctl", ["unload", plistPath], { timeout: 3000 }, (err2) => {
            resolve(!err2);
          });
        }
      );
    });
  }

  function stopIdleSleepGuard() {
    if (caffeinateChild) {
      try {
        caffeinateChild.kill("SIGTERM");
      } catch {}
      caffeinateChild = null;
    }
  }

  function startIdleSleepGuard(targetPid: number) {
    stopIdleSleepGuard();
    if (process.platform !== "darwin" || !targetPid) return;
    try {
      const guard = spawnFn("caffeinate", ["-i", "-w", String(targetPid)], {
        stdio: "ignore",
      });
      guard.unref?.();
      guard.on("exit", () => {
        if (caffeinateChild === guard) caffeinateChild = null;
      });
      caffeinateChild = guard;
    } catch {
      // best-effort on macOS
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function stop(): Promise<void> {
    stopping = true;
    clearReconnectTimer();
    stopIdleSleepGuard();
    const active = frpcChild;
    frpcChild = null;
    pid = null;
    connectedAt = null;
    if (active && !active.killed) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          try {
            active.kill("SIGKILL");
          } catch {}
          resolve();
        }, 1500);
        force.unref?.();
        active.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
        try {
          active.kill("SIGTERM");
        } catch {
          clearTimeout(force);
          resolve();
        }
      });
    }
    runtimeState = "stopped";
    stopping = false;
    notifyChanged();
  }

  function scheduleReconnect() {
    if (stopping) return;
    const cfg = readConfig();
    if (!cfg.enabled || cfg.mode !== "frpc") return;
    clearReconnectTimer();
    const delayMs = Math.min(30_000, 2000 * Math.pow(2, Math.min(4, reconnectAttempt)));
    reconnectAttempt += 1;
    runtimeState = "reconnecting";
    notifyChanged();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void start();
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function start(): { ok: boolean; status: RelayRuntimeState; error?: string } {
    const cfg = readConfig();
    if (!cfg.enabled || cfg.mode === "off") {
      void stop();
      return { ok: true, status: "stopped" };
    }
    if (cfg.mode === "external") {
      clearReconnectTimer();
      runtimeState = cfg.publicUrl ? "connected" : "error";
      lastError = cfg.publicUrl ? "" : "请先填写外网访问地址";
      notifyChanged();
      return { ok: Boolean(cfg.publicUrl), status: runtimeState, ...(lastError ? { error: lastError } : {}) };
    }

    if (!cfg.frpc.serverAddr) {
      runtimeState = "error";
      lastError = "请先填写中继服务器地址（serverAddr）";
      notifyChanged();
      return { ok: false, status: runtimeState, error: lastError };
    }

    const bin = detectFrpcBinary(cfg.frpc.binaryPath, execSyncFn);
    if (!bin.available) {
      runtimeState = "error";
      lastError = "未检测到 frpc 可执行文件，请先安装 frpc 或指定路径";
      notifyChanged();
      return { ok: false, status: runtimeState, error: lastError };
    }

    if (frpcChild && !frpcChild.killed) {
      return { ok: true, status: runtimeState };
    }

    stopping = false;
    clearReconnectTimer();
    const relayDir = resolvedDataDir
      ? path.join(path.resolve(resolvedDataDir), "relay")
      : fs.mkdtempSync(path.join(os.tmpdir(), "tb-relay-"));
    fs.mkdirSync(relayDir, { recursive: true, mode: 0o700 });
    const tomlPath = path.join(relayDir, "frpc.toml");
    const rendered = renderFrpcToml(cfg, mainPort);
    fs.writeFileSync(tomlPath, rendered, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tomlPath, 0o600);
    } catch {}

    runtimeState = "starting";
    lastError = "";
    pushLog(`[relay] starting frpc (${bin.path}) -> ${cfg.frpc.serverAddr}:${cfg.frpc.serverPort}`);
    notifyChanged();

    const child = spawnFn(bin.path, ["-c", tomlPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    frpcChild = child;
    pid = child.pid ?? null;

    if (cfg.preventIdleSleep && child.pid) {
      startIdleSleepGuard(child.pid);
    }

    const handleChunk = (chunk: Buffer | string) => {
      const text = String(chunk || "");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        pushLog(line);
        if (/start proxy success/i.test(line) || /login to server success/i.test(line)) {
          const prevState = runtimeState;
          runtimeState = "connected";
          connectedAt = connectedAt || new Date().toISOString();
          lastError = "";
          reconnectAttempt = 0;
          if (prevState !== "connected") notifyChanged();
        } else if (/login to server failed|start proxy error|connect: connection refused/i.test(line)) {
          lastError = line.trim().slice(0, 220);
          runtimeState = "reconnecting";
          notifyChanged();
        }
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    child.on("error", (err) => {
      lastError = err?.message || "frpc spawn error";
      pushLog(`[relay] process error: ${lastError}`);
      if (frpcChild === child) {
        frpcChild = null;
        pid = null;
        stopIdleSleepGuard();
        scheduleReconnect();
      }
    });
    child.on("exit", (code, signal) => {
      pushLog(`[relay] frpc exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      if (frpcChild === child) {
        frpcChild = null;
        pid = null;
        connectedAt = null;
        stopIdleSleepGuard();
        if (!stopping) {
          if (!lastError && code && code !== 0) {
            lastError = `frpc 异常退出 (code=${code})`;
          }
          scheduleReconnect();
        }
      }
    });

    return { ok: true, status: runtimeState };
  }

  async function restart() {
    await stop();
    return start();
  }

  async function importLegacyRelay({
    unloadLaunchAgent = true,
    publicUrlOverride = "",
  }: {
    unloadLaunchAgent?: boolean;
    publicUrlOverride?: string;
  } = {}) {
    const legacy = detectLegacyRelay();
    if (!legacy.detected) {
      throw new Error("未检测到旧版 geminibot-frpc / twinklebot-frpc 配置");
    }
    const rawToml = fs.readFileSync(legacy.configPath, "utf8");
    const parsed = parseFrpcToml(rawToml);
    let legacyTok = "";
    if (legacy.tokenPath && fs.existsSync(legacy.tokenPath)) {
      legacyTok = sanitizeSingleLine(fs.readFileSync(legacy.tokenPath, "utf8"), 256);
    }
    const existing = readConfig();
    const nextPublic =
      normalizePublicUrl(publicUrlOverride) ||
      existing.publicUrl ||
      legacy.suggestedPublicUrl;

    if (unloadLaunchAgent && legacy.plistPath) {
      await unloadLegacyLaunchAgent(legacy.plistPath);
    }

    const saved = writeConfig(
      {
        ...existing,
        mode: "frpc",
        enabled: true,
        publicUrl: nextPublic,
        accessToken: legacyTok || existing.accessToken || generateRelayToken(),
        relayLocalPort: existing.relayLocalPort || DEFAULT_RELAY_LOCAL_PORT,
        enforceAuthOnRelayPort: true,
        frpc: {
          ...existing.frpc,
          serverAddr: parsed.serverAddr,
          serverPort: parsed.serverPort,
          transportProtocol: parsed.transportProtocol,
          wsPath: parsed.wsPath,
          tlsEnable: parsed.tlsEnable,
          authToken: parsed.authToken,
          proxyName: parsed.proxyName,
          remotePort: parsed.remotePort,
        },
      },
      { ensureToken: true }
    );
    pushLog(`[relay] imported legacy config from ${legacy.configPath}`);
    const startRes = await restart();
    return {
      ok: true,
      config: saved,
      legacy,
      runtime: startRes,
    };
  }

  function rotateAccessToken(): RelayConfig {
    const cur = readConfig();
    const next = writeConfig({ ...cur, accessToken: generateRelayToken() }, { ensureToken: true });
    pushLog("[relay] rotated relay access token");
    notifyChanged();
    return next;
  }

  async function testPublicEndpoint(customUrl = ""): Promise<RelayTestResult> {
    const cfg = readConfig();
    const targetUrl = normalizePublicUrl(customUrl || cfg.publicUrl);
    const checkedAt = new Date().toISOString();
    if (!targetUrl) {
      return {
        ok: false,
        checkedAt,
        publicUrl: "",
        withTokenStatus: 0,
        withTokenLatencyMs: 0,
        withoutTokenStatus: 0,
        authEnforced: false,
        error: "请先配置有效的公网访问地址（https://...）",
      };
    }

    const pingUrl = `${targetUrl}/api/relay/ping`;
    const started = Date.now();
    let withTokenStatus = 0;
    let withTokenLatencyMs = 0;
    let remoteDeployEnv = "";
    let remoteInstanceId = "";
    let error = "";
    let ok = false;

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetchImpl(pingUrl, {
          headers: cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {},
          signal: ctrl.signal,
        });
        withTokenStatus = res.status;
        withTokenLatencyMs = Math.max(1, Date.now() - started);
        const json: any = await res.json().catch(() => null);
        if (res.ok && json?.ok) {
          ok = true;
          remoteDeployEnv = String(json.deployEnv || "");
          remoteInstanceId = String(json.instanceId || "");
        } else {
          error = json?.error || `HTTP ${res.status}`;
        }
      } finally {
        clearTimeout(t);
      }
    } catch (err: any) {
      withTokenLatencyMs = Math.max(1, Date.now() - started);
      error = err?.name === "AbortError" ? "请求超时 (8s)" : err?.message || "连接失败";
    }

    let withoutTokenStatus = 0;
    let authEnforced = false;
    try {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 5000);
      try {
        const res2 = await fetchImpl(pingUrl, { signal: ctrl2.signal });
        withoutTokenStatus = res2.status;
        if (res2.status === 401 || res2.status === 403) {
          authEnforced = true;
        } else {
          const j2: any = await res2.json().catch(() => null);
          authEnforced = !j2?.ok;
        }
      } finally {
        clearTimeout(t2);
      }
    } catch {
      authEnforced = false;
    }

    const myId = getInstanceId();
    return {
      ok,
      checkedAt,
      publicUrl: targetUrl,
      withTokenStatus,
      withTokenLatencyMs,
      withoutTokenStatus,
      authEnforced,
      ...(remoteDeployEnv ? { remoteDeployEnv } : {}),
      ...(remoteInstanceId ? { remoteInstanceId } : {}),
      ...(remoteInstanceId && myId ? { instanceMatched: remoteInstanceId === myId } : {}),
      ...(error ? { error } : {}),
    };
  }

  function updateConfig(patch: Record<string, any> = {}): RelayConfig {
    const cur = readConfig();
    const merged: Record<string, any> = {
      ...cur,
      ...patch,
      frpc: {
        ...cur.frpc,
        ...(patch.frpc && typeof patch.frpc === "object" ? patch.frpc : {}),
      },
    };
    return writeConfig(merged, { ensureToken: true });
  }

  function getStatus({ reveal = false, relayPortListening = false } = {}) {
    const cfg = readConfig();
    const frpcBinary = detectFrpcBinary(cfg.frpc.binaryPath, execSyncFn);
    const legacyRelay = detectLegacyRelay();
    return {
      config: {
        mode: cfg.mode,
        enabled: cfg.enabled,
        publicUrl: cfg.publicUrl,
        relayLocalPort: cfg.relayLocalPort,
        enforceAuthOnRelayPort: cfg.enforceAuthOnRelayPort,
        preventIdleSleep: cfg.preventIdleSleep,
        hasAccessToken: Boolean(cfg.accessToken),
        ...(reveal ? { accessToken: cfg.accessToken } : {}),
        frpc: {
          binaryPath: cfg.frpc.binaryPath,
          serverAddr: cfg.frpc.serverAddr,
          serverPort: cfg.frpc.serverPort,
          transportProtocol: cfg.frpc.transportProtocol,
          wsPath: cfg.frpc.wsPath,
          tlsEnable: cfg.frpc.tlsEnable,
          proxyName: cfg.frpc.proxyName,
          remotePort: cfg.frpc.remotePort,
          hasAuthToken: Boolean(cfg.frpc.authToken),
          ...(reveal ? { authToken: cfg.frpc.authToken } : {}),
        },
      },
      runtime: {
        status: cfg.enabled && cfg.mode === "external" && cfg.publicUrl ? "connected" : runtimeState,
        pid,
        connectedAt,
        lastError,
        reconnectAttempt,
        relayPortListening,
      },
      frpcBinary,
      legacyRelay,
      logs: [...logs],
    };
  }

  function getBotSummary() {
    const st = getStatus({ reveal: false });
    return {
      mode: st.config.mode,
      enabled: st.config.enabled,
      status: st.runtime.status,
      publicUrl: st.config.publicUrl,
      relayLocalPort: st.config.relayLocalPort,
      lastError: st.runtime.lastError,
      frpcAvailable: st.frpcBinary.available,
      legacyDetected: st.legacyRelay.detected,
      legacySource: st.legacyRelay.source || undefined,
    };
  }

  function isActiveOrConfigured(): boolean {
    const cfg = readConfig();
    if (cfg.enabled && cfg.mode !== "off") return true;
    return runtimeState === "connected" || runtimeState === "starting" || runtimeState === "reconnecting";
  }

  function getAccessToken(): string {
    return readConfig().accessToken || "";
  }

  function bootAutoStart() {
    const cfg = readConfig();
    if (cfg.enabled && cfg.mode === "frpc") {
      start();
    } else if (cfg.enabled && cfg.mode === "external" && cfg.publicUrl) {
      runtimeState = "connected";
    }
  }

  return {
    readConfig,
    writeConfig,
    updateConfig,
    getStatus,
    getBotSummary,
    getAccessToken,
    isActiveOrConfigured,
    detectLegacyRelay,
    importLegacyRelay,
    rotateAccessToken,
    testPublicEndpoint,
    generateServerTemplates,
    bootAutoStart,
    start,
    stop,
    restart,
  };
}

export default {
  DEFAULT_RELAY_LOCAL_PORT,
  normalizeRelayConfig,
  parseFrpcToml,
  renderFrpcToml,
  detectFrpcBinary,
  generateServerTemplates,
  createRelayManager,
};
