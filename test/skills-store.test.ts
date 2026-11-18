import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import { normalizeMailAuthStore } from "../src/lib/mail-client.js";

const SECRET_QQ = "qqsecretqqsecret";
const SECRET_CM = "cmSuperSecretPw";

async function boot(t: any) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-skills-"));
  const store = createStore(tmpDir);
  const broadcasts: any[] = [];
  const srv = createServer({
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal: (ev: any) => broadcasts.push(ev),
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      port: 0,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
      writeRoots: [tmpDir],
    },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const call = async (method: string, p: string, body?: any) => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  return { store, call, broadcasts };
}

function seedAccounts(store: any) {
  store.writeMailAuth({
    accounts: [
      {
        id: "qq1",
        provider: "qqmail",
        email: "me@qq.com",
        password: SECRET_QQ,
        isDefault: true,
      },
      {
        id: "cm1",
        provider: "custom-mail",
        email: "me@163.com",
        password: SECRET_CM,
        inboundHost: "imap.163.com",
        smtpHost: "smtp.163.com",
      },
    ],
  });
}

test("fresh install exposes catalog with both mail skills added by default and kimi-cu not added", async (t) => {
  const { call } = await boot(t);
  const r = await call("GET", "/api/skills");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.installedSkills, ["qqmail", "custom-mail"]);
  assert.equal(r.json.skillsCatalog.platform.length, 8);
  assert.ok(r.json.skillsCatalog.platform.some((s: any) => s.id === "custom-skill-manager" && s.builtin && !s.removable));
  assert.ok(r.json.skillsCatalog.platform.some((s: any) => s.id === "websearch" && s.builtin && !s.removable));
  const kimiSkill = r.json.skillsCatalog.platform.find((s: any) => s.id === "kimi-cu");
  assert.equal(kimiSkill.installed, false);
  assert.equal(kimiSkill.removable, true);
  assert.deepEqual(
    r.json.skillsCatalog.office.map((s: any) => [s.id, s.installed, s.accountCount]),
    [
      ["qqmail", true, 0],
      ["custom-mail", true, 0],
    ]
  );
  const s = await call("GET", "/api/settings");
  assert.deepEqual(s.json.installedSkills, ["qqmail", "custom-mail"]);
  assert.ok(s.json.skillsCatalog);
});

test("platform skills cannot be removed; unknown skills 404", async (t) => {
  const { call } = await boot(t);
  const r = await call("DELETE", "/api/skills/ai-image");
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "平台技能为系统内置核心能力，不可关闭或移除");
  assert.equal((await call("DELETE", "/api/skills/bogus")).status, 404);
  assert.equal((await call("POST", "/api/skills/ai-image/install")).status, 400);
});

test("removing, gating, reinstalling and purging a mail skill", async (t) => {
  const { store, call, broadcasts } = await boot(t);
  seedAccounts(store);

  const rm = await call("DELETE", "/api/skills/qqmail");
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.json.installedSkills, ["custom-mail"]);
  assert.ok(broadcasts.some((b) => b.type === "skills_updated"));
  // effective default after removal
  assert.deepEqual(
    rm.json.mailAccounts.map((a: any) => [a.id, a.isDefault]),
    [["cm1", true]]
  );
  const qqMeta = rm.json.skillsCatalog.office.find((s: any) => s.id === "qqmail");
  assert.equal(qqMeta.installed, false);
  assert.equal(qqMeta.accountCount, 0);
  assert.equal(qqMeta.savedAccountCount, 1);
  assert.equal(normalizeMailAuthStore(store.readMailAuth()).accounts.length, 2);

  // gated REST config
  const blocked = await call("POST", "/api/integrations/mail/accounts", {
    provider: "qqmail",
    email: "new@qq.com",
    authCode: "x".repeat(16),
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.error, "请先在技能商店添加该邮箱技能后再配置");
  const blockedPatch = await call("PATCH", "/api/integrations/mail/accounts/qq1", { label: "x" });
  assert.equal(blockedPatch.status, 400);

  // settings POST cannot change installedSkills
  await call("POST", "/api/settings", { installedSkills: ["qqmail", "custom-mail"], theme: "dark" });
  assert.deepEqual((await call("GET", "/api/skills")).json.installedSkills, ["custom-mail"]);

  // reinstall restores dormant accounts
  const add = await call("POST", "/api/skills/qqmail/install");
  assert.equal(add.status, 200);
  assert.deepEqual(add.json.installedSkills, ["qqmail", "custom-mail"]);
  assert.deepEqual(
    add.json.mailAccounts.map((a: any) => a.id).sort(),
    ["cm1", "qq1"]
  );

  // purge
  const purge = await call("DELETE", "/api/skills/qqmail?purgeCredentials=true");
  assert.equal(purge.status, 200);
  const left = normalizeMailAuthStore(store.readMailAuth()).accounts;
  assert.deepEqual(left.map((a) => a.id), ["cm1"]);

  for (const r of [rm, add, purge, await call("GET", "/api/settings"), await call("GET", "/api/skills")]) {
    assert.ok(!r.text.includes(SECRET_QQ));
    assert.ok(!r.text.includes(SECRET_CM));
  }
});

test("removing an account broadcasts skills_updated", async (t) => {
  const { store, call, broadcasts } = await boot(t);
  seedAccounts(store);
  const r = await call("DELETE", "/api/integrations/mail/accounts/cm1");
  assert.equal(r.status, 200);
  assert.ok(broadcasts.some((b) => b.type === "skills_updated"));
});
