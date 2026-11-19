import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { createTarGzFromDir } from "../../src/lib/tar-gzip.js";

// Valid 2x2 PNG (base64)
export const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEwMhAAAwACf8BAf+J6T8AAAAASUVORK5CYII=";
export const SAMPLE_PNG_BUFFER = Buffer.from(SAMPLE_PNG_BASE64, "base64");

export function isThinkingSummaryPrompt(payload: unknown): boolean {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload || "");
  return /Distill the current task progress|ultra-short Chinese phrase|提炼成极简中文短语|短语|概括/.test(s);
}

export function isContextCompressionPrompt(payload: unknown): boolean {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload || "");
  return /context compression assistant|Core Goals & Constraints|Compress the following earlier|上下文压缩助手|核心目标与约束/.test(s);
}

export interface CapturedLlmRequest {
  at: string;
  method: string;
  url: string;
  headers: Record<string, any>;
  body: any;
}

export type MockLlmHandler = (
  req: { endpoint: string; body: any; headers: Record<string, any> }
) => Promise<MockLlmResponse | null | undefined> | MockLlmResponse | null | undefined;

export interface MockLlmResponse {
  status?: number;
  headers?: Record<string, string>;
  // For OpenAI chat completions
  text?: string;
  thoughts?: string;
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, any> | string }>;
  finishReason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
  streamChunks?: string[];
  delayMs?: number;
  rawJson?: any;
  // For Gemini Interactions API
  geminiOutputs?: any[];
  geminiUsage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_cached_tokens?: number;
  };
  geminiOutputImage?: { data: string; mime_type?: string };
}

function listenHttpServer(srv: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      resolve((srv.address() as net.AddressInfo).port);
    });
  });
}

function listenNetServer(srv: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      resolve((srv.address() as net.AddressInfo).port);
    });
  });
}

export async function startMockLlmServer(opts: {
  initialBalanceCny?: number;
  onRequest?: MockLlmHandler;
} = {}) {
  const capturedRequests: CapturedLlmRequest[] = [];
  const queuedResponses: MockLlmResponse[] = [];
  let customHandler: MockLlmHandler | undefined = opts.onRequest;
  let balanceCny = opts.initialBalanceCny ?? 128.5;
  let imageGenEnabled = true;

  const enqueue = (resp: MockLlmResponse) => {
    queuedResponses.push(resp);
  };

  const setHandler = (fn: MockLlmHandler | undefined) => {
    customHandler = fn;
  };

  const setBalance = (cny: number) => {
    balanceCny = cny;
  };

  const setImageGenEnabled = (enabled: boolean) => {
    imageGenEnabled = enabled;
  };

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    const rawStr = Buffer.concat(chunks).toString("utf8");
    let body: any = {};
    try {
      body = rawStr ? JSON.parse(rawStr) : {};
    } catch {
      body = { rawStr };
    }

    capturedRequests.push({
      at: new Date().toISOString(),
      method: req.method || "GET",
      url: req.url || "/",
      headers: { ...req.headers },
      body,
    });

    if (req.method === "GET" && urlPath.endsWith("/user/balance")) {
      const payload = {
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: balanceCny.toFixed(2),
            granted_balance: "0.00",
            topped_up_balance: balanceCny.toFixed(2),
          },
        ],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === "POST" && urlPath.endsWith("/images/generations")) {
      if (!imageGenEnabled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "image model not found" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: SAMPLE_PNG_BASE64 }],
        })
      );
      return;
    }

    // Consult queue or custom handler
    let reply: MockLlmResponse | null | undefined = null;
    if (customHandler) {
      reply = await customHandler({ endpoint: urlPath, body, headers: req.headers });
    }
    if (!reply && queuedResponses.length > 0) {
      reply = queuedResponses.shift()!;
    }
    if (!reply) {
      // Default deterministic behavior
      const msgs = Array.isArray(body?.messages) ? body.messages : [];
      const lastUser = [...msgs].reverse().find((m: any) => m?.role === "user");
      const userTxt =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content.map((p: any) => p?.text || "").join(" ")
            : "";

      if (/Reply with OK|ping/i.test(userTxt)) {
        reply = { text: "OK" };
      } else if (/NO.*stop|stop words|abort/i.test(String(msgs[0]?.content || ""))) {
        reply = { text: userTxt.includes("停下") || userTxt.trim() === "stop" ? "YES" : "NO" };
      } else if (urlPath.includes("/interactions")) {
        const inputText =
          typeof body?.input === "string"
            ? body.input
            : Array.isArray(body?.input)
              ? JSON.stringify(body.input)
              : "";
        if (body?.response_modalities?.includes("image")) {
          if (!imageGenEnabled) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "not supported by the Interactions API" } }));
            return;
          }
          reply = { geminiOutputImage: { data: SAMPLE_PNG_BASE64, mime_type: "image/png" } };
        } else if (inputText.includes("thought_signature")) {
          reply = { text: "Gemini ok" };
        } else {
          reply = {
            geminiOutputs: [{ type: "text", text: "Gemini 响应完成" }],
            geminiUsage: { total_input_tokens: 120, total_output_tokens: 32 },
          };
        }
      } else {
        reply = { text: `收到并完成: ${userTxt.slice(0, 60)}` };
      }
    }

    if (reply.delayMs && reply.delayMs > 0) {
      await new Promise((r) => setTimeout(r, reply!.delayMs));
    }

    if (reply.status && reply.status >= 400) {
      res.writeHead(reply.status, {
        "Content-Type": "application/json",
        ...(reply.headers || {}),
      });
      res.end(
        JSON.stringify(
          reply.rawJson || {
            error: {
              message: reply.text || `Mock HTTP ${reply.status}`,
              code: reply.status === 413 ? "context_length_exceeded" : `err_${reply.status}`,
            },
          }
        )
      );
      return;
    }

    // Gemini Interactions API response
    if (urlPath.includes("/v1beta/interactions")) {
      const outputs =
        reply.geminiOutputs ||
        (reply.toolCalls?.length
          ? reply.toolCalls.map((tc, i) => ({
              type: "function_call",
              id: tc.id || `gem-call-${Date.now()}-${i}`,
              name: tc.name,
              arguments: typeof tc.args === "string" ? tc.args : tc.args || {},
            }))
          : [{ type: "text", text: reply.text ?? "Gemini OK" }]);

      const payload: any = reply.rawJson || {
        id: `int-${crypto.randomUUID().slice(0, 8)}`,
        status: "completed",
        outputs,
        ...(reply.geminiOutputImage ? { output_image: reply.geminiOutputImage } : {}),
        usage: reply.geminiUsage || {
          total_input_tokens: reply.usage?.prompt_tokens ?? 100,
          total_output_tokens: reply.usage?.completion_tokens ?? 25,
          total_thought_tokens: reply.usage?.reasoning_tokens ?? 0,
          total_cached_tokens: reply.usage?.cached_tokens ?? 0,
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    // OpenAI Chat Completions (SSE or JSON)
    const isStream = Boolean(body?.stream);
    const finishReason =
      reply.finishReason || (reply.toolCalls && reply.toolCalls.length > 0 ? "tool_calls" : "stop");
    const usage = {
      prompt_tokens: reply.usage?.prompt_tokens ?? 80,
      completion_tokens: reply.usage?.completion_tokens ?? 24,
      total_tokens:
        reply.usage?.total_tokens ??
        (reply.usage?.prompt_tokens ?? 80) + (reply.usage?.completion_tokens ?? 24),
      ...(reply.usage?.cached_tokens
        ? { prompt_tokens_details: { cached_tokens: reply.usage.cached_tokens } }
        : {}),
      ...(reply.usage?.reasoning_tokens
        ? { completion_tokens_details: { reasoning_tokens: reply.usage.reasoning_tokens } }
        : {}),
    };

    if (!isStream) {
      const msg: any = {
        role: "assistant",
        content: reply.text ?? "",
      };
      if (reply.thoughts) msg.reasoning_content = reply.thoughts;
      if (reply.toolCalls?.length) {
        msg.tool_calls = reply.toolCalls.map((tc, idx) => ({
          id: tc.id || `call_${Date.now()}_${idx}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
          },
        }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          reply.rawJson || {
            id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
            object: "chat.completion",
            model: body?.model || "mock-model",
            choices: [{ index: 0, message: msg, finish_reason: finishReason }],
            usage,
          }
        )
      );
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const writeSse = (obj: any) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    if (reply.thoughts) {
      writeSse({
        id: "c1",
        choices: [{ index: 0, delta: { reasoning_content: reply.thoughts }, finish_reason: null }],
      });
    }

    const textChunks =
      reply.streamChunks ||
      (reply.text
        ? reply.text.length > 24
          ? [reply.text.slice(0, Math.floor(reply.text.length / 2)), reply.text.slice(Math.floor(reply.text.length / 2))]
          : [reply.text]
        : []);

    for (const chunk of textChunks) {
      writeSse({
        id: "c1",
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      });
    }

    if (reply.toolCalls?.length) {
      writeSse({
        id: "c1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: reply.toolCalls.map((tc, idx) => ({
                index: idx,
                id: tc.id || `call_${Date.now()}_${idx}`,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
                },
              })),
            },
            finish_reason: null,
          },
        ],
      });
    }

    writeSse({
      id: "c1",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  const port = await listenHttpServer(server);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
    capturedRequests,
    enqueue,
    setHandler,
    setBalance,
    setImageGenEnabled,
    clearRequests: () => {
      capturedRequests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        try {
          (server as any).closeAllConnections?.();
        } catch {}
        const tm = setTimeout(resolve, 1500);
        server.close(() => {
          clearTimeout(tm);
          resolve();
        });
      }),
  };
}

export interface LoopbackMailItem {
  uid: number;
  unseen: boolean;
  raw: string;
}

export interface CapturedSentMail {
  from: string;
  to: string[];
  raw: string;
}

export async function startLoopbackMailServer(opts: {
  validEmail?: string;
  validPassword?: string;
  initialMessages?: LoopbackMailItem[];
} = {}) {
  const validEmail = (opts.validEmail || "bot@example.test").toLowerCase();
  const validPassword = opts.validPassword || "auth-code-123456";
  const messages: LoopbackMailItem[] = opts.initialMessages ? [...opts.initialMessages] : [];
  const sentMessages: CapturedSentMail[] = [];

  const splitHeadersRaw = (raw: string) => {
    const idx = raw.indexOf("\r\n\r\n");
    return idx >= 0 ? raw.slice(0, idx) + "\r\n\r\n" : raw;
  };

  // 1. IMAP server
  const imapSrv = net.createServer((socket) => {
    socket.write("* OK Mock IMAP Ready\r\n");
    let buf = "";
    let authed = false;
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const m = line.match(/^(\S+)\s+(.+)$/);
        if (!m) continue;
        const tag = m[1];
        const cmdFull = m[2].trim();
        const cmdUpper = cmdFull.toUpperCase();

        if (cmdUpper.startsWith("LOGIN ")) {
          const args = [...cmdFull.slice(6).matchAll(/"([^"]*)"|(\S+)/g)].map((x) => x[1] ?? x[2] ?? "");
          const u = (args[0] || "").toLowerCase();
          const p = args[1] || "";
          if (u === validEmail && p === validPassword) {
            authed = true;
            socket.write(`${tag} OK LOGIN completed\r\n`);
          } else {
            socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          }
        } else if (cmdUpper.startsWith("ID ")) {
          socket.write(`* ID ("name" "MockIMAP")\r\n${tag} OK ID completed\r\n`);
        } else if (!authed && !cmdUpper.startsWith("LOGOUT")) {
          socket.write(`${tag} NO authenticate first\r\n`);
        } else if (cmdUpper.startsWith("STATUS ")) {
          const unseen = messages.filter((x) => x.unseen).length;
          socket.write(`* STATUS "INBOX" (MESSAGES ${messages.length} UNSEEN ${unseen})\r\n${tag} OK STATUS completed\r\n`);
        } else if (cmdUpper.startsWith("SELECT ")) {
          socket.write(`* ${messages.length} EXISTS\r\n* ${messages.filter((x) => x.unseen).length} RECENT\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (cmdUpper.startsWith("UID SEARCH ")) {
          const unseenOnly = cmdUpper.includes("UNSEEN");
          const uids = messages.filter((x) => !unseenOnly || x.unseen).map((x) => x.uid);
          socket.write(`* SEARCH${uids.length ? " " + uids.join(" ") : ""}\r\n${tag} OK UID SEARCH completed\r\n`);
        } else if (cmdUpper.startsWith("UID FETCH ")) {
          const rest = cmdFull.slice("UID FETCH ".length);
          const sp = rest.indexOf(" ");
          const uidListStr = sp === -1 ? rest : rest.slice(0, sp);
          const wantedUids = uidListStr.split(",").map((n) => Number(n.trim())).filter(Boolean);
          const headerOnly = cmdUpper.includes("HEADER.FIELDS");
          for (const uid of wantedUids) {
            const msg = messages.find((x) => x.uid === uid);
            if (!msg) continue;
            const rawBytes = Buffer.from(headerOnly ? splitHeadersRaw(msg.raw) : msg.raw, "utf8");
            const flags = msg.unseen ? "" : "\\Seen";
            const section = headerOnly ? "BODY[HEADER.FIELDS (SUBJECT FROM TO CC DATE MESSAGE-ID)]" : "BODY[]";
            socket.write(`* ${messages.indexOf(msg) + 1} FETCH (UID ${msg.uid} FLAGS (${flags}) INTERNALDATE "19-Nov-2026 09:00:00 +0800" ${section} {${rawBytes.length}}\r\n`);
            socket.write(rawBytes);
            socket.write(`)\r\n`);
          }
          socket.write(`${tag} OK UID FETCH completed\r\n`);
        } else if (cmdUpper.startsWith("LOGOUT")) {
          socket.write(`* BYE Mock IMAP\r\n${tag} OK LOGOUT completed\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK\r\n`);
        }
      }
    });
  });

  // 2. POP3 server
  const pop3Srv = net.createServer((socket) => {
    socket.write("+OK Mock POP3 Ready\r\n");
    let buf = "";
    let pendingUser = "";
    let authed = false;
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("USER ")) {
          pendingUser = line.slice(5).trim().toLowerCase();
          socket.write("+OK user ok\r\n");
        } else if (upper.startsWith("PASS ")) {
          const pass = line.slice(5).trim();
          if (pendingUser === validEmail && pass === validPassword) {
            authed = true;
            socket.write("+OK logged in\r\n");
          } else {
            socket.write("-ERR auth failed\r\n");
          }
        } else if (upper === "QUIT") {
          socket.write("+OK bye\r\n");
          socket.end();
        } else if (!authed) {
          socket.write("-ERR auth required\r\n");
        } else if (upper === "STAT") {
          const bytes = messages.reduce((s, m) => s + Buffer.byteLength(m.raw, "utf8"), 0);
          socket.write(`+OK ${messages.length} ${bytes}\r\n`);
        } else if (upper === "UIDL") {
          socket.write("+OK\r\n");
          messages.forEach((m, i) => socket.write(`${i + 1} uid-${m.uid}\r\n`));
          socket.write(".\r\n");
        } else if (upper.startsWith("TOP ")) {
          const idx = Number(line.split(/\s+/)[1]) - 1;
          const m = messages[idx];
          if (!m) socket.write("-ERR missing\r\n");
          else {
            socket.write("+OK\r\n");
            socket.write(`${splitHeadersRaw(m.raw)}\r\n.\r\n`);
          }
        } else if (upper.startsWith("RETR ")) {
          const idx = Number(line.split(/\s+/)[1]) - 1;
          const m = messages[idx];
          if (!m) socket.write("-ERR missing\r\n");
          else {
            const stuffed = m.raw.split("\r\n").map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n");
            socket.write(`+OK ${Buffer.byteLength(m.raw, "utf8")} octets\r\n${stuffed}\r\n.\r\n`);
          }
        } else {
          socket.write("+OK\r\n");
        }
      }
    });
  });

  // 3. SMTP server
  const smtpSrv = net.createServer((socket) => {
    socket.write("220 mock.smtp.local ESMTP Ready\r\n");
    let buf = "";
    let authState: 0 | 1 | 2 = 0;
    let authUser = "";
    let mailFrom = "";
    let rcptTo: string[] = [];
    let inData = false;
    let dataLines: string[] = [];

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            const raw = dataLines.map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n");
            sentMessages.push({ from: mailFrom, to: [...rcptTo], raw });
            mailFrom = "";
            rcptTo = [];
            dataLines = [];
            socket.write("250 2.0.0 OK queued\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }

        if (authState === 1) {
          authUser = Buffer.from(line.trim(), "base64").toString("utf8").toLowerCase();
          authState = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (authState === 2) {
          const pw = Buffer.from(line.trim(), "base64").toString("utf8");
          authState = 0;
          if (authUser === validEmail && pw === validPassword) {
            socket.write("235 2.7.0 Authentication successful\r\n");
          } else {
            socket.write("535 5.7.8 Authentication failed\r\n");
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-mock.smtp.local\r\n250 AUTH LOGIN\r\n");
        } else if (upper === "AUTH LOGIN") {
          authState = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("MAIL FROM:")) {
          mailFrom = line.slice(10).replace(/[<>]/g, "").trim();
          socket.write("250 2.1.0 OK\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          rcptTo.push(line.slice(8).replace(/[<>]/g, "").trim());
          socket.write("250 2.1.5 OK\r\n");
        } else if (upper === "DATA") {
          inData = true;
          dataLines = [];
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });

  const [imapPort, pop3Port, smtpPort] = await Promise.all([
    listenNetServer(imapSrv),
    listenNetServer(pop3Srv),
    listenNetServer(smtpSrv),
  ]);

  return {
    imapPort,
    pop3Port,
    smtpPort,
    validEmail,
    validPassword,
    messages,
    sentMessages,
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => imapSrv.close(() => r())),
        new Promise<void>((r) => pop3Srv.close(() => r())),
        new Promise<void>((r) => smtpSrv.close(() => r())),
      ]);
    },
  };
}

export function createMockMcpServerScript(dir: string): string {
  const scriptPath = path.join(dir, "mock-kimi-cu-mcp.mjs");
  const code = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === "notifications/initialized") return;
  const reply = (result) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
  };
  if (req.method === "initialize") {
    reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-kimi-cu", version: "1.0.0" } });
  } else if (req.method === "tools/list") {
    reply({
      tools: [
        {
          name: "list_windows",
          description: "List macOS windows",
          inputSchema: { type: "object", properties: { app: { type: "string" } } }
        },
        {
          name: "click",
          description: "Click window element",
          inputSchema: { type: "object", properties: { app: { type: "string" }, x: { type: "number" }, y: { type: "number" } } }
        },
        {
          name: "inspect_env",
          description: "Return child env keys for security verification",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    });
  } else if (req.method === "tools/call") {
    const name = req.params?.name;
    const args = req.params?.arguments || {};
    if (name === "inspect_env") {
      reply({ content: [{ type: "text", text: JSON.stringify({ envKeys: Object.keys(process.env) }) }] });
      return;
    }
    reply({
      content: [
        { type: "text", text: JSON.stringify({ ok: true, tool: name, args }) },
        { type: "image", data: "${SAMPLE_PNG_BASE64}", mimeType: "image/png" }
      ]
    });
  } else {
    reply({});
  }
});
`;
  fs.writeFileSync(scriptPath, code, "utf8");
  return scriptPath;
}

export function makeMaliciousTarSlipGz(entryName = "../../evil-escape.txt"): Buffer {
  const data = Buffer.from("pwned", "utf8");
  const header = Buffer.alloc(512, 0);
  header.write(entryName, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const pad = (512 - (data.length % 512)) % 512;
  return zlib.gzipSync(Buffer.concat([header, data, Buffer.alloc(pad, 0), Buffer.alloc(1024, 0)]));
}

export async function startOtaFixtureServer(tmpDir: string, builtInPublicDir: string) {
  const goodBundleDir = path.join(tmpDir, "ota-good-src");
  const badBundleDir = path.join(tmpDir, "ota-bad-src");
  fs.cpSync(builtInPublicDir, goodBundleDir, { recursive: true });
  fs.cpSync(builtInPublicDir, badBundleDir, { recursive: true });

  const goodBuild = "20991119.120000-good111111";
  const badBuild = "20991119.130000-bad222222";

  fs.writeFileSync(
    path.join(goodBundleDir, "web-meta.json"),
    JSON.stringify({ webBuild: goodBuild, target: "desktop" }),
    "utf8"
  );
  // Inject a clean observable marker into index.html for white-box E2E verification
  const goodIdx = fs.readFileSync(path.join(goodBundleDir, "index.html"), "utf8");
  fs.writeFileSync(
    path.join(goodBundleDir, "index.html"),
    goodIdx.replace("</body>", `<div id="e2e-ota-marker" data-web-build="${goodBuild}" hidden></div></body>`),
    "utf8"
  );

  fs.writeFileSync(
    path.join(badBundleDir, "web-meta.json"),
    JSON.stringify({ webBuild: badBuild, target: "desktop" }),
    "utf8"
  );
  const badIdx = fs.readFileSync(path.join(badBundleDir, "index.html"), "utf8");
  fs.writeFileSync(
    path.join(badBundleDir, "index.html"),
    badIdx.replace("</body>", `<div id="e2e-ota-marker" data-web-build="${badBuild}" hidden></div></body>`),
    "utf8"
  );

  const goodTarPath = path.join(tmpDir, "ota-good.tar.gz");
  const badTarPath = path.join(tmpDir, "ota-bad.tar.gz");
  const goodInfo = createTarGzFromDir(goodBundleDir, goodTarPath);
  const badInfo = createTarGzFromDir(badBundleDir, badTarPath);
  const evilGz = makeMaliciousTarSlipGz("../../escape.txt");
  const evilSha = crypto.createHash("sha256").update(evilGz).digest("hex");

  const srv = http.createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    if (p === "/ota-good.tar.gz") {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.end(fs.readFileSync(goodTarPath));
      return;
    }
    if (p === "/ota-bad.tar.gz") {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.end(fs.readFileSync(badTarPath));
      return;
    }
    if (p === "/ota-evil.tar.gz") {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.end(evilGz);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listenHttpServer(srv);
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    baseUrl,
    goodBuild,
    goodSha256: goodInfo.sha256,
    goodUrl: `${baseUrl}/ota-good.tar.gz`,
    badBuild,
    badSha256: badInfo.sha256,
    badUrl: `${baseUrl}/ota-bad.tar.gz`,
    evilSha256: evilSha,
    evilUrl: `${baseUrl}/ota-evil.tar.gz`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

export async function startStaticSiteFixtureServer() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (u.pathname === "/login") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Portal Login</title></head><body>
        <h1>Portal Login</h1>
        <form onsubmit="event.preventDefault(); doLogin();">
          <input id="u" type="text" placeholder="Username" />
          <input id="p" type="password" placeholder="Password" />
          <button id="btn" type="submit">Sign In</button>
        </form>
        <script>
          async function doLogin() {
            const resp = await fetch('/do-login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user: document.getElementById('u').value, pass: document.getElementById('p').value })
            });
            if (resp.ok) {
              localStorage.setItem('portal_user', document.getElementById('u').value);
              location.href = '/dashboard';
            }
          }
        </script></body></html>`);
      return;
    }
    if (u.pathname === "/do-login" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const d = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (d.user === "e2e_alice" && d.pass === "SecretPass!99") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "portal_sid=cookie-ok-777; HttpOnly; Path=/",
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      }
      return;
    }
    if (u.pathname === "/dashboard") {
      const cookie = String(req.headers.cookie || "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Dashboard</title></head><body>
        <div id="sid">${cookie.includes("portal_sid=cookie-ok-777") ? "SID_OK" : "SID_MISSING"}</div>
        <div id="ls"></div>
        <script>document.getElementById('ls').textContent = 'LS:' + (localStorage.getItem('portal_user') || 'NONE');</script>
      </body></html>`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Fixture Home</title></head><body><h1>Fixture OK</h1></body></html>`);
  });

  const port = await listenHttpServer(srv);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}
