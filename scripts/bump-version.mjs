#!/usr/bin/env node
/**
 * Synchronized version bumper for TwinkleBot (aligned with cc-gateway convention):
 * - PATCH: 0–9 (at 9, rolls over to 0 and increments MINOR)
 * - MINOR: 0–19 (at 19, rolls over to 0 and increments MAJOR)
 * - Mobile native buildCode (`versionCode` / `CURRENT_PROJECT_VERSION`) increments +1 monotonically.
 *
 * Updates atomically:
 * - version-policy.json
 * - package.json (+ package-lock.json if present)
 * - android/app/build.gradle
 * - ios/App/App.xcodeproj/project.pbxproj
 *
 * Usage:
 *   node scripts/bump-version.mjs [--patch | --minor | --major | --set=X.Y.Z] [--dry-run] [--no-mobile-bump]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PATCH = 9;
const MAX_MINOR = 19;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");

function isValidProjectVersion(raw) {
  const cleaned = String(raw || "").trim().replace(/^v/i, "");
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(cleaned);
  if (!m) return false;
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return minor >= 0 && minor <= MAX_MINOR && patch >= 0 && patch <= MAX_PATCH;
}

function bumpVersion(current, level = "patch") {
  if (!isValidProjectVersion(current)) {
    throw new Error(
      `Invalid current version "${current}" (expected MAJOR.MINOR.PATCH, MINOR 0-${MAX_MINOR}, PATCH 0-${MAX_PATCH})`
    );
  }
  let [major, minor, patch] = current.replace(/^v/i, "").split(".").map(Number);
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    patch = 0;
    if (minor >= MAX_MINOR) {
      major += 1;
      minor = 0;
    } else {
      minor += 1;
    }
  } else {
    if (patch >= MAX_PATCH) {
      patch = 0;
      if (minor >= MAX_MINOR) {
        major += 1;
        minor = 0;
      } else {
        minor += 1;
      }
    } else {
      patch += 1;
    }
  }
  return `${major}.${minor}.${patch}`;
}

function main() {
  const args = process.argv.slice(2);
  let level = "patch";
  let explicitVersion = "";
  let dryRun = false;
  let bumpMobile = true;

  for (const arg of args) {
    if (arg === "--patch" || arg === "patch") level = "patch";
    else if (arg === "--minor" || arg === "minor") level = "minor";
    else if (arg === "--major" || arg === "major") level = "major";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-mobile-bump") bumpMobile = false;
    else if (arg.startsWith("--set=")) explicitVersion = arg.slice("--set=".length).trim().replace(/^v/i, "");
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  const policyPath = path.join(ROOT, "version-policy.json");
  const pkgPath = path.join(ROOT, "package.json");
  const lockPath = path.join(ROOT, "package-lock.json");
  const gradlePath = path.join(ROOT, "android", "app", "build.gradle");
  const pbxPath = path.join(ROOT, "ios", "App", "App.xcodeproj", "project.pbxproj");

  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const currentVersion = String(pkg.version || policy.shells?.desktop?.version || "1.0.0").trim();
  const nextVersion = explicitVersion ? explicitVersion : bumpVersion(currentVersion, level);

  if (!isValidProjectVersion(nextVersion)) {
    throw new Error(
      `Target version "${nextVersion}" violates TwinkleBot version rules (PATCH 0-${MAX_PATCH}, MINOR 0-${MAX_MINOR}).`
    );
  }

  const curAndroidCode = Number(policy.shells?.android?.buildCode || 1);
  const curIosCode = Number(policy.shells?.ios?.buildCode || 1);
  const nextAndroidCode = bumpMobile ? curAndroidCode + 1 : curAndroidCode;
  const nextIosCode = bumpMobile ? curIosCode + 1 : curIosCode;

  console.log(
    `[version:bump] ${currentVersion} -> ${nextVersion} (android buildCode: ${curAndroidCode} -> ${nextAndroidCode}, ios buildCode: ${curIosCode} -> ${nextIosCode})${dryRun ? " [DRY RUN]" : ""}`
  );
  if (dryRun) return;

  // 1. version-policy.json
  policy.shells.desktop.version = nextVersion;
  policy.backend.version = nextVersion;
  if (bumpMobile) {
    policy.shells.android.version = nextVersion;
    policy.shells.android.buildCode = nextAndroidCode;
    policy.shells.ios.version = nextVersion;
    policy.shells.ios.buildCode = nextIosCode;
  }
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n", "utf8");

  // 2. package.json
  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  // 3. package-lock.json (optional)
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.version = nextVersion;
    if (lock.packages && lock.packages[""]) {
      lock.packages[""].version = nextVersion;
    }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
  }

  // 4. android/app/build.gradle
  if (bumpMobile && fs.existsSync(gradlePath)) {
    let gradle = fs.readFileSync(gradlePath, "utf8");
    gradle = gradle.replace(/(\bversionCode\s+)\d+/, `$1${nextAndroidCode}`);
    gradle = gradle.replace(/(\bversionName\s+")[^"]+(")/, `$1${nextVersion}$2`);
    fs.writeFileSync(gradlePath, gradle, "utf8");
  }

  // 5. ios/App/App.xcodeproj/project.pbxproj
  if (bumpMobile && fs.existsSync(pbxPath)) {
    let pbx = fs.readFileSync(pbxPath, "utf8");
    pbx = pbx.replace(/(CURRENT_PROJECT_VERSION\s*=\s*)\d+;/g, `$1${nextIosCode};`);
    pbx = pbx.replace(/(MARKETING_VERSION\s*=\s*)[^;\s]+;/g, `$1${nextVersion};`);
    fs.writeFileSync(pbxPath, pbx, "utf8");
  }

  console.log("[version:bump] Updated version-policy.json, package.json, package-lock.json, Android build.gradle, and iOS project.pbxproj.");
}

main();
