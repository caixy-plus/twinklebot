import crypto from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsClient {
  id: string;
  socket: Duplex;
  meta: Record<string, any>;
  send(data: unknown): boolean;
}

interface DecodedWsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  bytesConsumed: number;
}

function encodeWsFrame(opcode: number, payloadBuf: Buffer = Buffer.alloc(0)): Buffer {
  const len = payloadBuf.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function tryDecodeWsFrame(buf: Buffer): DecodedWsFrame | null {
  if (buf.length < 2) return null;
  const firstByte = buf[0];
  const secondByte = buf[1];
  const fin = Boolean(firstByte & 0x80);
  const opcode = firstByte & 0x0f;
  const masked = Boolean(secondByte & 0x80);
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    const bigLen = buf.readBigUInt64BE(offset);
    if (bigLen > BigInt(16 * 1024 * 1024)) {
      throw new Error("WebSocket frame exceeds 16MB limit");
    }
    payloadLen = Number(bigLen);
    offset += 8;
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + payloadLen) return null;

  const payload = Buffer.alloc(payloadLen);
  if (masked) {
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ maskKey[i % 4];
    }
  } else {
    buf.copy(payload, 0, offset, offset + payloadLen);
  }

  return {
    fin,
    opcode,
    payload,
    bytesConsumed: offset + payloadLen,
  };
}

export function attachWebSocketServer(
  httpServer: HttpServer,
  {
    path = "/ws",
    authenticate,
    onConnection,
    onMessage,
    onClose,
    onOtherUpgrade,
  }: {
    path?: string;
    authenticate?: (req: IncomingMessage, url: URL) => boolean;
    onConnection?: (client: WsClient, url: URL) => void;
    onMessage?: (client: WsClient, msg: any) => void;
    onClose?: (client: WsClient) => void;
    onOtherUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;
  } = {}
) {
  const clients = new Map<string, WsClient>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function safeWrite(socket: Duplex, frame: Buffer): boolean {
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  function sendJson(client: WsClient, data: unknown): boolean {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    return safeWrite(client.socket, encodeWsFrame(0x1, Buffer.from(raw, "utf8")));
  }

  function sendToClient(clientId: string, data: unknown): boolean {
    const c = clients.get(clientId);
    if (!c) return false;
    return sendJson(c, data);
  }

  function broadcast(data: unknown): void {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    const frame = encodeWsFrame(0x1, Buffer.from(raw, "utf8"));
    for (const c of clients.values()) {
      safeWrite(c.socket, frame);
    }
  }

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (parsedUrl.pathname !== path) {
      if (typeof onOtherUpgrade === "function") {
        onOtherUpgrade(req, socket, head, parsedUrl);
        return;
      }
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (typeof authenticate === "function") {
      const allowed = authenticate(req, parsedUrl);
      if (!allowed) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const wsKey = req.headers["sec-websocket-key"];
    if (!wsKey || typeof wsKey !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash("sha1")
      .update(wsKey.trim() + WS_MAGIC_GUID)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "",
        "",
      ].join("\r\n")
    );

    const clientId = crypto.randomUUID();
    const client: WsClient = {
      id: clientId,
      socket,
      meta: {},
      send: (data: unknown) => sendJson(client, data),
    };
    clients.set(clientId, client);

    let buffer: Buffer = Buffer.alloc(0);
    let fragmentedChunks: Buffer[] = [];

    const cleanup = () => {
      if (!clients.has(clientId)) return;
      clients.delete(clientId);
      onClose?.(client);
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length > 0) {
          const frame = tryDecodeWsFrame(buffer);
          if (!frame) break;
          buffer = buffer.subarray(frame.bytesConsumed);

          if (frame.opcode === 0x8) {
            safeWrite(socket, encodeWsFrame(0x8, Buffer.alloc(0)));
            socket.end();
            cleanup();
            return;
          }
          if (frame.opcode === 0x9) {
            safeWrite(socket, encodeWsFrame(0xa, frame.payload));
            continue;
          }
          if (frame.opcode === 0xa) {
            continue;
          }
          if (frame.opcode === 0x1 || frame.opcode === 0x0) {
            fragmentedChunks.push(frame.payload);
            if (frame.fin) {
              const fullText = Buffer.concat(fragmentedChunks).toString("utf8");
              fragmentedChunks = [];
              let parsedMsg: any = null;
              try {
                parsedMsg = JSON.parse(fullText);
              } catch {
                parsedMsg = { type: "raw", text: fullText };
              }
              onMessage?.(client, parsedMsg);
            }
          }
        }
      } catch {
        safeWrite(socket, encodeWsFrame(0x8, Buffer.alloc(0)));
        socket.destroy();
        cleanup();
      }
    });

    socket.on("close", cleanup);
    socket.on("error", cleanup);
    onConnection?.(client, parsedUrl);
  };

  httpServer.on("upgrade", upgradeHandler);

  heartbeatTimer = setInterval(() => {
    const pingFrame = encodeWsFrame(0x9, Buffer.alloc(0));
    for (const c of clients.values()) {
      safeWrite(c.socket, pingFrame);
    }
  }, 20_000);
  heartbeatTimer.unref?.();

  return {
    broadcast,
    sendToClient,
    handleUpgrade: upgradeHandler,
    getClients() {
      return [...clients.values()];
    },
    close() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      httpServer.off("upgrade", upgradeHandler);
      for (const c of [...clients.values()]) {
        safeWrite(c.socket, encodeWsFrame(0x8, Buffer.alloc(0)));
        try {
          c.socket.destroy();
        } catch {
          // ignore
        }
      }
      clients.clear();
    },
  };
}
