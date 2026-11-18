import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAX_ARCHIVE_FILES = 1000;
const MAX_TOTAL_UNPACK_BYTES = 32 * 1024 * 1024; // 32 MiB hard safety limit

export interface TarGzPackageResult {
  outFile: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
}

export interface TarGzExtractResult {
  destDir: string;
  fileCount: number;
  totalBytes: number;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number) {
  const oct = Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(length - 1, "0");
  buf.write(`${oct}\0`, offset, length, "ascii");
}

function splitTarPath(relPosix: string): { prefix: string; name: string } {
  const bytes = Buffer.byteLength(relPosix, "utf8");
  if (bytes <= 100) {
    return { prefix: "", name: relPosix };
  }
  const parts = relPosix.split("/");
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { prefix, name };
    }
  }
  throw new Error(`Tar entry path too long (>255 bytes): ${relPosix}`);
}

function createUstarHeader(relPosix: string, sizeBytes: number, mtimeSec = 0): Buffer {
  const { prefix, name } = splitTarPath(relPosix);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, sizeBytes);
  writeOctal(header, 136, 12, mtimeSec);
  header.fill(0x20, 148, 156); // checksum placeholder spaces
  header.write("0", 156, 1, "ascii"); // regular file ('0')
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) {
    header.write(prefix, 345, 155, "utf8");
  }
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function collectFilesDeterministic(rootDir: string, relBase = ""): string[] {
  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const ent of entries) {
    if (
      ent.name === ".DS_Store" ||
      ent.name.endsWith(".map") ||
      ent.name.startsWith(".env")
    ) {
      continue;
    }
    const full = path.join(rootDir, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...collectFilesDeterministic(full, rel));
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Creates a deterministic USTAR `.tar.gz` archive from `sourceDir` without external binaries.
 * Source maps (`*.map`) and `.env*` files are excluded automatically.
 */
export function createTarGzFromDir(
  sourceDir: string,
  outFile: string
): TarGzPackageResult {
  const resolvedSrc = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedSrc) || !fs.statSync(resolvedSrc).isDirectory()) {
    throw new Error(`Source directory not found: ${resolvedSrc}`);
  }
  const relFiles = collectFilesDeterministic(resolvedSrc);
  const chunks: Buffer[] = [];
  for (const rel of relFiles) {
    const abs = path.join(resolvedSrc, ...rel.split("/"));
    const data = fs.readFileSync(abs);
    chunks.push(createUstarHeader(rel, data.length, 0));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // two zero 512-byte EOF blocks
  const tarBuf = Buffer.concat(chunks);
  const gzBuf = zlib.gzipSync(tarBuf, { level: 9 });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmpFile = `${outFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, gzBuf);
  fs.renameSync(tmpFile, outFile);

  const sha256 = crypto.createHash("sha256").update(gzBuf).digest("hex");
  return {
    outFile,
    sha256,
    sizeBytes: gzBuf.length,
    fileCount: relFiles.length,
  };
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : length).toString("utf8");
}

function readTarOctal(buf: Buffer, offset: number, length: number): number {
  const raw = readTarString(buf, offset, length).trim();
  if (!raw) return 0;
  const val = Number.parseInt(raw, 8);
  if (!Number.isFinite(val) || val < 0) {
    throw new Error(`Invalid tar octal field: ${raw}`);
  }
  return val;
}

function sanitizeArchiveRelativePath(rawPath: string): string {
  const normalized = String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Unsafe absolute tar path rejected: ${rawPath}`);
  }
  const segments = normalized.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) {
    throw new Error(`Unsafe tar traversal path rejected: ${rawPath}`);
  }
  return segments.join("/");
}

/**
 * Safely extracts a `.tar.gz` buffer or file into `destDir` with strict Tar-Slip,
 * symlink/hardlink rejection, and decompression size guards.
 */
export function extractTarGzSafely(
  tarGzInput: Buffer | string,
  destDir: string
): TarGzExtractResult {
  const gzBuf =
    typeof tarGzInput === "string" ? fs.readFileSync(tarGzInput) : tarGzInput;
  const tarBuf = zlib.gunzipSync(gzBuf, {
    maxOutputLength: MAX_TOTAL_UNPACK_BYTES + 2 * 1024 * 1024,
  });

  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true });

  let offset = 0;
  let fileCount = 0;
  let totalBytes = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    offset += 512;

    if (header.every((b) => b === 0)) {
      break;
    }

    const expectedSum = readTarOctal(header, 148, 8);
    let actualSum = 0;
    for (let i = 0; i < 512; i += 1) {
      actualSum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    if (actualSum !== expectedSum) {
      throw new Error("Invalid tar header checksum");
    }

    const namePart = readTarString(header, 0, 100);
    const prefixPart = readTarString(header, 345, 155);
    const rawRel = prefixPart ? `${prefixPart}/${namePart}` : namePart;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const fileSize = readTarOctal(header, 124, 12);

    const blocks = Math.ceil(fileSize / 512) * 512;
    if (offset + blocks > tarBuf.length) {
      throw new Error("Truncated tar entry payload");
    }
    const content = tarBuf.subarray(offset, offset + fileSize);
    offset += blocks;

    // Reject symlinks ('2') and hardlinks ('1') to prevent link-based traversal
    if (typeFlag === "1" || typeFlag === "2") {
      throw new Error(`Unsafe link entry rejected in tar: ${rawRel}`);
    }

    // Ignore PAX extended metadata headers ('x' / 'g')
    if (typeFlag === "x" || typeFlag === "g") {
      continue;
    }

    const cleanRel = sanitizeArchiveRelativePath(rawRel);
    if (!cleanRel) continue;

    const targetPath = path.resolve(resolvedDest, ...cleanRel.split("/"));
    const relCheck = path.relative(resolvedDest, targetPath);
    if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
      throw new Error(`Tar-Slip path escape rejected: ${rawRel}`);
    }

    if (typeFlag === "5") {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (typeFlag === "0" || typeFlag === "\0") {
      fileCount += 1;
      totalBytes += fileSize;
      if (fileCount > MAX_ARCHIVE_FILES || totalBytes > MAX_TOTAL_UNPACK_BYTES) {
        throw new Error("Tar archive exceeds safety limits");
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content);
    }
  }

  return { destDir: resolvedDest, fileCount, totalBytes };
}
