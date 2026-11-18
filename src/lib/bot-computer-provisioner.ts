import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createExecutorClient } from "../agent/executor-client.js";
import { buildScrubbedEnv } from "./mcp-client.js";
import { resolveProjectRoot } from "./project-root.js";
import {
  buildTwinklebotChromeWrapperScript,
  buildWslProvisionScript,
  classifyWslInstallFailure,
  ensureWslKeepalive,
  findWindowsAppsUbuntuLauncher,
  parseWslDistroList,
  pickWslUbuntuDistro,
  resolveUnpackedExecutorPath,
  resolveWindowsProxyHint,
  syncFileToWslViaChunks,
  windowsPathToWsl,
} from "./wsl-ubuntu.js";
import type { DeployEnv, ExecutorClient } from "../shared/config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PROJECT_ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

export const COMPUTER_STATES = [
  "uncreated",
  "creating",
  "ready",
  "unsupported",
  "error",
] as const;

export type ComputerState = (typeof COMPUTER_STATES)[number];

export interface ProbeBotComputerResult {
  state: ComputerState;
  provider: string;
  platform: string;
  online: boolean;
  vmInstalled?: boolean;
  distro?: string;
  screen?: any;
  detail: string;
}

export interface ProvisionBotComputerResult {
  ok: boolean;
  state: ComputerState;
  provider: string;
  platform: string;
  online: boolean;
  distro?: string;
  screen?: any;
  updatedAt?: string;
  detail?: string;
  error?: string;
  needsReboot?: boolean;
  needsElevation?: boolean;
  needsVirtualization?: boolean;
}

function providerForPlatform(deployEnv: DeployEnv | string, platform: string): string {
  if (deployEnv === "cloud") return "cloud-linux";
  if (platform === "darwin") return "orbstack";
  if (platform === "win32") return "wsl";
  return "unsupported";
}

function defaultExec(cmd: string, args: string[], timeout = 120_000) {
  return execFileAsync(cmd, args, {
    env: { ...buildScrubbedEnv(), WSL_UTF8: "1" },
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export async function probeBotComputerState({
  deployEnv = "local",
  platform = process.platform,
  executor = null,
  execFileFn = defaultExec,
  store = null,
}: {
  deployEnv?: DeployEnv | string;
  platform?: string;
  executor?: Partial<ExecutorClient> | null;
  execFileFn?: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  store?: any;
} = {}): Promise<ProbeBotComputerResult> {
  const provider = providerForPlatform(deployEnv, platform);
  if (deployEnv === "cloud") {
    return {
      state: "ready",
      provider,
      platform,
      online: true,
      detail: "云端 Linux 高权限沙箱已就绪",
    };
  }
  if (platform === "linux") {
    return {
      state: "unsupported",
      provider,
      platform,
      online: false,
      detail: "二期暂不支持 Linux 桌面端本地容器",
    };
  }

  const persisted = store?.readSettings?.()?.botComputer || {};
  if (persisted.state === "creating") {
    return {
      state: "creating",
      provider,
      platform,
      online: false,
      detail: "正在初始化 Bot 电脑环境…",
    };
  }

  let healthError = "";
  let vmInstalled = false;
  let vmRunning = false;
  let vmCheckSucceeded = false;
  let vmCheckEnoent = false;
  let distro: string | null = null;
  try {
    if (platform === "darwin") {
      const out = await execFileFn("orb", ["list"], 5_000);
      const stdout = String(out?.stdout || "");
      vmCheckSucceeded = true;
      vmInstalled = /\bubuntu\b/i.test(stdout);
      const ubuntuLine = stdout.split(/\r?\n/).find((line) => /^\s*ubuntu\b/i.test(line));
      vmRunning = Boolean(ubuntuLine && /\brunning\b/i.test(ubuntuLine));
      if (vmInstalled) distro = "ubuntu";
    } else if (platform === "win32") {
      const out = await execFileFn("wsl", ["-l", "-q"], 5_000);
      vmCheckSucceeded = true;
      distro = pickWslUbuntuDistro(parseWslDistroList(String(out?.stdout || "")));
      vmInstalled = Boolean(distro);
    }
  } catch (err: any) {
    vmInstalled = false;
    vmCheckEnoent = err?.code === "ENOENT";
  }

  if (executor?.health) {
    const shouldAutoWakeWsl =
      platform === "win32" &&
      vmInstalled &&
      Boolean(distro) &&
      persisted.state === "ready" &&
      execFileFn === defaultExec;
    if (shouldAutoWakeWsl && distro) {
      ensureWslKeepalive(distro);
    }
    const probeAttempts = shouldAutoWakeWsl ? 10 : 1;
    for (let i = 0; i < probeAttempts; i++) {
      try {
        const h = await executor.health();
        if (h && h.ok !== false) {
          if (platform === "win32" && distro && execFileFn === defaultExec) {
            ensureWslKeepalive(distro);
          }
          return {
            state: "ready",
            provider,
            platform,
            online: true,
            ...(distro ? { distro } : {}),
            screen: h.screen || null,
            detail: `${provider === "orbstack" ? "OrbStack" : `WSL (${distro || "Ubuntu"})`} 桌面已就绪`,
          };
        }
        healthError = "executor health returned not ok";
      } catch (err: any) {
        healthError = err?.message || String(err);
      }
      if (i + 1 < probeAttempts) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }

  const isInstalled = vmInstalled || (!vmCheckSucceeded && !vmCheckEnoent && persisted.state === "ready");
  const detail = isInstalled
    ? vmRunning
      ? `检测到 ${provider === "orbstack" ? "OrbStack" : `WSL (${distro || "Ubuntu"})`} 容器已启动，但桌面执行器未就绪`
      : `检测到 ${provider === "orbstack" ? "OrbStack" : `WSL (${distro || "Ubuntu"})`} 容器尚未启动或未就绪`
    : `尚未创建本地 Bot 电脑（将使用 ${platform === "darwin" ? "OrbStack + Ubuntu" : "WSL2 + Ubuntu"}）`;

  return {
    state: isInstalled ? "ready" : "uncreated",
    provider,
    platform,
    online: false,
    vmInstalled,
    ...(distro ? { distro } : {}),
    ...(healthError ? { healthError } : {}),
    detail,
  };
}

async function ensureWslUbuntuDistro({
  execFileFn,
  onProgress,
}: {
  execFileFn: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  onProgress: (msg: string) => void;
}): Promise<string> {
  let distro: string | null = null;
  try {
    const listOut = await execFileFn("wsl", ["-l", "-q"]);
    distro = pickWslUbuntuDistro(parseWslDistroList(String(listOut?.stdout || "")));
  } catch {
    distro = null;
  }
  if (distro) return distro;

  onProgress("正在安装 WSL2 与 Ubuntu 发行版（首次安装可能需数分钟）…");
  let lastInstallErr: any = null;
  try {
    await execFileFn(
      "wsl",
      ["--install", "-d", "Ubuntu", "--web-download", "--no-launch"],
      900_000
    );
  } catch (errWeb: any) {
    const msgWeb = `${errWeb?.stdout || ""}\n${errWeb?.stderr || ""}\n${errWeb?.message || ""}`;
    if (/--web-download|invalid|无效|未知/i.test(msgWeb)) {
      try {
        await execFileFn("wsl", ["--install", "-d", "Ubuntu", "--no-launch"], 900_000);
      } catch (errStd: any) {
        lastInstallErr = errStd;
      }
    } else {
      lastInstallErr = errWeb;
    }
  }

  if (lastInstallErr) {
    const rawErr = `${lastInstallErr?.stdout || ""}\n${lastInstallErr?.stderr || ""}\n${lastInstallErr?.message || ""}`;
    const classified = classifyWslInstallFailure(rawErr);
    if (classified.needsElevation) {
      onProgress("正在请求 Windows 管理员权限以启用 WSL2 与安装 Ubuntu…");
      try {
        await execFileFn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -FilePath 'wsl.exe' -ArgumentList '--install','-d','Ubuntu','--no-launch' -Verb RunAs -Wait",
          ],
          900_000
        );
        lastInstallErr = null;
      } catch (elevErr: any) {
        const errObj: any = new Error(classified.message);
        errObj.needsElevation = true;
        errObj.cause = elevErr;
        throw errObj;
      }
    } else if (classified.needsReboot || classified.needsVirtualization) {
      const errObj: any = new Error(classified.message);
      errObj.needsReboot = classified.needsReboot;
      errObj.needsVirtualization = classified.needsVirtualization;
      throw errObj;
    }
  }

  try {
    const afterList = await execFileFn("wsl", ["-l", "-q"]);
    distro = pickWslUbuntuDistro(parseWslDistroList(String(afterList?.stdout || "")));
  } catch {
    distro = null;
  }

  if (!distro) {
    const launcher = findWindowsAppsUbuntuLauncher();
    if (launcher) {
      onProgress("正在注册 Ubuntu 根文件系统（非交互模式）…");
      try {
        await execFileFn(launcher, ["install", "--root"], 300_000);
        const regList = await execFileFn("wsl", ["-l", "-q"]);
        distro = pickWslUbuntuDistro(parseWslDistroList(String(regList?.stdout || "")));
      } catch {
        // fall through to final error classification
      }
    }
  }

  if (!distro) {
    const rawErr = lastInstallErr
      ? `${lastInstallErr?.stdout || ""}\n${lastInstallErr?.stderr || ""}\n${lastInstallErr?.message || ""}`
      : "Windows 已安装 WSL 组件但尚未检测到已注册的 Ubuntu 发行版，可能需要先重启一次电脑完成虚拟化组件加载。";
    const classified = classifyWslInstallFailure(rawErr);
    const errObj: any = new Error(classified.message);
    errObj.needsReboot = classified.needsReboot || !lastInstallErr;
    errObj.needsElevation = classified.needsElevation;
    errObj.needsVirtualization = classified.needsVirtualization;
    throw errObj;
  }

  return distro;
}

export async function provisionBotComputer({
  deployEnv = "local",
  platform = process.platform,
  projectRoot = DEFAULT_PROJECT_ROOT,
  store = null,
  executor = null,
  executorToken = "",
  execFileFn = defaultExec,
  onProgress = () => {},
  maxHealthRetries = 25,
  retryDelayMs = 400,
}: {
  deployEnv?: DeployEnv | string;
  platform?: string;
  projectRoot?: string;
  store?: any;
  executor?: Partial<ExecutorClient> | null;
  executorToken?: string;
  execFileFn?: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  onProgress?: (msg: string) => void;
  maxHealthRetries?: number;
  retryDelayMs?: number;
} = {}): Promise<ProvisionBotComputerResult> {
  const provider = providerForPlatform(deployEnv, platform);
  if (deployEnv === "cloud") {
    const info: ProvisionBotComputerResult = {
      ok: true,
      state: "ready",
      provider,
      platform,
      online: true,
      detail: "云端 Linux 沙箱已就绪",
    };
    store?.writeSettings?.({
      botComputer: { state: "ready", provider, updatedAt: new Date().toISOString() },
    });
    return info;
  }

  if (platform === "linux") {
    return {
      ok: false,
      state: "unsupported",
      provider,
      platform,
      online: false,
      error: "二期暂不支持 Linux 桌面端本地容器",
    };
  }

  store?.writeSettings?.({
    botComputer: { state: "creating", provider, updatedAt: new Date().toISOString() },
  });

  const resolvedToken =
    executorToken || process.env.TWINKLEBOT_EXECUTOR_TOKEN || "unconfigured-token";
  let activeDistro: string | null = null;

  try {
    const executorPy = resolveUnpackedExecutorPath(projectRoot);
    const hasLocalExecutor = fs.existsSync(executorPy);

    if (platform === "darwin") {
      onProgress("检测 OrbStack 与 Ubuntu 容器…");
      let hasOrb = false;
      try {
        await execFileFn("orb", ["--version"]);
        hasOrb = true;
      } catch {
        hasOrb = false;
      }
      if (!hasOrb) {
        onProgress("正在通过 Homebrew 安装 OrbStack…");
        await execFileFn("brew", ["install", "--cask", "orbstack"], 600_000);
        await execFileFn("open", ["-a", "OrbStack"]);
      }
      const listOut = await execFileFn("orb", ["list"]);
      if (!/\bubuntu\b/i.test(String(listOut?.stdout || ""))) {
        onProgress("正在创建 Ubuntu 25.04 容器…");
        await execFileFn("orb", ["create", "ubuntu:25.04", "ubuntu"], 600_000);
      }
      activeDistro = "ubuntu";
      onProgress("正在配置桌面环境与执行器服务…");
      const envB64 = Buffer.from(
        `TWINKLEBOT_EXECUTOR_TOKEN=${resolvedToken}\nTWINKLEBOT_BROWSER=/usr/local/bin/google-chrome\nDISPLAY=:1\n`,
        "utf-8"
      ).toString("base64");
      const macWrapperB64 = Buffer.from(
        buildTwinklebotChromeWrapperScript(),
        "utf-8"
      ).toString("base64");
      await execFileFn("orb", [
        "-m",
        "ubuntu",
        "-u",
        "root",
        "bash",
        "-lc",
        [
          `mkdir -p /opt/twinklebot /opt/twinklebot/chrome-profile /etc/twinklebot`,
          `if [ -s /etc/twinklebot/executor.env ]; then sed -i 's|^TWINKLEBOT_BROWSER=/usr/local/bin/chromium$|TWINKLEBOT_BROWSER=/usr/local/bin/google-chrome|' /etc/twinklebot/executor.env || true; else printf '%s' '${envB64}' | base64 -d > /etc/twinklebot/executor.env && chmod 640 /etc/twinklebot/executor.env; fi`,
          `if [ ! -x /usr/bin/google-chrome-stable ] && [ ! -x /usr/bin/google-chrome ]; then case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH="" ;; esac; if [ -n "$ARCH" ]; then TMP_DEB=/tmp/google-chrome-stable.deb; if curl -fsSL --connect-timeout 15 --max-time 180 "https://dl.google.com/linux/direct/google-chrome-stable_current_\${ARCH}.deb" -o "$TMP_DEB"; then export DEBIAN_FRONTEND=noninteractive; apt-get -o Acquire::Retries=3 update -y >/dev/null 2>&1 || true; apt-get -o Acquire::Retries=3 install -y "$TMP_DEB" >/dev/null 2>&1 || (dpkg -i "$TMP_DEB" || apt-get -o Acquire::Retries=3 install -f -y); rm -f "$TMP_DEB"; fi; fi; fi`,
          `for cand in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do if [ -x "$cand" ]; then ln -sf "$cand" /opt/twinklebot/browser-bin; printf '%s' '${macWrapperB64}' | base64 -d > /usr/local/bin/twinklebot-chrome; chmod 0755 /usr/local/bin/twinklebot-chrome; ln -sf /usr/local/bin/twinklebot-chrome /usr/local/bin/google-chrome; ln -sf /usr/local/bin/twinklebot-chrome /usr/local/bin/chromium; break; fi; done`,
        ].join(" && "),
      ]);
      if (hasLocalExecutor) {
        await execFileFn("orb", [
          "-m",
          "ubuntu",
          "-u",
          "root",
          "install",
          "-m",
          "0755",
          executorPy,
          "/opt/twinklebot/executor.py",
        ]);
      }
      await execFileFn("orb", [
        "-m",
        "ubuntu",
        "-u",
        "root",
        "systemctl",
        "restart",
        "twinklebot-executor.service",
      ]);
    } else if (platform === "win32") {
      onProgress("检测 WSL2 与 Ubuntu 发行版…");
      const distro = await ensureWslUbuntuDistro({ execFileFn, onProgress });
      activeDistro = distro;
      if (execFileFn === defaultExec) {
        ensureWslKeepalive(distro);
      }

      onProgress(`正在部署 WSL (${distro}) Ubuntu 桌面、noVNC 与执行器服务…`);
      const proxyHint = await resolveWindowsProxyHint({
        platform,
        execFileFn: execFileFn === defaultExec ? execFileFn : undefined,
      });
      const script = buildWslProvisionScript({
        executorWslPath: hasLocalExecutor ? windowsPathToWsl(executorPy) : "",
        executorToken: resolvedToken,
        proxyHint,
      });
      const checkSuffix = hasLocalExecutor
        ? `\nif [ ! -s /opt/twinklebot/executor.py ]; then echo "__MISSING_EXECUTOR_PY__"; fi\n`
        : "";
      const scriptB64 = Buffer.from(script + checkSuffix, "utf-8").toString("base64");

      let deployOut: any;
      try {
        deployOut = await execFileFn(
          "wsl",
          [
            "-d",
            distro,
            "-u",
            "root",
            "--",
            "bash",
            "-lc",
            `printf '%s' '${scriptB64}' | base64 -d | bash`,
          ],
          900_000
        );
      } catch (wslDeployErr: any) {
        const rawErr = `${wslDeployErr?.stdout || ""}\n${wslDeployErr?.stderr || ""}\n${wslDeployErr?.message || ""}`;
        const classified = classifyWslInstallFailure(rawErr);
        if (classified.needsReboot || classified.needsVirtualization || classified.needsElevation) {
          const errObj: any = new Error(classified.message);
          errObj.needsReboot = classified.needsReboot;
          errObj.needsElevation = classified.needsElevation;
          errObj.needsVirtualization = classified.needsVirtualization;
          throw errObj;
        }
        throw wslDeployErr;
      }

      if (
        hasLocalExecutor &&
        String(deployOut?.stdout || "").includes("__MISSING_EXECUTOR_PY__")
      ) {
        onProgress("正在通过分块流同步 executor.py 至 WSL…");
        await syncFileToWslViaChunks({
          distro,
          localPath: executorPy,
          remotePath: "/opt/twinklebot/executor.py",
          mode: "0755",
          execFileFn,
        });
        await execFileFn("wsl", [
          "-d",
          distro,
          "-u",
          "root",
          "--",
          "bash",
          "-lc",
          "if [ \"$(ps -p 1 -o comm= 2>/dev/null || true)\" = \"systemd\" ]; then systemctl restart twinklebot-executor.service; else pkill -f '[/]opt/twinklebot/executor.py' || true; set -a; . /etc/twinklebot/executor.env; set +a; nohup /usr/bin/python3 /opt/twinklebot/executor.py </dev/null >/var/log/twinklebot/executor.log 2>&1 & fi",
        ]);
      }
    }

    let health: any = null;
    if (executor?.health) {
      onProgress("正在校验 Ubuntu 执行器与桌面健康状态…");
      for (let i = 0; i < maxHealthRetries; i++) {
        try {
          health = await executor.health();
          if (health && health.ok !== false) break;
        } catch {
          // retry while executor boots
        }
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
      if (!health || health.ok === false) {
        throw new Error("Bot 电脑环境已部署，但执行器健康检查未通过（端口 7300 未响应或鉴权不一致）");
      }
    }

    const updatedAt = new Date().toISOString();
    store?.writeSettings?.({
      botComputer: {
        state: "ready",
        provider,
        ...(activeDistro ? { distro: activeDistro } : {}),
        updatedAt,
      },
    });
    return {
      ok: true,
      state: "ready",
      provider,
      platform,
      online: true,
      ...(activeDistro ? { distro: activeDistro } : {}),
      screen: health?.screen || null,
      updatedAt,
      detail: `${provider === "orbstack" ? "OrbStack" : `WSL (${activeDistro || "Ubuntu"})`} 桌面环境初始化完成`,
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    store?.writeSettings?.({
      botComputer: {
        state: "error",
        provider,
        ...(activeDistro ? { distro: activeDistro } : {}),
        error: errMsg,
        updatedAt: new Date().toISOString(),
      },
    });
    return {
      ok: false,
      state: "error",
      provider,
      platform,
      online: false,
      ...(activeDistro ? { distro: activeDistro } : {}),
      ...(err?.needsReboot ? { needsReboot: true } : {}),
      ...(err?.needsElevation ? { needsElevation: true } : {}),
      ...(err?.needsVirtualization ? { needsVirtualization: true } : {}),
      error: errMsg,
    };
  }
}

let activeWslWakePromise: Promise<boolean> | null = null;

/**
 * Ensures the Windows WSL2 Ubuntu distro and its TwinkleBot desktop/executor services
 * are awake and keepalive-pinned. Deduplicates concurrent wake requests.
 */
export async function ensureLocalWslExecutorAwake({
  platform = process.platform,
  deployEnv = "local",
  store = null,
  execFileFn = defaultExec,
  probeHealthFn,
  maxHealthAttempts = 12,
  retryDelayMs = 350,
}: {
  platform?: string;
  deployEnv?: DeployEnv | string;
  store?: any;
  execFileFn?: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  probeHealthFn?: () => Promise<boolean>;
  maxHealthAttempts?: number;
  retryDelayMs?: number;
} = {}): Promise<boolean> {
  if (platform !== "win32" || deployEnv !== "local") return false;
  const persistedState = store?.readSettings?.()?.botComputer?.state;
  if (persistedState === "creating") return false;
  if (activeWslWakePromise) return activeWslWakePromise;

  activeWslWakePromise = (async () => {
    try {
      let distro = String(store?.readSettings?.()?.botComputer?.distro || "").trim() || null;
      if (!distro) {
        const listOut = await execFileFn("wsl", ["-l", "-q"], 5_000);
        distro = pickWslUbuntuDistro(parseWslDistroList(String(listOut?.stdout || "")));
      }
      if (!distro) return false;

      if (execFileFn === defaultExec) {
        ensureWslKeepalive(distro);
      }
      // Wake WSL & ensure desktop/executor/browser services are running if systemd is present.
      await execFileFn(
        "wsl",
        [
          "-d",
          distro,
          "-u",
          "root",
          "--",
          "bash",
          "-lc",
          [
            "if [ \"$(ps -p 1 -o comm= 2>/dev/null || true)\" = \"systemd\" ] && [ -d /run/systemd/system ]; then",
            "  if [ -x /opt/twinklebot/sync-proxy.sh ]; then /opt/twinklebot/sync-proxy.sh >/dev/null 2>&1 || true; fi;",
            "  systemctl start twinklebot-desktop.service twinklebot-executor.service >/dev/null 2>&1 || true;",
            "  for u in twinklebot-x11vnc.service twinklebot-novnc.service twinklebot-browser.service; do",
            "    if systemctl list-unit-files --no-pager --no-legend 2>/dev/null | grep -q \"^${u}\"; then",
            "      systemctl start \"$u\" >/dev/null 2>&1 || true;",
            "    fi;",
            "  done;",
            "elif [ -x /opt/twinklebot/start-desktop.sh ] && [ -f /opt/twinklebot/executor.py ]; then",
            "  /opt/twinklebot/start-desktop.sh >/dev/null 2>&1 || true;",
            "  if ! pgrep -f '[/]opt/twinklebot/executor.py' >/dev/null 2>&1 && [ -f /etc/twinklebot/executor.env ]; then",
            "    set -a; . /etc/twinklebot/executor.env; set +a;",
            "    nohup /usr/bin/python3 /opt/twinklebot/executor.py </dev/null >/var/log/twinklebot/executor.log 2>&1 &",
            "  fi;",
            "fi",
          ].join(" "),
        ],
        25_000
      );

      if (!probeHealthFn) return true;
      for (let i = 0; i < maxHealthAttempts; i++) {
        try {
          if (await probeHealthFn()) return true;
        } catch {
          // wait for executor port bind
        }
        if (i + 1 < maxHealthAttempts) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      activeWslWakePromise = null;
    }
  })();

  return activeWslWakePromise;
}

/**
 * Best-effort startup hook on Windows local mode: if Bot's Computer was previously
 * provisioned (`state === "ready"`), immediately establish the WSL keepalive handle
 * so WSL2 does not idle-stop before the user sends a message.
 */
export function initLocalWslKeepaliveOnStartup({
  platform = process.platform,
  deployEnv = "local",
  store = null,
}: {
  platform?: string;
  deployEnv?: DeployEnv | string;
  store?: any;
} = {}): void {
  if (platform !== "win32" || deployEnv !== "local") return;
  const botComputer = store?.readSettings?.()?.botComputer;
  if (botComputer?.state !== "ready") return;
  void ensureLocalWslExecutorAwake({ platform, deployEnv, store });
}

/**
 * Creates an ExecutorClient wired with Windows WSL2 auto-wake & startup keepalive
 * when running in local Windows mode.
 */
export function createLocalAwareExecutorClient({
  url,
  token,
  deployEnv = "local",
  platform = process.platform,
  store = null,
  fetchImpl,
  execFileFn,
  retryDelayMs,
}: {
  url: string;
  token: string;
  deployEnv?: DeployEnv | string;
  platform?: string;
  store?: any;
  fetchImpl?: typeof fetch;
  execFileFn?: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  retryDelayMs?: number;
}): ExecutorClient {
  const probeClient = createExecutorClient({
    url,
    token,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const client = createExecutorClient({
    url,
    token,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(deployEnv === "local" && platform === "win32"
      ? {
          onUnreachableWake: async () => {
            const persistedState = store?.readSettings?.()?.botComputer?.state;
            if (persistedState === "creating" || persistedState === "uncreated") {
              return false;
            }
            return ensureLocalWslExecutorAwake({
              platform,
              deployEnv,
              store,
              ...(execFileFn ? { execFileFn } : {}),
              ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
              probeHealthFn: async () => {
                const h = await probeClient.health({ timeoutMs: 2500, skipWake: true });
                return Boolean(h && h.ok !== false);
              },
            });
          },
        }
      : {}),
  });
  if (!fetchImpl && !execFileFn) {
    initLocalWslKeepaliveOnStartup({ platform, deployEnv, store });
  }
  return client;
}

export default {
  COMPUTER_STATES,
  probeBotComputerState,
  provisionBotComputer,
  ensureLocalWslExecutorAwake,
  initLocalWslKeepaliveOnStartup,
  createLocalAwareExecutorClient,
};
