import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let wslKeepaliveProc: ChildProcess | null = null;
let wslKeepaliveDistro = "";

/**
 * Keeps a lightweight hidden `wsl.exe -d <distro> -- sleep infinity` handle open on Windows
 * so WSL2's 8-second `vmIdleTimeout` does not shut down the Ubuntu desktop/executor VM while
 * TwinkleBot is running. Calling `unref()` ensures short-lived CLI/test processes still exit cleanly.
 */
export function ensureWslKeepalive(distro: string): void {
  if (process.platform !== "win32" || !distro) return;
  if (
    wslKeepaliveProc &&
    wslKeepaliveDistro === distro &&
    wslKeepaliveProc.exitCode === null &&
    !wslKeepaliveProc.killed
  ) {
    return;
  }
  stopWslKeepalive();
  try {
    const child = spawn(
      "wsl.exe",
      ["-d", distro, "-u", "root", "--", "sleep", "infinity"],
      {
        windowsHide: true,
        stdio: "ignore",
      }
    );
    child.on("error", () => {
      if (wslKeepaliveProc === child) {
        wslKeepaliveProc = null;
        wslKeepaliveDistro = "";
      }
    });
    child.on("exit", () => {
      if (wslKeepaliveProc === child) {
        wslKeepaliveProc = null;
        wslKeepaliveDistro = "";
      }
    });
    child.unref();
    wslKeepaliveProc = child;
    wslKeepaliveDistro = distro;
  } catch {
    wslKeepaliveProc = null;
    wslKeepaliveDistro = "";
  }
}

/**
 * Releases the Windows WSL keepalive handle when TwinkleBot shuts down.
 */
export function stopWslKeepalive(): void {
  const proc = wslKeepaliveProc;
  wslKeepaliveProc = null;
  wslKeepaliveDistro = "";
  if (!proc) return;
  if (process.platform === "win32" && proc.pid) {
    try {
      const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } catch {}
  }
  try {
    proc.kill("SIGTERM");
  } catch {}
}

/**
 * Parses `wsl -l -q` output (handling Windows UTF-16LE null bytes and BOM) into clean distro names.
 */
export function parseWslDistroList(rawStdout: string): string[] {
  return String(rawStdout || "")
    .replace(/\u0000/g, "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Picks the best Ubuntu distribution name from a parsed WSL distro list.
 * Prefers exact `Ubuntu`, otherwise the first `Ubuntu*` variant (e.g. `Ubuntu-24.04`, `Ubuntu-22.04`).
 */
export function pickWslUbuntuDistro(distros: string[]): string | null {
  const candidates = distros.filter(
    (name) => !/^docker-desktop/i.test(name) && /^ubuntu\b/i.test(name)
  );
  if (candidates.length === 0) return null;
  const exact = candidates.find((name) => name.toLowerCase() === "ubuntu");
  return exact || candidates[0];
}

/**
 * Translates a Windows drive path (`C:\foo\bar`) to its WSL mount path (`/mnt/c/foo/bar`).
 */
export function windowsPathToWsl(inputPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(inputPath || "").trim());
  if (!match) return String(inputPath || "").replace(/\\/g, "/");
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

export interface WindowsProxyHint {
  explicitProxyUrl: string;
  hostProxyPort: number | null;
  proxyEnabled: boolean;
}

/**
 * Parses host proxy hints from explicit env vars or Windows `reg query` output
 * (`Internet Settings` `ProxyEnable` / `ProxyServer`).
 */
export function parseWindowsProxyHint({
  env = process.env,
  regOutput = "",
}: {
  env?: Record<string, string | undefined>;
  regOutput?: string;
} = {}): WindowsProxyHint {
  const explicitRaw = String(
    env.TWINKLEBOT_WSL_PROXY ||
      env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      ""
  ).trim();
  if (/^https?:\/\/[^/\s]+/i.test(explicitRaw)) {
    try {
      const u = new URL(explicitRaw);
      const isLoopback =
        u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
      const parsedPort = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      if (isLoopback && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        return { explicitProxyUrl: "", hostProxyPort: parsedPort, proxyEnabled: true };
      }
      return { explicitProxyUrl: explicitRaw, hostProxyPort: null, proxyEnabled: true };
    } catch {
      // fall through
    }
  }

  let proxyEnabled = false;
  let hostProxyPort: number | null = null;
  if (regOutput) {
    const enableMatch = regOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i);
    if (enableMatch) {
      const val = enableMatch[1].startsWith("0x")
        ? parseInt(enableMatch[1], 16)
        : Number(enableMatch[1]);
      proxyEnabled = val === 1;
    }
    const serverMatch = regOutput.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (serverMatch) {
      const serverText = serverMatch[1].trim();
      const httpMatch =
        serverText.match(/(?:^|;)\s*(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)/i) ||
        serverText.match(/https?=(?:127\.0\.0\.1|localhost):(\d+)/i);
      if (httpMatch) {
        const port = Number(httpMatch[1]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          hostProxyPort = port;
        }
      }
    }
  }

  return { explicitProxyUrl: "", hostProxyPort, proxyEnabled };
}

/**
 * Resolves host proxy hint safely using explicit env vars and Windows Internet Settings registry.
 */
export async function resolveWindowsProxyHint({
  platform = process.platform,
  execFileFn,
  env = process.env,
}: {
  platform?: string;
  execFileFn?: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  env?: Record<string, string | undefined>;
} = {}): Promise<WindowsProxyHint> {
  const envHint = parseWindowsProxyHint({ env });
  if (envHint.explicitProxyUrl || envHint.hostProxyPort || platform !== "win32" || !execFileFn) {
    return envHint;
  }
  try {
    const out = await execFileFn(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      ],
      3_000
    );
    return parseWindowsProxyHint({ env, regOutput: String(out?.stdout || "") });
  } catch {
    return envHint;
  }
}

/**
 * Resolves `executor/executor.py` on disk, mapping `app.asar` to `app.asar.unpacked` when packaged.
 */
export function resolveUnpackedExecutorPath(projectRoot: string): string {
  const raw = path.join(projectRoot, "executor", "executor.py");
  if (!fs.existsSync(raw) && raw.includes(".asar")) {
    const unpacked = raw.replace(/\.asar([\\/])/, ".asar.unpacked$1");
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return raw;
}

/**
 * Finds an installed Store Ubuntu launcher (`ubuntu.exe`, `ubuntu2404.exe`, `ubuntu2204.exe`)
 * under `%LOCALAPPDATA%\Microsoft\WindowsApps` for non-interactive `install --root` registration.
 */
export function findWindowsAppsUbuntuLauncher(
  localAppData: string = process.env.LOCALAPPDATA || ""
): string | null {
  if (!localAppData) return null;
  const appsDir = path.join(localAppData, "Microsoft", "WindowsApps");
  const candidates = ["ubuntu.exe", "ubuntu2404.exe", "ubuntu2204.exe", "ubuntu2004.exe"];
  for (const exe of candidates) {
    const full = path.join(appsDir, exe);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Classifies WSL installation/startup stderr+stdout for actionable user guidance on a fresh PC.
 */
export function classifyWslInstallFailure(rawOutput: string): {
  needsReboot: boolean;
  needsElevation: boolean;
  needsVirtualization: boolean;
  message: string;
} {
  const text = String(rawOutput || "").replace(/\u0000/g, "");
  if (/0x80370102|virtualization|虚拟化|BIOS/i.test(text)) {
    return {
      needsReboot: true,
      needsElevation: false,
      needsVirtualization: true,
      message:
        "WSL2 需要开启硬件虚拟化或完成首次重启生效：若已开启虚拟化请先重启一次 Windows 电脑，否则请在 BIOS 中开启 Intel VT-x / AMD-V 后重试。",
    };
  }
  if (/restart|reboot|重新启动|重启|0x80370114|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(text)) {
    return {
      needsReboot: true,
      needsElevation: false,
      needsVirtualization: false,
      message:
        "Windows 已启用 WSL2 虚拟化组件，首次安装需要重启一次电脑才能生效；请重启电脑后再点击「初始化」继续完成 Ubuntu 桌面部署。",
    };
  }
  if (/elevation|需要提升|拒绝访问|Access is denied|0x800702e4|0x80070005/i.test(text)) {
    return {
      needsReboot: false,
      needsElevation: true,
      needsVirtualization: false,
      message:
        "首次安装 WSL2 需要 Windows 管理员权限确认（UAC）：请在弹出的管理员授权框中点击「是」，或以管理员身份运行 `wsl --install -d Ubuntu --no-launch` 后重试。",
    };
  }
  return {
    needsReboot: false,
    needsElevation: false,
    needsVirtualization: false,
    message: text.trim() || "WSL Ubuntu 安装或启动失败",
  };
}

/**
 * Pushes a local file into WSL via base64 chunks (16 KB raw -> ~22 KB base64 per call,
 * strictly within Windows 32 KB CreateProcess command-line limit) as a fallback when
 * `/mnt/<drive>` automount is unavailable.
 */
export async function syncFileToWslViaChunks({
  distro,
  localPath,
  remotePath,
  mode = "0755",
  execFileFn,
}: {
  distro: string;
  localPath: string;
  remotePath: string;
  mode?: string;
  execFileFn: (cmd: string, args: string[], timeout?: number) => Promise<any>;
}): Promise<void> {
  const buf = fs.readFileSync(localPath);
  const chunkSize = 16 * 1024;
  const quotedRemote = `'${remotePath.replace(/'/g, "'\\''")}'`;
  const tmpRemote = `'${(remotePath + ".tmp").replace(/'/g, "'\\''")}'`;

  await execFileFn("wsl", [
    "-d",
    distro,
    "-u",
    "root",
    "--",
    "bash",
    "-lc",
    `mkdir -p "$(dirname ${quotedRemote})" && : > ${tmpRemote}`,
  ]);

  for (let offset = 0; offset < buf.length; offset += chunkSize) {
    const b64 = buf.subarray(offset, offset + chunkSize).toString("base64");
    await execFileFn("wsl", [
      "-d",
      distro,
      "-u",
      "root",
      "--",
      "bash",
      "-lc",
      `printf '%s' '${b64}' | base64 -d >> ${tmpRemote}`,
    ]);
  }

  await execFileFn("wsl", [
    "-d",
    distro,
    "-u",
    "root",
    "--",
    "bash",
    "-lc",
    `chmod ${mode} ${tmpRemote} && mv -f ${tmpRemote} ${quotedRemote}`,
  ]);
}

export function buildTwinklebotChromeWrapperScript(): string {
  return `#!/usr/bin/env bash
unset WAYLAND_DISPLAY PULSE_SERVER
export DISPLAY="\${DISPLAY:-:1}"
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11

CDP_PORT="\${TWINKLEBOT_CDP_PORT:-9222}"
PROFILE_DIR="\${TWINKLEBOT_PROFILE_DIR:-/opt/twinklebot/chrome-profile}"
mkdir -p "$PROFILE_DIR"

if [ -f /etc/twinklebot/proxy.env ]; then
  . /etc/twinklebot/proxy.env || true
fi

ARGS_STR=" $* "
EXTRA_ARGS=(
  --ozone-platform=x11
  --no-sandbox
  --disable-dev-shm-usage
  --use-gl=angle
  --use-angle=swiftshader
  --enable-unsafe-swiftshader
  --disable-blink-features=AutomationControlled
  --disable-background-timer-throttling
  --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding
  --disable-session-crashed-bubble
  --hide-crash-restore-bubble
  --process-per-site
  --password-store=basic
  --window-position=0,0
  --window-size=1440,900
  --no-first-run
  --no-default-browser-check
)

case "$ARGS_STR" in
  *" --remote-debugging-port="*) ;;
  *) EXTRA_ARGS+=(--remote-debugging-port="$CDP_PORT" "--remote-allow-origins=*") ;;
esac

case "$ARGS_STR" in
  *" --user-data-dir="*) ;;
  *) EXTRA_ARGS+=(--user-data-dir="$PROFILE_DIR") ;;
esac

if [ -n "\${TWINKLE_PROXY:-}" ]; then
  case "$ARGS_STR" in
    *" --proxy-server="*) ;;
    *) EXTRA_ARGS+=("--proxy-server=$TWINKLE_PROXY" "--proxy-bypass-list=<-loopback>") ;;
  esac
fi

BROWSER_BIN="/opt/twinklebot/browser-bin"
if [ ! -x "$BROWSER_BIN" ]; then
  for cand in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/microsoft-edge /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$cand" ]; then
      BROWSER_BIN="$cand"
      break
    fi
  done
fi

exec "$BROWSER_BIN" "\${EXTRA_ARGS[@]}" "$@"
`;
}

/**
 * Builds an idempotent root bash script for WSL Ubuntu that deploys `executor.py`,
 * configures `/etc/twinklebot/executor.env`, installs XFCE/Xvfb/x11vnc/noVNC/X11 tools
 * and official Google Chrome when missing, isolates from WSLg Wayland, and starts both
 * desktop and executor services.
 */
export function buildWslProvisionScript({
  executorWslPath = "",
  executorToken,
  proxyHint = null,
}: {
  executorWslPath?: string;
  executorToken: string;
  proxyHint?: WindowsProxyHint | null;
}): string {
  const envContent = [
    `TWINKLEBOT_EXECUTOR_TOKEN=${executorToken}`,
    `TWINKLEBOT_BROWSER=/usr/local/bin/google-chrome`,
    `DISPLAY=:1`,
    `HOME=/root`,
    `XDG_SESSION_TYPE=x11`,
    `GDK_BACKEND=x11`,
    `QT_QPA_PLATFORM=xcb`,
    "",
  ].join("\n");
  const envB64 = Buffer.from(envContent, "utf-8").toString("base64");

  const proxyHintContent = [
    `EXPLICIT_PROXY_URL=${proxyHint?.explicitProxyUrl || ""}`,
    `HOST_PROXY_PORT=${proxyHint?.hostProxyPort ? String(proxyHint.hostProxyPort) : ""}`,
    `HOST_PROXY_ENABLED=${proxyHint?.proxyEnabled ? "1" : "0"}`,
    "",
  ].join("\n");
  const proxyHintB64 = Buffer.from(proxyHintContent, "utf-8").toString("base64");

  const syncProxyScript = `#!/usr/bin/env bash
set -e
mkdir -p /etc/twinklebot
EXPLICIT_PROXY_URL=""
HOST_PROXY_PORT=""
HOST_PROXY_ENABLED="0"
if [ -f /etc/twinklebot/proxy-hint ]; then
  . /etc/twinklebot/proxy-hint || true
fi

RESOLVED=""
if [ -n "$EXPLICIT_PROXY_URL" ]; then
  RESOLVED="$EXPLICIT_PROXY_URL"
elif [ -n "$HOST_PROXY_PORT" ]; then
  GW_IP="$(ip route 2>/dev/null | awk '/^default / {print $3; exit}')"
  if [ -n "$GW_IP" ] && timeout 1 bash -c "cat < /dev/null > /dev/tcp/\${GW_IP}/\${HOST_PROXY_PORT}" 2>/dev/null; then
    USE_PROXY="$HOST_PROXY_ENABLED"
    if [ "$USE_PROXY" != "1" ]; then
      # Also auto-forward when WSL resolves fake-ip (198.18.0.0/15) or direct egress times out (Clash TUN mode)
      RESOLVED_IP="$(getent ahostsv4 accounts.google.com 2>/dev/null | awk 'NR==1{print $1}')"
      case "$RESOLVED_IP" in
        198.18.*|198.19.*) USE_PROXY="1" ;;
      esac
      if [ "$USE_PROXY" != "1" ] && ! curl -fsS --connect-timeout 1 --max-time 2 https://accounts.google.com/generate_204 >/dev/null 2>&1; then
        if curl -fsS --connect-timeout 1 --max-time 2 -x "http://\${GW_IP}:\${HOST_PROXY_PORT}" https://accounts.google.com/generate_204 >/dev/null 2>&1; then
          USE_PROXY="1"
        fi
      fi
    fi
    if [ "$USE_PROXY" = "1" ]; then
      RESOLVED="http://\${GW_IP}:\${HOST_PROXY_PORT}"
    fi
  fi
fi

{
  printf 'TWINKLE_PROXY=%s\\n' "$RESOLVED"
} > /etc/twinklebot/proxy.env
chmod 644 /etc/twinklebot/proxy.env
`;
  const syncProxyB64 = Buffer.from(syncProxyScript, "utf-8").toString("base64");

  const browserSupervisorScript = `#!/usr/bin/env bash
set -u
unset WAYLAND_DISPLAY PULSE_SERVER
export HOME=/root
export DISPLAY=:1
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11

PROFILE_DIR="/opt/twinklebot/chrome-profile"
BROWSER_BIN="/opt/twinklebot/browser-bin"
if [ ! -x "$BROWSER_BIN" ]; then
  for cand in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/microsoft-edge /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$cand" ]; then
      BROWSER_BIN="$cand"
      break
    fi
  done
fi

if [ -x /opt/twinklebot/sync-proxy.sh ]; then
  /opt/twinklebot/sync-proxy.sh >/dev/null 2>&1 || true
fi
TWINKLE_PROXY=""
if [ -f /etc/twinklebot/proxy.env ]; then
  . /etc/twinklebot/proxy.env || true
fi

find_live_profile_pid() {
  python3 - "$PROFILE_DIR" <<'PY' 2>/dev/null
import os, socket, sys
profile = sys.argv[1]
lock_path = os.path.join(profile, "SingletonLock")
if os.path.islink(lock_path):
    try:
        target = os.readlink(lock_path)
        host, pid_str = target.rsplit("-", 1)
        if host == socket.gethostname() and pid_str.isdigit():
            pid = int(pid_str)
            cmd_path = f"/proc/{pid}/cmdline"
            if os.path.exists(cmd_path):
                cmd = open(cmd_path, "rb").read().decode("utf-8", errors="ignore")
                if "chrome" in cmd.lower() or "chromium" in cmd.lower():
                    print(pid)
                    sys.exit(0)
    except Exception:
        pass
PY
}

cdp_alive() {
  curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1
}

# Never invoke \`chrome about:blank\` while an existing Chrome instance already owns this profile:
# Chromium's SingletonSocket handshake would spawn a new about:blank tab and exit 0, causing a systemd loop.
LIVE_PID="$(find_live_profile_pid || true)"
if [ -n "$LIVE_PID" ] || cdp_alive; then
  while true; do
    sleep 3
    CUR_PID="$(find_live_profile_pid || true)"
    if [ -z "$CUR_PID" ] && ! cdp_alive; then
      break
    fi
  done
fi

# Clean only stale locks left by dead PIDs, and reset exit_type=Normal to suppress "Restore pages?" bubble.
rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/SingletonCookie" 2>/dev/null || true
python3 - "$PROFILE_DIR/Default/Preferences" <<'PY' 2>/dev/null || true
import json, os, sys
pref_path = sys.argv[1]
if not os.path.isfile(pref_path):
    sys.exit(0)
with open(pref_path, "r", encoding="utf-8", errors="ignore") as f:
    data = json.load(f)
prof = data.setdefault("profile", {})
changed = False
if prof.get("exit_type") != "Normal":
    prof["exit_type"] = "Normal"
    changed = True
if prof.get("exited_cleanly") is not True:
    prof["exited_cleanly"] = True
    changed = True
if changed:
    with open(pref_path, "w", encoding="utf-8") as f:
        json.dump(data, f)
PY

EXTRA_ARGS=()
if [ -n "$TWINKLE_PROXY" ]; then
  EXTRA_ARGS+=("--proxy-server=$TWINKLE_PROXY" "--proxy-bypass-list=<-loopback>")
fi

exec "$BROWSER_BIN" \\
  --ozone-platform=x11 \\
  --no-sandbox \\
  --disable-dev-shm-usage \\
  --use-gl=angle \\
  --use-angle=swiftshader \\
  --enable-unsafe-swiftshader \\
  --disable-blink-features=AutomationControlled \\
  --disable-background-timer-throttling \\
  --disable-backgrounding-occluded-windows \\
  --disable-renderer-backgrounding \\
  --disable-session-crashed-bubble \\
  --hide-crash-restore-bubble \\
  --process-per-site \\
  --password-store=basic \\
  --remote-debugging-port=9222 \\
  --remote-allow-origins=* \\
  --user-data-dir="$PROFILE_DIR" \\
  --window-position=0,0 \\
  --window-size=1440,900 \\
  --no-first-run \\
  --no-default-browser-check \\
  "\${EXTRA_ARGS[@]}" \\
  about:blank
`;
  const browserSupervisorB64 = Buffer.from(browserSupervisorScript, "utf-8").toString("base64");

  const startDesktopScript = `#!/usr/bin/env bash
set -e
unset WAYLAND_DISPLAY PULSE_SERVER
export HOME=/root
export USER=root
export LOGNAME=root
export DISPLAY=:1
export XDG_RUNTIME_DIR=/tmp/runtime-root
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb

DESKTOP_ONLY=0
if [ "\${1:-}" = "--desktop-only" ]; then
  DESKTOP_ONLY=1
fi

mkdir -p /var/log/twinklebot /tmp/.X11-unix /tmp/runtime-root
chmod 700 /tmp/runtime-root || true
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

if ! xdpyinfo -display :1 >/dev/null 2>&1; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
  nohup Xvfb :1 -screen 0 1440x900x24 -ac +extension GLX +render -noreset </dev/null >/var/log/twinklebot/xvfb.log 2>&1 &
  for _ in $(seq 1 30); do
    if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
fi

if ! DISPLAY=:1 wmctrl -l >/dev/null 2>&1 || ! pgrep -x xfce4-panel >/dev/null 2>&1; then
  pkill -9 -f "[x]fce4-session|[x]fwm4.*--replace|[x]fdesktop|[x]fce4-panel" >/dev/null 2>&1 || true
  sleep 0.2
  nohup dbus-run-session -- bash -c 'xfwm4 --compositor=off --replace & sleep 0.4; xfdesktop & xfce4-panel & wait' </dev/null >/var/log/twinklebot/xfce.log 2>&1 &
  for _ in $(seq 1 25); do
    if DISPLAY=:1 wmctrl -l >/dev/null 2>&1 && pgrep -x xfce4-panel >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
fi

if [ "$DESKTOP_ONLY" = "0" ]; then
  if ! ss -tln 2>/dev/null | grep -qE ':5901\\b' && ! pgrep -f 'x11vnc.*-display :1\\b' >/dev/null 2>&1; then
    nohup env -u WAYLAND_DISPLAY DISPLAY=:1 x11vnc -display :1 -rfbport 5901 -listen 127.0.0.1 -forever -shared -nopw -xkb -nap -wait 10 -defer 10 </dev/null >/var/log/twinklebot/x11vnc.log 2>&1 &
  fi

  if ! ss -tln 2>/dev/null | grep -qE ':6080\\b' && ! pgrep -f 'websockify.*6080' >/dev/null 2>&1; then
    NOVNC_WEB="/usr/share/novnc"
    [ -d "$NOVNC_WEB" ] || NOVNC_WEB="/usr/share/novnc/"
    nohup websockify --web="$NOVNC_WEB" 6080 127.0.0.1:5901 </dev/null >/var/log/twinklebot/novnc.log 2>&1 &
  fi
fi
`;
  const startDesktopB64 = Buffer.from(startDesktopScript, "utf-8").toString("base64");

  const desktopUnit = `[Unit]
Description=TwinkleBot WSL Ubuntu XFCE Desktop (:1)
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=HOME=/root
Environment=DISPLAY=:1
Environment=XDG_SESSION_TYPE=x11
Environment=GDK_BACKEND=x11
UnsetEnvironment=WAYLAND_DISPLAY PULSE_SERVER
ExecStart=/opt/twinklebot/start-desktop.sh --desktop-only

[Install]
WantedBy=multi-user.target
`;
  const desktopUnitB64 = Buffer.from(desktopUnit, "utf-8").toString("base64");

  const x11vncUnit = `[Unit]
Description=TwinkleBot Primary Screen X11VNC (:1 -> 5901)
After=twinklebot-desktop.service
Requires=twinklebot-desktop.service

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=DISPLAY=:1
UnsetEnvironment=WAYLAND_DISPLAY PULSE_SERVER
ExecStart=/usr/bin/x11vnc -display :1 -rfbport 5901 -listen 127.0.0.1 -forever -shared -nopw -xkb -nap -wait 10 -defer 10
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
  const x11vncUnitB64 = Buffer.from(x11vncUnit, "utf-8").toString("base64");

  const novncUnit = `[Unit]
Description=TwinkleBot Primary Screen noVNC WebSocket (:6080 -> 5901)
After=twinklebot-desktop.service twinklebot-x11vnc.service
Wants=twinklebot-x11vnc.service

[Service]
Type=simple
User=root
Environment=HOME=/root
ExecStart=/usr/bin/python3 /usr/bin/websockify --web=/usr/share/novnc 6080 127.0.0.1:5901
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
  const novncUnitB64 = Buffer.from(novncUnit, "utf-8").toString("base64");

  const executorUnit = `[Unit]
Description=TwinkleBot Desktop Executor
After=twinklebot-desktop.service

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=DISPLAY=:1
Environment=XDG_SESSION_TYPE=x11
Environment=GDK_BACKEND=x11
UnsetEnvironment=WAYLAND_DISPLAY PULSE_SERVER
EnvironmentFile=/etc/twinklebot/executor.env
ExecStart=/usr/bin/python3 /opt/twinklebot/executor.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
  const executorUnitB64 = Buffer.from(executorUnit, "utf-8").toString("base64");

  const browserUnit = `[Unit]
Description=TwinkleBot Persistent Chrome Browser (CDP 9222)
After=twinklebot-desktop.service
Wants=twinklebot-desktop.service

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=DISPLAY=:1
Environment=XDG_SESSION_TYPE=x11
Environment=GDK_BACKEND=x11
UnsetEnvironment=WAYLAND_DISPLAY PULSE_SERVER
ExecStart=/opt/twinklebot/browser-supervisor.sh
Restart=always
RestartSec=3
KillMode=control-group

[Install]
WantedBy=multi-user.target
`;
  const browserUnitB64 = Buffer.from(browserUnit, "utf-8").toString("base64");

  const wrapperScript = buildTwinklebotChromeWrapperScript();
  const wrapperB64 = Buffer.from(wrapperScript, "utf-8").toString("base64");

  const quotedExecutorSrc = `'${String(executorWslPath || "").replace(/'/g, "'\\''")}'`;

  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /opt/twinklebot /etc/twinklebot /var/log/twinklebot

EXECUTOR_SRC=${quotedExecutorSrc}
if [ -n "$EXECUTOR_SRC" ] && [ -f "$EXECUTOR_SRC" ]; then
  install -m 0755 "$EXECUTOR_SRC" /opt/twinklebot/executor.py
fi

printf '%s' '${envB64}' | base64 -d > /etc/twinklebot/executor.env
chmod 600 /etc/twinklebot/executor.env

printf '%s' '${proxyHintB64}' | base64 -d > /etc/twinklebot/proxy-hint
chmod 644 /etc/twinklebot/proxy-hint

printf '%s' '${syncProxyB64}' | base64 -d > /opt/twinklebot/sync-proxy.sh
chmod 0755 /opt/twinklebot/sync-proxy.sh
/opt/twinklebot/sync-proxy.sh || true

NEED_APT=0
for bin in python3 Xvfb xfwm4 xfce4-panel xfdesktop x11vnc websockify xdotool wmctrl xclip import xdpyinfo dbus-run-session ss; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    NEED_APT=1
    break
  fi
done
if [ ! -f /usr/share/novnc/vnc.html ]; then
  NEED_APT=1
fi

if [ "$NEED_APT" = "1" ]; then
  apt-get -o Acquire::Retries=3 update -y
  apt-get -o Acquire::Retries=3 install -y --no-install-recommends \\
    python3 xvfb xfce4 xfce4-terminal dbus-x11 x11vnc novnc websockify \\
    xdotool wmctrl xclip imagemagick x11-utils iproute2 procps curl ca-certificates fonts-noto-cjk
  apt-get -o Acquire::Retries=3 install -y --no-install-recommends fonts-noto-color-emoji >/dev/null 2>&1 || true
fi

find_official_chrome() {
  for cand in /usr/bin/google-chrome-stable /usr/bin/google-chrome; do
    if [ -x "$cand" ]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

find_fallback_browser() {
  for cand in /usr/bin/microsoft-edge /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$cand" ] && ! head -n 1 "$cand" 2>/dev/null | grep -q 'snap'; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

# Always prefer and pre-install official Google Chrome (google-chrome-stable), not open-source Chromium.
BROWSER_BIN="$(find_official_chrome || true)"
if [ -z "$BROWSER_BIN" ]; then
  CHROME_DEB_ARCH=""
  case "$(uname -m)" in
    x86_64|amd64) CHROME_DEB_ARCH="amd64" ;;
    aarch64|arm64) CHROME_DEB_ARCH="arm64" ;;
  esac
  if [ -n "$CHROME_DEB_ARCH" ]; then
    TWINKLE_PROXY=""
    if [ -f /etc/twinklebot/proxy.env ]; then
      . /etc/twinklebot/proxy.env || true
    fi
    CURL_PROXY_ARGS=()
    if [ -n "$TWINKLE_PROXY" ]; then
      CURL_PROXY_ARGS=(-x "$TWINKLE_PROXY")
    fi
    TMP_DEB="/tmp/google-chrome-stable.deb"
    if curl -fsSL "\${CURL_PROXY_ARGS[@]}" --connect-timeout 15 --max-time 180 "https://dl.google.com/linux/direct/google-chrome-stable_current_\${CHROME_DEB_ARCH}.deb" -o "$TMP_DEB"; then
      if [ "$NEED_APT" != "1" ]; then
        apt-get -o Acquire::Retries=3 update -y >/dev/null 2>&1 || true
      fi
      apt-get -o Acquire::Retries=3 install -y "$TMP_DEB" >/dev/null 2>&1 || (dpkg -i "$TMP_DEB" || apt-get -o Acquire::Retries=3 install -f -y)
      rm -f "$TMP_DEB"
      BROWSER_BIN="$(find_official_chrome || true)"
    fi
  fi
fi
if [ -z "$BROWSER_BIN" ]; then
  BROWSER_BIN="$(find_fallback_browser || true)"
fi

if [ -n "$BROWSER_BIN" ]; then
  CHROME_PROFILE="/opt/twinklebot/chrome-profile"
  if [ -d "/opt/twinklebot-chrome-profile" ] && [ ! -e "$CHROME_PROFILE" ]; then
    mv /opt/twinklebot-chrome-profile "$CHROME_PROFILE"
  fi
  mkdir -p "$CHROME_PROFILE"
  ln -sf "$BROWSER_BIN" /opt/twinklebot/browser-bin
  printf '%s' '${wrapperB64}' | base64 -d > /usr/local/bin/twinklebot-chrome
  chmod 0755 /usr/local/bin/twinklebot-chrome
  ln -sf /usr/local/bin/twinklebot-chrome /usr/local/bin/google-chrome
  ln -sf /usr/local/bin/twinklebot-chrome /usr/local/bin/chromium
  printf '%s' '${browserSupervisorB64}' | base64 -d > /opt/twinklebot/browser-supervisor.sh
  chmod 0755 /opt/twinklebot/browser-supervisor.sh
  if [ -f /usr/share/applications/google-chrome.desktop ]; then
    sed -i -E 's|^Exec=.*google-chrome[^ ]*(.*)|Exec=/usr/local/bin/twinklebot-chrome\\1|' /usr/share/applications/google-chrome.desktop || true
  fi
elif command -v firefox >/dev/null 2>&1 || (apt-get -o Acquire::Retries=3 update -y >/dev/null 2>&1 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends firefox >/dev/null 2>&1); then
  sed -i 's|^TWINKLEBOT_BROWSER=.*|TWINKLEBOT_BROWSER=/usr/bin/firefox|' /etc/twinklebot/executor.env || true
fi

printf '%s' '${startDesktopB64}' | base64 -d > /opt/twinklebot/start-desktop.sh
chmod 0755 /opt/twinklebot/start-desktop.sh

if [ ! -f /etc/wsl.conf ] || ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  printf '\\n[boot]\\nsystemd=true\\n' >> /etc/wsl.conf
fi

if [ "$(ps -p 1 -o comm= 2>/dev/null || true)" = "systemd" ] && [ -d /run/systemd/system ]; then
  if systemctl list-unit-files --no-pager --no-legend 2>/dev/null | grep -q '^chromium-cdp\\.service'; then
    systemctl disable --now chromium-cdp.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/chromium-cdp.service
  fi
  # Release any legacy unmanaged :1 x11vnc/websockify before supervised units bind 5901/6080
  pkill -f 'x11vnc -display :1\\b' >/dev/null 2>&1 || true
  pkill -f 'websockify.*6080' >/dev/null 2>&1 || true
  printf '%s' '${desktopUnitB64}' | base64 -d > /etc/systemd/system/twinklebot-desktop.service
  printf '%s' '${x11vncUnitB64}' | base64 -d > /etc/systemd/system/twinklebot-x11vnc.service
  printf '%s' '${novncUnitB64}' | base64 -d > /etc/systemd/system/twinklebot-novnc.service
  printf '%s' '${executorUnitB64}' | base64 -d > /etc/systemd/system/twinklebot-executor.service
  printf '%s' '${browserUnitB64}' | base64 -d > /etc/systemd/system/twinklebot-browser.service
  systemctl daemon-reload
  systemctl enable twinklebot-desktop.service twinklebot-x11vnc.service twinklebot-novnc.service twinklebot-executor.service >/dev/null 2>&1 || true
  if [ -n "$BROWSER_BIN" ]; then
    systemctl enable twinklebot-browser.service >/dev/null 2>&1 || true
  fi
  systemctl restart twinklebot-desktop.service
  systemctl restart twinklebot-x11vnc.service
  systemctl restart twinklebot-novnc.service
  systemctl restart twinklebot-executor.service
  if [ -n "$BROWSER_BIN" ]; then
    systemctl restart twinklebot-browser.service
  fi
else
  /opt/twinklebot/start-desktop.sh
  pkill -f '[/]opt/twinklebot/executor.py' >/dev/null 2>&1 || true
  sleep 0.2
  unset WAYLAND_DISPLAY PULSE_SERVER
  set -a
  . /etc/twinklebot/executor.env
  set +a
  nohup /usr/bin/python3 /opt/twinklebot/executor.py </dev/null >/var/log/twinklebot/executor.log 2>&1 &
fi
`;
}
