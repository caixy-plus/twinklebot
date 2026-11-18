import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWriteRoots } from "../lib/config.js";

/**
 * Parses a standard `.env` file content into a plain key-value object.
 * Never logs values.
 */
export function parseDotEnv(content = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = String(content || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    let val = cleaned.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Resolves runtime configuration for the Electron Desktop App across macOS, Windows, and Linux.
 * Searches userData config, `.env` files, and process.env without crashing if unconfigured.
 */
export function resolveDesktopConfig({
  env = process.env,
  appRoot = process.cwd(),
  userDataDir = path.join(os.homedir(), ".twinklebot"),
  homeDir = os.homedir(),
  isPackaged = false,
}: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  appRoot?: string;
  userDataDir?: string;
  homeDir?: string;
  isPackaged?: boolean;
} = {}) {
  const candidateEnvPaths = [
    env.TWINKLEBOT_ENV_FILE,
    path.join(userDataDir, ".env"),
    path.join(homeDir, ".twinklebot", ".env"),
    path.join(appRoot, ".env"),
    path.join(homeDir, "Workspace", "twinklebot", ".env"),
  ].filter(Boolean) as string[];

  const fileVars: Record<string, string> = {};
  for (const p of candidateEnvPaths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const parsed = parseDotEnv(fs.readFileSync(p, "utf-8"));
        // Earlier candidates take precedence over later fallbacks
        for (const [k, v] of Object.entries(parsed)) {
          if (fileVars[k] === undefined && v !== "") {
            fileVars[k] = v;
          }
        }
      }
    } catch {
      // ignore unreadable candidate
    }
  }

  // Also merge optional JSON config saved from Electron settings (`userData/desktop-config.json`)
  const jsonConfigPath = path.join(userDataDir, "desktop-config.json");
  let savedJson: Record<string, any> = {};
  try {
    if (fs.existsSync(jsonConfigPath)) {
      savedJson = JSON.parse(fs.readFileSync(jsonConfigPath, "utf-8")) || {};
    }
  } catch {
    savedJson = {};
  }

  let localControlToken =
    env.TWINKLEBOT_LOCAL_TOKEN ||
    savedJson.TWINKLEBOT_LOCAL_TOKEN ||
    fileVars.TWINKLEBOT_LOCAL_TOKEN ||
    "";
  let executorToken =
    env.TWINKLEBOT_EXECUTOR_TOKEN ||
    fileVars.TWINKLEBOT_EXECUTOR_TOKEN ||
    savedJson.TWINKLEBOT_EXECUTOR_TOKEN ||
    "";
  let needPersistJson = false;
  const nextJson = { ...savedJson };
  if (!localControlToken) {
    localControlToken = crypto.randomBytes(24).toString("hex");
    nextJson.TWINKLEBOT_LOCAL_TOKEN = localControlToken;
    needPersistJson = true;
  }
  if (!executorToken) {
    executorToken = crypto.randomBytes(24).toString("hex");
    nextJson.TWINKLEBOT_EXECUTOR_TOKEN = executorToken;
    needPersistJson = true;
  }
  if (needPersistJson) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(jsonConfigPath, JSON.stringify(nextJson, null, 2), "utf-8");
      if (process.platform !== "win32") {
        fs.chmodSync(jsonConfigPath, 0o600);
      }
    } catch {
      // ignore if userDataDir is non-writable in tests
    }
  }

  const merged: Record<string, any> = {
    ...fileVars,
    ...savedJson,
    ...Object.fromEntries(
      Object.entries(env).filter(([, v]) => v !== undefined && v !== "")
    ),
  };

  // Determine persistent data directory:
  // If dev/local data directory exists with sessions, reuse it seamlessly; otherwise use userDataDir/data
  const devDataDir = path.join(appRoot, "data");
  const fallbackWorkspaceDataDir = path.join(
    homeDir,
    "Workspace",
    "twinklebot",
    "data"
  );

  let dataDir = merged.TWINKLEBOT_DATA_DIR;
  if (!dataDir) {
    if (!isPackaged && fs.existsSync(devDataDir)) {
      dataDir = devDataDir;
    } else if (fs.existsSync(fallbackWorkspaceDataDir)) {
      dataDir = fallbackWorkspaceDataDir;
    } else {
      dataDir = path.join(userDataDir, "data");
    }
  }

  const executorUrl =
    merged.TWINKLEBOT_EXECUTOR_URL || "http://127.0.0.1:7300";
  const novncUrl =
    merged.TWINKLEBOT_NOVNC_URL ||
    "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale";

  const writeRoots = merged.TWINKLEBOT_WRITE_ROOTS
    ? String(merged.TWINKLEBOT_WRITE_ROOTS)
        .split(path.delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultWriteRoots(homeDir);

  const desktopPort =
    merged.TWINKLEBOT_DESKTOP_PORT !== undefined &&
    merged.TWINKLEBOT_DESKTOP_PORT !== ""
      ? Number(merged.TWINKLEBOT_DESKTOP_PORT)
      : 3230;
  const lanAccess = merged.TWINKLEBOT_LAN_ACCESS !== "0";

  return {
    deployEnv: "local" as const,
    initialRole: "master" as const,
    sandboxMode: "full" as const,
    host: merged.HOST || (lanAccess ? "0.0.0.0" : "127.0.0.1"),
    port: Number.isFinite(desktopPort) ? desktopPort : 3230,
    lanAccess,
    localControlToken,
    geminiApiKey: merged.GEMINI_API_KEY || "",
    executorUrl,
    executorToken,
    novncUrl,
    defaultModel: "gemini-4-argon",
    deepModel: "gemini-4-carbon",
    fastModel: "gemini-4-hydrogen",
    thinkingSummaryModel: merged.TWINKLEBOT_THINKING_SUMMARY_MODEL || "gemini-4-hydrogen",
    imageModel: merged.TWINKLEBOT_IMAGE_MODEL || "gemini-3.1-flash-image",
    proImageModel: merged.TWINKLEBOT_PRO_IMAGE_MODEL || "gemini-3-pro-image",
    fallbackImageModel: "gemini-2.5-flash-image",
    models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
    maxSteps: 60,
    keepScreenshots: 3,
    shellTimeoutSec: 120,
    screen: { width: 1440, height: 900 },
    writeRoots,
    dataDir,
    userDataDir,
    isConfigured: Boolean(merged.GEMINI_API_KEY && executorToken),
  };
}
