import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import {
  buildWebBundle,
  computeBundleContentHash,
  readProjectShellMetadata,
  readVersionPolicy,
} from "./build-web.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUILTIN_CORE_DIR = path.join(PROJECT_ROOT, "dist-server", "core-runtime");

function formatUtcStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `.${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

function sha256ShortFile(filePath, len = 16) {
  if (!fs.existsSync(filePath)) return "";
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, len);
}

function copyDirClean(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (ent.name === ".DS_Store" || ent.name.startsWith(".env")) continue;
    const srcPath = path.join(srcDir, ent.name);
    const destPath = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyDirClean(srcPath, destPath);
    } else if (ent.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function buildCoreBundle({
  outDir = DEFAULT_BUILTIN_CORE_DIR,
  desktopWebDir = "",
  clean = true,
} = {}) {
  const resolvedOut = path.resolve(outDir);
  const workerEntry = path.join(
    PROJECT_ROOT,
    "dist-server",
    "src",
    "server",
    "desktop-backend-worker.js"
  );
  if (!fs.existsSync(workerEntry)) {
    throw new Error(
      `Missing compiled worker entry at ${workerEntry}. Run tsc -p tsconfig.json first.`
    );
  }

  let preservedMeta = null;
  const metaPath = path.join(resolvedOut, "core-meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      preservedMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {}
  }

  if (clean) {
    fs.rmSync(resolvedOut, { recursive: true, force: true });
  }
  fs.mkdirSync(resolvedOut, { recursive: true });

  // 1. Bundle pure-ESM Node backend + runtime deps (@google/genai) into standalone server-bundle.mjs
  const bundleOutFile = path.join(resolvedOut, "server-bundle.mjs");
  await esbuild({
    entryPoints: [workerEntry],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: bundleOutFile,
    external: ["electron"],
    sourcemap: false,
    minify: false,
    logLevel: "silent",
    banner: {
      js: [
        'import { createRequire as __twinkleCreateRequire } from "node:module";',
        'import { fileURLToPath as __twinkleFileURLToPath } from "node:url";',
        'import { dirname as __twinkleDirnameFn } from "node:path";',
        'const require = __twinkleCreateRequire(import.meta.url);',
        'var __filename = __twinkleFileURLToPath(import.meta.url);',
        'var __dirname = __twinkleDirnameFn(__filename);',
      ].join("\n") + "\n",
    },
  });

  // 2. Stage System Prompts alongside server-bundle.mjs (`MODULE_DIR/prompts/*.md`)
  const promptsSrc = path.join(PROJECT_ROOT, "src", "agent", "prompts");
  const promptsDest = path.join(resolvedOut, "prompts");
  if (fs.existsSync(promptsSrc)) {
    fs.mkdirSync(promptsDest, { recursive: true });
    for (const name of fs.readdirSync(promptsSrc)) {
      if (name.endsWith(".md")) {
        fs.copyFileSync(path.join(promptsSrc, name), path.join(promptsDest, name));
      }
    }
  }

  // 3. Stage executor/executor.py (`WORKER_ROOT/executor/executor.py`) for automatic VM SHA-256 sync
  const execSrc = path.join(PROJECT_ROOT, "executor", "executor.py");
  const execDestDir = path.join(resolvedOut, "executor");
  const execDest = path.join(execDestDir, "executor.py");
  if (fs.existsSync(execSrc)) {
    fs.mkdirSync(execDestDir, { recursive: true });
    fs.copyFileSync(execSrc, execDest);
  }

  // 4. Stage Desktop Web bundle into `<coreOut>/public/`
  const publicDest = path.join(resolvedOut, "public");
  let webMeta;
  if (desktopWebDir && fs.existsSync(path.join(desktopWebDir, "index.html"))) {
    copyDirClean(desktopWebDir, publicDest);
    webMeta = JSON.parse(fs.readFileSync(path.join(publicDest, "web-meta.json"), "utf8"));
  } else {
    const builtWeb = await buildWebBundle({ target: "desktop", outDir: publicDest });
    webMeta = builtWeb.meta;
  }

  // 5. Stage package.json + version-policy.json so resolveProjectRoot() & APP_VERSION anchor right here
  const shells = readProjectShellMetadata();
  const policy = readVersionPolicy();
  fs.writeFileSync(
    path.join(resolvedOut, "package.json"),
    JSON.stringify(
      {
        name: "twinklebot",
        version: shells.backendVersion || shells.desktopVersion,
        type: "module",
        private: true,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(resolvedOut, "version-policy.json"),
    JSON.stringify(policy, null, 2) + "\n",
    "utf8"
  );

  // 6. Compute deterministic contentHash covering server-bundle.mjs + prompts + executor.py + public/ + version-policy.json
  const contentHash = computeBundleContentHash(resolvedOut);
  const explicitId = String(process.env.WEB_BUILD_ID || "").trim();
  const coreBuild = explicitId
    ? `${explicitId}-${contentHash}`
    : preservedMeta &&
        preservedMeta.contentHash === contentHash &&
        preservedMeta.coreBuild
      ? preservedMeta.coreBuild
      : `${formatUtcStamp()}-${contentHash}`;

  const builtAt =
    preservedMeta &&
    preservedMeta.contentHash === contentHash &&
    preservedMeta.builtAt &&
    !explicitId
      ? preservedMeta.builtAt
      : new Date().toISOString();

  const coreMeta = {
    schemaVersion: 1,
    target: "desktop",
    coreBuild,
    coreVersion: shells.backendVersion || shells.desktopVersion,
    webBuild: String(webMeta?.webBuild || coreBuild),
    contentHash,
    executorSha256: sha256ShortFile(execDest, 16),
    minShellVersion: shells.minDesktopVersionForCoreOta || shells.minDesktopVersionForOta,
    apiCapabilities: Array.isArray(webMeta?.requiredApiCapabilities)
      ? webMeta.requiredApiCapabilities
      : shells.policyApiCapabilities,
    githubRepo: shells.githubRepo,
    builtAt,
  };
  fs.writeFileSync(metaPath, JSON.stringify(coreMeta, null, 2) + "\n", "utf8");

  return {
    outDir: resolvedOut,
    bundlePath: bundleOutFile,
    metaPath,
    meta: coreMeta,
    webMeta,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outArg = process.argv.find((a) => a.startsWith("--out-dir="));
  const res = await buildCoreBundle({
    outDir: outArg ? outArg.slice("--out-dir=".length) : DEFAULT_BUILTIN_CORE_DIR,
  });
  console.log(
    `[build-core] coreBuild=${res.meta.coreBuild} coreVersion=${res.meta.coreVersion} executorSha=${res.meta.executorSha256} outDir=${res.outDir}`
  );
}
