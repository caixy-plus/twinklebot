import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMPUTER_STATES,
  createLocalAwareExecutorClient,
  ensureLocalWslExecutorAwake,
  probeBotComputerState,
  provisionBotComputer,
} from "../src/lib/bot-computer-provisioner.js";
import {
  buildWslProvisionScript,
  classifyWslInstallFailure,
  parseWindowsProxyHint,
  parseWslDistroList,
  pickWslUbuntuDistro,
  windowsPathToWsl,
} from "../src/lib/wsl-ubuntu.js";
import { runBotCollabTool, BOT_COLLAB_TOOL_DECLARATIONS } from "../src/agent/bot-tools.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { createStore } from "../src/store/index.js";

test("probeBotComputerState resolves cloud, linux, macOS orbstack, and windows wsl states", async () => {
  assert.deepEqual(COMPUTER_STATES, [
    "uncreated",
    "creating",
    "ready",
    "unsupported",
    "error",
  ]);

  const cloud = await probeBotComputerState({ deployEnv: "cloud" });
  assert.equal(cloud.state, "ready");
  assert.equal(cloud.provider, "cloud-linux");
  assert.equal(cloud.online, true);

  const linux = await probeBotComputerState({
    deployEnv: "local",
    platform: "linux",
  });
  assert.equal(linux.state, "unsupported");
  assert.equal(linux.provider, "unsupported");
  assert.equal(linux.online, false);

  const macUncreated = await probeBotComputerState({
    deployEnv: "local",
    platform: "darwin",
    executor: { health: async () => { throw new Error("ECONNREFUSED"); } },
    execFileFn: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(macUncreated.state, "uncreated");
  assert.equal(macUncreated.provider, "orbstack");
  assert.equal(macUncreated.online, false);

  const macReady = await probeBotComputerState({
    deployEnv: "local",
    platform: "darwin",
    executor: { health: async () => ({ ok: true, screen: { width: 1440, height: 900 } }) },
    execFileFn: async () => ({ stdout: "ubuntu  running\n", stderr: "" }),
  });
  assert.equal(macReady.state, "ready");
  assert.equal(macReady.online, true);

  const macSleeping = await probeBotComputerState({
    deployEnv: "local",
    platform: "darwin",
    executor: { health: async () => { throw new Error("ECONNREFUSED"); } },
    execFileFn: async () => ({ stdout: "ubuntu  stopped  ubuntu  plucky  arm64\n", stderr: "" }),
  });
  assert.equal(macSleeping.state, "ready");
  assert.equal(macSleeping.online, false);
  assert.equal((macSleeping as any).vmInstalled, true);

  const winUncreated = await probeBotComputerState({
    deployEnv: "local",
    platform: "win32",
    executor: { health: async () => { throw new Error("ECONNREFUSED"); } },
    execFileFn: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(winUncreated.state, "uncreated");
  assert.equal(winUncreated.provider, "wsl");
});

test("provisionBotComputer runs platform setup, verifies executor health, and persists ready state", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-prov-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);

  const commands: any[] = [];
  let healthCalls = 0;
  const res = await provisionBotComputer({
    deployEnv: "local",
    platform: "darwin",
    projectRoot: tmpDir,
    store,
    executor: {
      health: async () => {
        healthCalls += 1;
        return { ok: true, screen: { width: 1440, height: 900 } };
      },
    },
    execFileFn: async (cmd, args) => {
      commands.push({ cmd, args });
      if (cmd === "orb" && args[0] === "list") {
        return { stdout: "ubuntu\n", stderr: "" };
      }
      return { stdout: "ok", stderr: "" };
    },
    retryDelayMs: 5,
  });

  assert.equal(res.ok, true);
  assert.equal(res.state, "ready");
  assert.equal(res.provider, "orbstack");
  assert.ok(healthCalls >= 1);
  assert.ok(commands.some((c) => c.cmd === "orb"));
  assert.equal(store.readSettings().botComputer?.state, "ready");
});

test("regular bot blocked from computer provisioning and update_bot_computer while admin bot succeeds", async (t) => {
  assert.ok(BOT_COLLAB_TOOL_DECLARATIONS.some((d) => d.name === "computer_provision"));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-rbac-prov-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);
  const admin = store.ensureAdminBot();
  const regular = store.createSession({ title: "普通专员" });

  const regularProv = await runBotCollabTool(
    "computer_provision",
    { action: "install" },
    { store, senderSessionId: regular.id, senderBot: regular }
  );
  assert.equal(regularProv.ok, false);
  assert.match(regularProv.error, /仅管理员 Bot/);

  const regularUpd = await runBotCollabTool(
    "system_diagnostics",
    { action: "update_bot_computer" },
    { store, senderSessionId: regular.id, senderBot: regular }
  );
  assert.equal(regularUpd.ok, false);
  assert.match(regularUpd.error, /仅管理员 Bot/);

  const broadcasts: any[] = [];
  const adminProv = await runBotCollabTool(
    "computer_provision",
    { action: "install" },
    {
      store,
      senderSessionId: admin.id,
      senderBot: admin,
      config: { deployEnv: "local" },
      broadcastGlobal: (ev: any) => broadcasts.push(ev),
      provisionComputerFn: async () => ({
        ok: true,
        state: "ready",
        provider: "orbstack",
        online: true,
        detail: "Ubuntu 桌面就绪",
      }),
    }
  );
  assert.equal(adminProv.ok, true);
  assert.equal(adminProv.state, "ready");
  assert.ok(broadcasts.some((e) => e.type === "computer_status_updated" && e.state === "ready"));

  const adminPrompt = buildSystemInstruction({
    enableBotTools: true,
    isAdminBot: true,
    deployEnv: "local",
  });
  const regularPrompt = buildSystemInstruction({
    enableBotTools: true,
    isAdminBot: false,
    deployEnv: "local",
  });
  assert.match(adminPrompt, /computer_provision/);
  assert.match(regularPrompt, /仅管理员 Bot 有权/);

  const winAdminPrompt = buildSystemInstruction({
    enableBotTools: true,
    isAdminBot: true,
    deployEnv: "local",
    hostPlatform: "win32",
  });
  assert.match(winAdminPrompt, /Windows PC/);
  assert.match(winAdminPrompt, /WSL_UTF8=1/);
  assert.match(winAdminPrompt, /needsReboot/);
});

test("wsl-ubuntu helpers handle UTF-16LE distro lists, Ubuntu-24.04 selection, path translation, and reboot errors", () => {
  const utf16Raw = "\uFEFFdocker-desktop\r\nUbuntu-24.04\r\n".split("").join("\u0000");
  const distros = parseWslDistroList(utf16Raw);
  assert.deepEqual(distros, ["docker-desktop", "Ubuntu-24.04"]);
  assert.equal(pickWslUbuntuDistro(distros), "Ubuntu-24.04");
  assert.equal(pickWslUbuntuDistro(["Ubuntu-22.04", "Ubuntu"]), "Ubuntu");
  assert.equal(pickWslUbuntuDistro(["docker-desktop"]), null);
  assert.equal(
    windowsPathToWsl("C:\\Users\\YOUR_USERNAME\\AppData\\Local\\Programs\\TwinkleBot\\executor.py"),
    "/mnt/c/Users/YOUR_USERNAME/AppData/Local/Programs/TwinkleBot/executor.py"
  );
  assert.equal(classifyWslInstallFailure("Error: 0x80370102").needsVirtualization, true);
  assert.equal(classifyWslInstallFailure("The requested operation requires elevation.").needsElevation, true);
  assert.equal(classifyWslInstallFailure("Please restart your machine to complete WSL install").needsReboot, true);
});

test("provisionBotComputer on win32 handles brand-new PC install, Ubuntu-24.04 distro, chunk sync fallback, and reboot guidance", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-prov-win-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmpDir, "executor"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "executor", "executor.py"), "#!/usr/bin/env python3\nprint('ok')\n", "utf8");
  const store = createStore(tmpDir);

  // 1. Brand-new PC: no Ubuntu initially -> installs via --web-download --no-launch -> deploys -> chunk fallback -> ready
  let installed = false;
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const res = await provisionBotComputer({
    deployEnv: "local",
    platform: "win32",
    projectRoot: tmpDir,
    store,
    executorToken: "fresh-pc-secret-token",
    executor: {
      health: async () => ({ ok: true, screen: { width: 1440, height: 900 } }),
    },
    execFileFn: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "wsl" && args[0] === "-l") {
        return { stdout: installed ? "docker-desktop\nUbuntu-24.04\n" : "docker-desktop\n", stderr: "" };
      }
      if (cmd === "wsl" && args[0] === "--install") {
        installed = true;
        return { stdout: "installed", stderr: "" };
      }
      if (cmd === "wsl" && args.includes("bash") && args[args.length - 1].includes("base64 -d | bash")) {
        // Simulate disabled /mnt/ automount so chunked fallback also gets exercised
        return { stdout: "__MISSING_EXECUTOR_PY__\n", stderr: "" };
      }
      return { stdout: "ok", stderr: "" };
    },
    retryDelayMs: 5,
  });

  assert.equal(res.ok, true);
  assert.equal(res.state, "ready");
  assert.equal(res.provider, "wsl");
  assert.equal(res.distro, "Ubuntu-24.04");
  assert.ok(calls.some((c) => c.cmd === "wsl" && c.args.includes("--install")));
  assert.ok(calls.some((c) => c.cmd === "wsl" && c.args[1] === "Ubuntu-24.04"));
  assert.equal(store.readSettings().botComputer?.distro, "Ubuntu-24.04");

  // 2. Fresh PC requiring first-time WSL2 reboot surfaces needsReboot=true cleanly
  const rebootRes = await provisionBotComputer({
    deployEnv: "local",
    platform: "win32",
    projectRoot: tmpDir,
    store,
    execFileFn: async (_cmd, args) => {
      if (args[0] === "-l") return { stdout: "", stderr: "" };
      if (args[0] === "--install") {
        const err: any = new Error("WSL install pending reboot");
        err.stdout = "The requested operation is successful. Changes will not be effective until the system is rebooted.";
        throw err;
      }
      return { stdout: "", stderr: "" };
    },
    retryDelayMs: 5,
  });
  assert.equal(rebootRes.ok, false);
  assert.equal(rebootRes.state, "error");
  assert.equal((rebootRes as any).needsReboot, true);
  assert.match(rebootRes.error || "", /重启/);
});

test("buildWslProvisionScript unifies persistent chrome profile, SwiftShader GL, and browser systemd unit, and ensureLocalWslExecutorAwake wakes & deduplicates", async () => {
  const script = buildWslProvisionScript({
    executorWslPath: "/mnt/c/twinklebot/executor/executor.py",
    executorToken: "tok",
    proxyHint: { explicitProxyUrl: "", hostProxyPort: 7890, proxyEnabled: false },
  });
  const decodedBlobs = [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/g)]
    .map((m) => Buffer.from(m[1], "base64").toString("utf-8"))
    .join("\n");
  const fullRendered = `${script}\n${decodedBlobs}`;
  assert.match(fullRendered, /\/opt\/twinklebot\/chrome-profile/);
  assert.ok(!fullRendered.includes("/opt/twinklebot/chrome-profiles"), "all Bots share Primary Chrome Profile");
  assert.match(fullRendered, /TWINKLEBOT_BROWSER=\/usr\/local\/bin\/google-chrome/);
  assert.match(fullRendered, /google-chrome-stable_current_/);
  assert.match(fullRendered, /aarch64\|arm64/);
  assert.match(fullRendered, /--disable-background-timer-throttling/);
  assert.match(fullRendered, /--disable-renderer-backgrounding/);
  assert.match(fullRendered, /\/usr\/local\/bin\/twinklebot-chrome/);
  assert.match(fullRendered, /--use-angle=swiftshader/);
  assert.match(fullRendered, /twinklebot-browser\.service/);
  assert.match(fullRendered, /twinklebot-x11vnc\.service/);
  assert.match(fullRendered, /twinklebot-novnc\.service/);
  assert.match(fullRendered, /browser-supervisor\.sh/);
  assert.match(fullRendered, /sync-proxy\.sh/);
  assert.match(fullRendered, /HOST_PROXY_PORT=7890/);
  assert.ok(!fullRendered.includes("--test-type"), "should not pass --test-type automation flag");

  const regParsed = parseWindowsProxyHint({
    env: {},
    regOutput:
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n",
  });
  assert.equal(regParsed.hostProxyPort, 7890);
  assert.equal(regParsed.proxyEnabled, true);

  let wakeCalls = 0;
  let healthCalls = 0;
  const fakeStore = { readSettings: () => ({ botComputer: { distro: "Ubuntu" } }) };
  const fakeExec = async () => {
    wakeCalls++;
    await new Promise((r) => setTimeout(r, 20));
    return { stdout: "ok", stderr: "" };
  };
  const [r1, r2] = await Promise.all([
    ensureLocalWslExecutorAwake({
      platform: "win32",
      deployEnv: "local",
      store: fakeStore,
      execFileFn: fakeExec,
      probeHealthFn: async () => {
        healthCalls++;
        return healthCalls >= 2;
      },
      retryDelayMs: 5,
    }),
    ensureLocalWslExecutorAwake({
      platform: "win32",
      deployEnv: "local",
      store: fakeStore,
      execFileFn: fakeExec,
    }),
  ]);
  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(wakeCalls, 1, "concurrent wakes should be deduplicated");

  // Regression: createLocalAwareExecutorClient must not self-deadlock when health probe fails initially during wake
  let wslExecCount = 0;
  let healthProbeCount = 0;
  let shellAttempts = 0;
  const localClient = createLocalAwareExecutorClient({
    url: "http://127.0.0.1:7300",
    token: "tok-win",
    deployEnv: "local",
    platform: "win32",
    store: { readSettings: () => ({ botComputer: { state: "ready", distro: "Ubuntu" } }) },
    retryDelayMs: 5,
    execFileFn: async () => {
      wslExecCount++;
      return { stdout: "started", stderr: "" };
    },
    fetchImpl: (async (targetUrl: any) => {
      const u = String(targetUrl);
      if (u.endsWith("/health")) {
        healthProbeCount++;
        if (healthProbeCount < 2) {
          throw new TypeError("fetch failed");
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }
      shellAttempts++;
      if (shellAttempts === 1) {
        throw new TypeError("fetch failed");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ exit_code: 0, stdout: "recovered" }),
      };
    }) as any,
  });

  // Passive health() check must NOT trigger WSL wake when offline
  healthProbeCount = 0;
  await assert.rejects(() => localClient.health(), /executor unreachable/);
  assert.equal(wslExecCount, 0, "passive health() must not spawn wsl auto-wake");

  // Active call() wakes WSL once, survives ECONNREFUSED on first health probe without deadlocking, and retries
  healthProbeCount = 0;
  const shellRes: any = await localClient.call("/shell", { command: "echo hi" });
  assert.equal(shellRes.stdout, "recovered");
  assert.equal(wslExecCount, 1);
  assert.equal(healthProbeCount, 2);
});
