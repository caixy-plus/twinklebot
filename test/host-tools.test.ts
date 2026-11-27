import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOST_TOOL_DECLARATIONS,
  buildHostShellSpawnSpec,
  cleanPowerShellClixmlStderr,
  isHostTool,
  runHostTool,
} from "../src/agent/host-tools.js";
import {
  computeBundledExecutorSha256,
  createExecutorAutoSyncController,
  updateBotComputer,
} from "../src/lib/bot-computer-updater.js";
import { createLocalAwareExecutorClient } from "../src/lib/bot-computer-provisioner.js";

test("HOST_TOOL_DECLARATIONS defines 6 host tools and scopes risk parameter to mutating tools", () => {
  const names = HOST_TOOL_DECLARATIONS.map((t) => t.name);
  assert.deepEqual(names, [
    "host_run_shell",
    "host_open",
    "host_read_file",
    "host_write_file",
    "host_edit_file",
    "host_record_screen",
  ]);
  const mutatingRiskTools = new Set([
    "host_run_shell",
    "host_write_file",
    "host_edit_file",
    "host_record_screen",
  ]);
  for (const decl of HOST_TOOL_DECLARATIONS) {
    assert.equal(decl.type, "function");
    assert.equal(isHostTool(decl.name), true);
    if (mutatingRiskTools.has(decl.name)) {
      assert.ok((decl.parameters.properties as Record<string, any>).risk, `${decl.name} should define risk`);
    } else {
      assert.equal(
        (decl.parameters.properties as Record<string, any>).risk,
        undefined,
        `read-only/open tool ${decl.name} should omit risk to prevent spurious high-risk prompts`
      );
    }
  }
  assert.equal(isHostTool("run_shell"), false);
  assert.equal(isHostTool("mcp__kimi_cu__click"), false);
});

test("host_run_shell runs zsh command, scrubs secrets from env, and supports abort", async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevTok = process.env.TWINKLEBOT_EXECUTOR_TOKEN;
  process.env.GEMINI_API_KEY = "top-secret-key";
  process.env.TWINKLEBOT_EXECUTOR_TOKEN = "top-secret-token";

  try {
    const out = await runHostTool("host_run_shell", {
      command: `"${process.execPath}" -e "process.stdout.write((process.env.GEMINI_API_KEY || '') + '|' + (process.env.TWINKLEBOT_EXECUTOR_TOKEN || '') + '|ok')"`,
    });
    assert.equal(out.result.exitCode, 0);
    assert.equal(out.result.stdout, "||ok");

    const ac = new AbortController();
    const slowPromise = runHostTool(
      "host_run_shell",
      { command: `"${process.execPath}" -e "setTimeout(() => {}, 10000)"` },
      { signal: ac.signal }
    );
    setTimeout(() => ac.abort(new Error("user stopped")), 60);
    await assert.rejects(() => slowPromise, /stopped|Abort/i);
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.TWINKLEBOT_EXECUTOR_TOKEN;
    else process.env.TWINKLEBOT_EXECUTOR_TOKEN = prevTok;
  }
});

test("host_read_file and host_write_file read and write local files safely", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-host-tools-"));
  try {
    const targetFile = path.join(tmpDir, "nested", "hello.txt");
    const writeRes = await runHostTool("host_write_file", {
      path: targetFile,
      content: "你好，你的电脑！",
    });
    assert.equal(writeRes.result.ok, true);

    const readRes = await runHostTool("host_read_file", {
      path: targetFile,
    });
    assert.equal(readRes.result.ok, true);
    assert.equal(readRes.result.content, "你好，你的电脑！");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("host_open invokes /usr/bin/open with -a and -R flags when requested", async () => {
  const calls: any[] = [];
  const res = await runHostTool(
    "host_open",
    {
      target: "/Users/YOUR_USERNAME/Downloads",
      app: "Finder",
      reveal_in_finder: true,
    },
    {
      execOpenFn: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "" };
      },
    }
  );
  assert.equal(res.result.ok, true);
  assert.equal(calls.length, 1);
  if (process.platform === "linux") {
    assert.equal(calls[0].cmd, "xdg-open");
    assert.deepEqual(calls[0].args, [path.resolve("/Users/YOUR_USERNAME/Downloads")]);
  } else if (process.platform === "win32") {
    assert.equal(calls[0].cmd, "explorer.exe");
    assert.deepEqual(calls[0].args, ["/select,", path.resolve("/Users/YOUR_USERNAME/Downloads")]);
  } else {
    assert.equal(calls[0].cmd, "/usr/bin/open");
    assert.deepEqual(calls[0].args, [
      "-R",
      "-a",
      "Finder",
      path.resolve("/Users/YOUR_USERNAME/Downloads"),
    ]);
  }
});

test("updateBotComputer syncs executor.py via orb, restarts systemd unit, and verifies health", async () => {
  const execCalls: any[] = [];
  let healthChecks = 0;
  const res = await updateBotComputer({
    platform: "darwin",
    projectRoot: "/Users/YOUR_USERNAME/Workspace/twinklebot",
    executorToken: "synced-mac-tok-123",
    execFileFn: async (cmd, args) => {
      execCalls.push({ cmd, args });
      return { stdout: "done", stderr: "" };
    },
    executor: {
      async health() {
        healthChecks += 1;
        if (healthChecks < 2) {
          const err: any = new Error("unauthorized");
          err.status = 401;
          throw err;
        }
        return { ok: true, screen: { width: 1440, height: 900 } };
      },
    },
    retryDelayMs: 5,
  });

  assert.equal(res.ok, true);
  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[0].cmd, "orb");
  assert.ok(execCalls[0].args.includes("/opt/twinklebot/executor.py"));
  const bashScript = String(execCalls[1].args[execCalls[1].args.length - 1] || "");
  assert.ok(bashScript.includes("twinklebot-executor.service"));
  assert.ok(bashScript.includes("geminibot-executor.service"));
  assert.ok(bashScript.includes("/etc/twinklebot/executor.env"));
  assert.ok(bashScript.includes(Buffer.from("synced-mac-tok-123", "utf-8").toString("base64")));
  assert.equal(healthChecks, 2);
});

test("updateBotComputer on win32 discovers Ubuntu-* distro via wsl, syncs executor & token, and verifies health", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-upd-win-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmpDir, "executor"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "executor", "executor.py"), "print('executor')\n", "utf8");

  const execCalls: any[] = [];
  let decodedScript = "";
  const res = await updateBotComputer({
    platform: "win32",
    projectRoot: tmpDir,
    executorToken: "win-tok-999",
    execFileFn: async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === "wsl" && args[0] === "-l") {
        // Simulate Windows UTF-16LE null-byte interleaved wsl -l -q output
        const utf16Mock = "docker-desktop\r\nUbuntu-24.04\r\n".split("").join("\u0000");
        return { stdout: utf16Mock, stderr: "" };
      }
      const bashArg = args[args.length - 1] || "";
      const b64Match = /printf '%s' '([^']+)' \| base64 -d/.exec(bashArg);
      if (b64Match) {
        decodedScript = Buffer.from(b64Match[1], "base64").toString("utf8");
      }
      return { stdout: "ok", stderr: "" };
    },
    executor: {
      async health() {
        return { ok: true, screen: { width: 1440, height: 900 } };
      },
    },
    retryDelayMs: 5,
  });

  assert.equal(res.ok, true);
  assert.equal(res.distro, "Ubuntu-24.04");
  assert.equal(execCalls[1].cmd, "wsl");
  assert.equal(execCalls[1].args[1], "Ubuntu-24.04");
  assert.match(decodedScript, /\/opt\/twinklebot\/executor\.py/);
  assert.match(decodedScript, /twinklebot-desktop\.service/);
  assert.match(decodedScript, /twinklebot-executor\.service/);
});

test("createExecutorAutoSyncController & createLocalAwareExecutorClient auto-sync outdated executor.py once and skip when up-to-date", async () => {
  const realSha = computeBundledExecutorSha256();
  assert.match(realSha, /^[a-f0-9]{16}$/);

  // 1. Already up-to-date -> 0 calls to updateBotComputerFn
  let updCount1 = 0;
  const ctrlUpToDate = createExecutorAutoSyncController({
    platform: "darwin",
    deployEnv: "local",
    localShaOverride: "abcdef0123456789",
    executor: {
      async health() {
        return { ok: true, executor_sha256: "abcdef0123456789" };
      },
    },
    updateBotComputerFn: async () => {
      updCount1 += 1;
      return { ok: true, updatedAt: new Date().toISOString() };
    },
  });
  const r1 = await ctrlUpToDate.syncIfOutdated("test");
  assert.equal(r1.ok, true);
  assert.equal(r1.synced, false);
  assert.equal(updCount1, 0);
  assert.equal(ctrlUpToDate.isSynced(), true);
  ctrlUpToDate.dispose();

  // 2. Legacy/outdated executor on first Bot Computer call -> auto-updates ONCE before executing call, then caches
  let remoteSha = ""; // simulates legacy executor.py without executor_sha256
  let updateCalls = 0;
  const savedSettings: any[] = [];
  const fakeFetch: typeof fetch = (async (input: any) => {
    const u = String(input);
    if (u.endsWith("/health")) {
      return new Response(
        JSON.stringify({ ok: true, width: 1440, height: 900, ...(remoteSha ? { executor_sha256: remoteSha } : {}) }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ ok: true, echoedSha: remoteSha }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;

  const client = createLocalAwareExecutorClient({
    url: "http://127.0.0.1:7300",
    token: "tok-sync",
    deployEnv: "local",
    platform: "darwin",
    autoSyncExecutor: true,
    localShaOverride: "1122334455667788",
    fetchImpl: fakeFetch,
    store: {
      readSettings: () => ({ botComputer: { state: "ready" } }),
      writeSettings: (patch: any) => savedSettings.push(patch),
    },
    updateBotComputerFn: async () => {
      updateCalls += 1;
      remoteSha = "1122334455667788";
      return { ok: true, updatedAt: "2026-11-21T03:00:00.000Z" };
    },
  });

  const firstOut = await client.call("/displays/ensure", { bot_id: "b1" });
  assert.equal(updateCalls, 1, "First call must auto-sync outdated executor.py before executing");
  assert.equal(firstOut.echoedSha, "1122334455667788");
  assert.equal(savedSettings.length, 1);

  // Subsequent calls incur zero additional syncs
  await client.call("/browser/snapshot", {});
  assert.equal(updateCalls, 1);

  // 3. Cloud mode or uncreated Bot Computer must never trigger local auto-sync
  let cloudUpd = 0;
  const cloudCtrl = createExecutorAutoSyncController({
    platform: "darwin",
    deployEnv: "cloud",
    localShaOverride: "1122334455667788",
    executor: { async health() { return { ok: true }; } },
    updateBotComputerFn: async () => {
      cloudUpd += 1;
      return { ok: true, updatedAt: new Date().toISOString() };
    },
  });
  const rCloud = await cloudCtrl.syncIfOutdated("test");
  assert.equal(rCloud.synced, false);
  assert.equal(cloudUpd, 0);
  cloudCtrl.dispose();
});

test("host_read_file slices lines, host_edit_file replaces/appends safely, and Windows WSL/CLIXML helpers work", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-host-edit-"));
  try {
    const filePath = path.join(tmpDir, "notes.txt");
    fs.writeFileSync(filePath, "line1\nline2\ntarget line\ntarget line\nline5", "utf8");

    const slice = await runHostTool("host_read_file", {
      path: filePath,
      start_line: 2,
      end_line: 3,
    });
    assert.equal(slice.result.ok, true);
    assert.equal(slice.result.startLine, 2);
    assert.equal(slice.result.endLine, 3);
    assert.equal(slice.result.totalLines, 5);
    assert.equal(slice.result.hasMore, true);
    assert.equal(slice.result.content, "2: line2\n3: target line");

    const ambiguous = await runHostTool("host_edit_file", {
      path: filePath,
      target: "target line",
      replacement: "edited",
    });
    assert.equal(ambiguous.result.ok, false);
    assert.match(ambiguous.result.error, /matched 2 times/);

    const replaceAll = await runHostTool("host_edit_file", {
      path: filePath,
      target: "target line",
      replacement: "edited line",
      replace_all: true,
    });
    assert.equal(replaceAll.result.ok, true);
    assert.equal(replaceAll.result.replacements, 2);

    const appended = await runHostTool("host_edit_file", {
      path: filePath,
      append: true,
      replacement: "\nline6",
    });
    assert.equal(appended.result.ok, true);
    assert.equal(appended.result.mode, "append");
    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "line1\nline2\nedited line\nedited line\nline5\nline6"
    );

    // Windows WSL passthrough & CLIXML noise cleanup
    const wslSpec = buildHostShellSpawnSpec("git status | tail -n 5", {
      platform: "win32",
      shell: "wsl",
      wslDistro: "Ubuntu-24.04",
    });
    assert.equal(wslSpec.cmd, "wsl.exe");
    assert.deepEqual(wslSpec.args, ["-d", "Ubuntu-24.04", "--", "bash", "-lc", "git status | tail -n 5"]);
    assert.equal(wslSpec.isPowerShell, false);

    const noisyClixml = `#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><PR N="Progress"><T>Completed</T></PR></Objs>`;
    assert.equal(cleanPowerShellClixmlStderr(noisyClixml), "");

    const realErrClixml = `#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">fatal: not a git repo_x000D__x000A_</S></Objs>`;
    assert.equal(cleanPowerShellClixmlStderr(realErrClixml), "fatal: not a git repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
