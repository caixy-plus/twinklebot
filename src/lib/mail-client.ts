import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SOCKET_BYTES = 4 * 1024 * 1024; // 4 MB safety cap

export const QQMAIL_PRESET = {
  imapHost: "imap.qq.com",
  imapPort: 993,
  pop3Host: "pop.qq.com",
  pop3Port: 995,
  smtpHost: "smtp.qq.com",
  smtpPort: 465,
} as const;

export interface MailConfig {
  provider: "qqmail" | "custom-mail";
  email: string;
  password: string;
  senderName: string;
  inboundProtocol: "imap" | "pop3";
  inboundHost: string;
  inboundPort: number;
  inboundTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  smtpStarttls: boolean;
}

export interface MailAccountRecord extends MailConfig {
  id: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  inboxStats: Record<string, any> | null;
}

export function stripHeaderCrlf(val: unknown = ""): string {
  return String(val || "").replace(/[\r\n]+/g, " ").trim();
}

function normalizeCharset(rawCharset = "utf-8"): string {
  const c = String(rawCharset || "utf-8")
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "");
  if (!c || c === "utf8" || c === "us-ascii" || c === "ascii") return "utf-8";
  if (c === "gb2312" || c === "gb_2312-80") return "gbk";
  if (c === "cp936") return "gbk";
  if (c === "latin1" || c === "iso-8859-1") return "windows-1252";
  return c;
}

export function decodeBytes(buf: Uint8Array | Buffer | null | undefined, charset = "utf-8"): string {
  if (!buf || buf.length === 0) return "";
  const norm = normalizeCharset(charset);
  try {
    return new TextDecoder(norm, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

export function decodeQuotedPrintableToBuffer(input = ""): Buffer {
  const cleaned = String(input || "").replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (
      ch === "=" &&
      i + 2 < cleaned.length &&
      /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function decodeRfc2047(raw = ""): string {
  if (!raw) return "";
  const unfolded = String(raw).replace(/\r?\n[ \t]+/g, " ");
  const tokenRe = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

  let out = "";
  let lastIdx = 0;
  let pendingCharset: string | null = null;
  let pendingChunks: Buffer[] = [];

  const flushPending = () => {
    if (pendingChunks.length === 0) return;
    const merged = Buffer.concat(pendingChunks);
    out += decodeBytes(merged, pendingCharset || "utf-8");
    pendingCharset = null;
    pendingChunks = [];
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(unfolded)) !== null) {
    const between = unfolded.slice(lastIdx, match.index);
    if (pendingChunks.length > 0) {
      // RFC 2047: whitespace between adjacent encoded-words is ignored
      if (/^[ \t]+$/.test(between) || between === "") {
        // keep accumulating if same charset
      } else {
        flushPending();
        out += between;
      }
    } else {
      out += between;
    }

    const charset = normalizeCharset(match[1]);
    const encoding = match[2].toUpperCase();
    const payload = match[3] || "";

    let decodedBuf: Buffer;
    if (encoding === "B") {
      decodedBuf = Buffer.from(payload.replace(/\s+/g, ""), "base64");
    } else {
      const qPayload = payload.replace(/_/g, " ");
      decodedBuf = decodeQuotedPrintableToBuffer(qPayload);
    }

    if (pendingCharset && pendingCharset !== charset) {
      flushPending();
    }
    pendingCharset = charset;
    pendingChunks.push(decodedBuf);
    lastIdx = tokenRe.lastIndex;
  }

  flushPending();
  out += unfolded.slice(lastIdx);
  return out.trim();
}

function encodeRfc2047Word(text = ""): string {
  const clean = stripHeaderCrlf(text);
  if (!clean) return "";
  if (/^[\x20-\x7E]+$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function formatAddressHeader(email: string, displayName = ""): string {
  const cleanEmail = stripHeaderCrlf(email).replace(/[<>]/g, "").trim();
  const cleanName = stripHeaderCrlf(displayName);
  if (!cleanName) return cleanEmail;
  return `${encodeRfc2047Word(cleanName)} <${cleanEmail}>`;
}

function extractEmailAddresses(raw: unknown = ""): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(/[,;]+/);
  const result: string[] = [];
  for (const item of items) {
    const clean = stripHeaderCrlf(item);
    if (!clean) continue;
    const angle = clean.match(/<([^<>@\s]+@[^<>@\s]+)>/);
    if (angle) {
      result.push(angle[1].trim());
    } else {
      const bare = clean.match(/([^\s<>@]+@[^\s<>@]+)/);
      if (bare) result.push(bare[1].trim());
    }
  }
  return result;
}

export function parseHeaders(headerStr = ""): Record<string, string> {
  const unfolded = String(headerStr || "").replace(/\r?\n[ \t]+/g, " ");
  const lines = unfolded.split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (headers[key]) {
      headers[key] = `${headers[key]}, ${val}`;
    } else {
      headers[key] = val;
    }
  }
  return headers;
}

function parseHeaderParam(headerVal = "", paramName = ""): string {
  if (!headerVal) return "";
  // RFC 2231 filename*=utf-8''...
  const starRe = new RegExp(`${paramName}\\*=([^;'\\s]+)''([^;\\s]+)`, "i");
  const starMatch = headerVal.match(starRe);
  if (starMatch) {
    try {
      const pctBytes = Buffer.from(
        starMatch[2].replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16))
        ),
        "latin1"
      );
      return decodeBytes(pctBytes, starMatch[1]);
    } catch {
      // fallback below
    }
  }

  const re = new RegExp(`${paramName}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, "i");
  const m = headerVal.match(re);
  if (!m) return "";
  return decodeRfc2047(m[1] ?? m[2] ?? "");
}

export function htmlToReadableText(html = ""): string {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeMimePartBody(
  rawBodyLatin1: string,
  transferEncoding = "",
  charset = "utf-8"
): { buf: Buffer; text: string } {
  const enc = String(transferEncoding || "").trim().toLowerCase();
  let buf: Buffer;
  if (enc === "base64") {
    buf = Buffer.from(rawBodyLatin1.replace(/\s+/g, ""), "base64");
  } else if (enc === "quoted-printable") {
    buf = decodeQuotedPrintableToBuffer(rawBodyLatin1);
  } else {
    buf = Buffer.from(rawBodyLatin1, "latin1");
  }
  return { buf, text: decodeBytes(buf, charset) };
}

function splitHeaderAndBodyLatin1(rawLatin1: string): [string, string] {
  const crlfIdx = rawLatin1.indexOf("\r\n\r\n");
  if (crlfIdx !== -1) {
    return [rawLatin1.slice(0, crlfIdx), rawLatin1.slice(crlfIdx + 4)];
  }
  const lfIdx = rawLatin1.indexOf("\n\n");
  if (lfIdx !== -1) {
    return [rawLatin1.slice(0, lfIdx), rawLatin1.slice(lfIdx + 2)];
  }
  return [rawLatin1, ""];
}

export function parseRawEmail(
  rawInput: Buffer | string,
  { maxBodyChars = 8000 }: { maxBodyChars?: number } = {}
) {
  const rawLatin1 = Buffer.isBuffer(rawInput)
    ? rawInput.toString("latin1")
    : Buffer.from(String(rawInput || ""), "utf8").toString("latin1");

  const [topHeaderBlock, topBodyLatin1] = splitHeaderAndBodyLatin1(rawLatin1);
  const topHeaderUtf8 = decodeBytes(Buffer.from(topHeaderBlock, "latin1"), "utf-8");
  const topHeaders = parseHeaders(topHeaderUtf8);

  const plainParts: string[] = [];
  const htmlParts: string[] = [];
  const attachments: Array<{ filename: string; contentType: string; size: number }> = [];

  function walkPart(headers: Record<string, string>, bodyLatin1: string, depth = 0): void {
    if (depth > 8) return;
    const ct = headers["content-type"] || "text/plain; charset=utf-8";
    const ctLower = ct.toLowerCase();
    const cte = headers["content-transfer-encoding"] || "";
    const disp = headers["content-disposition"] || "";
    const dispLower = disp.toLowerCase();

    if (ctLower.startsWith("multipart/")) {
      const boundary = parseHeaderParam(ct, "boundary");
      if (!boundary) return;
      const delim = `--${boundary}`;
      const segments = bodyLatin1.split(delim);
      for (let i = 1; i < segments.length; i += 1) {
        let seg = segments[i];
        if (seg.startsWith("--")) break;
        seg = seg.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
        if (!seg) continue;
        const [subHdrRaw, subBody] = splitHeaderAndBodyLatin1(seg);
        const subHdrUtf8 = decodeBytes(Buffer.from(subHdrRaw, "latin1"), "utf-8");
        walkPart(parseHeaders(subHdrUtf8), subBody, depth + 1);
      }
      return;
    }

    const filename =
      parseHeaderParam(disp, "filename") || parseHeaderParam(ct, "name");
    const isAttachment =
      dispLower.includes("attachment") ||
      (Boolean(filename) && !ctLower.startsWith("text/"));

    if (isAttachment) {
      const approxBytes =
        cte.trim().toLowerCase() === "base64"
          ? Math.floor(bodyLatin1.replace(/\s+/g, "").length * 0.75)
          : bodyLatin1.length;
      attachments.push({
        filename: filename || "attachment",
        contentType: ct.split(";")[0].trim(),
        size: approxBytes,
      });
      return;
    }

    const charset = parseHeaderParam(ct, "charset") || "utf-8";
    if (ctLower.startsWith("text/plain")) {
      const { text } = decodeMimePartBody(bodyLatin1, cte, charset);
      if (text.trim()) plainParts.push(text.trim());
    } else if (ctLower.startsWith("text/html")) {
      const { text } = decodeMimePartBody(bodyLatin1, cte, charset);
      if (text.trim()) htmlParts.push(text.trim());
    }
  }

  // If rawInput was passed as a normal JS UTF-8 string in tests/callers, preserve UTF-8 for plain unencoded bodies
  const isBufferInput = Buffer.isBuffer(rawInput);
  if (
    !isBufferInput &&
    !(topHeaders["content-type"] || "").toLowerCase().startsWith("multipart/") &&
    !(topHeaders["content-transfer-encoding"] || "").trim()
  ) {
    const [, strBody] = splitHeaderAndBodyLatin1(String(rawInput || ""));
    plainParts.push(strBody.trim());
  } else {
    walkPart(topHeaders, topBodyLatin1, 0);
  }

  let bodyText = plainParts.join("\n\n").trim();
  if (!bodyText && htmlParts.length > 0) {
    bodyText = htmlToReadableText(htmlParts.join("\n\n"));
  }
  if (bodyText.length > maxBodyChars) {
    bodyText = `${bodyText.slice(0, maxBodyChars)}\n…[正文已截断]`;
  }

  return {
    subject: decodeRfc2047(topHeaders.subject || "(无主题)"),
    from: decodeRfc2047(topHeaders.from || ""),
    to: decodeRfc2047(topHeaders.to || ""),
    cc: decodeRfc2047(topHeaders.cc || ""),
    date: topHeaders.date || "",
    messageId: topHeaders["message-id"] || "",
    body: bodyText,
    attachments,
  };
}

export function normalizeMailConfig(
  raw: Record<string, any> = {},
  provider = "custom-mail"
): MailConfig {
  const email = String(raw.email || "").trim();
  const rawSecret = String(raw.password ?? raw.authCode ?? "").replace(/\s+/g, "");

  if (provider === "qqmail") {
    const inboundProtocol = raw.inboundProtocol === "pop3" ? "pop3" : "imap";
    const defaultInboundHost =
      inboundProtocol === "pop3" ? QQMAIL_PRESET.pop3Host : QQMAIL_PRESET.imapHost;
    const defaultInboundPort =
      inboundProtocol === "pop3" ? QQMAIL_PRESET.pop3Port : QQMAIL_PRESET.imapPort;
    return {
      provider: "qqmail",
      email,
      password: rawSecret,
      senderName: stripHeaderCrlf(raw.senderName || ""),
      inboundProtocol,
      inboundHost: String(raw.inboundHost || defaultInboundHost).trim(),
      inboundPort: Number(raw.inboundPort) || defaultInboundPort,
      inboundTls: raw.inboundTls !== false,
      smtpHost: String(raw.smtpHost || QQMAIL_PRESET.smtpHost).trim(),
      smtpPort: Number(raw.smtpPort) || QQMAIL_PRESET.smtpPort,
      smtpTls: raw.smtpTls !== false,
      smtpStarttls: Boolean(raw.smtpStarttls),
    };
  }

  const inboundProtocol = raw.inboundProtocol === "pop3" ? "pop3" : "imap";
  const defaultPort = inboundProtocol === "pop3" ? 995 : 993;
  const inboundPort = Number(raw.inboundPort) || defaultPort;
  const smtpPort = Number(raw.smtpPort) || 465;
  const smtpSecurity = String(raw.smtpSecurity || "").toLowerCase();
  const smtpTls =
    smtpSecurity === "ssl"
      ? true
      : smtpSecurity === "starttls" || smtpSecurity === "none"
        ? false
        : raw.smtpTls !== undefined
          ? Boolean(raw.smtpTls)
          : smtpPort === 465;
  const smtpStarttls =
    smtpSecurity === "starttls" ||
    (raw.smtpStarttls !== undefined
      ? Boolean(raw.smtpStarttls)
      : !smtpTls && smtpPort === 587);

  return {
    provider: "custom-mail",
    email,
    password: rawSecret,
    senderName: stripHeaderCrlf(raw.senderName || ""),
    inboundProtocol,
    inboundHost: String(raw.inboundHost || "").trim(),
    inboundPort,
    inboundTls:
      raw.inboundTls !== undefined
        ? Boolean(raw.inboundTls)
        : inboundPort === 993 || inboundPort === 995,
    smtpHost: String(raw.smtpHost || "").trim(),
    smtpPort,
    smtpTls,
    smtpStarttls,
  };
}

export function normalizeMailAuthStore(rawAuth: any = {}): { accounts: MailAccountRecord[] } {
  const src = rawAuth && typeof rawAuth === "object" ? rawAuth : {};
  const rawList: any[] = [];

  if (Array.isArray(src.accounts)) {
    rawList.push(...src.accounts);
  } else {
    if (src.qqmail && typeof src.qqmail === "object" && src.qqmail.email) {
      rawList.push({
        id: src.qqmail.id || "acct-qqmail",
        provider: "qqmail",
        ...src.qqmail,
      });
    }
    if (
      src["custom-mail"] &&
      typeof src["custom-mail"] === "object" &&
      src["custom-mail"].email
    ) {
      rawList.push({
        id: src["custom-mail"].id || "acct-custom-mail",
        provider: "custom-mail",
        ...src["custom-mail"],
      });
    }
  }

  const seenIds = new Set<string>();
  const accounts: MailAccountRecord[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const provider = item.provider === "qqmail" ? "qqmail" : "custom-mail";
    const cfg = normalizeMailConfig(item, provider);
    if (!cfg.email) continue;
    let id = String(item.id || "").trim() || crypto.randomUUID();
    if (seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);

    accounts.push({
      id,
      ...cfg,
      label: stripHeaderCrlf(item.label || ""),
      enabled: item.enabled !== false,
      isDefault: Boolean(item.isDefault),
      createdAt: item.createdAt || item.updatedAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString(),
      lastVerifiedAt: item.lastVerifiedAt || null,
      inboxStats: item.inboxStats || null,
    });
  }

  const activeCandidates = accounts.filter(
    (a) => a.enabled !== false && a.email && a.password
  );
  if (activeCandidates.length > 0) {
    const preferred =
      activeCandidates.find((a) => a.isDefault) || activeCandidates[0];
    for (const acct of accounts) {
      acct.isDefault = acct.id === preferred.id;
    }
  } else {
    for (const acct of accounts) {
      acct.isDefault = false;
    }
  }

  return { accounts };
}

export function sanitizeMailAccount(
  rawEntry: any = {},
  fallbackProvider = "custom-mail"
) {
  const provider =
    rawEntry?.provider === "qqmail"
      ? "qqmail"
      : fallbackProvider === "qqmail"
        ? "qqmail"
        : "custom-mail";
  const cfg = normalizeMailConfig(rawEntry || {}, provider);
  const configured = Boolean(cfg.email && cfg.password);
  const tail = cfg.password ? cfg.password.slice(-4) : "";
  return {
    id: rawEntry?.id ? String(rawEntry.id) : "",
    provider,
    label: stripHeaderCrlf(rawEntry?.label || ""),
    configured,
    enabled: configured && rawEntry?.enabled !== false,
    isDefault: Boolean(configured && rawEntry?.enabled !== false && rawEntry?.isDefault),
    email: cfg.email,
    senderName: cfg.senderName,
    maskedSecret: configured ? `•••• •••• •••• ${tail}` : "",
    inboundProtocol: cfg.inboundProtocol,
    inboundHost: cfg.inboundHost,
    inboundPort: cfg.inboundPort,
    inboundTls: cfg.inboundTls,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    smtpTls: cfg.smtpTls,
    smtpStarttls: cfg.smtpStarttls,
    lastVerifiedAt: rawEntry?.lastVerifiedAt || null,
    inboxStats: rawEntry?.inboxStats || null,
  };
}

interface WaiterResult<T> {
  value: T;
  consumedBytes: number;
}

interface ProtocolConnection {
  readLine(): Promise<string>;
  readMultilineDotBlock(): Promise<Buffer>;
  readUntilImapTag(tag: string): Promise<{ rawBuffer: Buffer; statusLine: string }>;
  writeLine(line: string): void;
  writeRaw(data: string | Buffer): void;
  upgradeToTls(): Promise<void>;
  close(): void;
}

function createProtocolConnection({
  host,
  port,
  useTls = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  host: string;
  port: number;
  useTls?: boolean;
  timeoutMs?: number;
}): Promise<ProtocolConnection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf: Buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let waiter: {
      predicate: (b: Buffer) => WaiterResult<any> | null;
      resolve: (val: any) => void;
      reject: (err: Error) => void;
    } | null = null;
    let closedErr: Error | null = null;

    const failAll = (err: Error) => {
      closedErr = err;
      if (!settled) {
        settled = true;
        reject(err);
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(err);
      }
    };

    const checkWaiter = () => {
      if (!waiter) return;
      const res = waiter.predicate(buf);
      if (res !== null && res !== undefined) {
        const w = waiter;
        waiter = null;
        buf = buf.subarray(res.consumedBytes);
        w.resolve(res.value);
      }
    };

    const attachListeners = (sock: net.Socket | tls.TLSSocket) => {
      sock.setTimeout(timeoutMs);
      sock.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_SOCKET_BYTES) {
          sock.destroy();
          failAll(new Error("Mail server response exceeded 4MB safety limit"));
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        checkWaiter();
      });
      sock.on("timeout", () => {
        sock.destroy();
        failAll(new Error(`Connection timed out (${host}:${port})`));
      });
      sock.on("error", (err: Error) => {
        failAll(err);
      });
      sock.on("close", () => {
        if (!closedErr) {
          closedErr = new Error(`Connection closed by ${host}:${port}`);
        }
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.reject(closedErr);
        }
      });
    };

    const waitFor = <T>(predicate: (b: Buffer) => WaiterResult<T> | null): Promise<T> => {
      if (closedErr && buf.length === 0) {
        return Promise.reject(closedErr);
      }
      const immediate = predicate(buf);
      if (immediate !== null && immediate !== undefined) {
        buf = buf.subarray(immediate.consumedBytes);
        return Promise.resolve(immediate.value);
      }
      if (closedErr) {
        return Promise.reject(closedErr);
      }
      return new Promise((res, rej) => {
        waiter = { predicate, resolve: res, reject: rej };
      });
    };

    let currentSocket: net.Socket | tls.TLSSocket;

    const api: ProtocolConnection = {
      readLine() {
        return waitFor((b) => {
          const idx = b.indexOf("\r\n");
          if (idx === -1) return null;
          return {
            value: b.subarray(0, idx).toString("utf8"),
            consumedBytes: idx + 2,
          };
        });
      },
      readMultilineDotBlock() {
        return waitFor((b) => {
          // Terminated by "\r\n.\r\n" or starting immediately with ".\r\n"
          if (b.length >= 3 && b[0] === 0x2e && b[1] === 0x0d && b[2] === 0x0a) {
            return { value: Buffer.alloc(0), consumedBytes: 3 };
          }
          const marker = Buffer.from("\r\n.\r\n");
          const idx = b.indexOf(marker);
          if (idx === -1) return null;
          return {
            value: b.subarray(0, idx),
            consumedBytes: idx + marker.length,
          };
        });
      },
      readUntilImapTag(tag: string) {
        const tagPrefix = Buffer.from(`${tag} `);
        return waitFor((b) => {
          let offset = 0;
          while (offset < b.length) {
            const lineEnd = b.indexOf("\r\n", offset);
            if (lineEnd === -1) return null;
            const lineBuf = b.subarray(offset, lineEnd);

            // Check if this line ends with an IMAP literal "{byteCount}"
            const lineAscii = lineBuf.toString("latin1");
            const litMatch = lineAscii.match(/\{(\d+)\}$/);
            if (litMatch) {
              const litLen = Number(litMatch[1]);
              const afterLit = lineEnd + 2 + litLen;
              if (b.length < afterLit) return null;
              offset = afterLit;
              continue;
            }

            if (
              lineBuf.length >= tagPrefix.length &&
              lineBuf.subarray(0, tagPrefix.length).equals(tagPrefix)
            ) {
              return {
                value: {
                  rawBuffer: b.subarray(0, lineEnd + 2),
                  statusLine: lineBuf.toString("utf8"),
                },
                consumedBytes: lineEnd + 2,
              };
            }
            offset = lineEnd + 2;
          }
          return null;
        });
      },
      writeLine(line: string) {
        currentSocket.write(`${line}\r\n`);
      },
      writeRaw(data: string | Buffer) {
        currentSocket.write(data);
      },
      upgradeToTls() {
        return new Promise((resUpgrade, rejUpgrade) => {
          currentSocket.removeAllListeners("data");
          currentSocket.removeAllListeners("timeout");
          currentSocket.removeAllListeners("error");
          currentSocket.removeAllListeners("close");
          buf = Buffer.alloc(0);
          const tlsSock = tls.connect(
            { socket: currentSocket, servername: host },
            () => {
              currentSocket = tlsSock;
              resUpgrade();
            }
          );
          tlsSock.once("error", rejUpgrade);
          attachListeners(tlsSock);
        });
      },
      close() {
        try {
          currentSocket.end();
          currentSocket.destroy();
        } catch {
          // ignore
        }
      },
    };

    const onSocketReady = () => {
      if (settled) return;
      settled = true;
      resolve(api);
    };

    currentSocket = useTls
      ? tls.connect({ host, port, servername: host }, onSocketReady)
      : net.connect({ host, port }, onSocketReady);

    attachListeners(currentSocket);
  });
}

function unstuffDotLinesLatin1(buf: Buffer): Buffer {
  const s = buf.toString("latin1");
  return Buffer.from(
    s
      .split("\r\n")
      .map((line) => (line.startsWith("..") ? line.slice(1) : line))
      .join("\r\n"),
    "latin1"
  );
}

/* ==================== POP3 OPERATIONS ==================== */

async function withPop3Session<T>(
  cfg: MailConfig,
  fn: (conn: ProtocolConnection) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const conn = await createProtocolConnection({
    host: cfg.inboundHost,
    port: cfg.inboundPort,
    useTls: cfg.inboundTls,
    timeoutMs,
  });
  try {
    const greeting = await conn.readLine();
    if (!greeting.startsWith("+OK")) {
      throw new Error(`POP3 握手失败: ${greeting}`);
    }
    conn.writeLine(`USER ${stripHeaderCrlf(cfg.email)}`);
    const userResp = await conn.readLine();
    if (!userResp.startsWith("+OK")) {
      throw new Error(`POP3 用户名被拒绝: ${userResp}`);
    }
    conn.writeLine(`PASS ${stripHeaderCrlf(cfg.password)}`);
    const passResp = await conn.readLine();
    if (!passResp.startsWith("+OK")) {
      throw new Error(`POP3 登录认证失败（请检查邮箱密码或授权码）: ${passResp}`);
    }

    const result = await fn(conn);
    try {
      conn.writeLine("QUIT");
      await conn.readLine();
    } catch {
      // ignore quit errors
    }
    return result;
  } finally {
    conn.close();
  }
}

async function getPop3UidMap(
  conn: ProtocolConnection,
  totalCount: number
): Promise<Array<{ num: number; uid: string }>> {
  conn.writeLine("UIDL");
  const status = await conn.readLine();
  if (!status.startsWith("+OK")) {
    return Array.from({ length: totalCount }, (_, i) => ({
      num: i + 1,
      uid: String(i + 1),
    }));
  }
  const block = await conn.readMultilineDotBlock();
  const lines = block.toString("utf8").split(/\r?\n/).filter(Boolean);
  const items: Array<{ num: number; uid: string }> = [];
  for (const l of lines) {
    const sp = l.trim().split(/\s+/);
    const num = Number(sp[0]);
    const uid = sp.slice(1).join(" ") || String(num);
    if (Number.isFinite(num) && num > 0) {
      items.push({ num, uid });
    }
  }
  return items;
}

/* ==================== IMAP OPERATIONS ==================== */

function quoteImapString(val = ""): string {
  const clean = stripHeaderCrlf(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${clean}"`;
}

function extractImapLiterals(
  rawBuffer: Buffer
): Array<{ metaLine: string; bytes: Buffer }> {
  const literals: Array<{ metaLine: string; bytes: Buffer }> = [];
  let offset = 0;
  while (offset < rawBuffer.length) {
    const lineEnd = rawBuffer.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const lineAscii = rawBuffer.subarray(offset, lineEnd).toString("latin1");
    const litMatch = lineAscii.match(/\{(\d+)\}$/);
    if (litMatch) {
      const len = Number(litMatch[1]);
      const start = lineEnd + 2;
      const end = Math.min(rawBuffer.length, start + len);
      literals.push({
        metaLine: lineAscii,
        bytes: rawBuffer.subarray(start, end),
      });
      offset = end;
    } else {
      offset = lineEnd + 2;
    }
  }
  return literals;
}

type ImapRunCmd = (
  cmd: string,
  opts?: { allowFail?: boolean }
) => Promise<{ rawBuffer: Buffer; statusLine: string }>;

async function withImapSession<T>(
  cfg: MailConfig,
  fn: (runCmd: ImapRunCmd) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const conn = await createProtocolConnection({
    host: cfg.inboundHost,
    port: cfg.inboundPort,
    useTls: cfg.inboundTls,
    timeoutMs,
  });
  let seq = 1;
  const runCmd: ImapRunCmd = async (cmd, { allowFail = false } = {}) => {
    const tag = `A${String(seq++).padStart(3, "0")}`;
    conn.writeLine(`${tag} ${cmd}`);
    const resp = await conn.readUntilImapTag(tag);
    if (!allowFail && !new RegExp(`^${tag}\\s+OK\\b`, "i").test(resp.statusLine)) {
      throw new Error(`IMAP 命令失败 (${cmd.split(" ")[0]}): ${resp.statusLine}`);
    }
    return resp;
  };

  try {
    const greeting = await conn.readLine();
    if (!greeting.startsWith("* OK")) {
      throw new Error(`IMAP 握手失败: ${greeting}`);
    }
    try {
      await runCmd(
        `LOGIN ${quoteImapString(cfg.email)} ${quoteImapString(cfg.password)}`
      );
    } catch (err: any) {
      throw new Error(
        `IMAP 登录失败（请确认已开启 IMAP 服务并填写正确的授权码/密码）: ${err.message}`
      );
    }
    // RFC 2971 client identification (required by 163/126/NetEase & some enterprise servers)
    await runCmd('ID ("name" "TwinkleBot" "version" "1.0.0")', { allowFail: true });

    const out = await fn(runCmd);
    try {
      await runCmd("LOGOUT", { allowFail: true });
    } catch {
      // ignore
    }
    return out;
  } finally {
    conn.close();
  }
}

/* ==================== SMTP OPERATIONS ==================== */

async function readSmtpResponse(
  conn: ProtocolConnection
): Promise<{ code: number; lines: string[]; text: string }> {
  const lines: string[] = [];
  while (true) {
    const line = await conn.readLine();
    lines.push(line);
    if (/^\d{3}\s/.test(line) || line.length < 4) {
      const code = Number(line.slice(0, 3)) || 0;
      return { code, lines, text: lines.join("\n") };
    }
  }
}

async function withSmtpSession<T>(
  cfg: MailConfig,
  fn: (conn: ProtocolConnection) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const conn = await createProtocolConnection({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    useTls: cfg.smtpTls,
    timeoutMs,
  });

  try {
    const greet = await readSmtpResponse(conn);
    if (greet.code !== 220) {
      throw new Error(`SMTP 握手失败: ${greet.text}`);
    }

    conn.writeLine("EHLO twinklebot.local");
    let ehlo = await readSmtpResponse(conn);
    if (ehlo.code !== 250) {
      conn.writeLine("HELO twinklebot.local");
      ehlo = await readSmtpResponse(conn);
      if (ehlo.code !== 250) {
        throw new Error(`SMTP EHLO 失败: ${ehlo.text}`);
      }
    }

    if (!cfg.smtpTls && cfg.smtpStarttls) {
      conn.writeLine("STARTTLS");
      const stls = await readSmtpResponse(conn);
      if (stls.code !== 220) {
        throw new Error(`SMTP STARTTLS 升级失败: ${stls.text}`);
      }
      await conn.upgradeToTls();
      conn.writeLine("EHLO twinklebot.local");
      const ehlo2 = await readSmtpResponse(conn);
      if (ehlo2.code !== 250) {
        throw new Error(`SMTP TLS 升级后 EHLO 失败: ${ehlo2.text}`);
      }
    }

    conn.writeLine("AUTH LOGIN");
    const step1 = await readSmtpResponse(conn);
    if (step1.code !== 334) {
      throw new Error(`SMTP AUTH LOGIN 未就绪: ${step1.text}`);
    }
    conn.writeLine(Buffer.from(stripHeaderCrlf(cfg.email), "utf8").toString("base64"));
    const step2 = await readSmtpResponse(conn);
    if (step2.code !== 334) {
      throw new Error(`SMTP 账号被拒绝: ${step2.text}`);
    }
    conn.writeLine(
      Buffer.from(stripHeaderCrlf(cfg.password), "utf8").toString("base64")
    );
    const authDone = await readSmtpResponse(conn);
    if (authDone.code !== 235) {
      throw new Error(`SMTP 认证失败（请检查授权码或密码）: ${authDone.text}`);
    }

    const res = await fn(conn);
    try {
      conn.writeLine("QUIT");
      await readSmtpResponse(conn);
    } catch {
      // ignore
    }
    return res;
  } finally {
    conn.close();
  }
}

/* ==================== PUBLIC UNIFIED API ==================== */

export async function verifyMailConnection(
  rawConfig: Record<string, any>,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}
) {
  const cfg = normalizeMailConfig(rawConfig, rawConfig?.provider);
  if (!cfg.email || !cfg.password) {
    throw new Error("邮箱地址和授权码/密码不能为空");
  }
  if (!cfg.inboundHost || !cfg.smtpHost) {
    throw new Error("收件服务器与 SMTP 发件服务器地址不能为空");
  }

  const startedAt = Date.now();
  let messages = 0;
  let unseen: number | null = null;

  if (cfg.inboundProtocol === "pop3") {
    const popStats = await withPop3Session(
      cfg,
      async (conn) => {
        conn.writeLine("STAT");
        const statLine = await conn.readLine();
        if (!statLine.startsWith("+OK")) {
          throw new Error(`POP3 STAT 失败: ${statLine}`);
        }
        const parts = statLine.split(/\s+/);
        return { messages: Number(parts[1]) || 0 };
      },
      timeoutMs
    );
    messages = popStats.messages;
  } else {
    const imapStats = await withImapSession(
      cfg,
      async (runCmd) => {
        const statusResp = await runCmd('STATUS "INBOX" (MESSAGES UNSEEN)', {
          allowFail: true,
        });
        const txt = statusResp.rawBuffer.toString("utf8");
        const mMsg = txt.match(/MESSAGES\s+(\d+)/i);
        const mUnseen = txt.match(/UNSEEN\s+(\d+)/i);
        if (mMsg) {
          return {
            messages: Number(mMsg[1]) || 0,
            unseen: mUnseen ? Number(mUnseen[1]) || 0 : 0,
          };
        }
        const selResp = await runCmd('SELECT "INBOX"');
        const selTxt = selResp.rawBuffer.toString("utf8");
        const ex = selTxt.match(/\*\s+(\d+)\s+EXISTS/i);
        return { messages: ex ? Number(ex[1]) || 0 : 0, unseen: null };
      },
      timeoutMs
    );
    messages = imapStats.messages;
    unseen = imapStats.unseen;
  }

  // Also verify SMTP login so outbound mail is guaranteed working
  await withSmtpSession(cfg, async () => true, timeoutMs);

  return {
    ok: true,
    protocol: cfg.inboundProtocol,
    messages,
    ...(unseen !== null ? { unseen } : {}),
    latencyMs: Date.now() - startedAt,
  };
}

export async function listMailMessages(
  rawConfig: Record<string, any>,
  {
    folder = "INBOX",
    limit = 10,
    unseenOnly = false,
    query = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: {
    folder?: string;
    limit?: number;
    unseenOnly?: boolean;
    query?: string;
    timeoutMs?: number;
  } = {}
) {
  const cfg = normalizeMailConfig(rawConfig, rawConfig?.provider);
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 10));
  const needle = String(query || "").trim().toLowerCase();

  if (cfg.inboundProtocol === "pop3") {
    return withPop3Session(
      cfg,
      async (conn) => {
        conn.writeLine("STAT");
        const statLine = await conn.readLine();
        const total = Number(statLine.split(/\s+/)[1]) || 0;
        if (total === 0) return [];

        const uidItems = await getPop3UidMap(conn, total);
        const maxScan = Math.min(uidItems.length, needle ? 35 : safeLimit);
        const results: Array<{
          uid: string;
          subject: string;
          from: string;
          to: string;
          date: string;
          unseen: boolean | null;
        }> = [];

        for (
          let i = uidItems.length - 1;
          i >= 0 && uidItems.length - 1 - i < maxScan && results.length < safeLimit;
          i -= 1
        ) {
          const item = uidItems[i];
          conn.writeLine(`TOP ${item.num} 0`);
          let respLine = await conn.readLine();
          let rawBuf: Buffer;
          if (respLine.startsWith("+OK")) {
            rawBuf = unstuffDotLinesLatin1(await conn.readMultilineDotBlock());
          } else {
            conn.writeLine(`RETR ${item.num}`);
            respLine = await conn.readLine();
            if (!respLine.startsWith("+OK")) continue;
            rawBuf = unstuffDotLinesLatin1(await conn.readMultilineDotBlock());
          }
          const parsed = parseRawEmail(rawBuf, { maxBodyChars: 300 });
          if (
            needle &&
            !parsed.subject.toLowerCase().includes(needle) &&
            !parsed.from.toLowerCase().includes(needle)
          ) {
            continue;
          }
          results.push({
            uid: item.uid,
            subject: parsed.subject,
            from: parsed.from,
            to: parsed.to,
            date: parsed.date,
            unseen: null,
          });
        }
        return results;
      },
      timeoutMs
    );
  }

  return withImapSession(
    cfg,
    async (runCmd) => {
      await runCmd(`SELECT ${quoteImapString(folder || "INBOX")}`);
      const searchRes = await runCmd(
        unseenOnly ? "UID SEARCH UNSEEN" : "UID SEARCH ALL"
      );
      const searchTxt = searchRes.rawBuffer.toString("utf8");
      const searchLine = searchTxt
        .split(/\r?\n/)
        .find((l) => /^\*\s+SEARCH\b/i.test(l));
      if (!searchLine) return [];
      const allUids = searchLine
        .replace(/^\*\s+SEARCH\s*/i, "")
        .trim()
        .split(/\s+/)
        .filter((x) => /^\d+$/.test(x));
      if (allUids.length === 0) return [];

      const windowSize = needle ? 40 : safeLimit;
      const targetUids = allUids.slice(-windowSize);
      const fetchRes = await runCmd(
        `UID FETCH ${targetUids.join(",")} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC DATE MESSAGE-ID)])`
      );

      const literals = extractImapLiterals(fetchRes.rawBuffer);
      const items: Array<{
        uid: string;
        subject: string;
        from: string;
        to: string;
        date: string;
        unseen: boolean;
      }> = [];
      for (const lit of literals) {
        const uidMatch = lit.metaLine.match(/\bUID\s+(\d+)/i);
        const flagsMatch = lit.metaLine.match(/\bFLAGS\s*\(([^)]*)\)/i);
        const uid = uidMatch ? uidMatch[1] : "";
        const flagsStr = flagsMatch ? flagsMatch[1] : "";
        const isSeen = /\\Seen\b/i.test(flagsStr);
        const parsed = parseRawEmail(lit.bytes, { maxBodyChars: 200 });
        if (
          needle &&
          !parsed.subject.toLowerCase().includes(needle) &&
          !parsed.from.toLowerCase().includes(needle)
        ) {
          continue;
        }
        items.push({
          uid,
          subject: parsed.subject,
          from: parsed.from,
          to: parsed.to,
          date: parsed.date,
          unseen: !isSeen,
        });
      }
      items.reverse();
      return items.slice(0, safeLimit);
    },
    timeoutMs
  );
}

export async function readMailMessage(
  rawConfig: Record<string, any>,
  {
    uid,
    folder = "INBOX",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: { uid?: string; folder?: string; timeoutMs?: number } = {}
) {
  const cfg = normalizeMailConfig(rawConfig, rawConfig?.provider);
  const targetUid = String(uid || "").trim();
  if (!targetUid) {
    throw new Error("uid 不能为空");
  }

  if (cfg.inboundProtocol === "pop3") {
    return withPop3Session(
      cfg,
      async (conn) => {
        conn.writeLine("STAT");
        const statLine = await conn.readLine();
        const total = Number(statLine.split(/\s+/)[1]) || 0;
        const uidItems = await getPop3UidMap(conn, total);
        const found =
          uidItems.find((x) => x.uid === targetUid) ||
          uidItems.find((x) => String(x.num) === targetUid);
        if (!found) {
          throw new Error(`未找到 UID 为 ${targetUid} 的邮件`);
        }
        conn.writeLine(`RETR ${found.num}`);
        const retrLine = await conn.readLine();
        if (!retrLine.startsWith("+OK")) {
          throw new Error(`POP3 读取邮件失败: ${retrLine}`);
        }
        const rawBuf = unstuffDotLinesLatin1(await conn.readMultilineDotBlock());
        return { uid: found.uid, ...parseRawEmail(rawBuf) };
      },
      timeoutMs
    );
  }

  return withImapSession(
    cfg,
    async (runCmd) => {
      if (!/^\d+$/.test(targetUid)) {
        throw new Error(`无效的 IMAP UID: ${targetUid}`);
      }
      await runCmd(`SELECT ${quoteImapString(folder || "INBOX")}`);
      const fetchRes = await runCmd(
        `UID FETCH ${targetUid} (UID FLAGS INTERNALDATE BODY.PEEK[])`
      );
      const literals = extractImapLiterals(fetchRes.rawBuffer);
      if (literals.length === 0) {
        throw new Error(`未找到 UID 为 ${targetUid} 的邮件`);
      }
      const lit = literals[0];
      const flagsMatch = lit.metaLine.match(/\bFLAGS\s*\(([^)]*)\)/i);
      const isSeen = flagsMatch ? /\\Seen\b/i.test(flagsMatch[1]) : false;
      return {
        uid: targetUid,
        unseen: !isSeen,
        ...parseRawEmail(lit.bytes),
      };
    },
    timeoutMs
  );
}

export async function sendMailMessage(
  rawConfig: Record<string, any>,
  {
    to,
    cc = "",
    subject = "",
    text = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: {
    to?: string | string[];
    cc?: string | string[];
    subject?: string;
    text?: string;
    timeoutMs?: number;
  } = {}
) {
  const cfg = normalizeMailConfig(rawConfig, rawConfig?.provider);
  const toList = extractEmailAddresses(to);
  const ccList = extractEmailAddresses(cc);
  const allRecipients = [...new Set([...toList, ...ccList])];

  if (toList.length === 0) {
    throw new Error("请提供至少一个有效的收件人邮箱地址");
  }

  const cleanSubject = stripHeaderCrlf(subject || "(无主题)");
  const bodyStr = String(text || "").replace(/\r?\n/g, "\r\n");
  const bodyB64 =
    Buffer.from(bodyStr, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";

  const domain = cfg.email.split("@")[1] || "twinklebot.local";
  const messageId = `<${Date.now()}.${crypto.randomBytes(6).toString("hex")}@${stripHeaderCrlf(domain)}>`;

  const headers = [
    `From: ${formatAddressHeader(cfg.email, cfg.senderName)}`,
    `To: ${toList.join(", ")}`,
    ...(ccList.length > 0 ? [`Cc: ${ccList.join(", ")}`] : []),
    `Subject: ${encodeRfc2047Word(cleanSubject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
  ];

  const rawMime = `${headers.join("\r\n")}\r\n\r\n${bodyB64}`;
  // RFC 5321 Section 4.5.2 transparency (dot-stuffing)
  const dotStuffed = rawMime
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");

  return withSmtpSession(
    cfg,
    async (conn) => {
      const senderAddr = extractEmailAddresses(cfg.email)[0] || stripHeaderCrlf(cfg.email);
      conn.writeLine(`MAIL FROM:<${senderAddr}>`);
      const mf = await readSmtpResponse(conn);
      if (mf.code !== 250) {
        throw new Error(`SMTP MAIL FROM 失败: ${mf.text}`);
      }

      for (const rcpt of allRecipients) {
        conn.writeLine(`RCPT TO:<${rcpt}>`);
        const rt = await readSmtpResponse(conn);
        if (rt.code !== 250 && rt.code !== 251) {
          throw new Error(`SMTP 收件人被拒绝 (${rcpt}): ${rt.text}`);
        }
      }

      conn.writeLine("DATA");
      const dataReady = await readSmtpResponse(conn);
      if (dataReady.code !== 354) {
        throw new Error(`SMTP DATA 阶段失败: ${dataReady.text}`);
      }

      conn.writeRaw(`${dotStuffed}\r\n.\r\n`);
      const done = await readSmtpResponse(conn);
      if (done.code !== 250) {
        throw new Error(`SMTP 邮件投递失败: ${done.text}`);
      }

      return {
        ok: true,
        from: senderAddr,
        to: toList,
        ...(ccList.length > 0 ? { cc: ccList } : {}),
        subject: cleanSubject,
        messageId,
        sentAt: new Date().toISOString(),
      };
    },
    timeoutMs
  );
}
