import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutorClient } from "../src/agent/executor-client.js";
import { createRunner } from "../src/agent/runner.js";
import {
  clearEphemeralSecrets,
  registerEphemeralSecret,
  runTool,
} from "../src/agent/tools.js";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _UP_TWO = path.resolve(_HERE, "..", "..");
const PROJECT_ROOT =
  path.basename(_UP_TWO) === "dist-server" ? path.dirname(_UP_TWO) : _UP_TWO;

const EXECUTOR_TOKEN = "fullstack-exec-tok";

const PY_CDP_HARNESS = `
import base64, hashlib, http.server, json, os, struct, sys, threading, urllib.parse
sys.path.insert(0, sys.argv[1])
import executor as ex

PROFILE_DIR = sys.argv[2]
MAP_PATH = sys.argv[3]
TOKEN = sys.argv[4]
os.makedirs(PROFILE_DIR, exist_ok=True)

CDP_STATE = {
    "tabs": [
        {
            "id": "TAB-1",
            "type": "page",
            "url": "about:blank",
            "title": "Initial Tab",
        }
    ],
    "seq": 1,
    "events": [],
    "activated": [],
    "lock": threading.RLock(),
}
CDP_PORT = 0

def _tab_payload(t):
    tid = t["id"]
    return {
        "id": tid,
        "type": "page",
        "url": t["url"],
        "title": t["title"],
        "webSocketDebuggerUrl": f"ws://127.0.0.1:{CDP_PORT}/devtools/page/{tid}",
    }

class FakeCdpHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send_json(self, code, obj):
        b = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/json/new":
            start_url = urllib.parse.unquote(parsed.query or "about:blank")
            with CDP_STATE["lock"]:
                CDP_STATE["seq"] += 1
                tid = f"TAB-{CDP_STATE['seq']}"
                t = {"id": tid, "type": "page", "url": start_url, "title": f"Tab {tid}"}
                CDP_STATE["tabs"].append(t)
                CDP_STATE["events"].append({"method": "Target.createTarget", "target_id": tid, "url": start_url})
                out = _tab_payload(t)
            self._send_json(200, out)
            return
        self._send_json(404, {"error": "not found"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if self.headers.get("Upgrade", "").lower() == "websocket":
            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.wfile.write((
                "HTTP/1.1 101 Switching Protocols\\r\\n"
                "Upgrade: websocket\\r\\n"
                "Connection: Upgrade\\r\\n"
                f"Sec-WebSocket-Accept: {accept}\\r\\n\\r\\n"
            ).encode("ascii"))
            self.wfile.flush()
            tid = parsed.path.rsplit("/", 1)[-1]
            sock = self.connection
            while True:
                hdr = sock.recv(2)
                if len(hdr) < 2:
                    break
                opcode = hdr[0] & 0x0F
                if opcode == 0x8:
                    break
                length = hdr[1] & 0x7F
                if length == 126:
                    (length,) = struct.unpack(">H", sock.recv(2))
                elif length == 127:
                    (length,) = struct.unpack(">Q", sock.recv(8))
                mask = sock.recv(4)
                raw = bytearray()
                while len(raw) < length:
                    chunk = sock.recv(length - len(raw))
                    if not chunk:
                        break
                    raw.extend(chunk)
                payload = bytes(b ^ mask[i & 3] for i, b in enumerate(raw))
                req = json.loads(payload.decode("utf-8"))
                method = req.get("method")
                params = req.get("params") or {}
                res = {}
                with CDP_STATE["lock"]:
                    CDP_STATE["events"].append({"method": method, "target_id": tid, "params": params})
                    if method == "Target.createTarget":
                        CDP_STATE["seq"] += 1
                        new_id = f"TAB-{CDP_STATE['seq']}"
                        t = {"id": new_id, "type": "page", "url": params.get("url", "about:blank"), "title": f"Tab {new_id}"}
                        CDP_STATE["tabs"].append(t)
                        res = {"targetId": new_id}
                    elif method == "Page.navigate":
                        for t in CDP_STATE["tabs"]:
                            if t["id"] == tid:
                                t["url"] = params.get("url", t["url"])
                        res = {"frameId": "F1"}
                    elif method == "Runtime.evaluate":
                        expr = params.get("expression", "")
                        cur_url = next((t["url"] for t in CDP_STATE["tabs"] if t["id"] == tid), "about:blank")
                        if "document.readyState" in expr:
                            res = {"result": {"value": "complete"}}
                        elif "getBoundingClientRect" in expr:
                            res = {"result": {"value": {"ok": True, "visible": True, "x": 120, "y": 160, "tag": "input", "name": "Password"}}}
                        elif "collectGbSnapshot" in expr:
                            res = {"result": {"value": {
                                "ok": True,
                                "url": cur_url,
                                "title": f"Mock:{tid}",
                                "element_count": 1,
                                "elements": [{"ref": "e1", "tag": "input", "role": "password", "name": "Password"}],
                                "text_excerpt": f"TARGET:{tid} URL:{cur_url}",
                            }}}
                        else:
                            res = {"result": {"value": {"ok": True}}}
                reply = json.dumps({"id": req["id"], "result": res}).encode("utf-8")
                frame = bytearray([0x81])
                if len(reply) < 126:
                    frame.append(len(reply))
                elif len(reply) < 65536:
                    frame.append(126)
                    frame.extend(struct.pack(">H", len(reply)))
                else:
                    frame.append(127)
                    frame.extend(struct.pack(">Q", len(reply)))
                frame.extend(reply)
                sock.sendall(bytes(frame))
            return

        if parsed.path == "/json/version":
            self._send_json(200, {"Browser": "Chrome/157.0.0.0", "webSocketDebuggerUrl": f"ws://127.0.0.1:{CDP_PORT}/devtools/browser/MAIN"})
            return
        if parsed.path == "/json/list":
            with CDP_STATE["lock"]:
                out = [_tab_payload(t) for t in CDP_STATE["tabs"]]
            self._send_json(200, out)
            return
        if parsed.path.startswith("/json/activate/"):
            tid = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
            with CDP_STATE["lock"]:
                CDP_STATE["activated"].append(tid)
                CDP_STATE["events"].append({"method": "activate", "target_id": tid})
            self._send_json(200, {"ok": True})
            return
        if parsed.path.startswith("/json/close/"):
            tid = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
            with CDP_STATE["lock"]:
                CDP_STATE["tabs"] = [t for t in CDP_STATE["tabs"] if t["id"] != tid]
                CDP_STATE["events"].append({"method": "close", "target_id": tid})
            self._send_json(200, {"ok": True})
            return
        if parsed.path == "/__debug/state":
            with CDP_STATE["lock"]:
                self._send_json(200, {
                    "tabs": list(CDP_STATE["tabs"]),
                    "events": list(CDP_STATE["events"]),
                    "activated": list(CDP_STATE["activated"]),
                })
            return
        self._send_json(404, {"error": "not found"})

class FakeCdpServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

cdp_srv = FakeCdpServer(("127.0.0.1", 0), FakeCdpHandler)
CDP_PORT = cdp_srv.server_address[1]
threading.Thread(target=cdp_srv.serve_forever, daemon=True).start()

dm = ex.TabManager(
    map_path=MAP_PATH,
    primary_profile_dir=PROFILE_DIR,
    max_concurrent_screens=2,
    browser_idle_sec=300,
    browser_boot_timeout_sec=0.1,
    cdp_port=CDP_PORT,
    spawn_fn=lambda *a, **kw: type("P", (), {"pid": 43210})(),
    tcp_open_fn=lambda p: True,
)
actions = ex.Actions(cdp_port=CDP_PORT, profile_dir=PROFILE_DIR)
srv = ex.make_server(actions, TOKEN, host="127.0.0.1", port=0, display_manager=dm)
exec_port = srv.server_address[1]
print(json.dumps({"exec_port": exec_port, "cdp_port": CDP_PORT}), flush=True)
srv.serve_forever()
`;

function resolvePython3Binary(): string {
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (probe.status === 0 && /Python 3\./i.test(`${probe.stdout || ""}${probe.stderr || ""}`)) {
      return cmd;
    }
  }
  return "python3";
}

async function spawnRealPythonExecutorHarness(tmpDir: string): Promise<{
  execPort: number;
  cdpPort: number;
  profileDir: string;
  close: () => Promise<void>;
}> {
  const profileDir = path.join(tmpDir, "chrome-profile");
  const mapPath = path.join(tmpDir, "display-map.json");
  const executorDir = path.join(PROJECT_ROOT, "executor");

  const proc: ChildProcess = spawn(
    resolvePython3Binary(),
    ["-u", "-c", PY_CDP_HARNESS, executorDir, profileDir, mapPath, EXECUTOR_TOKEN],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const info = await new Promise<{ exec_port: number; cdp_port: number }>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Python executor harness boot timeout. stderr=${stderr}`));
    }, 10_000);
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
      reject(new Error(`Python executor exited early (${code}): ${stderr}`));
    });
  });

  return {
    execPort: info.exec_port,
    cdpPort: info.cdp_port,
    profileDir,
    close: async () => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    },
  };
}

test("Fullstack integration: Node Server/Runner/ScreenPool/WebSocket <-> Real Python executor.py", async (t) => {
  clearEphemeralSecrets();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-fullstack-"));
  t.after(() => {
    clearEphemeralSecrets();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pyExec = await spawnRealPythonExecutorHarness(tmpDir);
  t.after(() => pyExec.close());

  // Mock noVNC upstream server on a local ephemeral port
  const novncStreams: string[] = [];
  const novncUpstream = net.createServer((sock) => {
    sock.on("data", (buf) => {
      novncStreams.push(buf.toString("utf8"));
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nNOVNC_STREAM_OK");
      sock.end();
    });
  });
  await new Promise<void>((resolve) => novncUpstream.listen(0, "127.0.0.1", resolve));
  t.after(() => novncUpstream.close());
  const novncUpstreamPort = (novncUpstream.address() as net.AddressInfo).port;

  // Rewrite /displays/ensure or point novncProxyTarget at upstream while allowing dynamic port fallback
  // Note: Python returns novnc_port: 6080; we wrap executor.call only to remap novnc_port in test without altering Python behavior
  let browserGateResolvers: Array<() => void> = [];
  let holdBrowserSnapshots = false;

  const rawExecutor = createExecutorClient({
    url: `http://127.0.0.1:${pyExec.execPort}`,
    token: EXECUTOR_TOKEN,
  });
  const executor = {
    ...rawExecutor,
    call: async (route: string, body?: any, opts?: any) => {
      if (route === "/browser/snapshot" && holdBrowserSnapshots) {
        await new Promise<void>((resolve) => {
          browserGateResolvers.push(resolve);
        });
      }
      const res: any = await rawExecutor.call(route, body, opts);
      if (route === "/displays/ensure" && res && res.novnc_port === 6080) {
        return { ...res, novnc_port: novncUpstreamPort };
      }
      return res;
    },
  };

  const store = createStore(tmpDir);
  store.writeSettings({
    routing: { smartRouter: false },
    screenPool: { mode: "custom", maxConcurrentScreens: 2 },
  });

  const adminBot = store.createSession({ title: "Twinkle", isAdmin: true });
  const bots = Array.from({ length: 7 }, (_, i) =>
    store.createSession({ title: `Worker-${i + 1}`, isAdmin: false })
  );
  const groupSession = store.createSession({
    title: "联调协作群",
    type: "group",
    memberBotIds: [adminBot.id, bots[0].id],
  });

  const interceptedModelInputs: any[] = [];

  const model = {
    async nextTurn({ input }: any) {
      interceptedModelInputs.push(input);
      let lastUserIdx = -1;
      for (let i = input.length - 1; i >= 0; i -= 1) {
        if (input[i]?.type === "user_input" || input[i]?.type === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const tailSteps = lastUserIdx >= 0 ? input.slice(lastUserIdx + 1) : input;
      const hasResult = tailSteps.some((s: any) => s.type === "function_result");
      if (hasResult) {
        return {
          thoughts: [],
          text: "task-finished",
          calls: [],
          outputSteps: [{ type: "model_output", text: "task-finished" }],
        };
      }
      const promptText = String(
        (lastUserIdx >= 0 ? input[lastUserIdx]?.content?.[0]?.text : "") || ""
      );

      if (promptText.startsWith("BROWSER_WAIT:")) {
        return {
          thoughts: [],
          text: "",
          calls: [
            {
              id: "c-snap",
              name: "browser_snapshot",
              args: { url: "https://example.test/page", risk: "low" },
            },
          ],
          outputSteps: [
            {
              type: "function_call",
              id: "c-snap",
              name: "browser_snapshot",
              arguments: { url: "https://example.test/page", risk: "low" },
            },
          ],
        };
      }

      if (promptText.startsWith("SECRET_TYPE:")) {
        const ref = promptText.slice("SECRET_TYPE:".length).trim();
        return {
          thoughts: [],
          text: "",
          calls: [
            {
              id: "c-type",
              name: "browser_type",
              args: { ref: "e1", text: ref, submit: false, clear: true, risk: "low" },
            },
          ],
          outputSteps: [
            {
              type: "function_call",
              id: "c-type",
              name: "browser_type",
              arguments: { ref: "e1", text: ref, submit: false, clear: true, risk: "low" },
            },
          ],
        };
      }

      if (promptText.startsWith("CLI_FAST:")) {
        return {
          thoughts: [],
          text: "",
          calls: [{ id: "c-sh", name: "run_shell", args: { command: "echo CLI_INTEGRATION_OK", risk: "low" } }],
          outputSteps: [
            {
              type: "function_call",
              id: "c-sh",
              name: "run_shell",
              arguments: { command: "echo CLI_INTEGRATION_OK", risk: "low" },
            },
          ],
        };
      }

      return {
        thoughts: [],
        text: "plain-chat-ok",
        calls: [],
        outputSteps: [{ type: "model_output", text: "plain-chat-ok" }],
      };
    },
  };

  const config = {
    deployEnv: "local",
    host: "127.0.0.1",
    port: 0,
    geminiApiKey: "fake-key",
    models: ["gemini-4-hydrogen"],
    defaultModel: "gemini-4-hydrogen",
    maxSteps: 6,
    settleMs: 0,
    executorUrl: `http://127.0.0.1:${pyExec.execPort}`,
    executorToken: EXECUTOR_TOKEN,
    novncUrl: `http://127.0.0.1:${novncUpstreamPort}/vnc.html`,
    novncProxyTarget: `http://127.0.0.1:${novncUpstreamPort}`,
    screen: { width: 1440, height: 900 },
    writeRoots: [tmpDir],
    dataDir: tmpDir,
  };

  const runner = createRunner({ store, config, model, executor });
  const server = createServer({ store, config, runner, executor, model });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const basePort = (server.address() as net.AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${basePort}`;

  // Subscribe to real WebSocket /ws broadcasts
  const wsEvents: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${basePort}/ws`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("/ws connect timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("message", (ev) => {
      try {
        wsEvents.push(JSON.parse(String(ev.data)));
      } catch {}
    });
  });
  t.after(() => ws.close());

  // ---------- INT-1 & INT-2: Screen Pool FIFO queue, CLI non-blocking & live limit raise ----------
  holdBrowserSnapshots = true;
  for (const botId of [adminBot.id, bots[0].id, bots[1].id, bots[2].id]) {
    const postRes = await fetch(`${baseUrl}/api/sessions/${botId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `BROWSER_WAIT:${botId}` }),
    });
    assert.equal(postRes.status, 202);
  }

  // Wait until 2 tasks hold leases (blocked in model.nextTurn) and 2 are queued in waiting_screen
  const waitUntil = async (fn: () => boolean, msg: string) => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for: ${msg}`);
  };

  await waitUntil(
    () =>
      runner.getScreenPoolStats().activeCount === 2 &&
      runner.getScreenPoolStats().queuedCount === 2,
    "pool active=2 and queued=2"
  );
  assert.ok(
    wsEvents.some((e) => e.type === "status" && e.status === "waiting_screen"),
    "/ws must broadcast waiting_screen status"
  );

  // While 2 screen slots are 100% occupied, 3 CLI Bots must finish immediately without queueing!
  for (const cliBotId of [bots[3].id, bots[4].id, bots[5].id]) {
    const r = await fetch(`${baseUrl}/api/sessions/${cliBotId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `CLI_FAST:${cliBotId}` }),
    });
    assert.equal(r.status, 202);
  }
  await waitUntil(
    () => ![bots[3].id, bots[4].id, bots[5].id].some((id) => runner.isSessionBusy(id)),
    "3 CLI bots finish while screen pool full"
  );

  // Release the 2 held browser tasks -> INT-2: ALSO test live limit increase on next batch!
  holdBrowserSnapshots = false;
  await waitUntil(() => {
    while (browserGateResolvers.length > 0) browserGateResolvers.shift()!();
    return ![adminBot.id, bots[0].id, bots[1].id, bots[2].id].some((id) => runner.isSessionBusy(id));
  }, "all 4 browser bots finish via real Python executor.py");

  // Verify GET /api/computer/displays returns live Python TabManager bindings & pool stats
  const dispRes = await fetch(`${baseUrl}/api/computer/displays`);
  const dispJson: any = await dispRes.json();
  assert.equal(dispJson.ok, true);
  assert.equal(dispJson.mode, "shared-profile-multi-tab");
  assert.equal(dispJson.pool.maxConcurrentScreens, 2);
  assert.ok(Object.keys(dispJson.bindings || {}).length >= 1);

  const curSettings: any = await (await fetch(`${baseUrl}/api/settings`)).json();
  const initialLimit = Math.min(2, curSettings.screenPool.budget.max - 1);
  const expandedLimit = Math.min(4, curSettings.screenPool.budget.max);
  assert.ok(expandedLimit > initialLimit);
  await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenPool: { mode: "custom", maxConcurrentScreens: initialLimit } }),
  });

  // Now hold `initialLimit` slots and queue remaining, then dynamically raise limit -> expandedLimit!
  holdBrowserSnapshots = true;
  browserGateResolvers = [];
  const expandBatchIds = [adminBot.id, bots[0].id, bots[1].id, bots[2].id].slice(0, expandedLimit);
  for (const botId of expandBatchIds) {
    await fetch(`${baseUrl}/api/sessions/${botId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `BROWSER_WAIT:${botId}` }),
    });
  }
  await waitUntil(
    () =>
      runner.getScreenPoolStats().activeCount === initialLimit &&
      runner.getScreenPoolStats().queuedCount === expandedLimit - initialLimit,
    "2nd batch queued before limit increase"
  );

  const upSettingsRes = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenPool: { mode: "custom", maxConcurrentScreens: expandedLimit } }),
  });
  assert.equal(upSettingsRes.status, 200);

  await waitUntil(
    () =>
      runner.getScreenPoolStats().activeCount === expandedLimit &&
      runner.getScreenPoolStats().queuedCount === 0,
    "raising limit wakes queued Bots immediately"
  );
  holdBrowserSnapshots = false;
  await waitUntil(() => {
    while (browserGateResolvers.length > 0) browserGateResolvers.shift()!();
    return !expandBatchIds.some((id) => runner.isSessionBusy(id));
  }, "all active bots drain after limit increase");

  // Verify Python TabManager synced expandedLimit
  const dispAfterUp: any = await (await fetch(`${baseUrl}/api/computer/displays`)).json();
  assert.equal(dispAfterUp.max_concurrent_screens, expandedLimit);

  // ---------- INT-3: End-to-end secret_ref injection without plaintext leakage ----------
  const secretRef = registerEphemeralSecret("TopSecret!@#888");
  await fetch(`${baseUrl}/api/sessions/${adminBot.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `SECRET_TYPE:${secretRef}` }),
  });
  await waitUntil(() => !runner.isSessionBusy(adminBot.id), "secret browser_type finishes");

  const cdpDebug: any = await (await fetch(`http://127.0.0.1:${pyExec.cdpPort}/__debug/state`)).json();
  const insertTexts = (cdpDebug.events || []).filter(
    (e: any) => e.method === "Input.insertText" && e.params?.text === "TopSecret!@#888"
  );
  assert.ok(insertTexts.length >= 1, "Python Chrome CDP must receive resolved secret text");

  const rawEventsFile = fs.readFileSync(
    path.join(tmpDir, "sessions", `${adminBot.id}.ndjson`),
    "utf8"
  );
  const rawHistoryFile = fs.readFileSync(
    path.join(tmpDir, "sessions", `${adminBot.id}.history.json`),
    "utf8"
  );
  assert.ok(!rawEventsFile.includes("TopSecret!@#888"), "session ndjson must never leak plaintext secret");
  assert.ok(!rawHistoryFile.includes("TopSecret!@#888"), "history.json must never leak plaintext secret");
  assert.ok(rawEventsFile.includes(secretRef), "session ndjson retains opaque secret_ref placeholder");

  // Passing secret_ref into run_shell must be refused before reaching Python executor
  const blockedShell = await runTool("run_shell", { command: `echo ${secretRef}` }, executor, {
    settleMs: 0,
  });
  assert.match(blockedShell.result?.error || "", /Refusing to inject credential secret_ref/);

  // ---------- INT-4: Real /novnc/websockify proxy activates target Bot tab in Python ----------
  const prevActivatedCount = (cdpDebug.activated || []).length;
  await new Promise<void>((resolve, reject) => {
    const reqSock = net.connect(basePort, "127.0.0.1", () => {
      reqSock.write(
        `GET /novnc/websockify?sessionId=${encodeURIComponent(groupSession.id)}&botId=${encodeURIComponent(bots[0].id)} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${basePort}\r\n` +
          `Connection: Upgrade\r\n` +
          `Upgrade: websocket\r\n\r\n`
      );
    });
    let received = "";
    reqSock.on("data", (d) => {
      received += d.toString("utf8");
      if (received.includes("NOVNC_STREAM_OK")) {
        reqSock.destroy();
        resolve();
      }
    });
    reqSock.on("error", reject);
  });
  const cdpAfterVnc: any = await (await fetch(`http://127.0.0.1:${pyExec.cdpPort}/__debug/state`)).json();
  assert.ok(
    (cdpAfterVnc.activated || []).length > prevActivatedCount,
    "/novnc/websockify upgrade must invoke Python /displays/ensure and activate target Bot tab"
  );

  // ---------- INT-5: DELETE /api/sessions/:id releases Bot tab in Python while preserving Primary Profile ----------
  const delRes = await fetch(`${baseUrl}/api/sessions/${bots[0].id}`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  await new Promise((r) => setTimeout(r, 80));
  const dispAfterDel: any = await (await fetch(`${baseUrl}/api/computer/displays`)).json();
  assert.equal(dispAfterDel.bindings?.[bots[0].id], undefined, "deleted Bot tab must be unbound");
  assert.ok(fs.existsSync(pyExec.profileDir), "shared Primary Profile directory must never be deleted");

  // ---------- INT-6: Interleaved thought + orphaned calls history is sanitized before model.nextTurn ----------
  const dirtyBot = bots[6];
  store.saveHistory(dirtyBot.id, [
    { type: "user_input", content: [{ type: "text", text: "previous step" }] },
    { type: "thought", text: "orphaned reasoning" },
    { type: "function_call", id: "orphan-call-99", name: "run_shell", arguments: { command: "pwd" } },
    { type: "function_result", call_id: "stale-unmatched", name: "run_shell", output: { exit_code: 0 } },
  ]);
  const prevLen = interceptedModelInputs.length;
  await fetch(`${baseUrl}/api/sessions/${dirtyBot.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `CLI_FAST:recover` }),
  });
  await waitUntil(() => !runner.isSessionBusy(dirtyBot.id), "dirty history recovery turn completes");

  const firstRecoveryInput = interceptedModelInputs[prevLen];
  assert.ok(Array.isArray(firstRecoveryInput));
  assert.ok(
    !firstRecoveryInput.some(
      (s: any) =>
        (s.type === "function_call" && s.id === "orphan-call-99") ||
        (s.type === "function_result" && s.call_id === "stale-unmatched")
    ),
    "interleaved orphaned calls and unmatched results must be stripped before reaching model.nextTurn"
  );
});
