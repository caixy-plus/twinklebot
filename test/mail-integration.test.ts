import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  decodeRfc2047,
  parseRawEmail,
  verifyMailConnection,
  listMailMessages,
  readMailMessage,
  sendMailMessage,
} from "../src/lib/mail-client.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import { assessToolCall } from "../src/agent/policy.js";
import {
  BOT_COLLAB_TOOL_DECLARATIONS,
  runBotCollabTool,
} from "../src/agent/bot-tools.js";
import { createControl } from "../src/agent/loop.js";
import { APPS_CATALOG } from "../public/dist/avatars.js";

function listenRandomPort(server: any) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as any).port);
    });
  });
}

function startMockPop3Server(messages: any[]) {
  const server = net.createServer((socket) => {
    socket.write("+OK Mock POP3 Ready\r\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("USER ")) {
          socket.write("+OK user accepted\r\n");
        } else if (upper.startsWith("PASS ")) {
          if (line.slice(5).trim() === "badpass") {
            socket.write("-ERR invalid auth\r\n");
          } else {
            socket.write("+OK logged in\r\n");
          }
        } else if (upper === "STAT") {
          const totalBytes = messages.reduce((s, m) => s + Buffer.byteLength(m.raw), 0);
          socket.write(`+OK ${messages.length} ${totalBytes}\r\n`);
        } else if (upper === "UIDL") {
          socket.write("+OK uidl follows\r\n");
          messages.forEach((m, i) => {
            socket.write(`${i + 1} ${m.uid}\r\n`);
          });
          socket.write(".\r\n");
        } else if (upper.startsWith("TOP ")) {
          const parts = line.split(/\s+/);
          const num = Number(parts[1]) - 1;
          const msg = messages[num];
          if (!msg) {
            socket.write("-ERR no such message\r\n");
          } else {
            const sep = msg.raw.indexOf("\r\n\r\n");
            const hdr = sep !== -1 ? msg.raw.slice(0, sep) : msg.raw;
            socket.write("+OK top of message follows\r\n");
            socket.write(`${hdr}\r\n\r\n.\r\n`);
          }
        } else if (upper.startsWith("RETR ")) {
          const num = Number(line.split(/\s+/)[1]) - 1;
          const msg = messages[num];
          if (!msg) {
            socket.write("-ERR no such message\r\n");
          } else {
            const stuffed = msg.raw
              .split("\r\n")
              .map((l: string) => (l.startsWith(".") ? `.${l}` : l))
              .join("\r\n");
            socket.write(`+OK ${Buffer.byteLength(msg.raw)} octets\r\n`);
            socket.write(`${stuffed}\r\n.\r\n`);
          }
        } else if (upper === "QUIT") {
          socket.write("+OK bye\r\n");
          socket.end();
        } else {
          socket.write("-ERR unknown command\r\n");
        }
      }
    });
  });
  return server;
}

function startMockImapServer(messages: any[]) {
  let sawRfc2971Id = false;
  const server = net.createServer((socket) => {
    socket.write("* OK Mock IMAP4rev1 Service Ready\r\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const sp = line.indexOf(" ");
        if (sp === -1) continue;
        const tag = line.slice(0, sp);
        const rest = line.slice(sp + 1);
        const upper = rest.toUpperCase();

        if (upper.startsWith("LOGIN ")) {
          if (rest.includes("badcode")) {
            socket.write(`${tag} NO LOGIN failed\r\n`);
          } else {
            socket.write(`${tag} OK LOGIN completed\r\n`);
          }
        } else if (upper.startsWith("ID ")) {
          sawRfc2971Id = true;
          socket.write(`* ID ("name" "MockIMAP")\r\n${tag} OK ID completed\r\n`);
        } else if (upper.startsWith("SELECT ") || upper.startsWith("EXAMINE ")) {
          const unseen = messages.filter((m) => m.unseen).length;
          socket.write(`* ${messages.length} EXISTS\r\n`);
          socket.write(`* OK [UNSEEN ${unseen}] unseen\r\n`);
          socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (upper.startsWith("STATUS ")) {
          const unseen = messages.filter((m) => m.unseen).length;
          socket.write(
            `* STATUS "INBOX" (MESSAGES ${messages.length} UNSEEN ${unseen})\r\n`
          );
          socket.write(`${tag} OK STATUS completed\r\n`);
        } else if (upper.startsWith("UID SEARCH ")) {
          const onlyUnseen = upper.includes("UNSEEN");
          const uids = messages
            .filter((m) => (!onlyUnseen ? true : m.unseen))
            .map((m) => m.uid)
            .join(" ");
          socket.write(`* SEARCH${uids ? ` ${uids}` : ""}\r\n`);
          socket.write(`${tag} OK UID SEARCH completed\r\n`);
        } else if (upper.startsWith("UID FETCH ")) {
          const mSet = rest.match(/^UID FETCH\s+([^\s]+)\s+/i);
          const rawSet = mSet ? mSet[1] : "";
          const wanted = new Set(rawSet.split(",").map((s) => s.trim()));
          const isHeaderOnly = upper.includes("HEADER.FIELDS");
          messages.forEach((m, i) => {
            if (!wanted.has(String(m.uid))) return;
            const flags = m.unseen ? "" : "\\Seen";
            const payload = isHeaderOnly
              ? `${m.raw.split("\r\n\r\n")[0]}\r\n\r\n`
              : m.raw;
            const byteLen = Buffer.byteLength(payload);
            const secLabel = isHeaderOnly
              ? "BODY[HEADER.FIELDS (SUBJECT FROM TO CC DATE MESSAGE-ID)]"
              : "BODY[]";
            socket.write(
              `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${flags}) ${secLabel} {${byteLen}}\r\n`
            );
            socket.write(payload);
            socket.write(`)\r\n`);
          });
          socket.write(`${tag} OK UID FETCH completed\r\n`);
        } else if (upper.startsWith("LOGOUT")) {
          socket.write(`* BYE IMAP4rev1 logging out\r\n${tag} OK LOGOUT completed\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} BAD unsupported command\r\n`);
        }
      }
    });
  });
  return { server, didReceiveId: () => sawRfc2971Id };
}

function startMockSmtpServer() {
  const received: any[] = [];
  const server = net.createServer((socket) => {
    socket.write("220 mock.smtp.local ESMTP ready\r\n");
    let buf = "";
    let authStage = 0;
    let inData = false;
    let dataBuf = "";
    let envelope = { from: "", to: [] };

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (inData) {
        dataBuf += buf;
        buf = "";
        const endMarker = dataBuf.indexOf("\r\n.\r\n");
        if (endMarker !== -1) {
          const rawBody = dataBuf.slice(0, endMarker);
          const unstuffed = rawBody
            .split("\r\n")
            .map((l) => (l.startsWith("..") ? l.slice(1) : l))
            .join("\r\n");
          received.push({ ...envelope, raw: unstuffed });
          buf = dataBuf.slice(endMarker + 5);
          dataBuf = "";
          inData = false;
          socket.write("250 2.0.0 Ok: queued\r\n");
        }
        return;
      }

      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const upper = line.toUpperCase();

        if (authStage === 1) {
          authStage = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (authStage === 2) {
          authStage = 0;
          const decoded = Buffer.from(line, "base64").toString("utf8");
          if (decoded === "badpass" || decoded === "badcode") {
            socket.write("535 Error: authentication failed\r\n");
          } else {
            socket.write("235 2.7.0 Authentication successful\r\n");
          }
          continue;
        }

        if (upper.startsWith("EHLO ") || upper.startsWith("HELO ")) {
          socket.write("250-mock.smtp.local\r\n250 AUTH LOGIN PLAIN\r\n");
        } else if (upper === "AUTH LOGIN") {
          authStage = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("MAIL FROM:")) {
          envelope = { from: line.slice(10).trim(), to: [] } as any;
          socket.write("250 Ok\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          (envelope as any).to.push(line.slice(8).trim());
          socket.write("250 Ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          if (buf.length > 0) {
            dataBuf += buf;
            buf = "";
          }
          break;
        } else if (upper === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 Ok\r\n");
        }
      }
    });
  });

  return { server, received };
}

test("RFC 2047 multi-segment UTF-8/GBK decoding and MIME parsing", () => {
  const b64Part1 = Buffer.from("【周报汇总】").toString("base64");
  const b64Part2 = Buffer.from("研发进度通知").toString("base64");
  const encodedSubj = `=?UTF-8?B?${b64Part1}?= =?UTF-8?B?${b64Part2}?=`;
  assert.equal(decodeRfc2047(encodedSubj), "【周报汇总】研发进度通知");

  // GBK encoded header: "测试邮件" in GBK is B2 E2 CA D4 D3 CA BC FE
  const gbkB64 = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xd3, 0xca, 0xbc, 0xfe]).toString(
    "base64"
  );
  assert.equal(decodeRfc2047(`=?GBK?B?${gbkB64}?=`), "测试邮件");

  const rawMime = [
    `From: =?UTF-8?B?${Buffer.from("张工").toString("base64")}?= <zhang@example.com>`,
    `To: user@qq.com`,
    `Subject: ${encodedSubj}`,
    `Date: Wed, 11 Nov 2026 14:00:00 +0800`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="bound_123"`,
    ``,
    `--bound_123`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(
      "<html><head><style>body{color:red}</style></head><body><h1>项目里程碑</h1><p>第一阶段已完成 100%。</p></body></html>"
    ).toString("base64"),
    `--bound_123`,
    `Content-Type: application/pdf; name="report.pdf"`,
    `Content-Disposition: attachment; filename="report.pdf"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from("PDFDATA").toString("base64"),
    `--bound_123--`,
    ``,
  ].join("\r\n");

  const parsed = parseRawEmail(rawMime);
  assert.equal(parsed.subject, "【周报汇总】研发进度通知");
  assert.match(parsed.from, /张工/);
  assert.match(parsed.body, /项目里程碑/);
  assert.match(parsed.body, /第一阶段已完成 100%/);
  assert.ok(!parsed.body.includes("color:red"));
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, "report.pdf");
});

test("POP3 + IMAP + SMTP end-to-end client operations over loopback servers", async (t) => {
  const sampleRaw1 = [
    `From: Boss <boss@company.com>`,
    `To: dev@company.com`,
    `Subject: =?UTF-8?B?${Buffer.from("Q4 预算审批通过").toString("base64")}?=`,
    `Date: Wed, 11 Nov 2026 10:00:00 +0800`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    `你好，预算已批复。`,
    `.leading-dot-line-preserved`,
  ].join("\r\n");

  const sampleRaw2 = [
    `From: HR <hr@company.com>`,
    `To: dev@company.com`,
    `Subject: Holiday Notice`,
    `Date: Wed, 11 Nov 2026 12:00:00 +0800`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    `Enjoy your holiday!`,
  ].join("\r\n");

  const popServer = startMockPop3Server([
    { uid: "pop-uid-101", raw: sampleRaw1 },
    { uid: "pop-uid-102", raw: sampleRaw2 },
  ]);
  const { server: imapServer, didReceiveId } = startMockImapServer([
    { uid: "501", unseen: true, raw: sampleRaw1 },
    { uid: "502", unseen: false, raw: sampleRaw2 },
  ]);
  const { server: smtpServer, received: smtpReceived } = startMockSmtpServer();

  const [popPort, imapPort, smtpPort] = await Promise.all([
    listenRandomPort(popServer),
    listenRandomPort(imapServer),
    listenRandomPort(smtpServer),
  ]);

  t.after(() => {
    popServer.close();
    imapServer.close();
    smtpServer.close();
  });

  // 1. Generic POP3 + SMTP verify, list, read
  const popConfig = {
    email: "dev@company.com",
    password: "secret-pop-password",
    senderName: "研发小助手",
    inboundProtocol: "pop3",
    inboundHost: "127.0.0.1",
    inboundPort: popPort,
    inboundTls: false,
    smtpHost: "127.0.0.1",
    smtpPort: smtpPort,
    smtpTls: false,
  };

  const popVerify = await verifyMailConnection(popConfig);
  assert.equal(popVerify.ok, true);
  assert.equal(popVerify.messages, 2);

  const popList = await listMailMessages(popConfig, { limit: 5, query: "预算" });
  assert.equal(popList.length, 1);
  assert.equal(popList[0].uid, "pop-uid-101");
  assert.equal(popList[0].subject, "Q4 预算审批通过");

  const popFull = await readMailMessage(popConfig, { uid: "pop-uid-101" });
  assert.match(popFull.body, /预算已批复/);
  assert.match(popFull.body, /\.leading-dot-line-preserved/);

  // 2. IMAP + SMTP verify (must issue RFC 2971 ID), unseen filter, read, send with dot-stuffing & CRLF guard
  const imapConfig = {
    email: "10001@qq.com",
    password: "abcd1234efgh5678",
    senderName: "QQ邮箱用户\r\nBcc:injected@evil.com",
    inboundProtocol: "imap",
    inboundHost: "127.0.0.1",
    inboundPort: imapPort,
    inboundTls: false,
    smtpHost: "127.0.0.1",
    smtpPort: smtpPort,
    smtpTls: false,
  };

  const imapVerify = await verifyMailConnection(imapConfig);
  assert.equal(imapVerify.ok, true);
  assert.equal(imapVerify.messages, 2);
  assert.equal(imapVerify.unseen, 1);
  assert.equal(didReceiveId(), true, "IMAP client should send RFC 2971 ID command");

  const unseenList = await listMailMessages(imapConfig, { unseenOnly: true });
  assert.equal(unseenList.length, 1);
  assert.equal(unseenList[0].uid, "501");

  const sendRes = await sendMailMessage(imapConfig, {
    to: "colleague@example.com\r\nCc:evil@attacker.com",
    subject: "回执确认\r\nX-Injected: yes",
    text: "第一行内容\n.单独句点开头的行\n最后一行",
  });
  assert.equal(sendRes.ok, true);
  assert.equal(smtpReceived.length, 1);
  assert.ok(!smtpReceived[0].raw.includes("X-Injected:"));
  assert.ok(!smtpReceived[0].raw.includes("Bcc:injected@evil.com"));
  const parsedSent = parseRawEmail(smtpReceived[0].raw);
  assert.match(parsedSent.body, /\.单独句点开头的行/);
});

test("mail-auth.json isolation (0600 mode + policy deny) and server integration endpoints", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-mail-api-"));
  const store = createStore(tmpDir);

  const { server: imapServer } = startMockImapServer([
    {
      uid: "1",
      unseen: true,
      raw: "From: a@b.com\r\nSubject: Hello\r\n\r\nWorld",
    },
  ]);
  const { server: smtpServer } = startMockSmtpServer();
  const [imapPort, smtpPort] = await Promise.all([
    listenRandomPort(imapServer),
    listenRandomPort(smtpServer),
  ]);

  const srv = createServer({
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
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
    imapServer.close();
    smtpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Initially zero connected apps (no fake 6 apps!)
  const initSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.deepEqual(initSettings.connectedApps, []);

  // Save QQ Mail against loopback mock server
  const saveQqRes = await fetch(`${baseUrl}/api/integrations/mail/qqmail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "888888@qq.com",
      authCode: "qqsecretcode9876",
      senderName: "测试昵称",
      inboundProtocol: "imap",
      inboundHost: "127.0.0.1",
      inboundPort: imapPort,
      inboundTls: false,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort,
      smtpTls: false,
    }),
  });
  assert.equal(saveQqRes.status, 200);
  const saveQqData = await saveQqRes.json();
  assert.equal(saveQqData.ok, true);
  assert.equal(saveQqData.integration.configured, true);
  assert.equal(saveQqData.integration.maskedSecret, "•••• •••• •••• 9876");
  assert.ok(!JSON.stringify(saveQqData).includes("qqsecretcode9876"));

  // Check mail-auth.json permissions (POSIX) and policy.js protection
  const authFilePath = path.join(tmpDir, "mail-auth.json");
  assert.equal(fs.existsSync(authFilePath), true);
  if (process.platform !== "win32") {
    const mode = fs.statSync(authFilePath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const policyCheck = assessToolCall(
    "read_file",
    { path: authFilePath },
    { writeRoots: [tmpDir] }
  );
  assert.equal(policyCheck.decision, "deny");

  // Blank password update preserves existing authCode
  const updateNameRes = await fetch(`${baseUrl}/api/integrations/mail/qqmail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "888888@qq.com",
      authCode: "",
      senderName: "新昵称",
      inboundProtocol: "imap",
      inboundHost: "127.0.0.1",
      inboundPort: imapPort,
      inboundTls: false,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort,
      smtpTls: false,
    }),
  });
  assert.equal(updateNameRes.status, 200);
  const afterUpdate = await (await fetch(`${baseUrl}/api/integrations/mail`)).json();
  assert.equal(afterUpdate.qqmail.senderName, "新昵称");
  assert.equal(afterUpdate.qqmail.maskedSecret, "•••• •••• •••• 9876");
  assert.ok(!JSON.stringify(afterUpdate).includes("qqsecretcode9876"));

  const midSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.deepEqual(midSettings.connectedApps, ["qqmail"]);

  // Disconnect QQ Mail
  const delRes = await fetch(`${baseUrl}/api/integrations/mail/qqmail`, {
    method: "DELETE",
  });
  assert.equal(delRes.status, 200);
  const endSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.deepEqual(endSettings.connectedApps, []);
});

test("Agent mail tools enforce draft confirmation and block unapproved sending", async (t) => {
  const sendToolDecl = BOT_COLLAB_TOOL_DECLARATIONS.find(
    (d) => d.name === "mail_send_message"
  );
  assert.ok(sendToolDecl, "mail_send_message tool declaration must exist");
  assert.equal(
    "require_confirmation" in (sendToolDecl.parameters?.properties || {}),
    false,
    "LLM must NOT have a require_confirmation bypass parameter"
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-mail-tools-"));
  const store = createStore(tmpDir);
  const { server: popServer } = {
    server: startMockPop3Server([
      {
        uid: "u-99",
        raw: "From: alice@example.com\r\nSubject: Weekly Sync\r\n\r\nMeeting at 3pm.",
      },
    ]),
  };
  const { server: smtpServer, received } = startMockSmtpServer();
  const [popPort, smtpPort] = await Promise.all([
    listenRandomPort(popServer),
    listenRandomPort(smtpServer),
  ]);

  t.after(() => {
    popServer.close();
    smtpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  store.writeMailAuth({
    "custom-mail": {
      enabled: true,
      email: "me@corp.com",
      password: "corppassword1234",
      senderName: "Me",
      inboundProtocol: "pop3",
      inboundHost: "127.0.0.1",
      inboundPort: popPort,
      inboundTls: false,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort,
      smtpTls: false,
    },
  });

  // 1. List & Read
  const listRes = await runBotCollabTool(
    "mail_list_messages",
    { limit: 5 },
    { store }
  );
  assert.equal(listRes.ok, true);
  assert.equal(listRes.messages.length, 1);
  assert.equal(listRes.messages[0].subject, "Weekly Sync");

  const readRes = await runBotCollabTool(
    "mail_read_message",
    { uid: "u-99" },
    { store }
  );
  assert.equal(readRes.ok, true);
  assert.match(readRes.message.body, /Meeting at 3pm/);

  // 2. Non-interactive context without allowRules MUST refuse to auto-send
  const blockedRes = await runBotCollabTool(
    "mail_send_message",
    {
      to: "external@example.com",
      subject: "Exfil attempt",
      body: "Secret",
    },
    { store, control: {} }
  );
  assert.ok(blockedRes.error);
  assert.equal(received.length, 0);

  // 3. Interactive context emits draft_request and sends edited draft upon user approval
  const ctrl = createControl();
  const events: any[] = [];
  const sendPromise = runBotCollabTool(
    "mail_send_message",
    {
      to: "alice@example.com",
      subject: "Re: Weekly Sync",
      body: "原始草稿正文",
    },
    {
      store,
      control: ctrl,
      callId: "call-mail-1",
      emit: (ev: any) => {
        events.push(ev);
        if (ev.type === "draft_request") {
          ctrl.resolveChoice("call-mail-1", {
            approved: true,
            title: "Re: Weekly Sync (已确认)",
            recipient: "alice@example.com",
            content: "用户确认并微调后的正文",
          });
        }
      },
    }
  );

  const sentOut = await sendPromise;
  assert.equal(sentOut.ok, true);
  assert.equal(received.length, 1);
  const sentParsed = parseRawEmail(received[0].raw);
  assert.equal(sentParsed.subject, "Re: Weekly Sync (已确认)");
  assert.match(sentParsed.body, /用户确认并微调后的正文/);
});

test("Multi-account Mail APIs and Agent tools support adding, editing, switching default, and selecting among multiple mailboxes", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-multi-mail-"));
  const store = createStore(tmpDir);

  const { server: imapServer1 } = startMockImapServer([
    {
      uid: 101,
      unseen: true,
      raw: "From: boss@qq.com\r\nSubject: 工作QQ邮件\r\n\r\n来自第一个QQ邮箱的内容。",
    },
  ]);
  const { server: imapServer2 } = startMockImapServer([
    {
      uid: 202,
      unseen: true,
      raw: "From: friend@qq.com\r\nSubject: 个人QQ邮件\r\n\r\n来自第二个QQ邮箱的内容。",
    },
  ]);
  const popServer3 = startMockPop3Server([
    {
      uid: "pop-303",
      raw: "From: ops@corp.com\r\nSubject: 企业POP3告警\r\n\r\n来自通用POP3企业邮箱的内容。",
    },
  ]);
  const { server: smtpServer1, received: sent1 } = startMockSmtpServer();
  const { server: smtpServer2, received: sent2 } = startMockSmtpServer();

  const [imapPort1, imapPort2, popPort3, smtpPort1, smtpPort2] = await Promise.all([
    listenRandomPort(imapServer1),
    listenRandomPort(imapServer2),
    listenRandomPort(popServer3),
    listenRandomPort(smtpServer1),
    listenRandomPort(smtpServer2),
  ]);

  let srv: any = null;
  t.after(async () => {
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    imapServer1.close();
    imapServer2.close();
    popServer3.close();
    smtpServer1.close();
    smtpServer2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  srv = createServer({
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      port: 0,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
      writeRoots: [tmpDir],
    },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;

  // 1. Add first QQ Mail account
  const add1Res = await fetch(`${baseUrl}/api/integrations/mail/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "qqmail",
      label: "工作QQ",
      email: "work@qq.com",
      authCode: "qqworksecret1111",
      senderName: "张工(工作)",
      inboundProtocol: "imap",
      inboundHost: "127.0.0.1",
      inboundPort: imapPort1,
      inboundTls: false,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort1,
      smtpTls: false,
    }),
  });
  assert.equal(add1Res.status, 200);
  const add1 = await add1Res.json();
  assert.equal(add1.ok, true);
  assert.ok(add1.account?.id);
  assert.equal(add1.account.isDefault, true);
  assert.equal(add1.accounts.length, 1);

  // 2. Add second QQ Mail account (same provider, distinct account!)
  const add2Res = await fetch(`${baseUrl}/api/integrations/mail/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "qqmail",
      label: "个人QQ",
      email: "life@qq.com",
      authCode: "qqlifesecret2222",
      senderName: "小张(个人)",
      inboundProtocol: "imap",
      inboundHost: "127.0.0.1",
      inboundPort: imapPort2,
      inboundTls: false,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort2,
      smtpTls: false,
    }),
  });
  assert.equal(add2Res.status, 200);
  const add2 = await add2Res.json();
  assert.equal(add2.accounts.length, 2);
  assert.notEqual(add1.account.id, add2.account.id);

  // 3. Add third Generic POP3 Mail account and mark as default
  const add3Res = await fetch(`${baseUrl}/api/integrations/mail/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "custom-mail",
      label: "运维企业邮",
      email: "ops@corp.com",
      password: "corpsecretpassword3333",
      senderName: "Ops Team",
      inboundProtocol: "pop3",
      inboundHost: "127.0.0.1",
      inboundPort: popPort3,
      inboundTls: false,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort2,
      smtpTls: false,
      isDefault: true,
    }),
  });
  assert.equal(add3Res.status, 200);
  const add3 = await add3Res.json();
  assert.equal(add3.accounts.length, 3);
  assert.equal(add3.account.isDefault, true);

  // Verify GET /api/settings and GET /api/integrations/mail expose all 3 sanitized accounts without leaking secrets
  const settingsData = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(settingsData.mailAccounts.length, 3);
  const serialized = JSON.stringify(settingsData);
  assert.ok(!serialized.includes("qqworksecret1111"));
  assert.ok(!serialized.includes("qqlifesecret2222"));
  assert.ok(!serialized.includes("corpsecretpassword3333"));
  assert.deepEqual(
    settingsData.mailAccounts.filter((a: any) => a.isDefault).map((a: any) => a.email),
    ["ops@corp.com"]
  );

  // 4. Edit second QQ Mail account by id with blank authCode (preserves its secret without touching account 1 or 3)
  const edit2Res = await fetch(`${baseUrl}/api/integrations/mail/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: add2.account.id,
      provider: "qqmail",
      label: "个人生活号",
      email: "life@qq.com",
      authCode: "",
      senderName: "小张Updated",
      inboundProtocol: "imap",
      inboundHost: "127.0.0.1",
      inboundPort: imapPort2,
      inboundTls: false,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort2,
      smtpTls: false,
    }),
  });
  assert.equal(edit2Res.status, 200);
  const edit2 = await edit2Res.json();
  assert.equal(edit2.account.label, "个人生活号");
  assert.equal(edit2.account.maskedSecret, "•••• •••• •••• 2222");

  // 5. One-click test saved account by id without resending password
  const testByIdRes = await fetch(
    `${baseUrl}/api/integrations/mail/accounts/${add1.account.id}/test`,
    { method: "POST" }
  );
  assert.equal(testByIdRes.status, 200);
  const testById = await testByIdRes.json();
  assert.equal(testById.ok, true);
  assert.equal(testById.messages, 1);

  // 6. Agent tools: mail_list_accounts + default account + selecting by email / label / id
  const listAccts = await runBotCollabTool("mail_list_accounts", {}, { store });
  assert.equal(listAccts.ok, true);
  assert.equal(listAccts.accounts.length, 3);
  assert.ok(!JSON.stringify(listAccts).includes("qqworksecret1111"));

  // Default account is currently ops@corp.com
  const defaultMsgs = await runBotCollabTool("mail_list_messages", {}, { store });
  assert.equal(defaultMsgs.ok, true);
  assert.equal(defaultMsgs.email, "ops@corp.com");
  assert.equal(defaultMsgs.messages[0].subject, "企业POP3告警");

  // Select first QQ mail by email
  const qq1Msgs = await runBotCollabTool(
    "mail_list_messages",
    { account: "work@qq.com" },
    { store }
  );
  assert.equal(qq1Msgs.ok, true);
  assert.equal(qq1Msgs.email, "work@qq.com");
  assert.equal(qq1Msgs.messages[0].subject, "工作QQ邮件");

  // Select second QQ mail by custom label
  const qq2Msgs = await runBotCollabTool(
    "mail_list_messages",
    { account: "个人生活号" },
    { store }
  );
  assert.equal(qq2Msgs.ok, true);
  assert.equal(qq2Msgs.email, "life@qq.com");
  assert.equal(qq2Msgs.messages[0].subject, "个人QQ邮件");

  // Send email specifically from work@qq.com (smtpServer1)
  const ctrl = createControl();
  const sendFromWork = await runBotCollabTool(
    "mail_send_message",
    {
      account: "work@qq.com",
      to: "client@example.com",
      subject: "工作汇报",
      body: "使用工作QQ发出",
    },
    {
      store,
      control: ctrl,
      callId: "call-multi-send",
      emit: (ev: any) => {
        if (ev.type === "draft_request") {
          ctrl.resolveChoice("call-multi-send", { approved: true });
        }
      },
    }
  );
  assert.equal(sendFromWork.ok, true);
  assert.equal(sent1.length, 1);
  assert.equal(sent2.length, 0);
  assert.match(sent1[0].from, /work@qq\.com/);

  // 7. Switch default account via PATCH and delete one account via DELETE
  const patchDefRes = await fetch(
    `${baseUrl}/api/integrations/mail/accounts/${add1.account.id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isDefault: true }),
    }
  );
  assert.equal(patchDefRes.status, 200);

  const del3Res = await fetch(
    `${baseUrl}/api/integrations/mail/accounts/${add3.account.id}`,
    { method: "DELETE" }
  );
  assert.equal(del3Res.status, 200);
  const del3 = await del3Res.json();
  assert.equal(del3.accounts.length, 2);
  assert.deepEqual(
    del3.accounts.map((a: any) => a.email),
    ["work@qq.com", "life@qq.com"]
  );
});

test("APPS_CATALOG and public/index.html only expose QQ Mail and Generic Mail", async () => {
  assert.deepEqual(
    APPS_CATALOG.map((a: any) => a.id),
    ["qqmail", "custom-mail"]
  );
  const { renderFullAppHtml } = await import("./helpers/react-test-helpers.js");
  const html = renderFullAppHtml();
  assert.ok(!html.includes("已连接 6 个"));
  assert.ok(!html.includes("badge-gmail"));
  assert.ok(!html.includes("密码管理器"));
  assert.ok(html.includes('id="mail-accounts-section"'));
  assert.ok(html.includes('id="qqmail-label-input"'));
  assert.ok(html.includes('id="custom-mail-label-input"'));
});
