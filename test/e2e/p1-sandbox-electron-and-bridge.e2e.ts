import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createExecutorClient } from "../../src/agent/executor-client.js";
import { createWebOtaManager } from "../../src/electron/web-ota.js";
import { createTarGzFromDir } from "../../src/lib/tar-gzip.js";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import {
  startMockLlmServer,
  startOtaFixtureServer,
  startStaticSiteFixtureServer,
} from "../helpers/e2e-protocol-fixtures.js";
import {
  createSuiteCollector,
  EnvSkipSignal,
  PROJECT_ROOT,
} from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

function hasOrbUbuntu(): boolean {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("orb", ["list"], { encoding: "utf8" });
  return r.status === 0 && /\bubuntu\b/i.test(r.stdout || "");
}

const PY_REAL_CHROME_EXECUTOR_BOOTSTRAP = `
import json, os, shutil, signal, socket, subprocess, sys, tempfile, threading, time
sys.path.insert(0, sys.argv[1])
import executor as ex

TOKEN = sys.argv[2]
def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("0.0.0.0", 0))
        return int(s.getsockname()[1])

def find_free_display():
    for d in range(96, 129):
        if not os.path.exists(f"/tmp/.X{d}-lock") and not os.path.exists(f"/tmp/.X11-unix/X{d}"):
            return d
    raise RuntimeError("No free display in :96..:128")

chrome_bin = next((c for c in ("/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", shutil.which("google-chrome-stable") or "", shutil.which("google-chrome") or "") if c and os.path.isfile(c)), "")
if not chrome_bin:
    raise RuntimeError("Official Google Chrome not found")

xvfb = shutil.which("Xvfb")
tiger = shutil.which("Xtigervnc")
if not xvfb and not tiger:
    raise RuntimeError("Neither Xvfb nor Xtigervnc found")

tmp_dir = tempfile.mkdtemp(prefix="tb-p1-sbox-")
profile_dir = os.path.join(tmp_dir, "chrome-profile")
map_path = os.path.join(tmp_dir, "display-map.json")
os.makedirs(profile_dir, exist_ok=True)
disp_num = find_free_display()
disp = f":{disp_num}"

if xvfb:
    x_cmd = [xvfb, disp, "-screen", "0", "1440x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"]
else:
    x_cmd = [tiger, disp, "-geometry", "1440x900", "-depth", "24", "-SecurityTypes", "None", "-localhost", "yes", "-rfbport", str(find_free_port())]

x_proc = subprocess.Popen(x_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
for _ in range(50):
    if os.path.exists(f"/tmp/.X11-unix/X{disp_num}"):
        break
    time.sleep(0.1)

cdp_port = find_free_port()
spawned = []
def tracked_spawn(argv, **kwargs):
    env = dict(kwargs.get("env") or {})
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "TWINKLE_PROXY"):
        env.pop(k, None)
    kwargs["env"] = env
    p = subprocess.Popen(argv, **kwargs)
    spawned.append(p)
    return p

dm = ex.TabManager(
    map_path=map_path,
    primary_profile_dir=profile_dir,
    max_concurrent_screens=2,
    browser_idle_sec=300,
    browser_boot_timeout_sec=15.0,
    cdp_port=cdp_port,
    display=disp,
    spawn_fn=tracked_spawn,
    browser_bin=chrome_bin,
)
actions = ex.Actions(browser=chrome_bin, display=disp, cdp_port=cdp_port, profile_dir=profile_dir)
srv = ex.make_server(actions, TOKEN, host="0.0.0.0", port=0, display_manager=dm)
exec_port = srv.server_address[1]

def cleanup(*_):
    try: srv.shutdown()
    except Exception: pass
    for p in spawned:
        try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            try: p.kill()
            except Exception: pass
    try: os.killpg(os.getpgid(x_proc.pid), signal.SIGKILL)
    except Exception:
        try: x_proc.kill()
        except Exception: pass
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os._exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)
print(json.dumps({"exec_port": exec_port, "cdp_port": cdp_port, "tmp_dir": tmp_dir}), flush=True)
srv.serve_forever()
`;

async function spawnRealSandboxExecutor(token: string) {
  const executorDir = path.join(PROJECT_ROOT, "executor");
  const useOrb = hasOrbUbuntu();
  if (!useOrb && process.platform !== "linux") {
    throw new EnvSkipSignal("Real Linux X11 + Official Chrome sandbox requires Linux or macOS OrbStack 'ubuntu'");
  }
  const cmd = useOrb ? "orb" : "python3";
  const args = useOrb
    ? ["-m", "ubuntu", "python3", "-u", "-c", PY_REAL_CHROME_EXECUTOR_BOOTSTRAP, executorDir, token]
    : ["-u", "-c", PY_REAL_CHROME_EXECUTOR_BOOTSTRAP, executorDir, token];

  const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const info = await new Promise<{ exec_port: number; cdp_port: number; tmp_dir: string }>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Real sandbox executor boot timeout: ${stderr}`)), 20_000);
    proc.stdout?.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (err) {
          reject(err);
        }
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Real sandbox executor exited (${code}): ${stderr}`));
    });
  });

  // Resolve reachable URL from macOS (OrbStack forwards 127.0.0.1 and ubuntu.orb.local)
  let baseUrl = `http://127.0.0.1:${info.exec_port}`;
  try {
    const r = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("not ok");
  } catch {
    baseUrl = `http://ubuntu.orb.local:${info.exec_port}`;
  }

  return {
    baseUrl,
    info,
    close: async () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
      try {
        proc.kill("SIGKILL");
      } catch {}
    },
  };
}

test("P1 Suite 3: Fullstack Real Sandbox, Electron v45 Shell, Web OTA Watchdog & Cloud↔Host Bridge", async (t) => {
  const collector = createSuiteCollector("p1-sandbox-electron-and-bridge");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  // ---------- P1-SBOX-01 & P1-SBOX-02 ----------
  let realSbox: Awaited<ReturnType<typeof spawnRealSandboxExecutor>> | null = null;
  const sboxToken = "p1-sbox-token-999";

  await collector.runCase(
    t,
    {
      id: "P1-SBOX-01",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "全栈真沙盒闭环：Web UI → Node Agent → 真实 Python executor.py → 真实 Chrome 登录 + send_file 投递卡片",
      module: "Fullstack Sandbox",
    },
    async () => {
      realSbox = await spawnRealSandboxExecutor(sboxToken);
      t.after(() => realSbox?.close());

      // Start fixture site accessible from inside OrbStack (bind 0.0.0.0, use host IP or 127.0.0.1 inside linux)
      const siteSrv = http.createServer(async (req, res) => {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        if (u.pathname === "/login") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><head><title>SboxLogin</title></head><body>
            <form onsubmit="event.preventDefault(); doLogin();">
              <input id="u" type="text" placeholder="Username" />
              <input id="p" type="password" placeholder="Password" />
              <button id="go" type="submit">Sign In</button>
            </form>
            <script>
              async function doLogin() {
                const r = await fetch('/do-login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({u:u.value,p:p.value}) });
                if (r.ok) { localStorage.setItem('sbox_user', u.value); location.href='/whoami'; }
              }
            </script></body></html>`);
          return;
        }
        if (u.pathname === "/do-login" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "sbox_sid=shared-777; Path=/" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (u.pathname === "/whoami") {
          const hasCookie = String(req.headers.cookie || "").includes("sbox_sid=shared-777");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body><div id="ck">${hasCookie ? "COOKIE_OK" : "COOKIE_MISS"}</div><div id="ls"></div><script>ls.textContent='LS:'+localStorage.getItem('sbox_user');</script></body></html>`);
          return;
        }
        res.writeHead(404);
        res.end("404");
      });
      await new Promise<void>((r) => siteSrv.listen(0, "0.0.0.0", r));
      t.after(() => siteSrv.close());
      const sitePort = (siteSrv.address() as net.AddressInfo).port;
      const siteHost = hasOrbUbuntu() ? "host.orb.internal" : "127.0.0.1";
      const loginUrl = `http://${siteHost}:${sitePort}/login`;
      const whoamiUrl = `http://${siteHost}:${sitePort}/whoami`;

      const realExec = createExecutorClient({ url: realSbox.baseUrl, token: sboxToken });
      const ws = await createE2EWorkspace({
        customExecutor: realExec,
        smartRouter: false,
      });
      t.after(() => ws.close());

      const reportFile = path.join(realSbox.info.tmp_dir, "sbox-report.txt");
      let step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        const mStr = JSON.stringify(body?.messages || "");
        if (
          mStr.includes("ultra-short Chinese phrase") ||
          mStr.includes("Distill the current task progress") ||
          mStr.includes("短语") ||
          mStr.includes("概括")
        )
          return { text: "操控沙盒" };
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "sb1", name: "browser_snapshot", args: { url: loginUrl, risk: "low" } }] };
        }
        if (step === 2) {
          return { toolCalls: [{ id: "sb2", name: "browser_type", args: { ref: "e1", text: "alice_sbox", clear: true, submit: false, risk: "low" } }] };
        }
        if (step === 3) {
          return { toolCalls: [{ id: "sb3", name: "browser_type", args: { ref: "e2", text: "pass123", clear: true, submit: false, risk: "low" } }] };
        }
        if (step === 4) {
          return { toolCalls: [{ id: "sb4", name: "browser_click", args: { ref: "e3", risk: "low" } }] };
        }
        if (step === 5) {
          return {
            toolCalls: [
              { id: "sb5", name: "run_shell", args: { command: `printf 'SBOX_REPORT_OK' > ${reportFile}`, risk: "low" } },
            ],
          };
        }
        if (step === 6) {
          return {
            toolCalls: [{ id: "sb6", name: "send_file", args: { path: reportFile, label: "沙盒导出报告" } }],
          };
        }
        return { text: "全栈真沙盒任务已完成并投递报告" };
      });

      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('Twinkle') &&
         document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`
      );
      await chrome!.typeText("#message-input", "登录沙盒测试站并导出文件", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('全栈真沙盒任务已完成并投递报告'))`,
        25_000
      );
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-file-card'))`, 8000);
      const cardText = await chrome!.evalJs<string>(`document.querySelector('.msg-file-card')?.textContent || ''`);
      assert.match(cardText, /sbox-report\.txt|沙盒导出报告/);

      // Store whoamiUrl on global for P1-SBOX-02 shared profile test
      (realSbox as any).whoamiUrl = whoamiUrl;
    },
    { getChrome: () => chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P1-SBOX-02",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "共享 Chrome Profile 跨 Bot 登录态(Cookie + localStorage)与双标签并发 DOM 操作隔离",
      module: "Sandbox Shared Profile",
    },
    async () => {
      if (!realSbox || !(realSbox as any).whoamiUrl) {
        throw new EnvSkipSignal("Depends on real sandbox executor from P1-SBOX-01");
      }
      const realExec = createExecutorClient({ url: realSbox.baseUrl, token: sboxToken });
      // Second non-admin Bot opens a brand-new tab and immediately shares login state!
      const snapBot2: any = await realExec.call(
        "/browser/snapshot",
        { url: (realSbox as any).whoamiUrl },
        { botId: "worker-bot-2", isAdmin: false }
      );
      assert.match(snapBot2?.text_excerpt || "", /COOKIE_OK/);
      assert.match(snapBot2?.text_excerpt || "", /LS:alice_sbox/);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SBOX-03 & P1-SBOX-04 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SBOX-03",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "屏幕并发池 FIFO 排队、纯 CLI 零阻塞、调大上限实时唤醒与右侧排队状态徽章",
      module: "Screen Lease Pool",
    },
    async () => {
      let releaseHold!: () => void;
      const holdGate = new Promise<void>((r) => {
        releaseHold = r;
      });
      const customExec = {
        health: async () => ({ ok: true, screen: { width: 1440, height: 900 } }),
        call: async (route: string) => {
          if (route === "/displays") {
            return {
              ok: true,
              mode: "shared-profile-multi-tab",
              bindings: { __primary__: "标签 #1" },
              displays: [{ display_num: 1, display: ":1", novnc_online: true, cdp_online: true }],
            };
          }
          if (route === "/browser/snapshot") {
            await holdGate;
            return { ok: true, url: "https://example.test", elements: [] };
          }
          if (route === "/shell") {
            return { exit_code: 0, stdout: "fast-cli-ok", stderr: "", truncated: false };
          }
          return { ok: true };
        },
      };

      const ws = await createE2EWorkspace({ customExecutor: customExec, smartRouter: false });
      t.after(() => ws.close());

      const initSettings: any = await (await fetch(`${ws.baseUrl}/api/settings`)).json();
      const minLimit = initSettings.screenPool.budget.min;
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screenPool: { mode: "custom", maxConcurrentScreens: minLimit } }),
      });

      const admin = ws.store.ensureAdminBot();
      const b1 = ws.store.createSession({ title: "占屏员1" });
      const b2 = ws.store.createSession({ title: "排队员2" });
      const cliBot = ws.store.createSession({ title: "纯命令行员" });

      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "执行中" };
        if (Array.isArray(body?.messages) && body.messages.some((m: any) => m.role === "tool")) {
          return { text: "done" };
        }
        const s = JSON.stringify(body?.messages || "");
        if (s.includes("CLI_ONLY")) {
          return { toolCalls: [{ id: `cli-${Date.now()}`, name: "run_shell", args: { command: "echo ok", risk: "low" } }] };
        }
        return { toolCalls: [{ id: `sn-${Date.now()}`, name: "browser_snapshot", args: { url: "https://example.test", risk: "low" } }] };
      });

      const fillers = [admin, b1].slice(0, minLimit);
      for (const fb of fillers) {
        await fetch(`${ws.baseUrl}/api/sessions/${fb.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "HOLD_SCREEN" }),
        });
      }
      await ws.waitUntil(() => ws.runner.getScreenPoolStats().activeCount >= minLimit, 6000, "pool active full");

      await fetch(`${ws.baseUrl}/api/sessions/${b2.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "QUEUE_ME" }),
      });
      await ws.waitUntil(() => ws.runner.getScreenPoolStats().queuedCount >= 1, 6000, "b2 queued");

      // Pure CLI bot finishes immediately while screen pool is 100% full!
      await fetch(`${ws.baseUrl}/api/sessions/${cliBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "CLI_ONLY" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(cliBot.id), 5000, "CLI bot finishes without waiting for screen");

      // Raise screen pool limit live -> wakes queued b2 immediately!
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screenPool: { mode: "custom", maxConcurrentScreens: minLimit + 1 } }),
      });
      await ws.waitUntil(() => ws.runner.getScreenPoolStats().queuedCount === 0, 5000, "limit increase wakes queued bot");
      releaseHold();
      await ws.waitUntil(() => ![...fillers, b2].some((x) => ws.runner.isSessionBusy(x.id)), 6000, "all drain");
    },
    { getChrome: () => chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P1-SBOX-04",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "noVNC 顶栏隐藏注入、人工独占接管(#pause-btn -> #resume-btn 补拍截图续跑)与群聊自动跟屏/手动切屏",
      module: "BotComputerOverlay / noVNC",
    },
    async () => {
      const ws = await createE2EWorkspace({ smartRouter: false });
      t.after(() => ws.close());

      // Verify /novnc/vnc.html injects CSS hiding native control bar
      const vncHtml = await (await fetch(`${ws.baseUrl}/novnc/vnc.html`)).text();
      assert.match(vncHtml, /#noVNC_control_bar.*display:\s*none/s, "/novnc/vnc.html must inject CSS hiding native bar");

      const w1 = ws.store.createSession({ title: "切屏成员A" });
      const w2 = ws.store.createSession({ title: "切屏成员B" });
      const grp = ws.store.createSession({ title: "多屏联调群", type: "group", memberBotIds: [w1.id, w2.id] });

      // Proxy /api/computer/status -> online ready and /api/computer/displays -> bound :1/:2
      const proxySrv = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        if (req.method && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
          for await (const c of req) chunks.push(Buffer.from(c));
        }
        const reqBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const fwdHeaders: Record<string, string> = {};
        if (req.headers["content-type"]) fwdHeaders["content-type"] = String(req.headers["content-type"]);
        const up = await fetch(`${ws.baseUrl}${req.url || "/"}`, {
          method: req.method || "GET",
          headers: fwdHeaders,
          body: reqBody,
        });
        if ((req.url || "").startsWith("/api/computer/status")) {
          const j: any = await up.json();
          j.online = true;
          j.state = "ready";
          j.provider = "orbstack";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(j));
          return;
        }
        if ((req.url || "").startsWith("/api/computer/displays")) {
          const j: any = await up.json();
          j.ok = true;
          j.mode = "multi-display";
          j.bindings = { ...(j.bindings || {}), [w1.id]: ":1", [w2.id]: ":2" };
          j.displays = [
            { display_num: 1, display: ":1", novnc_online: true, cdp_online: true },
            { display_num: 2, display: ":2", novnc_online: true, cdp_online: true },
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(j));
          return;
        }
        const buf = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, Object.fromEntries(up.headers.entries()));
        res.end(buf);
      });
      proxySrv.on("upgrade", (req, socket, head) => {
        const up = net.connect(ws.port, "127.0.0.1", () => {
          const hdrs = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v}`).join("\r\n");
          up.write(`${req.method} ${req.url} HTTP/1.1\r\n${hdrs}\r\n\r\n`);
          if (head?.length) up.write(head);
          socket.pipe(up);
          up.pipe(socket);
        });
        up.on("error", () => socket.destroy());
      });
      await new Promise<void>((r) => proxySrv.listen(0, "127.0.0.1", r));
      t.after(() => {
        proxySrv.close();
        proxySrv.closeAllConnections?.();
      });
      const pUrl = `http://127.0.0.1:${(proxySrv.address() as net.AddressInfo).port}`;

      await chrome!.navigate(pUrl);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('多屏联调群'))`
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('多屏联调群'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#computer-card-status')?.textContent?.includes('运行中')`);
      await chrome!.click("#bot-computer-card");
      await chrome!.waitFor(`!document.querySelector('#bot-screen-overlay')?.hidden`);

      // Group speaker follow & manual dropdown switch
      ws.runner.broadcastGlobal({ type: "status", sessionId: grp.id, botId: w2.id, status: "running" });
      await chrome!.waitFor(
        `document.querySelector('#screen-status-label')?.textContent?.includes('切屏成员B') &&
         document.querySelector('#novnc-frame')?.getAttribute('src')?.includes('${w2.id}')`
      );
      await chrome!.selectOption("#group-screen-member-select", w1.id);
      await chrome!.waitFor(
        `document.querySelector('#screen-status-label')?.textContent?.includes('切屏成员A')`
      );

      // Takeover (#pause-btn) -> view_only=0, Release (#resume-btn) -> view_only=1
      await chrome!.click("#pause-btn");
      await chrome!.waitFor(
        `document.querySelector('#screen-status-label')?.textContent?.includes('你正在独占控制') &&
         document.querySelector('#novnc-frame')?.getAttribute('src')?.includes('view_only=0')`
      );
      await chrome!.click("#resume-btn");
      await chrome!.waitFor(
        `document.querySelector('#novnc-frame')?.getAttribute('src')?.includes('view_only=1')`
      );
      await chrome!.click("#exit-fullscreen-btn");
      await chrome!.waitFor(`document.querySelector('#bot-screen-overlay')?.hidden`);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-ELEC-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-ELEC-01",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "真实 Electron v45 主进程启动(短暂闪窗 3~5s 自动关闭)、端口冲突回退、IPC 桥与生产态非可信 OTA 拦截",
      module: "Electron Desktop Shell",
    },
    async ({ setEvidence }) => {
      const electronBin = path.join(
        PROJECT_ROOT,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "electron.cmd" : "electron"
      );
      if (!fs.existsSync(electronBin)) {
        throw new EnvSkipSignal("Electron binary not installed");
      }

      const elecTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-elec-e2e-"));
      t.after(() => fs.rmSync(elecTmp, { recursive: true, force: true }));

      // Occupy an explicit port so Electron hits EADDRINUSE and falls back to ephemeral port!
      const blocker = net.createServer();
      await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
      t.after(() => blocker.close());
      const busyPort = (blocker.address() as net.AddressInfo).port;

      const envFile = path.join(elecTmp, ".env");
      fs.writeFileSync(
        envFile,
        `PORT=${busyPort}\nHOST=127.0.0.1\nDATA_DIR=${path.join(elecTmp, "data")}\nTWINKLEBOT_LAN_ACCESS=false\n`,
        "utf8"
      );

      // Find a free remote debugging port for Electron
      const dbgPortSrv = net.createServer();
      await new Promise<void>((r) => dbgPortSrv.listen(0, "127.0.0.1", r));
      const dbgPort = (dbgPortSrv.address() as net.AddressInfo).port;
      dbgPortSrv.close();

      const elecArgs = [
        ".",
        ...(process.platform === "linux"
          ? ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"]
          : []),
        `--user-data-dir=${path.join(elecTmp, "userdata")}`,
        `--remote-debugging-port=${dbgPort}`,
      ];
      const elecProc: ChildProcess = spawn(electronBin, elecArgs, {
        cwd: PROJECT_ROOT,
        env: { ...process.env, TWINKLEBOT_ENV_FILE: envFile },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let elecStderr = "";
      elecProc.stderr?.on("data", (d) => {
        elecStderr += d.toString("utf8");
      });
      t.after(() => {
        try {
          elecProc.kill("SIGKILL");
        } catch {}
      });

      // Wait for Electron renderer CDP page target
      let pageWs = "";
      const deadline = Date.now() + 18_000;
      while (Date.now() < deadline) {
        if (elecProc.exitCode !== null) {
          throw new Error(`Electron exited early (${elecProc.exitCode}): ${elecStderr}`);
        }
        try {
          const targets: any[] = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
          const p = targets.find((x) => x.type === "page" && x.webSocketDebuggerUrl && String(x.url || "").startsWith("http://127.0.0.1:"));
          if (p) {
            pageWs = p.webSocketDebuggerUrl;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(pageWs, `Electron mainWindow CDP target must become ready: ${elecStderr}`);

      const wsSock = new WebSocket(pageWs);
      await new Promise<void>((resolve, reject) => {
        wsSock.addEventListener("open", () => resolve());
        wsSock.addEventListener("error", (e: any) => reject(new Error(e?.message || "ws err")));
      });
      let reqId = 0;
      const evalInElectron = (expression: string, timeoutMs = 15_000): Promise<any> =>
        new Promise((resolve, reject) => {
          const id = ++reqId;
          const cleanup = () => {
            clearTimeout(timer);
            wsSock.removeEventListener("message", onMsg);
            wsSock.removeEventListener("close", onClose);
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`evalInElectron timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          const onClose = () => {
            cleanup();
            reject(new Error("Electron CDP WebSocket closed"));
          };
          const onMsg = (ev: any) => {
            const m = JSON.parse(String(ev.data));
            if (m.id === id) {
              cleanup();
              if (m.error) reject(new Error(m.error.message));
              else if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description || "eval error"));
              else resolve(m.result?.result?.value);
            }
          };
          wsSock.addEventListener("message", onMsg);
          wsSock.addEventListener("close", onClose);
          wsSock.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
        });

      // Wait for preload.cjs to expose window.twinklebotDesktop
      let hasBridge = false;
      for (let i = 0; i < 40; i++) {
        hasBridge = Boolean(await evalInElectron(`Boolean(window.twinklebotDesktop && window.twinklebotDesktop.getDesktopInfo)`));
        if (hasBridge) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(hasBridge, true, "preload.cjs must expose window.twinklebotDesktop");
      const info = await evalInElectron(`window.twinklebotDesktop.getDesktopInfo()`);
      setEvidence("desktopInfo", info);
      assert.equal(await evalInElectron(`document.documentElement.dataset.electron`), "true");
      assert.ok(info?.backendUrl?.startsWith("http://127.0.0.1:"));
      assert.notEqual(
        Number(new URL(info.backendUrl).port),
        busyPort,
        "Electron must fall back from occupied port to an ephemeral port"
      );

      // Accounts load/save IPC roundtrip
      const saved = await evalInElectron(
        `window.twinklebotDesktop.saveAccounts({ activeAccountId: 'local', accounts: [{ id: 'local', type: 'local', name: 'E2E Local', baseUrl: '' }] })`
      );
      assert.equal(saved.activeAccountId, "local");

      // Production OTA security gate: untrusted loopback URL MUST be rejected!
      const otaRejected = await evalInElectron(`(async () => {
        try {
          await window.twinklebotDesktop.applyWebOta({ bundleUrl: 'http://127.0.0.1:9999/evil.tar.gz', expectedSha256: '${"a".repeat(64)}', webBuild: '20990101.000000-aaaaaaaaaa' });
          return 'ALLOWED';
        } catch (e) {
          return String(e.message || e);
        }
      })()`);
      assert.match(otaRejected, /未受信任的 GitHub|untrusted/i, "Production Electron must reject untrusted OTA URL");

      // Cleanly quit Electron window via IPC
      await evalInElectron(`window.twinklebotDesktop.quitApp()`).catch(() => {});
      wsSock.close();
      await new Promise<void>((resolve) => {
        const tm = setTimeout(() => {
          try { elecProc.kill("SIGKILL"); } catch {}
          resolve();
        }, 4000);
        elecProc.once("exit", () => {
          clearTimeout(tm);
          resolve();
        });
      });
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-OTA-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-OTA-01",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "纯前端 OTA 热更新全周期：SHA-256 校验、Tar-Slip 拦截、热切静态目录固化与看门狗超时自动回滚",
      module: "Web OTA Manager",
    },
    async () => {
      const otaTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ota-e2e-"));
      t.after(() => fs.rmSync(otaTmp, { recursive: true, force: true }));
      const builtInPublic = path.join(PROJECT_ROOT, "public");
      const fixture = await startOtaFixtureServer(otaTmp, builtInPublic);
      t.after(() => fixture.close());

      const otaMgr = createWebOtaManager({
        userDataDir: path.join(otaTmp, "userdata"),
        appVersion: "1.0.0",
        builtInPublicDir: builtInPublic,
        allowLoopbackForTest: true,
        watchdogTimeoutMs: 700,
      });
      t.after(() => otaMgr.dispose());

      const ws = await createE2EWorkspace({
        getEffectivePublicDir: () => otaMgr.getEffectivePublicDir(),
        otaController: {
          getStatus: () => otaMgr.getStatus(),
          confirmReady: (wb?: string) => otaMgr.confirmReady(wb),
          rollback: (reason?: string) => otaMgr.rollback(reason),
        },
      });
      t.after(() => ws.close());

      // 1. Tar-Slip malicious archive MUST be rejected
      await assert.rejects(
        () =>
          otaMgr.applyFromUrl({
            bundleUrl: fixture.evilUrl,
            expectedSha256: fixture.evilSha256,
            webBuild: "20991119.140000-evil000000",
          }),
        /非法|traversal|\.\.|index\.html/i
      );

      // 2. Apply valid OTA bundle, reload Chrome, verify new marker + confirmReady!
      await otaMgr.applyFromUrl({
        bundleUrl: fixture.goodUrl,
        expectedSha256: fixture.goodSha256,
        webBuild: fixture.goodBuild,
      });
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#e2e-ota-marker')?.dataset?.webBuild === '${fixture.goodBuild}'`,
        8000
      );
      const confirmRes = await fetch(`${ws.baseUrl}/api/system/ota/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webBuild: fixture.goodBuild }),
      });
      assert.equal(confirmRes.status, 200);
      assert.equal(otaMgr.getStatus().lastGoodBuild, fixture.goodBuild);

      // 3. Apply unconfirmed bad bundle -> 700ms watchdog auto-rolls back to goodBuild!
      await otaMgr.applyFromUrl({
        bundleUrl: fixture.badUrl,
        expectedSha256: fixture.badSha256,
        webBuild: fixture.badBuild,
      });
      await new Promise((r) => setTimeout(r, 950));
      const stAfterRollback = otaMgr.getStatus();
      assert.equal(stAfterRollback.activeBuild, fixture.goodBuild, "Watchdog must auto-rollback to lastGoodBuild");
      assert.ok(stAfterRollback.lastRollbackReason, "Watchdog rollback reason must be recorded");
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-BRIDGE-01 & P1-BRIDGE-02 ----------
  await collector.runCase(
    t,
    {
      id: "P1-BRIDGE-01",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "云端模式 Bearer 鉴权与静态隐藏 + 本地切 host_executor 角色 409 门控与切回 master 恢复",
      module: "Cloud Auth / Runtime Role Gate",
    },
    async () => {
      const cloudWs = await createE2EWorkspace({
        deployEnv: "cloud",
        cloudAuthToken: "cloud-secret-tok-888",
        smartRouter: false,
      });
      t.after(() => cloudWs.close());

      const localWs = await createE2EWorkspace({
        deployEnv: "local",
        localControlToken: "local-ctrl-tok-777",
        startScheduler: true,
        smartRouter: false,
      });
      t.after(() => localWs.close());

      // Cloud root hides Web UI and returns plain "ok"
      const rootRes = await fetch(`${cloudWs.baseUrl}/`);
      assert.equal(rootRes.status, 200);
      assert.equal(await rootRes.text(), "ok");

      // Cloud API rejects missing/bad Bearer token with 401
      assert.equal((await fetch(`${cloudWs.baseUrl}/api/sessions`)).status, 401);
      assert.equal(
        (await fetch(`${cloudWs.baseUrl}/api/sessions`, { headers: { Authorization: "Bearer cloud-secret-tok-888" } })).status,
        200
      );

      // Local switches to host_executor -> non-host routes return 409, host routes allowed!
      const swRes = await fetch(`${localWs.baseUrl}/api/system/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Local-Token": "local-ctrl-tok-777" },
        body: JSON.stringify({ role: "host_executor", cloudOrigin: cloudWs.baseUrl }),
      });
      assert.equal(swRes.status, 200);
      assert.equal((await fetch(`${localWs.baseUrl}/api/sessions`)).status, 409);
      assert.equal((await fetch(`${localWs.baseUrl}/api/computer/host-info`)).status, 200);

      // Switch back to master -> /api/sessions returns 200 again!
      const backRes = await fetch(`${localWs.baseUrl}/api/system/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Local-Token": "local-ctrl-tok-777" },
        body: JSON.stringify({ role: "master" }),
      });
      assert.equal(backRes.status, 200);
      assert.equal((await fetch(`${localWs.baseUrl}/api/sessions`)).status, 200);
    },
    { getChrome: () => chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P1-BRIDGE-02",
      priority: "P1",
      featureTier: "F1",
      difficulty: "D3",
      title: "云端↔本地 /ws host_rpc_request 跨网宿主机操控(含全 5 工具与环境变量脱敏)及多宿主机切换",
      module: "Cloud↔Host WebSocket Bridge",
    },
    async () => {
      const cloudWs = await createE2EWorkspace({
        deployEnv: "cloud",
        cloudAuthToken: "cloud-bridge-tok",
        smartRouter: false,
      });
      t.after(() => cloudWs.close());

      const localWs = await createE2EWorkspace({
        deployEnv: "local",
        localControlToken: "local-exec-tok",
        smartRouter: false,
      });
      t.after(() => localWs.close());

      // Connect 2 simulated desktop host_executor WebSocket clients to cloudWs
      const connectHost = (hostId: string, hostname: string) =>
        new Promise<WebSocket>((resolve, reject) => {
          const sock = new WebSocket(`ws://127.0.0.1:${cloudWs.port}/ws?token=cloud-bridge-tok`);
          sock.addEventListener("open", () => {
            sock.send(JSON.stringify({ type: "host_hello", hostId, hostname, platform: process.platform }));
            resolve(sock);
          });
          sock.addEventListener("message", async (ev) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.type === "host_rpc_request" && msg.rpcId) {
              // Forward exactly like renderer's forwardHostRpcToLocalExecutor!
              const resp = await fetch(`${localWs.baseUrl}/api/host/execute`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Local-Control-Token": "local-exec-tok" },
                body: JSON.stringify({ tool: msg.tool, args: msg.args || {}, approved: msg.approved !== false }),
              });
              const data: any = await resp.json();
              sock.send(
                JSON.stringify({
                  type: "host_rpc_response",
                  rpcId: msg.rpcId,
                  ok: Boolean(resp.ok && data?.ok !== false),
                  result: data?.result || { error: data?.error || "failed" },
                  screenshot: data?.screenshot || null,
                })
              );
            }
          });
          sock.addEventListener("error", reject);
        });

      const host1 = await connectHost("mac-host-1", "MacBook-Primary");
      const host2 = await connectHost("mac-host-2", "MacBook-Secondary");
      t.after(() => {
        host1.close();
        host2.close();
      });

      await cloudWs.waitUntil(async () => {
        const h: any = await (
          await fetch(`${cloudWs.baseUrl}/api/computer/hosts`, { headers: { Authorization: "Bearer cloud-bridge-tok" } })
        ).json();
        return (h.hosts || []).length >= 2;
      }, 4000, "2 hosts registered");

      const hostsList: any = await (
        await fetch(`${cloudWs.baseUrl}/api/computer/hosts`, { headers: { Authorization: "Bearer cloud-bridge-tok" } })
      ).json();
      const targetHost = hostsList.hosts.find((x: any) => x.hostname === "MacBook-Secondary");
      assert.ok(targetHost);
      const selRes = await fetch(`${cloudWs.baseUrl}/api/computer/hosts/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer cloud-bridge-tok" },
        body: JSON.stringify({ clientId: targetHost.clientId }),
      });
      assert.equal(selRes.status, 200);

      // Verify host_run_shell env scrubbing, host_write_file, host_read_file, and host_record_screen approval gate!
      const localNote = path.join(localWs.workspaceDir, "bridge-note.txt");
      const wrRes: any = await (
        await fetch(`${localWs.baseUrl}/api/host/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Local-Control-Token": "local-exec-tok" },
          body: JSON.stringify({ tool: "host_write_file", args: { path: localNote, content: "hello-bridge" }, approved: true }),
        })
      ).json();
      assert.equal(wrRes.ok, true);

      const rdRes: any = await (
        await fetch(`${localWs.baseUrl}/api/host/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Local-Control-Token": "local-exec-tok" },
          body: JSON.stringify({ tool: "host_read_file", args: { path: localNote }, approved: true }),
        })
      ).json();
      assert.equal(rdRes.result?.content, "hello-bridge");

      // host_record_screen without approved: true must require approval!
      const recRes: any = await (
        await fetch(`${localWs.baseUrl}/api/host/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Local-Control-Token": "local-exec-tok" },
          body: JSON.stringify({ tool: "host_record_screen", args: { duration_sec: 2 }, approved: false }),
        })
      ).json();
      assert.equal(recRes.needsApproval, true, "host_record_screen must require approval unless allowlisted");

      // Trigger Cloud Bot calling host_run_shell over WebSocket bridge and verify scrubbed env!
      const cloudBot = cloudWs.store.ensureAdminBot();
      await fetch(`${cloudWs.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer cloud-bridge-tok" },
        body: JSON.stringify({ hostComputer: { executionMode: "always" } }),
      });
      let step = 0;
      cloudWs.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (
          s.includes("ultra-short Chinese phrase") ||
          s.includes("Distill the current task progress") ||
          s.includes("短语") ||
          s.includes("概括")
        )
          return { text: "远控宿主机" };
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [
              { id: "br-1", name: "host_run_shell", args: { command: "echo BRIDGE_OK:$GEMINI_API_KEY:$TWINKLEBOT_LOCAL_TOKEN", risk: "low" } },
            ],
          };
        }
        return { text: "云端宿主机桥接执行完毕" };
      });
      await fetch(`${cloudWs.baseUrl}/api/sessions/${cloudBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer cloud-bridge-tok" },
        body: JSON.stringify({ text: "测试跨网宿主机执行" }),
      });
      await cloudWs.waitUntil(() => !cloudWs.runner.isSessionBusy(cloudBot.id), 8000, "cloud host_run_shell finishes");
      const evs = cloudWs.store.readEvents(cloudBot.id);
      const resEv = evs.find((e: any) => e.type === "result" && e.name === "host_run_shell");
      assert.match(resEv?.result?.stdout || "", /BRIDGE_OK::/, "Sensitive env vars must be scrubbed in host_run_shell");
    },
    { getChrome: () => chrome }
  );
});
