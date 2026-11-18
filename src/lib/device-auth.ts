import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIRING_ATTEMPTS = 5;

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  deviceId: string;
  tokenHash?: string;
  tokenPrefix: string;
  remoteAddress?: string;
  createdAt: string;
  lastSeenAt: string;
}

interface PendingPairing {
  pairingId: string;
  code: string;
  deviceName: string;
  platform: string;
  deviceId: string;
  remoteAddress: string;
  attempts: number;
  createdAt: number;
  expiresAt: number;
}

export function isLoopbackAddress(remoteAddr = ""): boolean {
  const raw = String(remoteAddr || "").trim().toLowerCase();
  if (!raw) return false;
  return (
    raw === "127.0.0.1" ||
    raw === "::1" ||
    raw === "::ffff:127.0.0.1" ||
    raw === "localhost"
  );
}

function sha256Hex(value = ""): string {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {}
  fs.renameSync(tmpFile, filePath);
}

function extractRequestToken(req: IncomingMessage | any, url?: URL): string {
  const authHeader = String(req?.headers?.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (url && typeof url.searchParams?.get === "function") {
    const q = String(url.searchParams.get("token") || "").trim();
    if (q) return q;
  }
  return "";
}

export function createDeviceAuthManager(
  store: { dataDir?: string } | null | undefined,
  { dataDir, nowFn = () => Date.now() }: { dataDir?: string; nowFn?: () => number } = {}
) {
  const resolvedDataDir = dataDir || store?.dataDir || "";
  const devicesFile = resolvedDataDir
    ? path.join(path.resolve(resolvedDataDir), "devices.json")
    : "";
  const pendingPairings = new Map<string, PendingPairing>();
  let memoryDevices: DeviceRecord[] = [];

  function readDevicesRaw(): DeviceRecord[] {
    if (!devicesFile) return [...memoryDevices];
    try {
      if (!fs.existsSync(devicesFile)) return [];
      const parsed = JSON.parse(fs.readFileSync(devicesFile, "utf8"));
      return Array.isArray(parsed?.devices) ? parsed.devices : Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeDevicesRaw(devices: DeviceRecord[]): void {
    memoryDevices = devices;
    if (!devicesFile) return;
    writeJsonAtomic(devicesFile, { devices });
  }

  function cleanupExpired(): void {
    const now = nowFn();
    for (const [id, entry] of pendingPairings.entries()) {
      if (now >= entry.expiresAt) {
        pendingPairings.delete(id);
      }
    }
  }

  function listDevices(): Omit<DeviceRecord, "tokenHash">[] {
    return readDevicesRaw().map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      deviceId: d.deviceId || "",
      tokenPrefix: d.tokenPrefix || "",
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      remoteAddress: d.remoteAddress || "",
    }));
  }

  function revokeDevice(id: string): boolean {
    const targetId = String(id || "").trim();
    if (!targetId) return false;
    const current = readDevicesRaw();
    const next = current.filter((d) => d.id !== targetId);
    if (next.length === current.length) return false;
    writeDevicesRaw(next);
    return true;
  }

  function createPairingRequest({
    deviceName = "Mobile Device",
    platform = "mobile",
    deviceId = "",
    remoteAddress = "",
  }: {
    deviceName?: string;
    platform?: string;
    deviceId?: string;
    remoteAddress?: string;
  } = {}) {
    cleanupExpired();
    const now = nowFn();
    const pairingId = crypto.randomUUID();
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now + PAIRING_TTL_MS;
    const entry: PendingPairing = {
      pairingId,
      code,
      deviceName: String(deviceName || "Mobile Device").trim().slice(0, 48) || "Mobile Device",
      platform: String(platform || "mobile").trim().slice(0, 24) || "mobile",
      deviceId: String(deviceId || "").trim().slice(0, 64),
      remoteAddress: String(remoteAddress || "").trim(),
      attempts: 0,
      createdAt: now,
      expiresAt,
    };
    pendingPairings.set(pairingId, entry);
    return {
      pairingId,
      code,
      deviceName: entry.deviceName,
      platform: entry.platform,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  function verifyPairing({
    pairingId,
    code,
    deviceName,
    platform,
  }: {
    pairingId?: string;
    code?: string;
    deviceName?: string;
    platform?: string;
  } = {}) {
    cleanupExpired();
    const id = String(pairingId || "").trim();
    const supplied = String(code || "").trim();
    const entry = pendingPairings.get(id);
    if (!entry) {
      throw new Error("配对请求不存在或已过期，请重新发起配对");
    }
    if (nowFn() >= entry.expiresAt) {
      pendingPairings.delete(id);
      throw new Error("配对码已过期，请重新发起配对");
    }
    if (entry.attempts >= MAX_PAIRING_ATTEMPTS) {
      pendingPairings.delete(id);
      throw new Error("错误次数过多，配对已锁定，请重新发起配对");
    }
    const a = Buffer.from(entry.code, "utf8");
    const b = Buffer.from(
      supplied.padEnd(entry.code.length, "\0").slice(0, entry.code.length),
      "utf8"
    );
    const matches = supplied.length === entry.code.length && crypto.timingSafeEqual(a, b);
    if (!matches) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_PAIRING_ATTEMPTS) {
        pendingPairings.delete(id);
        throw new Error("配对码错误次数过多，请重新发起配对");
      }
      throw new Error(`配对码错误（还可尝试 ${MAX_PAIRING_ATTEMPTS - entry.attempts} 次）`);
    }

    pendingPairings.delete(id);
    const deviceToken = crypto.randomBytes(32).toString("hex");
    const nowIso = new Date(nowFn()).toISOString();
    const cleanName =
      String(deviceName || entry.deviceName || "Mobile Device").trim().slice(0, 48) ||
      "Mobile Device";
    const cleanPlatform =
      String(platform || entry.platform || "mobile").trim().slice(0, 24) || "mobile";

    const current = readDevicesRaw().filter(
      (d) => !(entry.deviceId && d.deviceId && d.deviceId === entry.deviceId)
    );
    const record: DeviceRecord = {
      id: `dev-${crypto.randomUUID().slice(0, 12)}`,
      name: cleanName,
      platform: cleanPlatform,
      deviceId: entry.deviceId || "",
      tokenHash: sha256Hex(deviceToken),
      tokenPrefix: deviceToken.slice(0, 8),
      remoteAddress: entry.remoteAddress || "",
      createdAt: nowIso,
      lastSeenAt: nowIso,
    };
    current.push(record);
    writeDevicesRaw(current);

    return {
      device: {
        id: record.id,
        name: record.name,
        platform: record.platform,
        deviceId: record.deviceId,
        tokenPrefix: record.tokenPrefix,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
      },
      deviceToken,
    };
  }

  function isAuthorized(req: IncomingMessage | any, url?: URL): boolean {
    // Only trust socket.remoteAddress (never X-Forwarded-For) to enforce loopback vs LAN boundary
    const remoteAddr = req?.socket?.remoteAddress || req?.connection?.remoteAddress || "";
    if (isLoopbackAddress(remoteAddr)) {
      return true;
    }
    const token = extractRequestToken(req, url);
    if (!token) return false;
    const suppliedHash = Buffer.from(sha256Hex(token), "utf8");
    const devices = readDevicesRaw();
    for (const dev of devices) {
      if (!dev?.tokenHash) continue;
      const storedHash = Buffer.from(String(dev.tokenHash), "utf8");
      if (
        storedHash.length === suppliedHash.length &&
        crypto.timingSafeEqual(storedHash, suppliedHash)
      ) {
        dev.lastSeenAt = new Date(nowFn()).toISOString();
        try {
          writeDevicesRaw(devices);
        } catch {}
        return true;
      }
    }
    return false;
  }

  return {
    isAuthorized,
    listDevices,
    revokeDevice,
    createPairingRequest,
    verifyPairing,
    cleanupExpired,
  };
}

export default { isLoopbackAddress, createDeviceAuthManager };
