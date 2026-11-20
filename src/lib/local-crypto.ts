import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalCryptoKeyBackend = "os-keychain" | "dpapi" | "keyfile";

export interface EncryptedEnvelope {
  __twinklebot_encrypted__: 1;
  alg: "aes-256-gcm";
  kdf: LocalCryptoKeyBackend;
  iv: string;
  tag: string;
  ciphertext: string;
}

const AAD = Buffer.from("twinklebot-local-store-v1", "utf-8");
const KEYCHAIN_SERVICE = "com.twinklebot.vault";
const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

const keyCache = new Map<string, { key: Buffer; kdf: LocalCryptoKeyBackend }>();
let warnedKeychainFallback = false;

export function clearLocalCryptoKeyCache(): void {
  keyCache.clear();
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.__twinklebot_encrypted__ === 1 &&
    v.alg === "aes-256-gcm" &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.ciphertext === "string"
  );
}

function writeAtomicSecure(filePath: string, content: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmpFile, content, { encoding: "utf-8", mode });
  try {
    fs.chmodSync(tmpFile, mode);
  } catch {
    // ignore on platforms without POSIX chmod
  }
  fs.renameSync(tmpFile, filePath);
}

function isPathInsideDir(candidate: string, parentDir: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function shouldUseKeyfileDirectly(rootDir: string): boolean {
  if (process.env.TWINKLEBOT_MASTER_KEY_FILE) return true;
  if (process.env.TWINKLEBOT_KEY_BACKEND === "keyfile") return true;
  if (process.env.NODE_TEST_CONTEXT || process.env.TWINKLEBOT_TEST === "1") return true;
  const tmpRoot = os.tmpdir();
  let realTmp = tmpRoot;
  try {
    realTmp = fs.realpathSync(tmpRoot);
  } catch {
    // keep raw tmpdir
  }
  if (isPathInsideDir(rootDir, tmpRoot) || isPathInsideDir(rootDir, realTmp)) {
    return true;
  }
  return false;
}

function loadOrCreateKeyfile(keyFilePath: string): { key: Buffer; kdf: LocalCryptoKeyBackend } {
  if (fs.existsSync(keyFilePath)) {
    const raw = fs.readFileSync(keyFilePath, "utf-8").trim();
    if (HEX_KEY_RE.test(raw)) {
      return { key: Buffer.from(raw, "hex"), kdf: "keyfile" };
    }
  }
  const key = crypto.randomBytes(32);
  writeAtomicSecure(keyFilePath, `${key.toString("hex")}\n`, 0o600);
  return { key, kdf: "keyfile" };
}

function loadOrCreateMacKeychainKey(
  rootDir: string
): { key: Buffer; kdf: LocalCryptoKeyBackend } | null {
  const account = `master-key-${crypto
    .createHash("sha256")
    .update(path.resolve(rootDir))
    .digest("hex")
    .slice(0, 12)}`;

  try {
    const existing = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    if (HEX_KEY_RE.test(existing)) {
      return { key: Buffer.from(existing, "hex"), kdf: "os-keychain" };
    }
  } catch {
    // Entry may not exist yet; attempt to create below
  }

  try {
    const key = crypto.randomBytes(32);
    const hex = key.toString("hex");
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        account,
        "-w",
        hex,
        "-l",
        "TwinkleBot Local Vault Master Key",
      ],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }
    );
    return { key, kdf: "os-keychain" };
  } catch {
    return null;
  }
}

function loadOrCreateWindowsDpapiKey(
  rootDir: string
): { key: Buffer; kdf: LocalCryptoKeyBackend } | null {
  const dpapiFile = path.join(rootDir, ".vault.dpapi");
  const psArgs = ["-NoProfile", "-NonInteractive", "-Command"];

  if (fs.existsSync(dpapiFile)) {
    try {
      const protectedB64 = fs.readFileSync(dpapiFile, "utf-8").trim();
      if (protectedB64) {
        const script =
          "Add-Type -AssemblyName System.Security; " +
          "$raw = [Convert]::FromBase64String($env:TB_DPAPI_IN); " +
          "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
          "[Convert]::ToBase64String($plain)";
        const out = execFileSync("powershell.exe", [...psArgs, script], {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, TB_DPAPI_IN: protectedB64 },
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        const key = Buffer.from(out, "base64");
        if (key.length === 32) {
          return { key, kdf: "dpapi" };
        }
      }
    } catch {
      return null;
    }
  }

  try {
    const key = crypto.randomBytes(32);
    const script =
      "Add-Type -AssemblyName System.Security; " +
      "$raw = [Convert]::FromBase64String($env:TB_DPAPI_PLAIN); " +
      "$prot = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
      "[Convert]::ToBase64String($prot)";
    const protectedB64 = execFileSync("powershell.exe", [...psArgs, script], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, TB_DPAPI_PLAIN: key.toString("base64") },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (protectedB64) {
      writeAtomicSecure(dpapiFile, `${protectedB64}\n`, 0o600);
      return { key, kdf: "dpapi" };
    }
  } catch {
    return null;
  }
  return null;
}

function resolveMasterKey(
  rootDir: string,
  opts: { keyFilePath?: string; platform?: NodeJS.Platform; forceKeyfile?: boolean } = {}
): { key: Buffer; kdf: LocalCryptoKeyBackend } {
  const resolvedRoot = path.resolve(rootDir);
  const customKeyFile = opts.keyFilePath || process.env.TWINKLEBOT_MASTER_KEY_FILE || "";
  const platform = opts.platform || process.platform;
  const forceKeyfile = Boolean(opts.forceKeyfile || shouldUseKeyfileDirectly(resolvedRoot));
  const cacheKey = `${resolvedRoot}|${customKeyFile}|${platform}|${forceKeyfile ? "kf" : "os"}`;

  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const fallbackKeyFile = customKeyFile
    ? path.resolve(customKeyFile)
    : path.join(resolvedRoot, ".vault.key");

  let resolved: { key: Buffer; kdf: LocalCryptoKeyBackend } | null = null;

  if (customKeyFile || forceKeyfile) {
    resolved = loadOrCreateKeyfile(fallbackKeyFile);
  } else if (platform === "darwin") {
    resolved = loadOrCreateMacKeychainKey(resolvedRoot);
    if (!resolved) {
      if (!warnedKeychainFallback) {
        warnedKeychainFallback = true;
        console.warn("[local-crypto] macOS Keychain unavailable, falling back to 0600 keyfile");
      }
      resolved = loadOrCreateKeyfile(fallbackKeyFile);
    }
  } else if (platform === "win32") {
    resolved = loadOrCreateWindowsDpapiKey(resolvedRoot);
    if (!resolved) {
      if (!warnedKeychainFallback) {
        warnedKeychainFallback = true;
        console.warn("[local-crypto] Windows DPAPI unavailable, falling back to 0600 keyfile");
      }
      resolved = loadOrCreateKeyfile(fallbackKeyFile);
    }
  } else {
    resolved = loadOrCreateKeyfile(fallbackKeyFile);
  }

  keyCache.set(cacheKey, resolved);
  return resolved;
}

export function createLocalCrypto(
  rootDir: string,
  opts: { keyFilePath?: string; platform?: NodeJS.Platform; forceKeyfile?: boolean } = {}
) {
  const getKey = () => resolveMasterKey(rootDir, opts);

  function encryptJson(data: unknown): EncryptedEnvelope {
    const { key, kdf } = getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(data), "utf-8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      __twinklebot_encrypted__: 1,
      alg: "aes-256-gcm",
      kdf,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  function decryptJson<T = any>(envelope: EncryptedEnvelope): T {
    const { key } = getKey();
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf-8")) as T;
  }

  function writeEncryptedJsonFile(filePath: string, data: unknown): void {
    const envelope = encryptJson(data);
    writeAtomicSecure(filePath, JSON.stringify(envelope, null, 2), 0o600);
  }

  function readEncryptedJsonFile<T>(
    filePath: string,
    fallback: T,
    { migratePlaintext = true }: { migratePlaintext?: boolean } = {}
  ): T {
    if (!fs.existsSync(filePath)) return fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (isEncryptedEnvelope(parsed)) {
        return decryptJson<T>(parsed);
      }
      // Legacy plaintext JSON detected — transparently re-encrypt in place
      if (migratePlaintext) {
        try {
          writeEncryptedJsonFile(filePath, parsed);
        } catch {
          // Keep returning parsed data even if migration write fails (e.g. read-only FS)
        }
      }
      return parsed as T;
    } catch {
      return fallback;
    }
  }

  function getBackendKind(): LocalCryptoKeyBackend {
    return getKey().kdf;
  }

  return {
    encryptJson,
    decryptJson,
    readEncryptedJsonFile,
    writeEncryptedJsonFile,
    getBackendKind,
  };
}
