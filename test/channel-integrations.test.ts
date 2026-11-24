import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  chunkChannelText,
  decodeFeishuPbFrame,
  decryptFeishuEvent,
  encodeFeishuPbFrame,
  formatFeishuApiError,
  isSenderAllowed,
  parseApprovalCommand,
  parseFeishuWebhookPayload,
  parseTelegramUpdate,
  parseWhitelistIds,
  sendFeishuMessage,
  testFeishuChannel,
} from "../src/lib/channel-integrations.js";
import { createChannelManager } from "../src/lib/channel-manager.js";
import { createRunner } from "../src/agent/runner.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

function encryptFeishuPayloadForTest(obj: Record<string, any>, encryptKey: string): string {
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(obj), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

test("channel parsing, whitelist, approval commands, pbbp2 protobuf codec, and Feishu AES-256-CBC decryption", () => {
  assert.deepEqual(parseWhitelistIds("123, 456\nou_abc;123"), ["123", "456", "ou_abc"]);
  assert.equal(isSenderAllowed([], ["123"]), false);
  assert.equal(isSenderAllowed(["123", "ou_abc"], ["999"]), false);
  assert.equal(isSenderAllowed(["123", "ou_abc"], ["ou_abc"]), true);
  assert.equal(isSenderAllowed(["*"], ["anyone"]), true);

  assert.equal(parseApprovalCommand("允许"), true);
  assert.equal(parseApprovalCommand("/approve"), true);
  assert.equal(parseApprovalCommand("YES"), true);
  assert.equal(parseApprovalCommand("拒绝"), false);
  assert.equal(parseApprovalCommand("/deny"), false);
  assert.equal(parseApprovalCommand("继续查询天气"), null);

  const chunks = chunkChannelText("a".repeat(25) + "\n" + "b".repeat(25), 30);
  assert.equal(chunks.length, 2);

  // Feishu pbbp2.Frame binary protobuf roundtrip (including payload lengths 123/125 == 0x7b/0x7d)
  const payloadJson = JSON.stringify({ pad: "x".repeat(95), text: "hello" });
  const encodedFrame = encodeFeishuPbFrame({
    seqId: 9007199254740993n,
    logId: 42n,
    service: 33554432,
    method: 1,
    headers: [
      { key: "type", value: "event" },
      { key: "message_id", value: "msg-123" },
    ],
    payloadType: "json",
    payload: Buffer.from(payloadJson, "utf8"),
  });
  const decodedFrame = decodeFeishuPbFrame(encodedFrame);
  assert.equal(decodedFrame.seqId, 9007199254740993n);
  assert.equal(decodedFrame.logId, 42n);
  assert.equal(decodedFrame.service, 33554432);
  assert.equal(decodedFrame.method, 1);
  assert.deepEqual(decodedFrame.headers, [
    { key: "type", value: "event" },
    { key: "message_id", value: "msg-123" },
  ]);
  assert.equal(decodedFrame.payload?.toString("utf8"), payloadJson);

  // Feishu AES-256-CBC encrypted url_verification + plaintext downgrade protection
  const encKey = "feishu-test-encrypt-key";
  const encryptedChallenge = encryptFeishuPayloadForTest(
    { type: "url_verification", token: "vtok", challenge: "abc-999" },
    encKey
  );
  assert.deepEqual(decryptFeishuEvent(encryptedChallenge, encKey), {
    type: "url_verification",
    token: "vtok",
    challenge: "abc-999",
  });
  const parsedChallenge = parseFeishuWebhookPayload(
    { encrypt: encryptedChallenge },
    { verificationToken: "vtok", encryptKey: encKey }
  );
  assert.deepEqual(parsedChallenge, { kind: "challenge", challenge: "abc-999" });

  // Plaintext payload MUST be rejected when encryptKey is configured in webhook mode
  assert.throws(
    () =>
      parseFeishuWebhookPayload(
        { type: "url_verification", token: "vtok", challenge: "downgrade" },
        { verificationToken: "vtok", encryptKey: encKey },
        { requireVerificationToken: true, requireEncryptionIfConfigured: true }
      ),
    /unencrypted webhook payload rejected/i
  );

  const tgMsg = parseTelegramUpdate({
    update_id: 77,
    message: {
      message_id: 10,
      chat: { id: 555 },
      from: { id: 888, first_name: "Alice" },
      text: "Hello TwinkleBot",
    },
  });
  assert.deepEqual(tgMsg, {
    channel: "telegram-bot",
    eventId: "tg:77",
    chatId: "555",
    senderId: "888",
    senderName: "Alice",
    text: "Hello TwinkleBot",
  });
});

test("Telegram & Feishu channel HTTP lifecycle wired to REAL createRunner(): answer/done events, 2-arg approve, rapid concurrent turns, webhook mode guards, apiBaseUrl anti-exfil, and skill purge", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-channels-real-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  const outgoingCalls: Array<{ url: string; body: any }> = [];
  let approvalResolutions: boolean[] = [];

  // Wire REAL createRunner() with real event contract (`type: "answer"`, `status: "done"`, 2-arg `approve(callId, allowed)`)
  const realRunner = createRunner({
    store,
    config: {
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
      writeRoots: [tmpDir],
    },
    runTaskImpl: (async ({ userText, deps, control }: any) => {
      deps.emit({ type: "user", text: userText });
      deps.emit({ type: "status", status: "running" });

      if (String(userText).includes("高危")) {
        const callId = `call-danger-${Date.now()}`;
        const approvalPromise = control.requestApproval(callId);
        deps.emit({
          type: "approval_request",
          callId,
          name: "host_run_shell",
          reason: "删除系统目录文件",
        });
        deps.emit({ type: "status", status: "awaiting_approval" });
        const allowed = await approvalPromise;
        approvalResolutions.push(Boolean(allowed));
        deps.emit({ type: "approval", callId, allowed: Boolean(allowed) });
        const reply = allowed ? "审批通过并执行完成" : "用户已拒绝高危操作";
        deps.emit({ type: "answer", text: reply });
        deps.emit({ type: "status", status: "done" });
        return { status: "done", text: reply };
      }

      if (String(userText).includes("慢任务")) {
        await new Promise((r) => setTimeout(r, 40));
      }
      const answer = `真实Runner回复：${userText}`;
      deps.emit({ type: "answer", text: answer });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: answer };
    }) as any,
  });

  const mockFetch: any = async (url: string, init?: RequestInit) => {
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
    outgoingCalls.push({ url: String(url), body: parsedBody });

    if (String(url).includes("/getMe")) {
      return new Response(
        JSON.stringify({ ok: true, result: { id: 1001, username: "twinkle_test_bot", first_name: "TwinkleTG" } }),
        { status: 200 }
      );
    }
    if (String(url).includes("/sendMessage")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }
    if (String(url).includes("/tenant_access_token/internal")) {
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: "t-mock-token", expire: 7200 }),
        { status: 200 }
      );
    }
    if (String(url).includes("/bot/v3/info")) {
      return new Response(
        JSON.stringify({ code: 0, bot: { app_name: "TwinkleFeishu", open_id: "ou_bot_1" } }),
        { status: 200 }
      );
    }
    if (String(url).includes("/open-apis/im/v1/messages")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const srv = createServer({
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      deployEnv: "local",
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
      writeRoots: [tmpDir],
      screen: { width: 1440, height: 900 },
    },
    store,
    executor: { health: async () => ({ ok: true }), call: async () => ({ ok: true }) } as any,
    runner: realRunner,
    billingFetchImpl: mockFetch,
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    realRunner.stop();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  // 1. Install both channel skills
  assert.equal((await fetch(`${baseUrl}/api/skills/telegram-bot/install`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/skills/feishu-bot/install`, { method: "POST" })).status, 200);

  // 2. Enabling webhook mode WITHOUT webhookSecret / verificationToken must be rejected with 400
  const noSecretWebhook = await fetch(`${baseUrl}/api/integrations/channels/telegram-bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      connectionMode: "webhook",
      botToken: "999999:SUPER_SECRET_TG_TOKEN",
      webhookSecret: "",
    }),
  });
  assert.equal(noSecretWebhook.status, 400);

  // 3. Save Telegram in polling mode first -> verify webhook endpoint is blocked (403) while in polling mode!
  await fetch(`${baseUrl}/api/integrations/channels/telegram-bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: false,
      connectionMode: "polling",
      botToken: "999999:SUPER_SECRET_TG_TOKEN",
      allowedSenderIds: ["user_allowed_1"],
    }),
  });
  const pollingHookBlocked = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      update_id: 199,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "伪造请求" },
    }),
  });
  assert.equal(pollingHookBlocked.status, 403, "Webhook route must reject requests when not in webhook mode");

  // 4. Configure Telegram in webhook mode with secret + verify anti-exfiltration on /test with overridden apiBaseUrl
  const saveTgRes: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/telegram-bot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        connectionMode: "webhook",
        webhookSecret: "tg-hook-secret",
        defaultSessionId: adminBot.id,
        allowedSenderIds: ["user_allowed_1"],
        approvalMode: "channel_and_app",
      }),
    })
  ).json();
  assert.equal(saveTgRes.ok, true);
  assert.equal(saveTgRes.channels["telegram-bot"].config.hasBotToken, true);
  assert.equal(saveTgRes.settings.skillsCatalog.platform.find((s: any) => s.id === "telegram-bot")?.savedAccountCount, 1);

  const rawChannelsDisk = fs.readFileSync(path.join(tmpDir, "channels-auth.json"), "utf8");
  assert.ok(!rawChannelsDisk.includes("SUPER_SECRET_TG_TOKEN"), "channels-auth.json must be AES-256-GCM encrypted on disk");

  // Overriding apiBaseUrl without re-entering botToken must NOT exfiltrate stored botToken
  const exfilAttempt = await fetch(`${baseUrl}/api/integrations/channels/telegram-bot/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiBaseUrl: "https://evil-collector.example.com" }),
  });
  assert.equal(exfilAttempt.status, 400);
  assert.ok(!outgoingCalls.some((c) => c.url.includes("evil-collector.example.com")));

  // Normal test with stored apiBaseUrl succeeds
  const tgTest: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/telegram-bot/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  assert.equal(tgTest.ok, true);
  assert.equal(tgTest.botName, "TwinkleTG");

  // 5. Concurrent rapid messages from authorized sender serialize cleanly without "a task is already running"
  await Promise.all([
    fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
      },
      body: JSON.stringify({
        update_id: 201,
        message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "慢任务A" },
      }),
    }),
    fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
      },
      body: JSON.stringify({
        update_id: 202,
        message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "慢任务B" },
      }),
    }),
  ]);
  for (let i = 0; i < 30; i++) {
    const sentTexts = outgoingCalls
      .filter((c) => c.url.includes("/sendMessage"))
      .map((c) => String(c.body?.text || ""));
    if (sentTexts.some((t) => t.includes("真实Runner回复：慢任务A")) && sentTexts.some((t) => t.includes("真实Runner回复：慢任务B"))) {
      break;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  const allTgTexts = outgoingCalls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String(c.body?.text || ""));
  assert.ok(allTgTexts.some((t) => t.includes("真实Runner回复：慢任务A")), `missing reply A in ${JSON.stringify(allTgTexts)}`);
  assert.ok(allTgTexts.some((t) => t.includes("真实Runner回复：慢任务B")), `missing reply B in ${JSON.stringify(allTgTexts)}`);

  // 6. Real Runner high-risk approval (both channel_and_app allow AND app_only auto-deny)
  await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
    },
    body: JSON.stringify({
      update_id: 203,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "执行高危脚本" },
    }),
  });
  await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
    },
    body: JSON.stringify({
      update_id: 204,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "允许" },
    }),
  });
  assert.deepEqual(approvalResolutions, [true]);
  assert.ok(
    outgoingCalls.some(
      (c) => c.url.includes("/sendMessage") && String(c.body?.text || "").includes("审批通过并执行完成")
    ),
    "Real runner must resume after 2-arg approve(callId, true) and deliver final answer"
  );

  // Switch approvalMode to app_only -> auto-denies cleanly without deadlocking runner
  await fetch(`${baseUrl}/api/integrations/channels/telegram-bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      connectionMode: "webhook",
      webhookSecret: "tg-hook-secret",
      defaultSessionId: adminBot.id,
      allowedSenderIds: ["user_allowed_1"],
      approvalMode: "app_only",
    }),
  });
  await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
    },
    body: JSON.stringify({
      update_id: 205,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "再次执行高危脚本" },
    }),
  });
  assert.deepEqual(approvalResolutions, [true, false]);
  assert.equal(realRunner.isSessionBusy(adminBot.id), false, "app_only auto-deny must resolve pending approval immediately");

  // 7. Feishu webhook + purgeCredentials
  await fetch(`${baseUrl}/api/integrations/channels/feishu-bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      connectionMode: "webhook",
      appId: "cli_test_app",
      appSecret: "FEISHU_SECRET_XYZ",
      verificationToken: "fs-vtok",
      allowedSenderIds: ["ou_boss"],
    }),
  });
  await fetch(`${baseUrl}/api/channels/feishu/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      header: { event_id: "fs-ev-1", event_type: "im.message.receive_v1", token: "fs-vtok" },
      event: {
        sender: { sender_id: { open_id: "ou_boss" } },
        message: { chat_id: "oc_group_1", content: JSON.stringify({ text: "飞书消息测试" }) },
      },
    }),
  });
  assert.ok(
    outgoingCalls.some(
      (c) =>
        c.url.includes("/open-apis/im/v1/messages") &&
        String(c.body?.content || "").includes("真实Runner回复：飞书消息测试")
    ),
    "Bot reply must be sent back to Feishu chat"
  );

  const rmRes = await fetch(`${baseUrl}/api/skills/feishu-bot?purgeCredentials=true`, {
    method: "DELETE",
  });
  assert.equal(rmRes.status, 200);
  const afterPurge: any = await (await fetch(`${baseUrl}/api/integrations/channels`)).json();
  assert.equal(afterPurge.channels["feishu-bot"].config.hasAppSecret, false);
});

test("Feishu WebSocket Long Connection handles binary pbbp2.Frame events, returns <3s binary ACK, and delivers Bot reply", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-feishu-ws-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  store.writeSettings({ installedSkills: ["feishu-bot"] });

  const wsHttp = http.createServer();
  const ackFrames: Buffer[] = [];
  let pushBinaryFrameToClient: any = null;
  let activeUpgradeSocket: any = null;

  wsHttp.on("upgrade", (req, socket) => {
    activeUpgradeSocket = socket;
    socket.on("error", () => {});
    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n")
    );
    pushBinaryFrameToClient = (payload: Buffer) => {
      const len = payload.length;
      const head =
        len < 126
          ? Buffer.from([0x82, len])
          : Buffer.from([0x82, 126, (len >> 8) & 0xff, len & 0xff]);
      socket.write(Buffer.concat([head, payload]));
    };
    let rxBuf: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 2) {
        const opcode = rxBuf[0] & 0x0f;
        const masked = (rxBuf[1] & 0x80) !== 0;
        let len = rxBuf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (rxBuf.length < 4) return;
          len = rxBuf.readUInt16BE(2);
          offset = 4;
        }
        const totalNeeded = offset + (masked ? 4 : 0) + len;
        if (rxBuf.length < totalNeeded) return;
        const mask = masked ? rxBuf.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        const body = Buffer.from(rxBuf.subarray(offset, offset + len));
        rxBuf = Buffer.from(rxBuf.subarray(offset + len));
        if (mask) {
          for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        }
        if (opcode === 0x08) {
          socket.end();
          return;
        }
        if (opcode === 0x02) {
          ackFrames.push(body);
        }
      }
    });
  });

  await new Promise<void>((resolve) => wsHttp.listen(0, "127.0.0.1", resolve));
  const wsPort = (wsHttp.address() as AddressInfo).port;

  const feishuMessagesSent: string[] = [];
  const realRunner = createRunner({
    store,
    runTaskImpl: (async ({ userText, deps }: any) => {
      deps.emit({ type: "answer", text: `WS回复：${userText}` });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: `WS回复：${userText}` };
    }) as any,
  });

  store.writeChannelsAuth({
    "feishu-bot": {
      enabled: true,
      connectionMode: "websocket",
      domain: "feishu",
      apiBaseUrl: `http://127.0.0.1:${wsPort}`,
      appId: "cli_a1b2c3d4e5f60708",
      appSecret: "sec_ws_1234567890123456789012345",
      verificationToken: "",
      encryptKey: "",
      defaultSessionId: adminBot.id,
      allowedSenderIds: ["ou_ws_user"],
      approvalMode: "channel_and_app",
    },
  });

  const mgr = createChannelManager({
    store,
    runner: realRunner,
    getInstalledSkills: () => ["feishu-bot"],
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/callback/ws/endpoint")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: `ws://127.0.0.1:${wsPort}/ws?device_id=dev_1&service_id=777`,
              ClientConfig: {
                PingInterval: 60,
                ReconnectCount: 3,
                ReconnectInterval: 5,
                ReconnectNonce: 1,
              },
            },
          }),
          { status: 200 }
        );
      }
      if (String(url).includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-ws", expire: 7200 }), { status: 200 });
      }
      if (String(url).includes("/open-apis/im/v1/messages")) {
        const parsed = JSON.parse(String(init?.body || "{}"));
        feishuMessagesSent.push(String(parsed.content || ""));
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any,
  });

  t.after(async () => {
    mgr.stopAll();
    realRunner.stop();
    try {
      activeUpgradeSocket?.destroy();
    } catch {}
    wsHttp.closeAllConnections?.();
    await new Promise<void>((resolve) => wsHttp.close(() => resolve()));
  });

  mgr.syncFromStore();
  for (
    let i = 0;
    i < 60 &&
    (!pushBinaryFrameToClient || mgr.getStatusPayload()["feishu-bot"].runtime.status !== "connected");
    i++
  ) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(pushBinaryFrameToClient, "Feishu WebSocket client must connect to endpoint");
  assert.equal(mgr.getStatusPayload()["feishu-bot"].runtime.status, "connected");

  // Push binary pbbp2 DATA frame split into 2 fragments (sum=2, seq=0 & seq=1)
  const fullEventBuf = Buffer.from(
    JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev-ws-bin-1", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_ws_user" } },
        message: { chat_id: "oc_ws_chat", content: JSON.stringify({ text: "长连接二进制测试" }) },
      },
    }),
    "utf8"
  );
  const mid = Math.floor(fullEventBuf.length / 2);
  pushBinaryFrameToClient!(
    encodeFeishuPbFrame({
      seqId: 101n,
      logId: 202n,
      service: 777,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "frag-1" },
        { key: "sum", value: "2" },
        { key: "seq", value: "0" },
      ],
      payload: fullEventBuf.subarray(0, mid),
    })
  );
  pushBinaryFrameToClient!(
    encodeFeishuPbFrame({
      seqId: 102n,
      logId: 202n,
      service: 777,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "frag-1" },
        { key: "sum", value: "2" },
        { key: "seq", value: "1" },
      ],
      payload: fullEventBuf.subarray(mid),
    })
  );

  for (let i = 0; i < 60 && (ackFrames.filter((b) => decodeFeishuPbFrame(b).method === 1).length === 0 || feishuMessagesSent.length === 0); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const dataAckFrames = ackFrames.map(decodeFeishuPbFrame).filter((f) => f.method === 1);
  assert.ok(dataAckFrames.length >= 1, "Official Lark WSClient must send binary pbbp2 DATA ACK frame back to server");
  const ackDecoded = dataAckFrames[0];
  assert.equal(ackDecoded.seqId, 102n);
  assert.equal(ackDecoded.method, 1);
  assert.deepEqual(JSON.parse(ackDecoded.payload!.toString("utf8")), { code: 200 });
  assert.ok(
    feishuMessagesSent.some((s) => s.includes("WS回复：长连接二进制测试")),
    `Expected WS reply in ${JSON.stringify(feishuMessagesSent)}`
  );
});

test("Feishu diagnostics: code 21001 guidance, WS endpoint probe in websocket test mode, and sendFeishuMessage error checking", async () => {
  assert.match(formatFeishuApiError(21001, "Access denied due to platform policy", 200), /21001.*企业\/团队组织/);

  // Simulate code 21001 on tenant_access_token while /callback/ws/endpoint succeeds
  const mockFetch21001: any = async (url: string) => {
    if (String(url).includes("/tenant_access_token/internal")) {
      return new Response(
        JSON.stringify({ code: 21001, msg: "Access denied due to platform policy." }),
        { status: 200 }
      );
    }
    if (String(url).includes("/callback/ws/endpoint")) {
      return new Response(
        JSON.stringify({ code: 0, data: { URL: "wss://msg-frontier.feishu.cn/ws/v2?service_id=1" } }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 200 });
  };
  const diag = await testFeishuChannel(
    { appId: "cli_test", appSecret: "sec_test", domain: "feishu", apiBaseUrl: "", connectionMode: "websocket" },
    mockFetch21001
  );
  assert.equal(diag.ok, false);
  assert.match(diag.error || "", /长连接入口可通.*21001/);

  // sendFeishuMessage (via @larksuiteoapi/node-sdk Client) must throw with feishuCode when Feishu returns non-zero code
  const mockFailSend: any = async (url: string) => {
    if (String(url).includes("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-ok", expire: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 99991663, msg: "Invalid access token" }), { status: 200 });
  };
  await assert.rejects(
    () =>
      sendFeishuMessage(
        { appId: "cli_test", appSecret: "sec_test", domain: "feishu", apiBaseUrl: "" },
        "oc_chat_1",
        "hello",
        mockFailSend
      ),
    (err: any) => err?.feishuCode === 99991663
  );
});

test("Telegram grammy Bot long-polling lifecycle: getMe -> getUpdates -> real Runner -> sendMessage -> clean stop", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tg-grammy-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  const sentReplies: Array<{ chat_id: any; text: string }> = [];
  let deliveredUpdate = false;

  const realRunner = createRunner({
    store,
    runTaskImpl: (async ({ userText, deps }: any) => {
      deps.emit({ type: "answer", text: `Grammy回复：${userText}` });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: `Grammy回复：${userText}` };
    }) as any,
  });

  store.writeChannelsAuth({
    "telegram-bot": {
      enabled: true,
      connectionMode: "polling",
      botToken: "123456:GRAMMY_TEST_TOKEN",
      webhookSecret: "",
      apiBaseUrl: "http://127.0.0.1:9",
      defaultSessionId: adminBot.id,
      allowedSenderIds: ["tg_u_99"],
      approvalMode: "channel_and_app",
    },
  });

  let stateChanges = 0;
  const mgr = createChannelManager({
    store,
    runner: realRunner,
    getInstalledSkills: () => ["telegram-bot"],
    onStateChange: () => {
      stateChanges += 1;
    },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 7001,
              is_bot: true,
              first_name: "TwinkleGrammy",
              username: "twinkle_grammy_bot",
              can_join_groups: true,
              can_read_all_group_messages: false,
              supports_inline_queries: false,
            },
          }),
          { status: 200 }
        );
      }
      if (u.includes("/getUpdates")) {
        if (!deliveredUpdate) {
          deliveredUpdate = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 501,
                  message: {
                    message_id: 1,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: 8899, type: "private" },
                    from: { id: "tg_u_99", is_bot: false, first_name: "Bob" },
                    text: "你好 Grammy",
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }
        // Hold subsequent poll briefly until aborted by stopAll()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          timer.unref?.();
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      if (u.includes("/sendMessage")) {
        const parsed = JSON.parse(String(init?.body || "{}"));
        sentReplies.push({ chat_id: parsed.chat_id, text: parsed.text });
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 2, date: 0, chat: { id: parsed.chat_id, type: "private" }, text: parsed.text },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as any,
  });

  t.after(() => {
    mgr.stopAll();
    realRunner.stop();
  });

  mgr.syncFromStore();
  for (let i = 0; i < 60 && sentReplies.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const rt = mgr.getStatusPayload()["telegram-bot"].runtime;
  assert.equal(rt.status, "connected");
  assert.equal(rt.botName, "TwinkleGrammy");
  assert.ok(stateChanges >= 1, "onStateChange must fire on connected transition");
  assert.ok(
    sentReplies.some((r) => String(r.chat_id) === "8899" && r.text.includes("Grammy回复：你好 Grammy")),
    `Expected Grammy reply, got ${JSON.stringify(sentReplies)}`
  );
});
