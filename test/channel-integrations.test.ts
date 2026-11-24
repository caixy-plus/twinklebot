import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  chunkChannelText,
  decryptFeishuEvent,
  isSenderAllowed,
  parseApprovalCommand,
  parseFeishuWebhookPayload,
  parseTelegramUpdate,
  parseWhitelistIds,
} from "../src/lib/channel-integrations.js";
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

test("channel parsing, whitelist, approval commands, chunking, and Feishu AES-256-CBC decryption", () => {
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

  // Feishu AES-256-CBC encrypted url_verification + im.message.receive_v1
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

  const parsedFsMsg = parseFeishuWebhookPayload(
    {
      header: { event_id: "ev-1", event_type: "im.message.receive_v1", token: "vtok" },
      event: {
        sender: { sender_id: { open_id: "ou_owner1" } },
        message: {
          message_id: "om_1",
          chat_id: "oc_chat1",
          content: JSON.stringify({ text: "@_user_1 帮我整理今天的待办" }),
        },
      },
    },
    { verificationToken: "vtok", encryptKey: "" }
  );
  assert.equal(parsedFsMsg.kind, "message");
  if (parsedFsMsg.kind === "message") {
    assert.equal(parsedFsMsg.message.text, "帮我整理今天的待办");
    assert.equal(parsedFsMsg.message.senderId, "ou_owner1");
    assert.equal(parsedFsMsg.message.chatId, "oc_chat1");
  }
});

test("Telegram & Feishu channel HTTP lifecycle: encrypted storage, whitelist, Bot dispatch, in-channel approval, and skill purge", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-channels-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  const outgoingCalls: Array<{ url: string; body: any }> = [];
  const runnerSubscribers = new Set<(ev: any) => void>();
  const startedRuns: Array<{ sessionId: string; text: string; userMeta: any }> = [];
  const approvals: Array<{ sessionId: string; callId: string; allowed: boolean }> = [];

  const mockRunner: any = {
    subscribe: (fn: (ev: any) => void) => {
      runnerSubscribers.add(fn);
      return () => runnerSubscribers.delete(fn);
    },
    broadcastGlobal: () => {},
    getState: () => ({ status: "idle" }),
    start: async (sessionId: string, text: string, userMeta: any) => {
      startedRuns.push({ sessionId, text, userMeta });
      if (text.includes("高危")) {
        for (const fn of runnerSubscribers) {
          fn({
            type: "approval_request",
            sessionId,
            callId: "call-danger-1",
            name: "run_shell",
            reason: "删除临时文件",
          });
        }
        return;
      }
      for (const fn of runnerSubscribers) {
        fn({ type: "assistant_message", sessionId, text: `已收到：${text}` });
        fn({ type: "status", sessionId, status: "completed" });
      }
    },
    approve: async (sessionId: string, callId: string, allowed: boolean) => {
      approvals.push({ sessionId, callId, allowed });
      for (const fn of runnerSubscribers) {
        fn({ type: "approval", sessionId, callId, allowed });
        fn({
          type: "assistant_message",
          sessionId,
          text: allowed ? "审批通过并执行完毕" : "已取消操作",
        });
        fn({ type: "status", sessionId, status: "completed" });
      }
    },
  };

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
    runner: mockRunner,
    billingFetchImpl: mockFetch,
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  // 1. Configuring before installing skill fails with 400
  const preInstall = await fetch(`${baseUrl}/api/integrations/channels/telegram-bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, botToken: "tok-1" }),
  });
  assert.equal(preInstall.status, 400);

  // 2. Install both channel skills
  assert.equal((await fetch(`${baseUrl}/api/skills/telegram-bot/install`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/skills/feishu-bot/install`, { method: "POST" })).status, 200);

  // 3. Configure Telegram in webhook mode + verify encrypted at rest & masked in response
  const saveTgRes: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/telegram-bot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        connectionMode: "webhook",
        botToken: "999999:SUPER_SECRET_TG_TOKEN",
        webhookSecret: "tg-hook-secret",
        defaultSessionId: adminBot.id,
        allowedSenderIds: ["user_allowed_1"],
        approvalMode: "channel_and_app",
      }),
    })
  ).json();
  assert.equal(saveTgRes.ok, true);
  assert.equal(saveTgRes.channels["telegram-bot"].config.hasBotToken, true);
  assert.equal(saveTgRes.channels["telegram-bot"].config.botToken, undefined);

  const rawChannelsDisk = fs.readFileSync(path.join(tmpDir, "channels-auth.json"), "utf8");
  assert.ok(!rawChannelsDisk.includes("SUPER_SECRET_TG_TOKEN"), "channels-auth.json must be AES-256-GCM encrypted on disk");

  // 4. Test Telegram connectivity
  const tgTest: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/telegram-bot/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  assert.equal(tgTest.ok, true);
  assert.equal(tgTest.botName, "TwinkleTG");

  // 5. Unauthorized Telegram sender is rejected & never invokes runner
  const unauthRes: any = await (
    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
      },
      body: JSON.stringify({
        update_id: 200,
        message: { chat: { id: 777 }, from: { id: "stranger_99" }, text: "帮我删文件" },
      }),
    })
  ).json();
  assert.equal(unauthRes.rejected, true);
  assert.equal(startedRuns.length, 0);

  // 6. Authorized Telegram sender triggers Bot and receives reply (and duplicate update_id is ignored)
  await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
    },
    body: JSON.stringify({
      update_id: 201,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "你好" },
    }),
  });
  await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
    },
    body: JSON.stringify({
      update_id: 201,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "你好" },
    }),
  });
  assert.equal(startedRuns.length, 1);
  assert.ok(
    outgoingCalls.some(
      (c) => c.url.includes("/sendMessage") && String(c.body?.text || "").includes("已收到：你好")
    ),
    "Bot reply must be delivered back to Telegram chat"
  );

  // 7. In-channel high-risk approval flow
  await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
    },
    body: JSON.stringify({
      update_id: 202,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "执行高危清理" },
    }),
  });
  assert.ok(
    outgoingCalls.some(
      (c) => c.url.includes("/sendMessage") && String(c.body?.text || "").includes("需要你的确认")
    ),
    "High-risk approval prompt must be sent to Telegram"
  );
  await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "tg-hook-secret",
    },
    body: JSON.stringify({
      update_id: 203,
      message: { chat: { id: 888 }, from: { id: "user_allowed_1" }, text: "允许" },
    }),
  });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].allowed, true);
  assert.equal(approvals[0].callId, "call-danger-1");

  // 8. Feishu config, test, webhook message delivery, and skill removal with purgeCredentials
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
  const fsTest: any = await (
    await fetch(`${baseUrl}/api/integrations/channels/feishu-bot/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  assert.equal(fsTest.ok, true);
  assert.equal(fsTest.botName, "TwinkleFeishu");

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
        String(c.body?.content || "").includes("已收到：飞书消息测试")
    ),
    "Bot reply must be sent back to Feishu chat"
  );

  // Remove feishu-bot with purgeCredentials=true -> clears stored secret
  const rmRes = await fetch(`${baseUrl}/api/skills/feishu-bot?purgeCredentials=true`, {
    method: "DELETE",
  });
  assert.equal(rmRes.status, 200);
  const afterPurge: any = await (await fetch(`${baseUrl}/api/integrations/channels`)).json();
  assert.equal(afterPurge.channels["feishu-bot"].config.hasAppSecret, false);
  assert.equal(afterPurge.channels["feishu-bot"].config.configured, false);
});
