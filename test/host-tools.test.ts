import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOST_TOOL_DECLARATIONS,
  isHostTool,
  runHostTool,
} from "../src/agent/host-tools.js";
import { updateBotComputer } from "../src/lib/bot-computer-updater.js";

test("HOST_TOOL_DECLARATIONS defines 5 host tools with risk parameter", () => {
  const names = HOST_TOOL_DECLARATIONS.map((t) => t.name);
  assert.deepEqual(names, [
    "host_run_shell",
    "host_open",
    "host_read_file",
    "host_write_file",
    "host_record_screen",
  ]);
  for (const decl of HOST_TOOL_DECLARATIONS) {
    assert.equal(decl.type, "function");
    assert.equal(isHostTool(decl.name), true);
    assert.ok(decl.parameters.properties.risk);
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
