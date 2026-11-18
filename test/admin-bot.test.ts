import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

test("admin bot deletion and pin protection (store + HTTP API)", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-admin-bot-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);

  // Fresh store auto-creates Admin Bot on ensureAdminBot() and keeps it at index 0
  const admin = store.ensureAdminBot();
  assert.equal(admin.title, "Twinkle");
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.pinned, true);
  assert.equal(admin.type, "dm");

  // Calling ensureAdminBot() again returns the exact same Admin Bot
  const adminAgain = store.ensureAdminBot();
  assert.equal(adminAgain.id, admin.id);

  // Create regular bots after admin; admin stays first in listSessions()
  const b1 = store.createSession({ title: "研发助手", type: "dm" });
  const b2 = store.createSession({ title: "运维助手", type: "dm", pinned: true });
  assert.equal(b2.isAdmin, undefined);
  assert.equal(b2.pinned, false);

  const list = store.listSessions();
  assert.equal(list[0].id, admin.id);
  assert.equal(list[0].isAdmin, true);

  // Store-level delete protection
  assert.throws(() => store.deleteSession(admin.id), /管理员 Bot 不可删除/);
  assert.ok(store.getSession(admin.id));

  // Store-level pin & isAdmin immutability
  assert.throws(() => store.updateSession(admin.id, { pinned: false }), /置顶/);
  assert.throws(() => store.updateSession(b1.id, { pinned: true }), /置顶/);
  const renamedAdmin = store.updateSession(admin.id, {
    title: "主控官",
    avatar: { color: "violet" },
  });
  assert.equal(renamedAdmin.title, "主控官");
  assert.equal(renamedAdmin.avatar?.color, "violet");
  assert.equal(renamedAdmin.isAdmin, true);
  assert.equal(renamedAdmin.pinned, true);

  // HTTP Server guards
  const srv = createServer({
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal: () => {},
      stop: () => {},
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      port: 0,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
      writeRoots: [tmpDir],
    },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  // POST /api/sessions ignores pinned:true / isAdmin:true
  const createdRes = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "测试普通Bot", pinned: true, isAdmin: true }),
  });
  assert.equal(createdRes.status, 201);
  const createdBot = await createdRes.json();
  assert.equal(Boolean(createdBot.isAdmin), false);
  assert.equal(Boolean(createdBot.pinned), false);

  // DELETE /api/sessions/:adminId -> 403
  const delAdminRes = await fetch(`${baseUrl}/api/sessions/${admin.id}`, {
    method: "DELETE",
  });
  assert.equal(delAdminRes.status, 403);

  // PATCH /api/sessions/:adminId { pinned: false } -> 400
  const unpinAdminRes = await fetch(`${baseUrl}/api/sessions/${admin.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned: false }),
  });
  assert.equal(unpinAdminRes.status, 400);

  // PATCH /api/sessions/:regularId { pinned: true } -> 400
  const pinRegularRes = await fetch(`${baseUrl}/api/sessions/${b1.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(pinRegularRes.status, 400);

  // PATCH /api/sessions/:adminId { title, avatar } -> 200
  const editAdminRes = await fetch(`${baseUrl}/api/sessions/${admin.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Nori 总管", avatar: { color: "emerald" } }),
  });
  assert.equal(editAdminRes.status, 200);
  const editedAdmin = await editAdminRes.json();
  assert.equal(editedAdmin.title, "Nori 总管");
  assert.equal(editedAdmin.avatar.color, "emerald");
  assert.equal(editedAdmin.isAdmin, true);

  // Regular bot can still be deleted
  const delRegularRes = await fetch(`${baseUrl}/api/sessions/${createdBot.id}`, {
    method: "DELETE",
  });
  assert.equal(delRegularRes.status, 200);
});
