import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearLocalCryptoKeyCache,
  createLocalCrypto,
  isEncryptedEnvelope,
} from "../src/lib/local-crypto.js";
import { createStore } from "../src/store/index.js";
import { assessToolCall } from "../src/agent/policy.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import { clearEphemeralSecrets, resolveEphemeralSecretPlaceholders } from "../src/agent/tools.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { createServer } from "../src/server/index.js";

test("local-crypto encrypts/decrypts JSON with AES-256-GCM and migrates legacy plaintext files", (t) => {
  clearLocalCryptoKeyCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-crypto-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cryptoBox = createLocalCrypto(dir, { forceKeyfile: true });
  const targetFile = path.join(dir, "secret.json");

  // 1. Write legacy plaintext JSON directly to disk
  const legacyPayload = { accounts: [{ email: "alice@example.com", password: "PlainPassword#99" }] };
  fs.writeFileSync(targetFile, JSON.stringify(legacyPayload, null, 2), "utf-8");

  // 2. First read parses plaintext AND migrates file to AES-256-GCM ciphertext on disk
  const read1 = cryptoBox.readEncryptedJsonFile(targetFile, {});
  assert.deepEqual(read1, legacyPayload);

  const diskRaw = fs.readFileSync(targetFile, "utf-8");
  assert.ok(!diskRaw.includes("PlainPassword#99"), "plaintext password must not remain on disk after migration");
  assert.ok(!diskRaw.includes("alice@example.com"), "sensitive email metadata must not remain plaintext on disk");
  const diskParsed = JSON.parse(diskRaw);
  assert.equal(isEncryptedEnvelope(diskParsed), true);
  assert.equal(diskParsed.alg, "aes-256-gcm");

  // 3. Subsequent read decrypts envelope cleanly (even after clearing key cache)
  clearLocalCryptoKeyCache();
  const cryptoBox2 = createLocalCrypto(dir, { forceKeyfile: true });
  const read2 = cryptoBox2.readEncryptedJsonFile(targetFile, {});
  assert.deepEqual(read2, legacyPayload);

  // 4. Tampering with ciphertext fails GCM auth tag and returns fallback safely
  diskParsed.ciphertext = Buffer.from("tampered-bytes").toString("base64");
  fs.writeFileSync(targetFile, JSON.stringify(diskParsed), "utf-8");
  const readTampered = cryptoBox2.readEncryptedJsonFile(targetFile, { fallback: true });
  assert.deepEqual(readTampered, { fallback: true });
});

test("store encrypts vault.json & mail-auth.json on disk and policy denies reading key/vault files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-store-enc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStore(dir);
  store.writeVault([
    {
      id: "v-cred-1",
      category: "credential",
      title: "Apple ID",
      subtitle: "user@icloud.com",
      notes: "个人主力账号",
      password: "UltraSecretPassword!2026",
    },
  ]);
  store.writeMailAuth({
    version: 2,
    accounts: [{ id: "m-1", email: "user@qq.com", authCode: "abcdefghijklmnop" }],
  });

  const rawVault = fs.readFileSync(path.join(dir, "vault.json"), "utf-8");
  const rawMail = fs.readFileSync(path.join(dir, "mail-auth.json"), "utf-8");
  assert.ok(isEncryptedEnvelope(JSON.parse(rawVault)), "vault.json must be encrypted envelope on disk");
  assert.ok(isEncryptedEnvelope(JSON.parse(rawMail)), "mail-auth.json must be encrypted envelope on disk");
  assert.ok(!rawVault.includes("UltraSecretPassword!2026"), "vault.json must never contain plaintext password");
  assert.ok(!rawMail.includes("abcdefghijklmnop"), "mail-auth.json must never contain plaintext authCode");

  // readVaultPublic strips password while preserving hasPassword flag
  const pub = store.readVaultPublic();
  assert.equal(pub.length, 1);
  assert.equal(pub[0].hasPassword, true);
  assert.equal("password" in pub[0], false);

  // System prompt must never contain plaintext password
  const sysPrompt = buildSystemInstruction({ enableBotTools: true, vaultItems: pub });
  assert.ok(!sysPrompt.includes("UltraSecretPassword!2026"));
  assert.ok(sysPrompt.includes("vault_manage get_secret"));

  // Policy guardrails deny vault.json, .vault.key, and .vault.dpapi
  for (const sensitivePath of [
    path.join(dir, "vault.json"),
    path.join(dir, ".vault.key"),
    path.join(dir, ".vault.dpapi"),
  ]) {
    assert.equal(assessToolCall("read_file", { path: sensitivePath }, {}).decision, "deny");
    assert.equal(assessToolCall("host_read_file", { path: sensitivePath }, {}).decision, "deny");
  }
});

test("request_credential saveToVault persists encrypted password and vault_manage get_secret mints secret_ref", async (t) => {
  clearEphemeralSecrets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-vault-tool-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStore(dir);
  const res = await runBotCollabTool(
    "request_credential",
    { service: "GitHub", label: "请输入 GitHub 密码", field_type: "password" },
    {
      store,
      callId: "cred-call-1",
      control: {
        stopped: false,
        requestChoice: async () => ({
          value: "GhPass#7788",
          account: "octocat@github.com",
          saveToVault: true,
        }),
      },
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.savedToVault, true);
  assert.match(res.secret_ref, /^\{\{secret:cred_[a-f0-9]+\}\}$/);
  assert.ok(!JSON.stringify(res).includes("GhPass#7788"), "tool response must not echo plaintext");

  // Verify encrypted persistence on disk
  const rawVault = fs.readFileSync(path.join(dir, "vault.json"), "utf-8");
  assert.ok(!rawVault.includes("GhPass#7788"), "disk vault.json must not contain plaintext");

  // Clear ephemeral memory (simulate server restart / 30 min expiry) and fetch via vault_manage get_secret
  clearEphemeralSecrets();
  const listRes = await runBotCollabTool("vault_manage", { action: "list" }, { store });
  assert.equal(listRes.ok, true);
  const ghEntry = listRes.items.find((it: any) => it.title.includes("GitHub"));
  assert.ok(ghEntry);
  assert.equal(ghEntry.hasPassword, true);
  assert.equal("password" in ghEntry, false);

  const secretRes = await runBotCollabTool(
    "vault_manage",
    { action: "get_secret", item: ghEntry.id },
    { store }
  );
  assert.equal(secretRes.ok, true);
  assert.match(secretRes.secret_ref, /^\{\{secret:cred_[a-f0-9]+\}\}$/);
  assert.ok(!JSON.stringify(secretRes).includes("GhPass#7788"));
  const resolved = resolveEphemeralSecretPlaceholders(secretRes.secret_ref);
  assert.equal(resolved.resolved, "GhPass#7788");
});

test("HTTP /api/vault sanitizes password on GET/POST/PATCH and reveals only on POST /api/vault/:id/reveal", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-vault-http-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStore(dir);
  const srv = createServer({
    store,
    config: { port: 0, host: "127.0.0.1", dataDir: dir },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => srv.close(() => resolve())));
  const addr = srv.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;

  // POST with password
  const createRes = await fetch(`${base}/api/vault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "credential",
      title: "Staging Admin",
      subtitle: "admin@staging.local",
      password: "InitialSecret!1",
    }),
  });
  assert.equal(createRes.status, 201);
  const created: any = await createRes.json();
  assert.equal(created.hasPassword, true);
  assert.equal("password" in created, false);

  // GET list never returns plaintext password
  const listData: any = await (await fetch(`${base}/api/vault`)).json();
  const listed = listData.items.find((x: any) => x.id === created.id);
  assert.equal(listed.hasPassword, true);
  assert.equal("password" in listed, false);

  // POST /reveal returns decrypted password
  const revealData: any = await (
    await fetch(`${base}/api/vault/${created.id}/reveal`, { method: "POST" })
  ).json();
  assert.equal(revealData.hasPassword, true);
  assert.equal(revealData.password, "InitialSecret!1");

  // PATCH without password preserves existing password
  const patch1: any = await (
    await fetch(`${base}/api/vault/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Staging Admin v2" }),
    })
  ).json();
  assert.equal(patch1.hasPassword, true);
  const revealAfterPatch1: any = await (
    await fetch(`${base}/api/vault/${created.id}/reveal`, { method: "POST" })
  ).json();
  assert.equal(revealAfterPatch1.password, "InitialSecret!1");

  // PATCH with empty password clears stored password
  const patch2: any = await (
    await fetch(`${base}/api/vault/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "" }),
    })
  ).json();
  assert.equal(patch2.hasPassword, false);
});
