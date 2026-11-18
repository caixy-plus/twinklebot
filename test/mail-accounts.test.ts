import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/store/index.js";
import { normalizeMailAuthStore } from "../src/lib/mail-client.js";
import {
  upsertMailAccount,
  findMailAccount,
  setDefaultMailAccount,
  removeMailAccount,
  purgeProviderAccounts,
} from "../src/lib/mail-accounts.js";

const okVerify = async (): Promise<any> => ({ ok: true, protocol: "imap", messages: 3, latencyMs: 1 });

function tmpStore(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-mailacct-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStore(dir);
}

function accountsOf(store: any) {
  return normalizeMailAuthStore(store.readMailAuth()).accounts;
}

test("upsertMailAccount creates and adds multiple accounts", async (t) => {
  const store = tmpStore(t);
  const r1 = await upsertMailAccount(
    store,
    { provider: "qqmail", email: "a@qq.com", authCode: "abcd efgh ijkl mnop" },
    { verifyFn: okVerify }
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.created, true);
  assert.equal(r1.record.password, "abcdefghijklmnop");
  assert.deepEqual(r1.inboxStats, { messages: 3, latencyMs: 1 });
  assert.equal(accountsOf(store).length, 1);

  const r2: any = await upsertMailAccount(
    store,
    { provider: "qqmail", email: "b@qq.com", authCode: "zzzzzzzzzzzzzzzz", forceNew: true },
    { verifyFn: okVerify }
  );
  assert.equal(r2.created, true);
  assert.equal(accountsOf(store).length, 2);

  // Updating existing by email keeps the stored secret when omitted
  const r3 = await upsertMailAccount(
    store,
    { provider: "qqmail", email: "a@qq.com", label: "工作" },
    { verifyFn: okVerify }
  );
  assert.equal(r3.ok, true);
  assert.equal(r3.created, false);
  assert.equal(r3.record.label, "工作");
  assert.equal(r3.record.password, "abcdefghijklmnop");
  assert.equal(accountsOf(store).length, 2);
});

test("upsertMailAccount validation errors", async (t) => {
  const store = tmpStore(t);
  const noSecret = await upsertMailAccount(
    store,
    { provider: "qqmail", email: "a@qq.com" },
    { verifyFn: okVerify }
  );
  assert.equal(noSecret.ok, false);
  assert.equal(noSecret.status, 400);

  const badEmail: any = await upsertMailAccount(
    store,
    { provider: "qqmail", email: "nope", authCode: "x".repeat(16) },
    { verifyFn: okVerify }
  );
  assert.equal(badEmail.status, 400);

  const failVerify = await upsertMailAccount(
    store,
    { provider: "qqmail", email: "a@qq.com", authCode: "x".repeat(16) },
    { verifyFn: async () => { throw new Error("auth failed"); } }
  );
  assert.equal(failVerify.ok, false);
  assert.equal(failVerify.status, 400);
  assert.match(failVerify.error, /auth failed/);
  assert.equal(accountsOf(store).length, 0);

  const missingId: any = await upsertMailAccount(
    store,
    { email: "a@qq.com" },
    { explicitId: "nope", verifyFn: okVerify }
  );
  assert.equal(missingId.status, 404);
});

test("setDefaultMailAccount, findMailAccount, removeMailAccount, purgeProviderAccounts", async (t) => {
  const store = tmpStore(t);
  const a: any = await upsertMailAccount(
    store,
    { provider: "qqmail", email: "a@qq.com", authCode: "x".repeat(16), isDefault: true },
    { verifyFn: okVerify }
  );
  const b: any = await upsertMailAccount(
    store,
    {
      provider: "custom-mail",
      email: "b@163.com",
      password: "pw",
      inboundHost: "imap.163.com",
      smtpHost: "smtp.163.com",
      label: "备用",
    },
    { verifyFn: okVerify }
  );

  const def = setDefaultMailAccount(store, b.record.id);
  assert.equal(def.ok, true);
  const list = accountsOf(store);
  assert.equal(list.find((x) => x.id === b.record.id)!.isDefault, true);
  assert.equal(list.find((x) => x.id === a.record.id)!.isDefault, false);

  assert.equal(findMailAccount(list, "备用")!.id, b.record.id);
  assert.equal(findMailAccount(list, "A@QQ.com")!.id, a.record.id);
  assert.equal(findMailAccount(list, "a@qq.com", { providers: ["custom-mail"] }), null);

  const missingRemoval = removeMailAccount(store, "missing") as { ok: false; status: number; error: string };
  assert.equal(missingRemoval.status, 404);
  assert.equal(purgeProviderAccounts(store, "qqmail"), 1);
  const left = accountsOf(store);
  assert.equal(left.length, 1);
  assert.equal(left[0].provider, "custom-mail");

  const rm = removeMailAccount(store, b.record.id);
  assert.equal(rm.ok, true);
  assert.equal(accountsOf(store).length, 0);
});
