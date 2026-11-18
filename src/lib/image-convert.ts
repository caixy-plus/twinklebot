import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SupportedImageOutputFormat =
  | "svg"
  | "png"
  | "jpg"
  | "webp"
  | "gif"
  | "bmp"
  | "ico"
  | "pdf";

export const SUPPORTED_IMAGE_OUTPUT_FORMATS: readonly SupportedImageOutputFormat[] = [
  "svg",
  "png",
  "jpg",
  "webp",
  "gif",
  "bmp",
  "ico",
  "pdf",
];

const FORMAT_MIME_MAP: Record<SupportedImageOutputFormat, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
};

const MIME_FORMAT_MAP: Record<string, SupportedImageOutputFormat> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "application/pdf": "pdf",
};

const SIPS_WRITABLE_FORMATS = new Set<SupportedImageOutputFormat>([
  "png",
  "jpg",
  "gif",
  "bmp",
  "pdf",
]);

export function normalizeImageOutputFormat(
  raw: unknown
): SupportedImageOutputFormat | "" {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!s) return "";
  if (s === "jpeg") return "jpg";
  if (s === "svg+xml") return "svg";
  if ((SUPPORTED_IMAGE_OUTPUT_FORMATS as readonly string[]).includes(s)) {
    return s as SupportedImageOutputFormat;
  }
  return "";
}

export function mimeTypeForImageFormat(fmt: SupportedImageOutputFormat): string {
  return FORMAT_MIME_MAP[fmt] || "image/png";
}

export function imageFormatFromMimeType(
  mimeType: unknown
): SupportedImageOutputFormat | "" {
  const base = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return MIME_FORMAT_MAP[base] || "";
}

export interface ConvertImageOptions {
  inputBuffer: Buffer;
  inputMimeType?: string;
  targetFormat: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
  executor?: { call?: (path: string, body: Record<string, any>) => Promise<any> } | null;
  customConverter?: (opts: {
    inputBuffer: Buffer;
    inputMimeType: string;
    targetFormat: SupportedImageOutputFormat;
    width?: number;
    height?: number;
    signal?: AbortSignal;
  }) => Promise<{ buffer: Buffer; mimeType?: string; converter?: string }>;
}

export interface ConvertImageResult {
  buffer: Buffer;
  format: SupportedImageOutputFormat;
  mimeType: string;
  converter: string;
}

function execFileAsync(
  cmd: string,
  args: string[],
  timeoutMs = 20_000,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e: any = new Error(
            String(stderr || err.message || `Command failed: ${cmd}`).trim()
          );
          e.code = (err as any).code;
          e.cause = err;
          reject(e);
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

function readValidOutputFile(filePath: string): Buffer | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function looksLikeSvgBuffer(buf: Buffer, mime = ""): boolean {
  if (mime.includes("svg")) return true;
  const head = buf.subarray(0, 512).toString("utf-8").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

function wrapRasterAsSvg(
  inputBuffer: Buffer,
  inputMimeType: string,
  width = 1024,
  height = 1024
): Buffer {
  const safeW = Number.isFinite(width) && width > 0 ? Math.round(width) : 1024;
  const safeH = Number.isFinite(height) && height > 0 ? Math.round(height) : 1024;
  const b64 = inputBuffer.toString("base64");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${safeW} ${safeH}" width="${safeW}" height="${safeH}">`,
    `  <image href="data:${inputMimeType};base64,${b64}" width="${safeW}" height="${safeH}" preserveAspectRatio="xMidYMid meet"/>`,
    `</svg>`,
  ].join("\n");
  return Buffer.from(svg, "utf-8");
}

function getToolCandidates(names: string[]): string[] {
  const out: string[] = [];
  const commonDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  for (const name of names) {
    out.push(name);
    if (!name.startsWith("/")) {
      for (const dir of commonDirs) {
        const full = path.join(dir, name);
        if (fs.existsSync(full) && !out.includes(full)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

async function runFirstWorkingConverter(
  attempts: Array<{ name: string; fn: () => Promise<Buffer | null> }>,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; converter: string } | null> {
  for (const attempt of attempts) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    try {
      const buf = await attempt.fn();
      if (buf && buf.length > 0) {
        return { buffer: buf, converter: attempt.name };
      }
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw err;
      }
      // Try next converter
    }
  }
  return null;
}

async function convertRasterFileViaCli(
  srcPath: string,
  srcFmt: SupportedImageOutputFormat,
  targetFmt: SupportedImageOutputFormat,
  tmpDir: string,
  opts: { width?: number; height?: number; signal?: AbortSignal }
): Promise<{ buffer: Buffer; converter: string } | null> {
  if (srcFmt === targetFmt) {
    const buf = readValidOutputFile(srcPath);
    return buf ? { buffer: buf, converter: "passthrough" } : null;
  }

  const outPath = path.join(tmpDir, `out.${targetFmt}`);
  const sipsFormat = targetFmt === "jpg" ? "jpeg" : targetFmt;
  const needsOpaqueBg = targetFmt === "jpg" || targetFmt === "bmp";
  const attempts: Array<{ name: string; fn: () => Promise<Buffer | null> }> = [];

  for (const bin of getToolCandidates(["magick", "convert"])) {
    attempts.push({
      name: path.basename(bin),
      fn: async () => {
        const args = [srcPath];
        if (opts.width && opts.height) {
          args.push("-resize", `${Math.round(opts.width)}x${Math.round(opts.height)}`);
        }
        if (needsOpaqueBg) {
          args.push("-background", "white", "-alpha", "remove", "-alpha", "off");
        }
        if (targetFmt === "ico") {
          args.push("-define", "icon:auto-resize=256,128,64,48,32,16");
        }
        args.push(outPath);
        await execFileAsync(bin, args, 20_000, opts.signal);
        return readValidOutputFile(outPath);
      },
    });
  }

  if (process.platform === "darwin" && SIPS_WRITABLE_FORMATS.has(targetFmt)) {
    attempts.push({
      name: "sips",
      fn: async () => {
        const args = ["-s", "format", sipsFormat];
        if (opts.width && opts.height) {
          args.push("-z", String(Math.round(opts.height)), String(Math.round(opts.width)));
        }
        args.push(srcPath, "--out", outPath);
        await execFileAsync("/usr/bin/sips", args, 20_000, opts.signal);
        return readValidOutputFile(outPath);
      },
    });
  }

  if (targetFmt === "webp") {
    for (const bin of getToolCandidates(["cwebp"])) {
      attempts.push({
        name: "cwebp",
        fn: async () => {
          await execFileAsync(bin, ["-q", "90", srcPath, "-o", outPath], 20_000, opts.signal);
          return readValidOutputFile(outPath);
        },
      });
    }
  }

  if (targetFmt !== "pdf" && targetFmt !== "ico") {
    for (const bin of getToolCandidates(["ffmpeg"])) {
      attempts.push({
        name: "ffmpeg",
        fn: async () => {
          const args = ["-y", "-i", srcPath];
          if (opts.width && opts.height) {
            args.push("-vf", `scale=${Math.round(opts.width)}:${Math.round(opts.height)}`);
          }
          args.push("-frames:v", "1", outPath);
          await execFileAsync(bin, args, 20_000, opts.signal);
          return readValidOutputFile(outPath);
        },
      });
    }
  }

  return runFirstWorkingConverter(attempts, opts.signal);
}

/**
 * Converts an SVG or raster image buffer to a requested target format using
 * zero extra npm dependencies (local system converters -> macOS sips/qlmanage -> Ubuntu executor).
 */
export async function convertImageBuffer(
  opts: ConvertImageOptions
): Promise<ConvertImageResult> {
  const {
    inputBuffer,
    inputMimeType = "image/png",
    targetFormat,
    width,
    height,
    signal,
    executor,
    customConverter,
  } = opts;

  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error("convertImageBuffer requires a non-empty inputBuffer");
  }

  const normalizedTarget = normalizeImageOutputFormat(targetFormat);
  if (!normalizedTarget) {
    throw new Error(`不支持的目标图片格式: ${String(targetFormat || "")}`);
  }

  const normalizedInputMime = String(inputMimeType || "image/png")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const isSvgInput = looksLikeSvgBuffer(inputBuffer, normalizedInputMime);
  const inputFmt: SupportedImageOutputFormat | "" = isSvgInput
    ? "svg"
    : imageFormatFromMimeType(normalizedInputMime);

  if (inputFmt === normalizedTarget) {
    return {
      buffer: inputBuffer,
      format: normalizedTarget,
      mimeType: mimeTypeForImageFormat(normalizedTarget),
      converter: "passthrough",
    };
  }

  if (typeof customConverter === "function") {
    const customRes = await customConverter({
      inputBuffer,
      inputMimeType: normalizedInputMime,
      targetFormat: normalizedTarget,
      width,
      height,
      signal,
    });
    return {
      buffer: customRes.buffer,
      format: normalizedTarget,
      mimeType: customRes.mimeType || mimeTypeForImageFormat(normalizedTarget),
      converter: customRes.converter || "custom",
    };
  }

  if (normalizedTarget === "svg") {
    const wrapped = wrapRasterAsSvg(
      inputBuffer,
      normalizedInputMime || "image/png",
      width,
      height
    );
    return {
      buffer: wrapped,
      format: "svg",
      mimeType: "image/svg+xml",
      converter: "svg-embed",
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-imgconv-"));
  try {
    const srcExt = inputFmt || "png";
    const srcPath = path.join(tmpDir, `input.${srcExt}`);
    fs.writeFileSync(srcPath, inputBuffer);

    if (!isSvgInput && inputFmt) {
      const direct = await convertRasterFileViaCli(
        srcPath,
        inputFmt,
        normalizedTarget,
        tmpDir,
        { width, height, signal }
      );
      if (direct) {
        return {
          buffer: direct.buffer,
          format: normalizedTarget,
          mimeType: mimeTypeForImageFormat(normalizedTarget),
          converter: direct.converter,
        };
      }
    }

    const outPath = path.join(tmpDir, `output.${normalizedTarget}`);
    const attempts: Array<{ name: string; fn: () => Promise<Buffer | null> }> = [];

    if (isSvgInput) {
      // 1. rsvg-convert (crispest SVG rendering if installed)
      for (const bin of getToolCandidates(["rsvg-convert"])) {
        attempts.push({
          name: "rsvg-convert",
          fn: async () => {
            if (normalizedTarget === "png" || normalizedTarget === "pdf") {
              const args = ["-f", normalizedTarget];
              if (width) args.push("-w", String(Math.round(width)));
              if (height) args.push("-h", String(Math.round(height)));
              args.push("-o", outPath, srcPath);
              await execFileAsync(bin, args, 20_000, signal);
              return readValidOutputFile(outPath);
            }
            const midPng = path.join(tmpDir, "rsvg-mid.png");
            const args = ["-f", "png"];
            if (width) args.push("-w", String(Math.round(width)));
            if (height) args.push("-h", String(Math.round(height)));
            args.push("-o", midPng, srcPath);
            await execFileAsync(bin, args, 20_000, signal);
            if (!fs.existsSync(midPng)) return null;
            const converted = await convertRasterFileViaCli(
              midPng,
              "png",
              normalizedTarget,
              tmpDir,
              { width, height, signal }
            );
            return converted?.buffer || null;
          },
        });
      }

      // 2. ImageMagick (magick / convert)
      const needsOpaqueBg = normalizedTarget === "jpg" || normalizedTarget === "bmp";
      for (const bin of getToolCandidates(["magick", "convert"])) {
        attempts.push({
          name: path.basename(bin),
          fn: async () => {
            const args = ["-background", needsOpaqueBg ? "white" : "none", srcPath];
            if (width && height) {
              args.push("-resize", `${Math.round(width)}x${Math.round(height)}`);
            }
            if (needsOpaqueBg) {
              args.push("-alpha", "remove", "-alpha", "off");
            }
            if (normalizedTarget === "ico") {
              args.push("-define", "icon:auto-resize=256,128,64,48,32,16");
            }
            args.push(outPath);
            await execFileAsync(bin, args, 20_000, signal);
            return readValidOutputFile(outPath);
          },
        });
      }

      // 3. macOS built-in sips (zero external dependencies)
      if (process.platform === "darwin") {
        attempts.push({
          name: "sips",
          fn: async () => {
            if (SIPS_WRITABLE_FORMATS.has(normalizedTarget)) {
              const sipsFmt = normalizedTarget === "jpg" ? "jpeg" : normalizedTarget;
              const args = ["-s", "format", sipsFmt];
              if (width && height) {
                args.push("-z", String(Math.round(height)), String(Math.round(width)));
              }
              args.push(srcPath, "--out", outPath);
              await execFileAsync("/usr/bin/sips", args, 20_000, signal);
              return readValidOutputFile(outPath);
            }
            const midPng = path.join(tmpDir, "sips-mid.png");
            await execFileAsync(
              "/usr/bin/sips",
              ["-s", "format", "png", srcPath, "--out", midPng],
              20_000,
              signal
            );
            if (!fs.existsSync(midPng)) return null;
            const converted = await convertRasterFileViaCli(
              midPng,
              "png",
              normalizedTarget,
              tmpDir,
              { width, height, signal }
            );
            return converted?.buffer || null;
          },
        });

        // 4. macOS QuickLook qlmanage (WebKit SVG renderer)
        attempts.push({
          name: "qlmanage",
          fn: async () => {
            const maxDim = Math.max(512, Math.round(width || 0), Math.round(height || 0));
            await execFileAsync(
              "/usr/bin/qlmanage",
              ["-t", "-s", String(maxDim), "-o", tmpDir, srcPath],
              20_000,
              signal
            );
            const qlPng = path.join(tmpDir, `${path.basename(srcPath)}.png`);
            if (!fs.existsSync(qlPng)) return null;
            if (normalizedTarget === "png") {
              return readValidOutputFile(qlPng);
            }
            const converted = await convertRasterFileViaCli(
              qlPng,
              "png",
              normalizedTarget,
              tmpDir,
              { width, height, signal }
            );
            return converted?.buffer || null;
          },
        });
      }
    }

    // 5. Ubuntu sandbox executor fallback (if connected)
    const executorCall = executor?.call;
    if (typeof executorCall === "function") {
      attempts.push({
        name: "ubuntu-executor",
        fn: async () => {
          const inB64 = inputBuffer.toString("base64");
          const pyScript = [
            "import base64, os, shutil, subprocess, sys, tempfile",
            `fmt = ${JSON.stringify(normalizedTarget)}`,
            `src_ext = ${JSON.stringify(srcExt)}`,
            `w = ${JSON.stringify(width ? Math.round(width) : 0)}`,
            `h = ${JSON.stringify(height ? Math.round(height) : 0)}`,
            "with tempfile.TemporaryDirectory() as d:",
            "  src = os.path.join(d, f'in.{src_ext}')",
            "  out = os.path.join(d, f'out.{fmt}')",
            `  open(src, 'wb').write(base64.b64decode(${JSON.stringify(inB64)}))`,
            "  tool = shutil.which('magick') or shutil.which('convert')",
            "  if tool:",
            "    cmd = [tool, '-background', 'white' if fmt in ('jpg', 'bmp') else 'none', src]",
            "    if w and h: cmd += ['-resize', f'{w}x{h}']",
            "    if fmt in ('jpg', 'bmp'): cmd += ['-alpha', 'remove', '-alpha', 'off']",
            "    cmd.append(out)",
            "    subprocess.run(cmd, check=True)",
            "  elif shutil.which('rsvg-convert') and fmt in ('png', 'pdf'):",
            "    cmd = ['rsvg-convert', '-f', fmt, '-o', out, src]",
            "    subprocess.run(cmd, check=True)",
            "  else:",
            "    sys.exit(2)",
            "  print(base64.b64encode(open(out, 'rb').read()).decode('ascii'))",
          ].join("\n");
          const res = await executorCall.call(executor, "/run_shell", {
            command: `python3 -c ${JSON.stringify(pyScript)}`,
          });
          if (res?.exit_code !== 0 || !res?.stdout) return null;
          const b64 = String(res.stdout).trim().split(/\s+/).pop() || "";
          if (!b64) return null;
          const buf = Buffer.from(b64, "base64");
          return buf.length > 0 ? buf : null;
        },
      });
    }

    const hit = await runFirstWorkingConverter(attempts, signal);
    if (hit) {
      return {
        buffer: hit.buffer,
        format: normalizedTarget,
        mimeType: mimeTypeForImageFormat(normalizedTarget),
        converter: hit.converter,
      };
    }

    throw new Error(
      `当前运行环境缺少可将图像转换为 ${normalizedTarget.toUpperCase()} 的转换工具（rsvg-convert / ImageMagick / sips）`
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
