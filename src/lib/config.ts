import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDeployEnv, normalizeRuntimeRole } from "./runtime-state.js";
import { resolveProjectRoot } from "./project-root.js";
import type { AppConfig } from "../shared/config.js";

const PROJECT_ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

export function defaultWriteRoots(homeDir: string = os.homedir()): string[] {
  return [
    path.join(homeDir, "TwinkleBot", "workspace"),
    path.join(homeDir, "Downloads"),
  ];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const deployEnv = normalizeDeployEnv(env.DEPLOY_ENV);
  const initialRole =
    deployEnv === "cloud" ? "master" : normalizeRuntimeRole(env.RUNTIME_ROLE);
  const vertexRequested =
    env.GOOGLE_GENAI_USE_VERTEXAI === "true" ||
    env.GOOGLE_GENAI_USE_VERTEXAI === "1";
  const vertexProject = String(env.GOOGLE_CLOUD_PROJECT || "").trim();
  const vertexLocation = String(env.GOOGLE_CLOUD_LOCATION || "").trim();
  const useVertexAi = deployEnv === "cloud" && vertexRequested;

  const allowUnconfigured =
    deployEnv === "cloud" || env.TWINKLEBOT_ALLOW_UNCONFIGURED === "1";

  if (!allowUnconfigured && !env.GEMINI_API_KEY) {
    if (vertexRequested) {
      throw new Error(
        "Vertex AI 仅支持 GCP 云服务器部署，当前环境请配置 GEMINI_API_KEY (AI Studio)"
      );
    }
    throw new Error("GEMINI_API_KEY is not set");
  }
  if (!env.TWINKLEBOT_EXECUTOR_TOKEN) {
    throw new Error("TWINKLEBOT_EXECUTOR_TOKEN is not set");
  }

  const port = env.PORT !== undefined && env.PORT !== "" ? Number(env.PORT) : 3230;
  const lanAccess =
    env.TWINKLEBOT_LAN_ACCESS === "1" ||
    env.TWINKLEBOT_LAN_ACCESS === "true" ||
    env.HOST === "0.0.0.0";
  const host =
    deployEnv === "cloud"
      ? env.HOST || "0.0.0.0"
      : env.HOST || (lanAccess ? "0.0.0.0" : "127.0.0.1");
  const defaultLocalHost =
    process.platform === "win32" ? "127.0.0.1" : "ubuntu.orb.local";
  const executorUrl =
    env.TWINKLEBOT_EXECUTOR_URL ||
    (deployEnv === "cloud"
      ? "http://127.0.0.1:7300"
      : `http://${defaultLocalHost}:7300`);
  const novncUrl =
    env.TWINKLEBOT_NOVNC_URL !== undefined
      ? env.TWINKLEBOT_NOVNC_URL
      : deployEnv === "cloud"
        ? "/novnc/vnc.html?autoconnect=1&resize=scale"
        : `http://${defaultLocalHost}:6080/vnc.html?autoconnect=true&resize=scale`;
  const novncProxyTarget = String(
    env.TWINKLEBOT_NOVNC_PROXY_TARGET ||
      (deployEnv === "cloud" ? "http://127.0.0.1:6080" : "")
  ).trim();
  const dataDir = env.TWINKLEBOT_DATA_DIR || path.join(PROJECT_ROOT, "data");

  const writeRoots = env.TWINKLEBOT_WRITE_ROOTS
    ? env.TWINKLEBOT_WRITE_ROOTS.split(path.delimiter)
        .map((p) => p.trim())
        .filter(Boolean)
    : defaultWriteRoots();

  return {
    deployEnv,
    initialRole,
    sandboxMode: env.TWINKLEBOT_SANDBOX_MODE || "full",
    host,
    port,
    lanAccess,
    geminiApiKey: env.GEMINI_API_KEY || "",
    useVertexAi,
    vertexProject,
    vertexLocation,
    cloudAuthToken: env.TWINKLEBOT_CLOUD_TOKEN || "",
    localControlToken: env.TWINKLEBOT_LOCAL_TOKEN || "",
    executorUrl,
    executorToken: env.TWINKLEBOT_EXECUTOR_TOKEN,
    novncUrl,
    novncProxyTarget,
    defaultModel: "gemini-4-argon",
    deepModel: "gemini-4-carbon",
    fastModel: "gemini-4-hydrogen",
    thinkingSummaryModel: env.TWINKLEBOT_THINKING_SUMMARY_MODEL || "gemini-4-hydrogen",
    imageModel: env.TWINKLEBOT_IMAGE_MODEL || "gemini-3.1-flash-image",
    proImageModel: env.TWINKLEBOT_PRO_IMAGE_MODEL || "gemini-3-pro-image",
    fallbackImageModel: "gemini-2.5-flash-image",
    models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
    maxSteps: Number(env.TWINKLEBOT_MAX_STEPS || 60),
    keepScreenshots: Number(env.TWINKLEBOT_KEEP_SCREENSHOTS || 3),
    shellTimeoutSec: Number(env.TWINKLEBOT_SHELL_TIMEOUT_SEC || 120),
    screen: { width: 1440, height: 900 },
    writeRoots,
    dataDir,
  };
}
