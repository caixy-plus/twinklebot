import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, "dist-web");

const SHARED_BROWSER_MODULES = [
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "accounts-store.js"), dest: "accounts-store.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "skills-catalog.js"), dest: "skills-catalog.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "constants.js"), dest: "shared/constants.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "accounts-store.js"), dest: "shared/accounts-store.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "skills-catalog.js"), dest: "shared/skills-catalog.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "context-compression.js"), dest: "shared/context-compression.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "screen-pool.js"), dest: "shared/screen-pool.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "browser-automation.js"), dest: "shared/browser-automation.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "computer-status.js"), dest: "shared/computer-status.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "policy-utils.js"), dest: "shared/policy-utils.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "versioning.js"), dest: "shared/versioning.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "i18n-zh.js"), dest: "shared/i18n-zh.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "i18n-en.js"), dest: "shared/i18n-en.js" },
  { src: path.join(PROJECT_ROOT, "dist-server", "src", "shared", "i18n.js"), dest: "shared/i18n.js" },
];

const FALLBACK_API_CAPABILITIES = [
  "core-v1",
  "vault-patch-v1",
  "gemini-vertex-gate-v1",
  "ota-v1",
];

function copyDirClean(srcDir, destDir, filesOut = [], relBase = "") {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === ".DS_Store" || ent.name.startsWith(".env")) continue;
    const srcPath = path.join(srcDir, ent.name);
    const destPath = path.join(destDir, ent.name);
    const relPath = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      copyDirClean(srcPath, destPath, filesOut, relPath);
    } else if (ent.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      filesOut.push(relPath);
    }
  }
}

function collectFilesForHash(dirPath, relBase = "") {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [];
  for (const ent of entries) {
    if (
      ent.name === ".DS_Store" ||
      ent.name === "web-meta.json" ||
      ent.name === "core-meta.json" ||
      ent.name.endsWith(".map") ||
      ent.name.startsWith(".env")
    ) {
      continue;
    }
    const full = path.join(dirPath, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...collectFilesForHash(full, rel));
    } else if (ent.isFile()) {
      out.push({ rel, full });
    }
  }
  return out;
}

export function computeBundleContentHash(rootDir, extraFiles = []) {
  const hash = crypto.createHash("sha256");
  const all = [
    ...collectFilesForHash(rootDir),
    ...extraFiles
      .filter((item) => item && fs.existsSync(item.src))
      .map((item) => ({ rel: item.dest, full: item.src })),
  ].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  for (const entry of all) {
    hash.update(entry.rel);
    hash.update("\0");
    hash.update(fs.readFileSync(entry.full));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 10);
}

export function readVersionPolicy() {
  const policyPath = path.join(PROJECT_ROOT, "version-policy.json");
  if (fs.existsSync(policyPath)) {
    return JSON.parse(fs.readFileSync(policyPath, "utf8"));
  }
  return {
    schemaVersion: 1,
    baselineVersion: "1.0.0",
    githubRepo: "caixy-plus/twinklebot-releases",
    otaChannelTag: "ota-channel",
    shells: {
      desktop: { version: "1.0.0", minVersionForOta: "1.0.0" },
      android: { version: "1.0.0", buildCode: 1, minVersionForOta: "1.0.0", minBuildCodeForOta: 1 },
      ios: { version: "1.0.0", buildCode: 1, minVersionForOta: "1.0.0", minBuildCodeForOta: 1 },
    },
    backend: {
      version: "1.0.0",
      minCompatibleVersion: "1.0.0",
      apiCapabilities: [...FALLBACK_API_CAPABILITIES],
    },
  };
}

export function readProjectShellMetadata() {
  const policy = readVersionPolicy();
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
  );
  const desktopVersion = String(pkg.version || policy.shells?.desktop?.version || "1.0.0").trim();

  let androidVersion = String(policy.shells?.android?.version || desktopVersion);
  let androidBuildCode = Number(policy.shells?.android?.buildCode || 1);
  const gradlePath = path.join(PROJECT_ROOT, "android", "app", "build.gradle");
  if (fs.existsSync(gradlePath)) {
    const gradle = fs.readFileSync(gradlePath, "utf8");
    const vc = gradle.match(/versionCode\s+(\d+)/);
    const vn = gradle.match(/versionName\s+"([^"]+)"/);
    if (vc) androidBuildCode = Number.parseInt(vc[1], 10) || androidBuildCode;
    if (vn) androidVersion = vn[1].trim();
  }

  let iosVersion = String(policy.shells?.ios?.version || desktopVersion);
  let iosBuildCode = Number(policy.shells?.ios?.buildCode || 1);
  const pbxPath = path.join(
    PROJECT_ROOT,
    "ios",
    "App",
    "App.xcodeproj",
    "project.pbxproj"
  );
  if (fs.existsSync(pbxPath)) {
    const pbx = fs.readFileSync(pbxPath, "utf8");
    const mv = pbx.match(/MARKETING_VERSION\s*=\s*([^;\s]+);/);
    const cv = pbx.match(/CURRENT_PROJECT_VERSION\s*=\s*(\d+);/);
    if (mv) iosVersion = mv[1].trim();
    if (cv) iosBuildCode = Number.parseInt(cv[1], 10) || iosBuildCode;
  }

  return {
    desktopVersion,
    minDesktopVersionForOta: String(policy.shells?.desktop?.minVersionForOta || "1.0.0"),
    minDesktopVersionForCoreOta: String(
      policy.shells?.desktop?.minVersionForCoreOta ||
        policy.shells?.desktop?.minVersionForOta ||
        "1.0.4"
    ),
    androidVersion,
    androidBuildCode,
    minAndroidVersionForOta: String(policy.shells?.android?.minVersionForOta || "1.0.0"),
    minAndroidBuildCodeForOta: Number(policy.shells?.android?.minBuildCodeForOta || 1),
    iosVersion,
    iosBuildCode,
    minIosVersionForOta: String(policy.shells?.ios?.minVersionForOta || "1.0.0"),
    minIosBuildCodeForOta: Number(policy.shells?.ios?.minBuildCodeForOta || 1),
    backendVersion: String(policy.backend?.version || desktopVersion),
    minBackendCompatibleVersion: String(policy.backend?.minCompatibleVersion || "1.0.0"),
    policyApiCapabilities: Array.isArray(policy.backend?.apiCapabilities)
      ? policy.backend.apiCapabilities.map(String)
      : [...FALLBACK_API_CAPABILITIES],
    githubRepo: String(policy.githubRepo || "caixy-plus/twinklebot-releases"),
    otaChannelTag: String(policy.otaChannelTag || "ota-channel"),
  };
}

async function resolveApiCapabilities(fallbackCaps = FALLBACK_API_CAPABILITIES) {
  const builtVerPath = path.join(
    PROJECT_ROOT,
    "dist-server",
    "src",
    "shared",
    "versioning.js"
  );
  if (fs.existsSync(builtVerPath)) {
    try {
      const mod = await import(pathToFileURL(builtVerPath).href);
      if (Array.isArray(mod.CURRENT_API_CAPABILITIES)) {
        return [...mod.CURRENT_API_CAPABILITIES];
      }
    } catch {}
  }
  return [...fallbackCaps];
}

function formatUtcStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `.${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

export async function writeWebMetaFile(
  outDir,
  { target = "desktop", extraHashFiles = [] } = {}
) {
  const shells = readProjectShellMetadata();
  const contentHash = computeBundleContentHash(outDir, extraHashFiles);
  const metaPath = path.join(outDir, "web-meta.json");

  let existingMeta = null;
  if (fs.existsSync(metaPath)) {
    try {
      existingMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {}
  }

  const explicitId = String(process.env.WEB_BUILD_ID || "").trim();
  const webBuild = explicitId
    ? `${explicitId}-${contentHash}`
    : existingMeta &&
        existingMeta.contentHash === contentHash &&
        existingMeta.target === target &&
        existingMeta.webBuild
      ? existingMeta.webBuild
      : `${formatUtcStamp()}-${contentHash}`;

  const builtAt =
    existingMeta &&
    existingMeta.contentHash === contentHash &&
    existingMeta.target === target &&
    existingMeta.builtAt &&
    !explicitId
      ? existingMeta.builtAt
      : new Date().toISOString();

  const meta = {
    appVersion: shells.desktopVersion,
    target,
    webBuild,
    contentHash,
    githubRepo: shells.githubRepo,
    requiredApiCapabilities: await resolveApiCapabilities(shells.policyApiCapabilities),
    minDesktopShellVersion: shells.minDesktopVersionForOta,
    minAndroidShellVersion: shells.minAndroidVersionForOta,
    minAndroidBuildCode: shells.minAndroidBuildCodeForOta,
    minIosShellVersion: shells.minIosVersionForOta,
    minIosBuildCode: shells.minIosBuildCodeForOta,
    minBackendVersion: shells.minBackendCompatibleVersion,
    builtAt,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export async function buildWebBundle({
  target = process.env.APP_TARGET || "desktop",
  outDir = DEFAULT_OUT_DIR,
} = {}) {
  const normalizedTarget =
    String(target || "desktop").trim().toLowerCase() === "mobile"
      ? "mobile"
      : "desktop";
  const resolvedOut = path.resolve(outDir);

  fs.rmSync(resolvedOut, { recursive: true, force: true });
  fs.mkdirSync(resolvedOut, { recursive: true });

  const files = [];
  copyDirClean(PUBLIC_DIR, resolvedOut, files);

  for (const mod of SHARED_BROWSER_MODULES) {
    if (fs.existsSync(mod.src)) {
      const destPath = path.join(resolvedOut, mod.dest);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(mod.src, destPath);
      files.push(mod.dest);
    }
  }

  // Inject compile-time APP_TARGET flag cleanly into dist-web/index.html
  const indexPath = path.join(resolvedOut, "index.html");
  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, "utf8");
    const targetScript = `<script>window.__TWINKLEBOT_APP_TARGET__ = "${normalizedTarget}"; document.documentElement.dataset.appTarget = "${normalizedTarget}";</script>`;
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>\n    ${targetScript}`);
    } else {
      html = `${targetScript}\n${html}`;
    }
    fs.writeFileSync(indexPath, html, "utf8");
  }

  // Ensure mobile bundle always applies mobile layout regardless of screen width / orientation
  if (normalizedTarget === "mobile") {
    const mobileCssPath = path.join(resolvedOut, "mobile.css");
    if (fs.existsSync(mobileCssPath)) {
      let css = fs.readFileSync(mobileCssPath, "utf8");
      css = css
        .replace(
          "@media (max-width: 768px) and (hover: none) and (pointer: coarse), (hover: none) and (pointer: coarse) and (max-width: 1024px)",
          "@media all"
        )
        .replace(
          "@media (max-width: 768px) and (max-height: 560px) and (hover: none) and (pointer: coarse)",
          "@media (max-height: 560px)"
        );
      fs.writeFileSync(mobileCssPath, css, "utf8");
    }
  }

  const meta = await writeWebMetaFile(resolvedOut, { target: normalizedTarget });
  files.push("web-meta.json");

  return {
    target: normalizedTarget,
    outDir: resolvedOut,
    files,
    meta,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.includes("--public-meta")) {
    const meta = await writeWebMetaFile(PUBLIC_DIR, {
      target: "desktop",
      extraHashFiles: SHARED_BROWSER_MODULES,
    });
    console.log(
      `[build-web] public web-meta.json webBuild=${meta.webBuild} hash=${meta.contentHash}`
    );
  } else {
    const res = await buildWebBundle();
    console.log(
      `[build-web] target=${res.target} webBuild=${res.meta.webBuild} files=${res.files.length} outDir=${res.outDir}`
    );
  }
}
