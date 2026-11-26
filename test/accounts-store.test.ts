import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_ACCOUNT_ID,
  normalizeAccountsState,
  upsertCloudAccount,
  removeCloudAccount,
  setActiveAccount,
  buildWsUrlFromBase,
} from "../src/shared/accounts-store.js";

test("normalizeAccountsState always guarantees exactly one immutable local account", () => {
  const init = normalizeAccountsState(null, "http://127.0.0.1:3230");
  assert.equal(init.activeAccountId, LOCAL_ACCOUNT_ID);
  assert.equal(init.accounts.length, 1);
  assert.equal(init.accounts[0].id, LOCAL_ACCOUNT_ID);
  assert.equal(init.accounts[0].type, "local");
  assert.equal(init.accounts[0].baseUrl, "http://127.0.0.1:3230");

  // Extra local entries are rejected or collapsed to single local instance
  assert.throws(
    () =>
      upsertCloudAccount(init, {
        id: "local-2",
        type: "local",
        name: "Second Local",
        baseUrl: "http://127.0.0.1:3231",
      }),
    /only one local account is allowed/i
  );

  // Local account cannot be deleted
  assert.throws(
    () => removeCloudAccount(init, LOCAL_ACCOUNT_ID),
    /local account cannot be deleted/i
  );
});

test("upsertCloudAccount, setActiveAccount, and removeCloudAccount manage N cloud accounts cleanly", () => {
  let state = normalizeAccountsState(null, "http://127.0.0.1:3230");
  state = upsertCloudAccount(state, {
    id: "cloud-prod",
    name: "生产云端",
    baseUrl: "https://bot.acme.com/",
    authToken: "tok-prod",
  });
  state = upsertCloudAccount(state, {
    id: "cloud-dev",
    name: "测试云端",
    baseUrl: "http://10.0.0.5:3230",
    authToken: "tok-dev",
  });

  assert.equal(state.accounts.length, 3);
  assert.equal(state.accounts[1].baseUrl, "https://bot.acme.com");
  assert.equal(state.accounts[1].wsUrl, "wss://bot.acme.com/ws");
  assert.equal(state.accounts[2].wsUrl, "ws://10.0.0.5:3230/ws");
  assert.equal(buildWsUrlFromBase("https://bot.acme.com"), "wss://bot.acme.com/ws");

  state = setActiveAccount(state, "cloud-prod");
  assert.equal(state.activeAccountId, "cloud-prod");

  // Removing active cloud account falls back cleanly to local account
  state = removeCloudAccount(state, "cloud-prod");
  assert.equal(state.activeAccountId, LOCAL_ACCOUNT_ID);
  assert.equal(state.accounts.length, 2);
});

test("mobile mode (allowLocal=false) strips local account, avoids local fallback, and returns empty state when all removed", () => {
  const mobileOpts = { allowLocal: false };
  const emptyInit = normalizeAccountsState(null, "http://127.0.0.1:3230", mobileOpts);
  assert.equal(emptyInit.activeAccountId, "");
  assert.deepEqual(emptyInit.accounts, []);

  // Legacy persisted state containing a ghost "local" account is sanitized automatically
  const migrated = normalizeAccountsState(
    {
      activeAccountId: LOCAL_ACCOUNT_ID,
      accounts: [
        { id: LOCAL_ACCOUNT_ID, type: "local", name: "本地账号", baseUrl: "http://127.0.0.1:3230" },
        { id: "cloud-1", type: "cloud", name: "云端节点", baseUrl: "https://bot.acme.com" },
      ],
    },
    "http://127.0.0.1:3230",
    mobileOpts
  );
  assert.equal(migrated.accounts.length, 1);
  assert.equal(migrated.accounts[0].id, "cloud-1");
  assert.equal(migrated.activeAccountId, "cloud-1");

  const afterRemove = removeCloudAccount(migrated, "cloud-1", mobileOpts);
  assert.equal(afterRemove.activeAccountId, "");
  assert.deepEqual(afterRemove.accounts, []);
});
