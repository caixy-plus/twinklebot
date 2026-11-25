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
  createProxiedFetch,
  createTelegramFetch,
  decodeFeishuPbFrame,
  decryptFeishuEvent,
  encodeFeishuPbFrame,
  extractFeishuMessageText,
  formatFeishuApiError,
  generatePairingCode,
  isSenderAllowed,
  normalizeChannelsAuthStore,
  parseApprovalCommand,
  parseFeishuWebhookPayload,
  parseTelegramUpdate,
  parseWhitelistIds,
  redactProxyUrlForDisplay,
  sanitizeTelegramProxyUrl,
  sendFeishuMessage,
  summarizeChannelStatusForBot,
  testFeishuChannel,
} from "../src/lib/channel-integrations.js";
import { createChannelManager } from "../src/lib/channel-manager.js";
import { redactToolArgsForDisplay, runBotCollabTool } from "../src/agent/bot-tools.js";
import { createModel } from "../src/agent/model.js";
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
    messageId: "10",
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

test("channelManager tracks lastRejectedSender & lastSendError (code 21001), clears on whitelist sync, and exposes sanitized status to bot tools", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ch-diag-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  store.writeSettings({
    ...(store.readSettings?.() || {}),
    installedSkills: ["feishu-bot", "telegram-bot"],
  });

  const FEISHU_SECRET = "sec_super_secret_feishu_xyz";
  const TG_TOKEN = "999888:TG_SUPER_SECRET_TOKEN";
  const VERIFY_TOKEN = "verify_secret_tok";
  const ENCRYPT_KEY = "encrypt_secret_key";
  const TG_WEBHOOK_SECRET = "tg_hook_secret_val";

  store.writeChannelsAuth({
    "feishu-bot": {
      enabled: true,
      connectionMode: "webhook",
      domain: "feishu",
      apiBaseUrl: "",
      appId: "cli_diag_123",
      appSecret: FEISHU_SECRET,
      verificationToken: VERIFY_TOKEN,
      encryptKey: ENCRYPT_KEY,
      defaultSessionId: adminBot.id,
      allowedSenderIds: [],
      approvalMode: "channel_and_app",
    },
    "telegram-bot": {
      enabled: false,
      connectionMode: "webhook",
      botToken: TG_TOKEN,
      webhookSecret: TG_WEBHOOK_SECRET,
      apiBaseUrl: "",
      defaultSessionId: adminBot.id,
      allowedSenderIds: [],
      approvalMode: "channel_and_app",
    },
  });

  let blockToken21001 = true;
  const sentToChat: string[] = [];
  const realRunner = createRunner({
    store,
    runTaskImpl: (async ({ userText, deps }: any) => {
      deps.emit({ type: "answer", text: `已处理：${userText}` });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: `已处理：${userText}` };
    }) as any,
  });

  let stateChanges = 0;
  const mgr = createChannelManager({
    store,
    runner: realRunner,
    getInstalledSkills: () => ["feishu-bot", "telegram-bot"],
    onStateChange: () => {
      stateChanges += 1;
    },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/tenant_access_token/internal")) {
        if (blockToken21001) {
          return new Response(
            JSON.stringify({ code: 21001, msg: "Access denied due to platform policy." }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: "t-ok-2", expire: 7200 }),
          { status: 200 }
        );
      }
      if (u.includes("/open-apis/im/v1/messages")) {
        const parsed = JSON.parse(String(init?.body || "{}"));
        sentToChat.push(String(parsed.content || ""));
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_1" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any,
  });

  t.after(() => {
    mgr.stopAll();
    realRunner.stop();
  });

  mgr.syncFromStore();
  const baselineChanges = stateChanges;

  // 1. Unauthorized message arrives while outbound reply fails with 21001 -> must capture both lastRejectedSender and lastSendError!
  const rejectedOut = await mgr.handleInboundMessage({
    channel: "feishu-bot",
    eventId: "fs:ev-unauth-1",
    chatId: "oc_chat_demo",
    senderId: "ou_user_demo_1",
    senderName: "测试用户",
    text: "你好",
  });
  assert.equal(rejectedOut.handled, false);
  assert.equal(rejectedOut.rejected, true);
  assert.equal(rejectedOut.reason, "unauthorized_sender");

  for (let i = 0; i < 40 && !mgr.getStatusPayload()["feishu-bot"].runtime.lastSendError; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const rtAfterReject = mgr.getStatusPayload()["feishu-bot"].runtime;
  assert.ok(rtAfterReject.lastEventAt, "lastEventAt should be recorded");
  assert.equal(rtAfterReject.lastRejectedSender?.senderId, "ou_user_demo_1");
  assert.equal(rtAfterReject.lastRejectedSender?.chatId, "oc_chat_demo");
  assert.equal(rtAfterReject.lastRejectedSender?.senderName, "测试用户");
  assert.match(rtAfterReject.lastSendError || "", /21001/);
  assert.ok(stateChanges > baselineChanges, "onStateChange must fire on rejected sender & send error");

  // 2. Bot tools (`skill_list` & `system_diagnostics`) must expose sanitized channel state with zero secrets!
  const getChannelStatus = () => mgr.getStatusPayload();
  const skillListRes: any = await runBotCollabTool("skill_list", {}, { store, getChannelStatus });
  const fsEntry = (skillListRes.platform || []).find((p: any) => p.id === "feishu-bot");
  assert.ok(fsEntry?.channel, "skill_list should include feishu-bot channel summary");
  assert.equal(fsEntry.channel.connected, true);
  assert.equal(fsEntry.channel.status, "webhook_ready");
  assert.equal(fsEntry.channel.lastRejectedSender?.senderId, "ou_user_demo_1");
  assert.match(fsEntry.channel.lastSendError || "", /21001/);

  const diagRes: any = await runBotCollabTool(
    "system_diagnostics",
    { action: "status" },
    { store, config: { screen: { width: 1440, height: 900 } }, getChannelStatus }
  );
  assert.equal(diagRes.ok, true);
  assert.equal(diagRes.channels?.["feishu-bot"]?.lastRejectedSender?.senderId, "ou_user_demo_1");
  assert.match(diagRes.channels?.["feishu-bot"]?.lastSendError || "", /21001/);

  const serializedBotSummary = JSON.stringify({
    summarized: summarizeChannelStatusForBot(getChannelStatus()),
    skillListRes,
    diagChannels: diagRes.channels,
  });
  for (const secretVal of [FEISHU_SECRET, TG_TOKEN, VERIFY_TOKEN, ENCRYPT_KEY, TG_WEBHOOK_SECRET]) {
    assert.equal(
      serializedBotSummary.includes(secretVal),
      false,
      `Secret value ${secretVal} must never be exposed in bot tool summaries`
    );
  }

  // 3. Whitelist the captured open_id and clear 21001 block -> syncFromStore clears stale diagnostics and delivers turn cleanly
  const curCfg = store.readChannelsAuth();
  store.writeChannelsAuth({
    ...curCfg,
    "feishu-bot": {
      ...curCfg["feishu-bot"],
      allowedSenderIds: ["ou_user_demo_1"],
    },
  });
  blockToken21001 = false;
  mgr.syncFromStore();

  const rtAfterSync = mgr.getStatusPayload()["feishu-bot"].runtime;
  assert.equal(rtAfterSync.lastRejectedSender, null);
  assert.equal(rtAfterSync.lastSendError, null);

  const okOut = await mgr.handleInboundMessage({
    channel: "feishu-bot",
    eventId: "fs:ev-auth-2",
    chatId: "oc_chat_demo",
    senderId: "ou_user_demo_1",
    senderName: "测试用户",
    text: "现在收到了吗",
  });
  assert.equal(okOut.handled, true);

  for (let i = 0; i < 40 && sentToChat.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(sentToChat.some((m) => m.includes("已处理：现在收到了吗")));
  assert.equal(mgr.getStatusPayload()["feishu-bot"].runtime.lastSendError, null);
});

test("legacy single-bot channels-auth.json migrates cleanly to accounts[] with mirror sync and unique pairing codes", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ch-mig-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const legacyInput = {
    "feishu-bot": {
      enabled: true,
      connectionMode: "websocket",
      domain: "feishu",
      appId: "cli_legacy_123",
      appSecret: "sec_legacy_abc",
      defaultSessionId: "bot_legacy_main",
      allowedSenderIds: ["ou_legacy_1"],
    },
    "telegram-bot": {
      enabled: true,
      connectionMode: "polling",
      botToken: "111222:LEGACY_TG_SECRET",
      allowedSenderIds: ["777888"],
    },
  };

  const normalized = normalizeChannelsAuthStore(legacyInput);
  assert.equal(normalized.feishuAccounts.length, 1);
  assert.equal(normalized.feishuAccounts[0].id, "fs_default");
  assert.equal(normalized.feishuAccounts[0].appId, "cli_legacy_123");
  assert.equal(normalized.feishuAccounts[0].appSecret, "sec_legacy_abc");
  assert.equal(normalized.feishuAccounts[0].defaultSessionId, "bot_legacy_main");
  assert.deepEqual(normalized.feishuAccounts[0].allowedSenderIds, ["ou_legacy_1"]);
  assert.equal(normalized.feishuAccounts[0].requirePairing, true);

  assert.equal(normalized.telegramAccounts.length, 1);
  assert.equal(normalized.telegramAccounts[0].id, "tg_default");
  assert.equal(normalized.telegramAccounts[0].botToken, "111222:LEGACY_TG_SECRET");
  assert.deepEqual(normalized.telegramAccounts[0].allowedSenderIds, ["777888"]);

  const store = createStore(tmpDir);
  store.writeChannelsAuth(normalized);
  const disk = fs.readFileSync(path.join(tmpDir, "channels-auth.json"), "utf8");
  assert.equal(disk.includes("sec_legacy_abc"), false, "appSecret must be encrypted on disk");
  assert.equal(disk.includes("LEGACY_TG_SECRET"), false, "botToken must be encrypted on disk");

  // Legacy single-object patch writes must mirror into accounts[0]
  const cur = store.readChannelsAuth();
  store.writeChannelsAuth({
    ...cur,
    "feishu-bot": {
      ...cur["feishu-bot"],
      allowedSenderIds: ["ou_legacy_1", "ou_mirrored_2"],
    },
  });
  const afterMirror = normalizeChannelsAuthStore(store.readChannelsAuth());
  assert.deepEqual(afterMirror.feishuAccounts[0].allowedSenderIds, [
    "ou_legacy_1",
    "ou_mirrored_2",
  ]);

  const seen = new Set<string>(["123456"]);
  for (let i = 0; i < 30; i += 1) {
    const code = generatePairingCode(seen);
    assert.match(code, /^\d{6}$/);
    assert.equal(seen.has(code), false);
    seen.add(code);
  }
});

test("multi-bot HTTP CRUD, parallel independent Bot routing, and sibling connection isolation", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ch-multi-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  store.ensureAdminBot();
  const botA = store.createSession({ title: "Bot Alpha" });
  const botB = store.createSession({ title: "Bot Beta" });

  const routedTurns: Array<{ sessionId: string; text: string }> = [];
  const sentReplies: Array<{ url: string; body: string }> = [];

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tenant_access_token/internal")) {
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: "t-multi", expire: 7200 }),
        { status: 200 }
      );
    }
    if (u.includes("/bot/v3/info")) {
      return new Response(
        JSON.stringify({ code: 0, bot: { app_name: "MockFeishuMulti" } }),
        { status: 200 }
      );
    }
    if (u.includes("/open-apis/im/v1/messages")) {
      sentReplies.push({ url: u, body: String(init?.body || "") });
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_m1" } }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const realRunner = createRunner({
    store,
    runTaskImpl: (async ({ sessionId, userText, deps }: any) => {
      routedTurns.push({ sessionId, text: userText });
      deps.emit({ type: "answer", text: `${sessionId}:${userText}` });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: `${sessionId}:${userText}` };
    }) as any,
  });

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

  assert.equal((await fetch(`${baseUrl}/api/skills/feishu-bot/install`, { method: "POST" })).status, 200);

  // Create Bot #1 -> bound to botA
  const createA: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "研发助手",
        enabled: true,
        connectionMode: "webhook",
        appId: "cli_alpha",
        appSecret: "sec_alpha",
        verificationToken: "vtok_alpha",
        defaultSessionId: botA.id,
        allowedSenderIds: ["ou_alpha_user"],
      }),
    })
  ).json();
  assert.equal(createA.ok, true);
  const acctA = createA.accountId;
  assert.ok(acctA);

  // Create Bot #2 -> bound to botB
  const createB: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "客服助手",
        enabled: true,
        connectionMode: "webhook",
        appId: "cli_beta",
        appSecret: "sec_beta",
        verificationToken: "vtok_beta",
        defaultSessionId: botB.id,
        allowedSenderIds: ["ou_beta_user"],
      }),
    })
  ).json();
  assert.equal(createB.ok, true);
  const acctB = createB.accountId;
  assert.notEqual(acctA, acctB);
  assert.equal(createB.channels["feishu-bot"].accounts.length, 2);

  // Verify stored webhook URL per bot routes independently to botA vs botB
  await fetch(`${baseUrl}/api/channels/feishu/webhook/${acctA}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_alpha_1", event_type: "im.message.receive_v1", token: "vtok_alpha" },
      event: {
        sender: { sender_id: { open_id: "ou_alpha_user" } },
        message: {
          message_id: "om_alpha_1",
          chat_id: "oc_alpha",
          message_type: "text",
          content: JSON.stringify({ text: "hello alpha" }),
        },
      },
    }),
  });
  await fetch(`${baseUrl}/api/channels/feishu/webhook/${acctB}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_beta_1", event_type: "im.message.receive_v1", token: "vtok_beta" },
      event: {
        sender: { sender_id: { open_id: "ou_beta_user" } },
        message: {
          message_id: "om_beta_1",
          chat_id: "oc_beta",
          message_type: "text",
          content: JSON.stringify({ text: "hello beta" }),
        },
      },
    }),
  });

  for (let i = 0; i < 40 && routedTurns.length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(routedTurns.some((t) => t.sessionId === botA.id && t.text === "hello alpha"));
  assert.ok(routedTurns.some((t) => t.sessionId === botB.id && t.text === "hello beta"));

  // Updating & testing Bot B does not disturb Bot A
  const patchB: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts/${acctB}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "客服助手 V2" }),
    })
  ).json();
  assert.equal(patchB.ok, true);
  assert.equal(
    patchB.channels["feishu-bot"].accounts.find((a: any) => a.id === acctB)?.config.label,
    "客服助手 V2"
  );
  assert.equal(
    patchB.channels["feishu-bot"].accounts.find((a: any) => a.id === acctA)?.runtime.status,
    "webhook_ready"
  );

  const testA: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts/${acctA}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  assert.equal(testA.ok, true);

  // Test creating new bot with isNew: true & empty secret must NOT fall back to existing Bot A secret!
  const blankNewTest = await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isNew: true, appId: "cli_alpha" }),
  });
  assert.equal(blankNewTest.status, 400);

  // Delete Bot B -> Bot A remains configured and ready
  const delB: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts/${acctB}`, {
      method: "DELETE",
    })
  ).json();
  assert.equal(delB.ok, true);
  assert.equal(delB.channels["feishu-bot"].accounts.length, 1);
  assert.equal(delB.channels["feishu-bot"].accounts[0].id, acctA);
  assert.ok(sentReplies.length >= 2);
});

test("dual-channel 6-digit pairing lifecycle, bot tool security boundary, suspend/resume/delete, and requirePairing=false mode", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ch-pair-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  const outboundMessages: Array<{ url: string; text: string }> = [];

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tenant_access_token/internal")) {
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: "t-pair", expire: 7200 }),
        { status: 200 }
      );
    }
    if (u.includes("/open-apis/im/v1/messages") || u.includes("/sendMessage")) {
      outboundMessages.push({ url: u, text: String(init?.body || "") });
      return new Response(
        JSON.stringify(
          u.includes("/sendMessage")
            ? { ok: true, result: { message_id: 99 } }
            : { code: 0, data: { message_id: "om_p1" } }
        ),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  let runnerCalls = 0;
  const realRunner = createRunner({
    store,
    runTaskImpl: (async ({ userText, deps }: any) => {
      runnerCalls += 1;
      deps.emit({ type: "answer", text: `PASS:${userText}` });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: `PASS:${userText}` };
    }) as any,
  });

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

  await fetch(`${baseUrl}/api/skills/feishu-bot/install`, { method: "POST" });
  await fetch(`${baseUrl}/api/skills/telegram-bot/install`, { method: "POST" });

  const fsCreate: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "配对飞书Bot",
        enabled: true,
        connectionMode: "webhook",
        appId: "cli_pair",
        appSecret: "sec_pair",
        verificationToken: "vtok_pair",
        defaultSessionId: adminBot.id,
        requirePairing: true,
        allowedSenderIds: [],
      }),
    })
  ).json();
  const fsAcctId = fsCreate.accountId;

  const tgCreate: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/telegram-bot/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "配对TG Bot",
        enabled: true,
        connectionMode: "webhook",
        botToken: "555:TG_PAIR_TOK",
        webhookSecret: "tg_pair_sec",
        defaultSessionId: adminBot.id,
        requirePairing: true,
        allowedSenderIds: [],
      }),
    })
  ).json();
  const tgAcctId = tgCreate.accountId;

  // 1. Unknown Feishu sender triggers 6-digit pairing code
  await fetch(`${baseUrl}/api/channels/feishu/webhook/${fsAcctId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_pair_1", event_type: "im.message.receive_v1", token: "vtok_pair" },
      event: {
        sender: { sender_id: { open_id: "ou_new_1" } },
        message: {
          message_id: "om_pair_1",
          chat_id: "oc_new_chat_1",
          message_type: "text",
          content: JSON.stringify({ text: "请求配对" }),
        },
      },
    }),
  });
  assert.equal(runnerCalls, 0);

  const pairings1: any = await (await fetch(`${baseUrl}/api/integrations/channels/pairings`)).json();
  assert.equal(pairings1.ok, true);
  assert.equal(pairings1.pending.length, 1);
  const fsCode = pairings1.pending[0].code;
  assert.match(fsCode, /^\d{6}$/);
  assert.ok(outboundMessages.some((m) => m.text.includes(fsCode)));

  // System settings reflects pendingPairingCount = 1 for feishu-bot & diagnostics advertises capability
  const sysDiag: any = await (await fetch(`${baseUrl}/api/system/diagnostics`)).json();
  assert.ok(sysDiag.apiCapabilities?.includes("channel-multi-bot-pairing-v1"));
  const sysSettings: any = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(
    sysSettings.skillsCatalog?.platform?.find((p: any) => p.id === "feishu-bot")?.pendingPairingCount,
    1
  );

  // 2. Security check: external channel context MUST NOT execute channel_pairing_manage mutations
  const blockedFromExternal: any = await runBotCollabTool(
    "channel_pairing_manage",
    { action: "approve", code: fsCode },
    {
      store,
      senderSessionId: adminBot.id,
      senderBot: adminBot,
      channelPairingActions: (realRunner as any).channelPairingActions,
      userMeta: { channelMeta: { channel: "feishu-bot", chatId: "oc_attacker", senderId: "ou_attacker" } },
    }
  );
  assert.equal(blockedFromExternal.ok, false);

  // 3. Approve via App-side Bot tool (channel_pairing_manage)
  const appApproveRes: any = await runBotCollabTool(
    "channel_pairing_manage",
    { action: "approve", code: fsCode },
    {
      store,
      senderSessionId: adminBot.id,
      senderBot: adminBot,
      channelPairingActions: (realRunner as any).channelPairingActions,
    }
  );
  assert.equal(appApproveRes.ok, true);
  assert.equal(appApproveRes.action, "approve");
  for (
    let i = 0;
    i < 40 && !outboundMessages.some((m) => m.text.includes("管理员已通过你的配对请求"));
    i += 1
  ) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(outboundMessages.some((m) => m.text.includes("管理员已通过你的配对请求")));

  // Subsequent Feishu message from now-approved chat runs in Bot
  await fetch(`${baseUrl}/api/channels/feishu/webhook/${fsAcctId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_pair_2", event_type: "im.message.receive_v1", token: "vtok_pair" },
      event: {
        sender: { sender_id: { open_id: "ou_new_1" } },
        message: {
          message_id: "om_pair_2",
          chat_id: "oc_new_chat_1",
          message_type: "text",
          content: JSON.stringify({ text: "放行后提问" }),
        },
      },
    }),
  });
  for (let i = 0; i < 40 && runnerCalls < 1; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(runnerCalls, 1);

  // 4. Suspend -> message quietly ignored -> Resume -> message runs again -> Delete approved chat
  const suspendRes: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/pairings/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "feishu-bot",
        accountId: fsAcctId,
        chatId: "oc_new_chat_1",
        enabled: false,
      }),
    })
  ).json();
  assert.equal(suspendRes.ok, true);
  assert.equal(suspendRes.enabled, false);

  await fetch(`${baseUrl}/api/channels/feishu/webhook/${fsAcctId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_pair_3", event_type: "im.message.receive_v1", token: "vtok_pair" },
      event: {
        sender: { sender_id: { open_id: "ou_new_1" } },
        message: {
          message_id: "om_pair_3",
          chat_id: "oc_new_chat_1",
          message_type: "text",
          content: JSON.stringify({ text: "暂停中不应执行" }),
        },
      },
    }),
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runnerCalls, 1);

  await fetch(`${baseUrl}/api/integrations/channels/pairings/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: "feishu-bot",
      accountId: fsAcctId,
      chatId: "oc_new_chat_1",
      enabled: true,
    }),
  });
  await fetch(`${baseUrl}/api/channels/feishu/webhook/${fsAcctId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_pair_4", event_type: "im.message.receive_v1", token: "vtok_pair" },
      event: {
        sender: { sender_id: { open_id: "ou_new_1" } },
        message: {
          message_id: "om_pair_4",
          chat_id: "oc_new_chat_1",
          message_type: "text",
          content: JSON.stringify({ text: "恢复后继续" }),
        },
      },
    }),
  });
  for (let i = 0; i < 40 && runnerCalls < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(runnerCalls, 2);

  // 5. Reject Telegram pairing request via HTTP, then delete approved Feishu chat
  await fetch(`${baseUrl}/api/channels/telegram/webhook/${tgAcctId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg_pair_sec",
    },
    body: JSON.stringify({
      update_id: 7001,
      message: {
        message_id: 71,
        chat: { id: 889900, type: "private" },
        from: { id: 889900, first_name: "TGUser" },
        text: "hi",
      },
    }),
  });
  const pairings2: any = await (await fetch(`${baseUrl}/api/integrations/channels/pairings`)).json();
  const tgCode = pairings2.pending.find((p: any) => p.channel === "telegram-bot")?.code;
  assert.match(tgCode || "", /^\d{6}$/);

  const rejectTg: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/pairings/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: tgCode }),
    })
  ).json();
  assert.equal(rejectTg.ok, true);

  const delApproved: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/pairings/approved`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "feishu-bot",
        accountId: fsAcctId,
        chatId: "oc_new_chat_1",
      }),
    })
  ).json();
  assert.equal(delApproved.ok, true);
  assert.equal(delApproved.channels.pairings.approved.length, 0);

  // 6. Toggle requirePairing: false -> unknown senders receive ZERO pairing codes
  await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts/${fsAcctId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requirePairing: false }),
  });
  const beforeOutLen = outboundMessages.length;
  await fetch(`${baseUrl}/api/channels/feishu/webhook/${fsAcctId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_pair_off", event_type: "im.message.receive_v1", token: "vtok_pair" },
      event: {
        sender: { sender_id: { open_id: "ou_quiet_stranger" } },
        message: {
          message_id: "om_pair_off",
          chat_id: "oc_quiet_chat",
          message_type: "text",
          content: JSON.stringify({ text: "silent block" }),
        },
      },
    }),
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(outboundMessages.length, beforeOutLen);
  const pairings3: any = await (await fetch(`${baseUrl}/api/integrations/channels/pairings`)).json();
  assert.equal(pairings3.pending.length, 0);
});

test("Feishu post rich-text extraction, processing reactions (Typing & 👀), and Telegram proxy fetch tunnel", async (t) => {
  // 1. Feishu post extraction (flat and localized zh_cn with @mention stripped)
  const postLocalized = extractFeishuMessageText(
    JSON.stringify({
      zh_cn: {
        title: "周报同步",
        content: [
          [
            { tag: "at", user_name: "Twinkle" },
            { tag: "text", text: "@_user_1 请看 " },
            { tag: "a", text: "发布文档", href: "https://example.com/doc" },
          ],
        ],
      },
    }),
    "post"
  );
  assert.match(postLocalized, /周报同步/);
  assert.match(postLocalized, /请看 发布文档 \(https:\/\/example\.com\/doc\)/);
  assert.equal(postLocalized.includes("@_user_1"), false);

  const postFlat = extractFeishuMessageText(
    JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "第一行" }], [{ tag: "text", text: "第二行" }]],
    }),
    "post"
  );
  assert.equal(postFlat, "第一行\n第二行");

  // 2. Proxy URL sanitization & credential redaction
  assert.equal(sanitizeTelegramProxyUrl("http://127.0.0.1:7890/"), "http://127.0.0.1:7890");
  assert.equal(sanitizeTelegramProxyUrl("socks5://user:pass@127.0.0.1:1080"), "socks5://user:pass@127.0.0.1:1080");
  assert.equal(sanitizeTelegramProxyUrl("ftp://bad-proxy:21"), "");
  assert.equal(
    redactProxyUrlForDisplay("http://alice:supersecret@127.0.0.1:7890"),
    "http://alice:••••@127.0.0.1:7890"
  );

  // 3. Real loopback HTTP proxy tunnel test via createProxiedFetch
  let proxySawUrl = "";
  const proxySrv = http.createServer((req, res) => {
    proxySawUrl = String(req.url || "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, proxied: true }));
  });
  await new Promise<void>((resolve) => proxySrv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => proxySrv.close(() => resolve())));
  const proxyPort = (proxySrv.address() as AddressInfo).port;
  const proxiedFetch = createProxiedFetch(`http://127.0.0.1:${proxyPort}`);
  const proxiedResp = await proxiedFetch("http://example.invalid:9000/bot123/getMe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ test: 1 }),
  });
  const proxiedJson: any = await proxiedResp.json();
  assert.equal(proxiedJson.proxied, true);
  assert.equal(proxySawUrl, "http://example.invalid:9000/bot123/getMe");

  // 4. Turn reactions: Feishu Typing add+delete & Telegram 👀 set+clear
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ch-react-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  store.writeSettings({ installedSkills: ["feishu-bot", "telegram-bot"] });
  store.writeChannelsAuth({
    "feishu-bot": {
      enabled: true,
      connectionMode: "webhook",
      appId: "cli_react",
      appSecret: "sec_react",
      defaultSessionId: adminBot.id,
      allowedSenderIds: ["ou_react"],
    },
    "telegram-bot": {
      enabled: true,
      connectionMode: "webhook",
      botToken: "999:TG_REACT",
      defaultSessionId: adminBot.id,
      allowedSenderIds: ["909090"],
    },
  });

  const apiCalls: Array<{ method: string; url: string; body: string }> = [];
  const realRunner = createRunner({
    store,
    runTaskImpl: (async ({ userText, deps }: any) => {
      deps.emit({ type: "answer", text: `R:${userText}` });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: `R:${userText}` };
    }) as any,
  });
  const mgr = createChannelManager({
    store,
    runner: realRunner,
    getInstalledSkills: () => ["feishu-bot", "telegram-bot"],
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      apiCalls.push({ method, url: u, body: String(init?.body || "") });
      if (u.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-r", expire: 7200 }), {
          status: 200,
        });
      }
      if (u.includes("/reactions") && method === "POST") {
        return new Response(
          JSON.stringify({ code: 0, data: { reaction_id: "rx_123" } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ code: 0, ok: true, result: { message_id: 1 } }), {
        status: 200,
      });
    }) as any,
  });
  t.after(() => {
    mgr.stopAll();
    realRunner.stop();
  });
  mgr.syncFromStore();

  await mgr.handleInboundMessage({
    channel: "feishu-bot",
    eventId: "ev_r_fs",
    messageId: "om_react_fs_1",
    chatId: "oc_r_1",
    senderId: "ou_react",
    senderName: "ReactFS",
    text: "ping fs",
  });
  await mgr.handleInboundMessage({
    channel: "telegram-bot",
    eventId: "ev_r_tg",
    messageId: "42",
    chatId: "909090",
    senderId: "909090",
    senderName: "ReactTG",
    text: "ping tg",
  });

  for (
    let i = 0;
    i < 50 &&
    !apiCalls.some((c) => c.method === "DELETE" && c.url.includes("/reactions/rx_123"));
    i += 1
  ) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(
    apiCalls.some(
      (c) =>
        c.method === "POST" &&
        c.url.includes("/om_react_fs_1/reactions") &&
        c.body.includes("Typing")
    )
  );
  assert.ok(
    apiCalls.some(
      (c) => c.method === "DELETE" && c.url.includes("/om_react_fs_1/reactions/rx_123")
    )
  );
  assert.ok(
    apiCalls.some(
      (c) =>
        c.url.includes("/setMessageReaction") &&
        c.body.includes("👀")
    )
  );
  assert.ok(
    apiCalls.some(
      (c) =>
        c.url.includes("/setMessageReaction") &&
        c.body.includes("\"reaction\":[]")
    )
  );
});

test("skill_configure_channel handles direct upsert, auto-install, routing, whitelist, reconnect, card secret, security block & redaction", async (t) => {
  const redactedArgs = redactToolArgsForDisplay("skill_configure_channel", {
    action: "upsert",
    app_id: "cli_1",
    app_secret: "sec_secret_value",
    bot_token: "123:TG_SECRET",
    webhook_secret: "wh_sec",
    verification_token: "vt_sec",
    encrypt_key: "ek_sec",
    proxy: "http://alice:p@ss@127.0.0.1:7890",
  });
  assert.equal(redactedArgs.app_secret, "••••••••");
  assert.equal(redactedArgs.bot_token, "••••••••");
  assert.equal(redactedArgs.webhook_secret, "••••••••");
  assert.equal(redactedArgs.verification_token, "••••••••");
  assert.equal(redactedArgs.encrypt_key, "••••••••");
  assert.equal(redactedArgs.proxy.includes("p@ss"), false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ch-toolcfg-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  const nodeBot = store.createSession({ title: "节点刷新员" });

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tenant_access_token/internal")) {
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: "t-cfg", expire: 7200 }),
        { status: 200 }
      );
    }
    if (u.includes("/bot/v3/info")) {
      return new Response(
        JSON.stringify({ code: 0, bot: { app_name: "FeishuConvBot" } }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const model = createModel({
    getProviders: () => store.readSettings()?.providers || [],
    getRouting: () => store.readSettings()?.routing || {},
  });
  const realRunner = createRunner({ store, model });
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

  const baseCtx = {
    store,
    senderSessionId: adminBot.id,
    senderBot: adminBot,
    getChannelStatus: (realRunner as any).getChannelStatus,
    channelConfigActions: (realRunner as any).channelConfigActions,
  };

  // 1. Direct Feishu upsert auto-installs skill, routes to 节点刷新员, adds whitelist, and auto-tests
  const upsertRes: any = await runBotCollabTool(
    "skill_configure_channel",
    {
      action: "upsert",
      channel: "feishu-bot",
      connection_mode: "webhook",
      app_id: "cli_conv_1",
      app_secret: "sec_conv_1",
      verification_token: "vtok_conv",
      target_bot: "节点刷新员",
      add_allowed_sender_ids: ["ou_conv_1"],
    },
    baseCtx
  );
  assert.equal(upsertRes.ok, true);
  assert.equal(upsertRes.created, true);
  assert.equal(upsertRes.targetBotTitle, "节点刷新员");
  assert.equal(upsertRes.account?.defaultSessionId, nodeBot.id);
  assert.deepEqual(upsertRes.account?.allowedSenderIds, ["ou_conv_1"]);
  assert.equal(upsertRes.testResult?.ok, true);
  assert.equal(upsertRes.testResult?.botName, "FeishuConvBot");
  assert.ok((store.readSettings().installedSkills || []).includes("feishu-bot"));

  // 2. Append whitelist open_id + reconnect + list
  const wlRes: any = await runBotCollabTool(
    "skill_configure_channel",
    {
      action: "whitelist",
      channel: "feishu-bot",
      add_allowed_sender_ids: ["ou_conv_2"],
    },
    baseCtx
  );
  assert.equal(wlRes.ok, true);
  assert.deepEqual(wlRes.allowedSenderIds, ["ou_conv_1", "ou_conv_2"]);

  const recRes: any = await runBotCollabTool(
    "skill_configure_channel",
    { action: "reconnect", channel: "feishu-bot", account_id: upsertRes.accountId },
    baseCtx
  );
  assert.equal(recRes.ok, true);

  // 3. External channel security boundary blocks mutations while allowing list
  const extBlock: any = await runBotCollabTool(
    "skill_configure_channel",
    { action: "whitelist", channel: "feishu-bot", add_allowed_sender_ids: ["ou_evil"] },
    {
      ...baseCtx,
      userMeta: { channelMeta: { channel: "feishu-bot", chatId: "oc_1", senderId: "ou_conv_1" } },
    }
  );
  assert.equal(extBlock.ok, false);

  // 4. Interactive encrypted credential card path for Telegram when bot_token is omitted
  const cardEvents: any[] = [];
  const tgCardRes: any = await runBotCollabTool(
    "skill_configure_channel",
    {
      action: "upsert",
      channel: "telegram-bot",
      create_new: true,
      label: "卡片TG助手",
      connection_mode: "polling",
      auto_test: false,
    },
    {
      ...baseCtx,
      callId: "call_tg_card_1",
      emit: (ev: any) => cardEvents.push(ev),
      control: {
        stopped: false,
        requestChoice: async () => ({ value: "888999:CARD_TG_SECRET" }),
      },
    }
  );
  assert.equal(tgCardRes.ok, true);
  assert.ok(cardEvents.some((e) => e.type === "credential_request"));
  assert.ok(cardEvents.some((e) => e.type === "credential_resolved" && e.submitted === true));
  assert.equal(JSON.stringify(tgCardRes).includes("CARD_TG_SECRET"), false);
});

test("channelMeta persists in user events and injects [消息来源] header into LLM prompt", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ch-meta-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const llmRequests: string[] = [];
  const mockLlmSrv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    llmRequests.push(bodyText);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "已收到飞书消息" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );
  });
  await new Promise<void>((resolve) => mockLlmSrv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => mockLlmSrv.close(() => resolve())));
  const llmPort = (mockLlmSrv.address() as AddressInfo).port;

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  store.writeSettings({
    installedSkills: ["feishu-bot"],
    model: "gpt-4o",
    routing: { smartRouter: false },
    providers: [
      {
        id: "openai_mock",
        type: "openai",
        name: "MockOpenAI",
        apiKey: "sk-mock",
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        models: ["gpt-4o"],
        enabled: true,
      },
    ],
  });

  const model = createModel({
    getProviders: () => store.readSettings()?.providers || [],
    getRouting: () => store.readSettings()?.routing || {},
  });
  const realRunner = createRunner({ store, model });
  const srv = createServer({
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      deployEnv: "local",
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
      writeRoots: [tmpDir],
      screen: { width: 1440, height: 900 },
    },
    store,
    executor: { health: async () => ({ ok: true }), call: async () => ({ ok: true }) } as any,
    runner: realRunner,
    billingFetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-meta", expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_meta" } }), { status: 200 });
    },
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    realRunner.stop();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "客服助手",
      enabled: true,
      connectionMode: "webhook",
      appId: "cli_meta",
      appSecret: "sec_meta",
      verificationToken: "vtok_meta",
      defaultSessionId: adminBot.id,
      allowedSenderIds: ["ou_zhangsan"],
    }),
  });

  await fetch(`${baseUrl}/api/channels/feishu/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev_meta_1", event_type: "im.message.receive_v1", token: "vtok_meta" },
      event: {
        sender: { sender_id: { open_id: "ou_zhangsan" } },
        message: {
          message_id: "om_meta_1",
          chat_id: "oc_meta_chat",
          message_type: "text",
          content: JSON.stringify({ text: "你区分得出我吗" }),
        },
      },
    }),
  });

  for (
    let i = 0;
    i < 60 &&
    !llmRequests.some((r) => /\[消息来源：飞书机器人「客服助手」 · 发送者：ou_zhangsan\]/.test(r));
    i += 1
  ) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(
    llmRequests.some((r) => /\[消息来源：飞书机器人「客服助手」 · 发送者：ou_zhangsan\]/.test(r)),
    "mock LLM should receive [消息来源] header in prompt"
  );

  const userEv = store
    .readEvents(adminBot.id)
    .find((e: any) => e.type === "user" && e.text === "你区分得出我吗");
  assert.equal(userEv?.channelMeta?.channel, "feishu-bot");
  assert.equal(userEv?.channelMeta?.accountLabel, "客服助手");
  assert.equal(userEv?.channelMeta?.senderId, "ou_zhangsan");
});

test("createTelegramFetch and createProxiedFetch normalize polyfilled AbortSignal to native AbortSignal", async (t) => {
  let observedNativeSignal = false;
  let abortedObserved = false;
  let removedListenerCount = 0;

  const mockFetch = (async (_input: any, init?: RequestInit) => {
    const sig = init?.signal;
    observedNativeSignal =
      sig instanceof globalThis.AbortSignal;
    assert.ok(observedNativeSignal, "fetch must receive native globalThis.AbortSignal");
    return await new Promise<Response>((resolve, reject) => {
      if (sig?.aborted) {
        abortedObserved = true;
        reject(new Error("aborted"));
        return;
      }
      sig?.addEventListener(
        "abort",
        () => {
          abortedObserved = true;
          reject(new Error("aborted"));
        },
        { once: true }
      );
      setTimeout(() => resolve(new Response("ok", { status: 200 })), 20);
    });
  }) as unknown as typeof fetch;

  const listeners = new Set<() => void>();
  const polyfillSignal: any = {
    aborted: false,
    reason: "stop-now",
    addEventListener(ev: string, fn: () => void) {
      if (ev === "abort") listeners.add(fn);
    },
    removeEventListener(ev: string, fn: () => void) {
      if (ev === "abort" && listeners.delete(fn)) removedListenerCount += 1;
    },
  };

  const wrapped = createTelegramFetch({}, mockFetch);
  const okResp = await wrapped("https://api.telegram.org/bot123/getMe", {
    method: "POST",
    signal: polyfillSignal,
  });
  assert.equal(okResp.status, 200);
  assert.equal(observedNativeSignal, true);
  assert.equal(removedListenerCount, 1);

  // Also test abort propagation from polyfill AbortSignal -> native AbortController
  polyfillSignal.aborted = false;
  const abortedPromise = wrapped("https://api.telegram.org/bot123/getUpdates", {
    method: "POST",
    signal: polyfillSignal,
  });
  polyfillSignal.aborted = true;
  for (const fn of listeners) fn();
  await assert.rejects(abortedPromise, /aborted/);
  assert.equal(abortedObserved, true);

  // Also verify createProxiedFetch handles non-native AbortSignal before constructing Request(input, init)
  const proxySrv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => proxySrv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => proxySrv.close(() => resolve())));
  const proxyPort = (proxySrv.address() as AddressInfo).port;
  const proxiedFetch = createProxiedFetch(`http://127.0.0.1:${proxyPort}`);
  const proxyPolySignal: any = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const proxyResp = await proxiedFetch("http://example.invalid:9000/bot123/getMe", {
    method: "POST",
    signal: proxyPolySignal,
  });
  assert.equal(proxyResp.status, 200);
});
