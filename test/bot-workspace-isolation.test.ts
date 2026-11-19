import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import { createRunner } from "../src/agent/runner.js";
import { runTask } from "../src/agent/loop.js";
import { assessToolCall } from "../src/agent/policy.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import {
  inferSessionIdFromWorkspacePath,
  isOtherBotPrivateWorkspacePath,
  isPathInsideBotAccessibleRoots,
  resolveBotWorkspaceRoot,
  resolveBotWriteRoots,
  sanitizeBotWorkspaceId,
  scanWorkspaceFiles,
} from "../src/lib/bot-workspace.js";

const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-botws-"));
  const workspaceDir = path.join(dir, "workspace");
  const downloadsDir = path.join(dir, "downloads");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  const store = createStore(path.join(dir, "data"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, workspaceDir, downloadsDir, store, cleanup };
}

test("bot-workspace helpers enforce safe IDs, prevent double-nesting, and block cross-Bot access", () => {
  const { workspaceDir, downloadsDir, cleanup } = makeTempEnv();
  try {
    assert.equal(sanitizeBotWorkspaceId("bot-alpha_1"), "bot-alpha_1");
    for (const bad of ["", ".", "..", "../etc", "a/b", "a\\b", "has space"]) {
      assert.equal(sanitizeBotWorkspaceId(bad), "", `expected empty for ${JSON.stringify(bad)}`);
    }

    const botWsA = resolveBotWorkspaceRoot({
      writeRoots: [workspaceDir, downloadsDir],
      sessionId: "bot-a",
    });
    assert.equal(botWsA, path.join(workspaceDir, "bots", "bot-a"));

    // Idempotency: scoped writeRoots must not become .../bots/bot-a/bots/bot-a
    const botWsNested = resolveBotWorkspaceRoot({
      writeRoots: [botWsA, downloadsDir],
      sessionId: "bot-a",
    });
    assert.equal(botWsNested, botWsA);

    const writeRootsA = resolveBotWriteRoots({
      writeRoots: [workspaceDir, downloadsDir],
      sessionId: "bot-a",
    });
    assert.deepEqual(writeRootsA, [botWsA, downloadsDir]);

    const botAImg = path.join(botWsA, "generated", "cat.png");
    const botBImg = path.join(workspaceDir, "bots", "bot-b", "generated", "secret.png");
    const sharedDl = path.join(downloadsDir, "photo.png");
    fs.mkdirSync(path.dirname(botAImg), { recursive: true });
    fs.mkdirSync(path.dirname(botBImg), { recursive: true });
    fs.writeFileSync(botAImg, "a");
    fs.writeFileSync(botBImg, "b");
    fs.writeFileSync(sharedDl, "d");

    assert.equal(inferSessionIdFromWorkspacePath(botAImg, [workspaceDir]), "bot-a");
    assert.equal(inferSessionIdFromWorkspacePath(sharedDl, [workspaceDir]), "");
    assert.equal(isOtherBotPrivateWorkspacePath(botBImg, [workspaceDir], "bot-a"), true);
    assert.equal(isOtherBotPrivateWorkspacePath(botAImg, [workspaceDir], "bot-a"), false);

    assert.equal(
      isPathInsideBotAccessibleRoots(botAImg, { writeRoots: [workspaceDir, downloadsDir], sessionId: "bot-a" }),
      true
    );
    assert.equal(
      isPathInsideBotAccessibleRoots(sharedDl, { writeRoots: [workspaceDir, downloadsDir], sessionId: "bot-a" }),
      true
    );
    assert.equal(
      isPathInsideBotAccessibleRoots(botBImg, { writeRoots: [workspaceDir, downloadsDir], sessionId: "bot-a" }),
      false
    );
    assert.equal(
      isPathInsideBotAccessibleRoots(path.join(botWsA, ".env"), {
        writeRoots: [workspaceDir, downloadsDir],
        sessionId: "bot-a",
      }),
      false
    );

    // Scanning the parent base root ignores `bots/` subdir so Bot workspaces never leak
    const topItems = scanWorkspaceFiles(workspaceDir, 20);
    assert.equal(topItems.some((it) => it.path === botAImg || it.path === botBImg), false);
  } finally {
    cleanup();
  }
});

test("HTTP Library, attachments, image generation/convert, clone & delete isolate per Bot and Group", async () => {
  const { dir, workspaceDir, store, cleanup } = makeTempEnv();
  const broadcasts: any[] = [];
  const admin = store.ensureAdminBot();
  const botA = store.createSession({ title: "研究 Bot A" });
  const botB = store.createSession({ title: "设计 Bot B" });
  const groupG = store.createSession({
    title: "协同群 G",
    type: "group",
    memberBotIds: [botA.id, botB.id],
  });

  const fakeModel = {
    async generateImage({ title }: any) {
      return {
        images: [{ data: PNG_1X1_B64, mimeType: "image/png" }],
        text: title || "",
        usage: { input: 10, output: 100 },
        usedModel: "gemini-3.1-flash-image",
      };
    },
    async nextTurn() {
      return {
        text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
        usage: { input: 5, output: 20 },
        usedModel: "gemini-4-argon",
      };
    },
  };

  const srv = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      imageModel: "gemini-3.1-flash-image",
      writeRoots: [workspaceDir],
      dataDir: path.join(dir, "data"),
    },
    store,
    model: fakeModel,
    runner: {
      status: () => ({ sessionId: null, state: "idle", activeSessions: {} }),
      stop: () => {},
      subscribe: () => () => {},
      broadcastGlobal: (ev: any) => broadcasts.push(ev),
    },
    executor: { async call() { return {}; }, async health() { return true; } },
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as any;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Scoped uploads go strictly to each session's own workspace
    const upA = await fetch(`${baseUrl}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: botA.id,
        name: "alpha-brief.txt",
        dataBase64: Buffer.from("alpha only").toString("base64"),
      }),
    }).then((r) => r.json());
    const upB = await fetch(`${baseUrl}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: botB.id,
        name: "beta-spec.txt",
        dataBase64: Buffer.from("beta only").toString("base64"),
      }),
    }).then((r) => r.json());
    const upG = await fetch(`${baseUrl}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: groupG.id,
        name: "group-agenda.txt",
        dataBase64: Buffer.from("group only").toString("base64"),
      }),
    }).then((r) => r.json());

    assert.ok(upA.path.startsWith(path.join(workspaceDir, "bots", botA.id, "uploads")));
    assert.ok(upB.path.startsWith(path.join(workspaceDir, "bots", botB.id, "uploads")));
    assert.ok(upG.path.startsWith(path.join(workspaceDir, "bots", groupG.id, "uploads")));

    // Invalid traversal sessionId on upload is rejected cleanly
    const badUp = await fetch(`${baseUrl}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "../escape",
        name: "x.txt",
        dataBase64: Buffer.from("x").toString("base64"),
      }),
    });
    assert.equal(badUp.status, 400);

    // 2. Scoped image generation goes strictly to Bot A's workspace & emits library_updated
    const genA = await fetch(`${baseUrl}/api/images/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: botA.id,
        prompt: "画一枚蓝鲸徽章",
        title: "蓝鲸徽章",
      }),
    }).then((r) => r.json());
    assert.equal(genA.ok, true);
    assert.ok(genA.path.startsWith(path.join(workspaceDir, "bots", botA.id, "generated")));
    assert.ok(broadcasts.some((b) => b.type === "library_updated" && b.sessionId === botA.id));

    // 3. Cross-Bot convert / workspace file guard blocks Bot B from touching Bot A's private file
    const badConv = await fetch(`${baseUrl}/api/images/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: botB.id,
        path: genA.path,
        format: "png",
      }),
    });
    assert.equal(badConv.status, 403);

    const crossFile = await fetch(
      `${baseUrl}/api/workspace/file?path=${encodeURIComponent(upA.path)}&sessionId=${encodeURIComponent(botB.id)}`
    );
    assert.equal(crossFile.status, 403);

    // 4. Verify each Bot & Group sees ONLY its own Library items
    const libAdmin = await fetch(`${baseUrl}/api/sessions/${admin.id}/library`).then((r) => r.json());
    const libA = await fetch(`${baseUrl}/api/sessions/${botA.id}/library`).then((r) => r.json());
    const libB = await fetch(`${baseUrl}/api/sessions/${botB.id}/library`).then((r) => r.json());
    const libG = await fetch(`${baseUrl}/api/sessions/${groupG.id}/library`).then((r) => r.json());

    assert.equal(libAdmin.items.length, 0);
    assert.equal(libA.workspaceRoot, path.join(workspaceDir, "bots", botA.id));
    assert.ok(libA.items.some((i: any) => i.name.includes("alpha-brief.txt")));
    assert.ok(libA.items.some((i: any) => i.path === genA.path));
    assert.equal(libA.items.some((i: any) => i.name.includes("beta-spec.txt")), false);
    assert.equal(libA.items.some((i: any) => i.name.includes("group-agenda.txt")), false);

    assert.ok(libB.items.some((i: any) => i.name.includes("beta-spec.txt")));
    assert.equal(libB.items.some((i: any) => i.name.includes("alpha-brief.txt")), false);

    assert.ok(libG.items.some((i: any) => i.name.includes("group-agenda.txt")));
    assert.equal(libG.items.some((i: any) => i.name.includes("alpha-brief.txt")), false);

    // 5. Cloning Bot A creates a new Bot with an empty exclusive workspace
    const clonedA = await fetch(`${baseUrl}/api/sessions/${botA.id}/clone`, {
      method: "POST",
    }).then((r) => r.json());
    const libClonedA = await fetch(`${baseUrl}/api/sessions/${clonedA.id}/library`).then((r) =>
      r.json()
    );
    assert.equal(libClonedA.items.length, 0);
    assert.notEqual(libClonedA.workspaceRoot, libA.workspaceRoot);

    // 6. Deleting Bot B deletes Bot B's exclusive workspace directory without touching Bot A or Group G
    const botBDir = path.join(workspaceDir, "bots", botB.id);
    assert.equal(fs.existsSync(botBDir), true);
    const delRes = await fetch(`${baseUrl}/api/sessions/${botB.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(fs.existsSync(botBDir), false);
    assert.equal(fs.existsSync(path.join(workspaceDir, "bots", botA.id)), true);
    assert.equal(fs.existsSync(path.join(workspaceDir, "bots", groupG.id)), true);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    cleanup();
  }
});

test("Agent loop, runner headers, group library_manage, policy, and send_file enforce per-Bot isolation", async () => {
  const { workspaceDir, downloadsDir, store, cleanup } = makeTempEnv();
  try {
    const botA = store.createSession({ title: "Bot Alpha" });
    const botB = store.createSession({ title: "Bot Beta" });
    const groupG = store.createSession({
      title: "Group One",
      type: "group",
      memberBotIds: [botA.id, botB.id],
    });

    // 1. library_manage in Group chat targets Group G's workspace & emits Group G's sessionId (not speakerBot.id)
    const broadcasts: any[] = [];
    const noteInGroup = await runBotCollabTool(
      "library_manage",
      {
        action: "save_note",
        title: "群议程纪要",
        content: "# Group Summary\n- Exclusive to Group",
      },
      {
        store,
        senderSessionId: groupG.id,
        senderBot: botA,
        config: { writeRoots: [workspaceDir] },
        broadcastGlobal: (ev: any) => broadcasts.push(ev),
      }
    );
    assert.equal(noteInGroup.ok, true);
    assert.ok(noteInGroup.path.startsWith(path.join(workspaceDir, "bots", groupG.id, "saved-notes")));
    assert.ok(broadcasts.some((ev) => ev.type === "library_updated" && ev.sessionId === groupG.id));

    const botALibTool = await runBotCollabTool(
      "library_manage",
      { action: "list" },
      {
        store,
        senderSessionId: botA.id,
        config: { writeRoots: [workspaceDir] },
      }
    );
    assert.equal(botALibTool.items.length, 0);

    // 2. Policy denies/confirms Bot B touching Bot A's private workspace even when sandboxMode=full
    const botASecret = path.join(workspaceDir, "bots", botA.id, "saved-notes", "secret.md");
    fs.mkdirSync(path.dirname(botASecret), { recursive: true });
    fs.writeFileSync(botASecret, "top secret");

    assert.equal(
      assessToolCall(
        "write_file",
        { path: botASecret, content: "overwrite" },
        {
          sandboxMode: "full",
          writeRoots: [path.join(workspaceDir, "bots", botB.id), downloadsDir],
          baseWorkspaceRoot: workspaceDir,
          botWorkspaceSessionId: botB.id,
        }
      ).decision,
      "confirm"
    );
    assert.equal(
      assessToolCall(
        "read_file",
        { path: botASecret },
        {
          sandboxMode: "full",
          writeRoots: [path.join(workspaceDir, "bots", botB.id), downloadsDir],
          baseWorkspaceRoot: workspaceDir,
          botWorkspaceSessionId: botB.id,
        }
      ).decision,
      "confirm"
    );
    assert.equal(
      assessToolCall(
        "write_file",
        { path: path.join(workspaceDir, "bots", botB.id, "my-report.md"), content: "ok" },
        {
          sandboxMode: "restricted",
          writeRoots: [path.join(workspaceDir, "bots", botB.id), downloadsDir],
          baseWorkspaceRoot: workspaceDir,
          botWorkspaceSessionId: botB.id,
        }
      ).decision,
      "allow"
    );

    // 3. send_file & generate_image reject referencing Bot A's private workspace from Bot B
    const crossSend = await runBotCollabTool(
      "send_file",
      { path: botASecret },
      {
        store,
        senderSessionId: botB.id,
        config: { writeRoots: [workspaceDir, downloadsDir] },
      }
    );
    assert.equal(crossSend.ok, false);
    assert.match(crossSend.error, /access denied/i);

    // 4. Runner passes X-Twinkle-Bot-Workspace & loop injects dedicated workspace into promptConfig & executor
    const recordedCalls: Array<{ route: string; headers: Record<string, string> }> = [];
    const mockExecutor = {
      async health() {
        return { ok: true };
      },
      async call(route: string, _body?: Record<string, unknown>, opts?: { headers?: Record<string, string> }) {
        recordedCalls.push({ route, headers: opts?.headers || {} });
        return { exit_code: 0, stdout: "", stderr: "", png_base64: PNG_1X1_B64 };
      },
    };
    const systemInstructionsSeen: string[] = [];
    let loopTurn = 0;
    const runnerModel = {
      async nextTurn(req: any) {
        systemInstructionsSeen.push(req.systemInstruction);
        loopTurn += 1;
        if (loopTurn === 1) {
          return {
            text: "",
            thoughts: [],
            usage: { input: 5, output: 5 },
            outputSteps: [],
            calls: [{ id: "c1", name: "run_shell", args: { command: "pwd" } }],
          };
        }
        return {
          text: "done",
          thoughts: [],
          usage: { input: 5, output: 5 },
          outputSteps: [],
          calls: [],
        };
      },
    };

    const runner = createRunner({
      store,
      config: { writeRoots: [workspaceDir, downloadsDir], maxSteps: 5, settleMs: 0 },
      model: runnerModel,
      executor: mockExecutor,
      runTaskImpl: runTask,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("runner timeout")), 5000);
      const unsub = runner.subscribe((ev) => {
        if (ev.sessionId === botB.id && ev.type === "status" && ev.status === "done") {
          clearTimeout(timeout);
          unsub();
          resolve();
        }
      });
      runner.start(botB.id, "run pwd in my workspace");
    });

    const botBWorkspace = path.join(workspaceDir, "bots", botB.id);
    assert.ok(systemInstructionsSeen.some((s) => s.includes(botBWorkspace)));
    const shellCall = recordedCalls.find((c) => c.route === "/shell");
    assert.ok(shellCall);
    assert.equal(shellCall.headers["X-Twinkle-Bot-Workspace"], botBWorkspace);
    assert.equal(shellCall.headers["X-Twinkle-Bot-Id"], botB.id);
  } finally {
    cleanup();
  }
});
