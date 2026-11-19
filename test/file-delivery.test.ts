import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/store/index.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import { runTask } from "../src/agent/loop.js";
import { createServer } from "../src/server/index.js";
import { stageDeliveredFile } from "../src/lib/file-attachments.js";

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-file-delivery-"));
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const store = createStore(path.join(dir, "data"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, workspace, store, cleanup };
}

test("send_file stages local .docx deliverables, notifies library, and blocks sensitive files", async () => {
  const { dir, workspace, store, cleanup } = makeTempEnv();
  try {
    const s = store.createSession({ title: "B 站管理员" });
    const srcDoc = path.join(dir, "B站关注UP主最新视频汇总.docx");
    const fakeDocxBytes = Buffer.from("PK\x03\x04dummy-docx-payload");
    fs.writeFileSync(srcDoc, fakeDocxBytes);

    const broadcasts: any[] = [];
    const res = await runBotCollabTool(
      "send_file",
      { path: srcDoc, title: "B站关注UP主最新视频汇总.docx" },
      {
        store,
        config: { writeRoots: [workspace] },
        senderSessionId: s.id,
        broadcastGlobal: (evt: any) => broadcasts.push(evt),
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.name, "B站关注UP主最新视频汇总.docx");
    assert.equal(res.size, fakeDocxBytes.length);
    assert.equal(
      res.mime_type,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    assert.ok(res.path.startsWith(path.join(workspace, "bots", s.id, "deliverables")));
    assert.deepEqual(fs.readFileSync(res.path), fakeDocxBytes);
    assert.match(res.markdown, /^\[文件附件: B站关注UP主最新视频汇总\.docx · 路径: .+\]$/);
    assert.equal(broadcasts.some((e) => e.type === "library_updated"), true);

    // Ubuntu executor fallback when file is not on Mac local disk
    const remoteRes = await runBotCollabTool(
      "send_file",
      { path: "/home/user/report.pdf", title: "Ubuntu报告" },
      {
        store,
        config: { writeRoots: [workspace] },
        senderSessionId: s.id,
        executor: {
          async call(route: any) {
            assert.equal(route, "/shell");
            return {
              ok: true,
              stdout: Buffer.from("%PDF-1.7 mock").toString("base64"),
            };
          },
        },
      }
    );
    assert.equal(remoteRes.ok, true);
    assert.equal(remoteRes.name, "Ubuntu报告.pdf");
    assert.equal(remoteRes.mime_type, "application/pdf");

    // Security blocklist: refuse .env and SSH keys
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, "GEMINI_API_KEY=secret");
    const denied = await runBotCollabTool(
      "send_file",
      { path: envFile },
      {
        store,
        config: { writeRoots: [workspace] },
        senderSessionId: s.id,
      }
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error, /access denied/i);
  } finally {
    cleanup();
  }
});

test("runTask auto-embeds send_file attachment markdown onto final answer if model omits it", async () => {
  const { dir, workspace, store, cleanup } = makeTempEnv();
  try {
    const s = store.createSession({ title: "文档助手" });
    const docxPath = path.join(dir, "周报.docx");
    fs.writeFileSync(docxPath, Buffer.from("PK\x03\x04mock-docx"));

    let turn = 0;
    const mockModel = {
      async nextTurn() {
        turn++;
        if (turn === 1) {
          return {
            text: "",
            thoughts: [],
            usage: { input: 10, output: 10 },
            outputSteps: [],
            calls: [
              {
                id: "call_send_1",
                name: "send_file",
                args: { path: docxPath },
              },
            ],
          };
        }
        return {
          text: "已经为你整理好本周工作总结，请查收！",
          thoughts: [],
          usage: { input: 10, output: 10 },
          outputSteps: [],
          calls: [],
        };
      },
    };

    const events: any[] = [];
    const result = await runTask({
      sessionId: s.id,
      userText: "把周报发给我",
      deps: {
        model: mockModel,
        executor: {
          async call() {
            return { png_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
          },
        },
        store,
        enableBotTools: true,
        config: {
          writeRoots: [workspace],
          defaultModel: "gemini-4-argon",
        },
        emit: (e: any) => events.push(e),
      },
    });

    assert.equal(result.status, "done");
    assert.match(result.text, /\[文件附件: 周报\.docx · 路径: /);
    const answerEvt = events.find((e) => e.type === "answer");
    assert.ok(answerEvt);
    assert.match(answerEvt.text, /\[文件附件: 周报\.docx · 路径: /);
  } finally {
    cleanup();
  }
});

test("server exposes download Content-Disposition on /api/workspace/file, /api/files/meta, and guards /api/files/open", async () => {
  const { dir, workspace, store, cleanup } = makeTempEnv();
  const staged = stageDeliveredFile({
    buffer: Buffer.from("PK\x03\x04hello-word"),
    fileName: "测试文档.docx",
    title: "测试文档.docx",
    workspaceRoot: workspace,
  });
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "SECRET=1");

  const server = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(dir, "data"),
      writeRoots: [workspace],
    },
    store,
    model: { async nextTurn() { return { calls: [], text: "" }; } },
    executor: { async call() { return {}; }, async health() { return true; } },
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  try {
    const dlRes = await fetch(
      `http://127.0.0.1:${port}${staged.downloadUrl}`
    );
    assert.equal(dlRes.status, 200);
    assert.equal(
      dlRes.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    assert.match(
      dlRes.headers.get("content-disposition") || "",
      /attachment; filename\*=UTF-8''/
    );

    const metaRes = await fetch(
      `http://127.0.0.1:${port}/api/files/meta?path=${encodeURIComponent(staged.path)}`
    );
    assert.equal(metaRes.status, 200);
    const metaJson = await metaRes.json();
    assert.equal(metaJson.exists, true);
    assert.equal(metaJson.size, 14);
    assert.equal(metaJson.ext, ".docx");
    assert.equal(metaJson.inWorkspace, true);

    const blockedMeta = await fetch(
      `http://127.0.0.1:${port}/api/files/meta?path=${encodeURIComponent(envFile)}`
    );
    assert.equal(blockedMeta.status, 403);

    const blockedOpen = await fetch(`http://127.0.0.1:${port}/api/files/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: envFile }),
    });
    assert.equal(blockedOpen.status, 403);

    const missingOpen = await fetch(`http://127.0.0.1:${port}/api/files/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(dir, "missing.docx") }),
    });
    assert.equal(missingOpen.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
  }
});
