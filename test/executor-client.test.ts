import test from "node:test";
import assert from "node:assert/strict";
import {
  createBotScopedExecutorClient,
  createExecutorClient,
  ExecutorError,
} from "../src/agent/executor-client.js";

test("call sends bearer token and JSON", async () => {
  let capturedUrl: any;
  let capturedOptions: any;
  const fakeFetch = async (url: any, options: any) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    };
  };

  const client = createExecutorClient({
    url: "http://ubuntu.orb.local:7300",
    token: "test-token",
    fetchImpl: fakeFetch as any,
  });

  const res = await client.call("/click", { x: 100, y: 200 });
  assert.deepEqual(res, { ok: true });
  assert.equal(capturedUrl, "http://ubuntu.orb.local:7300/click");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers["Authorization"], "Bearer test-token");
  assert.equal(capturedOptions.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(capturedOptions.body), { x: 100, y: 200 });
});

test("call normalizes url route without leading slash and trailing baseUrl slash", async () => {
  let capturedUrl: any;
  const fakeFetch = async (url: any) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    };
  };

  const client = createExecutorClient({
    url: "http://ubuntu.orb.local:7300/",
    token: "test-token",
    fetchImpl: fakeFetch as any,
  });

  await client.call("screenshot");
  assert.equal(capturedUrl, "http://ubuntu.orb.local:7300/screenshot");
});

test("health sends GET with bearer token", async () => {
  let capturedUrl: any;
  let capturedOptions: any;
  const fakeFetch = async (url: any, options: any) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, width: 1440, height: 900 }),
    };
  };

  const client = createExecutorClient({
    url: "http://ubuntu.orb.local:7300",
    token: "test-token",
    fetchImpl: fakeFetch as any,
  });

  const res = await client.health();
  assert.deepEqual(res, { ok: true, width: 1440, height: 900 });
  assert.equal(capturedUrl, "http://ubuntu.orb.local:7300/health");
  assert.equal(capturedOptions.method, "GET");
  assert.equal(capturedOptions.headers["Authorization"], "Bearer test-token");
  assert.equal(capturedOptions.body, undefined);
});

test("non-2xx becomes ExecutorError with server message", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "denied" }),
  });

  const client = createExecutorClient({
    url: "http://ubuntu.orb.local:7300",
    token: "test-token",
    fetchImpl: fakeFetch as any,
  });

  await assert.rejects(
    client.call("/read", { path: "/root/.ssh/id_rsa" }),
    (e) => {
      assert.ok(e instanceof ExecutorError);
      assert.equal(e.message, "denied");
      assert.equal(e.status, 403);
      return true;
    }
  );
});

test("non-2xx without error field falls back to status text or HTTP status", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    json: async () => {
      throw new Error("not json");
    },
  });

  const client = createExecutorClient({
    url: "http://ubuntu.orb.local:7300",
    token: "test-token",
    fetchImpl: fakeFetch as any,
  });

  await assert.rejects(
    client.call("/screenshot"),
    (e) => {
      assert.ok(e instanceof ExecutorError);
      assert.equal(e.message, "Internal Server Error");
      assert.equal(e.status, 500);
      return true;
    }
  );
});

test("unreachable executor rejects quickly", async () => {
  const c = createExecutorClient({ url: "http://127.0.0.1:9", token: "t", timeoutMs: 1000 });
  await assert.rejects(
    c.call("/screenshot"),
    (e) => e instanceof ExecutorError && /executor unreachable/.test(e.message) && e.status === 0
  );
});

test("createExecutorClient invokes onUnreachableWake and retries request when WSL wakes up", async () => {
  let attempts = 0;
  let wakes = 0;
  const c = createExecutorClient({
    url: "http://127.0.0.1:7300",
    token: "t",
    fetchImpl: (async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("fetch failed");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ exit_code: 0, stdout: "woken", stderr: "" }),
      };
    }) as any,
    onUnreachableWake: async () => {
      wakes++;
      return true;
    },
  });

  const res = await c.call("/shell", { command: "echo ok" });
  assert.equal(wakes, 1);
  assert.equal(attempts, 2);
  assert.equal(res.stdout, "woken");
});

test("createBotScopedExecutorClient injects X-Twinkle-Bot-Id and X-Twinkle-Bot-Admin headers", async () => {
  let seenHeaders: any = null;
  const base = createExecutorClient({
    url: "http://127.0.0.1:7300",
    token: "tok-s",
    fetchImpl: (async (_url: any, opts: any) => {
      seenHeaders = opts?.headers || {};
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    }) as any,
  });

  const scoped = createBotScopedExecutorClient(base, { botId: "bot-tu", isAdmin: false })!;
  await scoped.call("/screenshot", {});
  assert.equal(seenHeaders["X-Twinkle-Bot-Id"], "bot-tu");
  assert.equal(seenHeaders["X-Twinkle-Bot-Admin"], "0");
  assert.equal(seenHeaders.Authorization, "Bearer tok-s");
});
