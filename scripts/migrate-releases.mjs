#!/usr/bin/env node
/**
 * Idempotent GitHub Release migrator for consolidating historical releases from
 * `caixy-plus/twinklebot-releases` into the open-source `caixy-plus/twinklebot` repo.
 *
 * Usage:
 *   node scripts/migrate-releases.mjs [--dry-run] [--force] [--include-all-ota] \
 *     [--tags=v1.0.0,v1.0.1] [--from=caixy-plus/twinklebot-releases] [--to=caixy-plus/twinklebot]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rewriteManifestRepoUrls } from "./build-ota-packages.mjs";

function parseArgs(argv) {
  const opts = {
    fromRepo: "caixy-plus/twinklebot-releases",
    toRepo: "caixy-plus/twinklebot",
    tags: null,
    includeAllOta: false,
    force: false,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--from=")) opts.fromRepo = arg.slice("--from=".length).trim();
    else if (arg.startsWith("--to=")) opts.toRepo = arg.slice("--to=".length).trim();
    else if (arg.startsWith("--tags=")) {
      opts.tags = arg
        .slice("--tags=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--include-all-ota") opts.includeAllOta = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFail) return null;
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    throw new Error(`gh ${args.join(" ")} failed: ${stderr || err?.message || err}`);
  }
}

function ghJson(args, opts) {
  const raw = gh(args, opts);
  if (raw === null) return null;
  return JSON.parse(raw);
}

function parseSemverTuple(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(String(tag || "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareReleasesOldestFirst(a, b) {
  const sa = parseSemverTuple(a.tagName);
  const sb = parseSemverTuple(b.tagName);
  if (sa && sb) {
    for (let i = 0; i < 3; i += 1) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
  }
  return Date.parse(a.createdAt || a.publishedAt || 0) - Date.parse(b.createdAt || b.publishedAt || 0);
}

function listReleases(repo) {
  return (
    ghJson([
      "release",
      "list",
      "--repo",
      repo,
      "--limit",
      "200",
      "--json",
      "tagName,name,isDraft,isPrerelease,isLatest,publishedAt,createdAt",
    ]) || []
  );
}

function resolveDefaultBranch(repo) {
  const info = ghJson(["repo", "view", repo, "--json", "defaultBranchRef"], { allowFail: true });
  return String(info?.defaultBranchRef?.name || "main").trim() || "main";
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.fromRepo || !opts.toRepo || opts.fromRepo === opts.toRepo) {
    throw new Error(`Invalid source/destination repos: from=${opts.fromRepo} to=${opts.toRepo}`);
  }

  const sourceReleases = listReleases(opts.fromRepo).filter((r) => !r.isDraft);
  const sourceByTag = new Map(sourceReleases.map((r) => [r.tagName, r]));
  const destReleases = listReleases(opts.toRepo);
  const destTags = new Set(destReleases.map((r) => r.tagName));
  const targetBranch = resolveDefaultBranch(opts.toRepo);

  // Inspect active ota-channel manifest from source (read-only) to find active OTA tag
  let activeOtaTag = null;
  if (sourceByTag.has("ota-channel")) {
    const rawManifest = gh(
      ["release", "download", "ota-channel", "--repo", opts.fromRepo, "--pattern", "version-manifest.json", "-O", "-"],
      { allowFail: true }
    );
    if (rawManifest) {
      try {
        const parsed = JSON.parse(rawManifest);
        if (parsed?.releaseTag && String(parsed.releaseTag).startsWith("ota-")) {
          activeOtaTag = String(parsed.releaseTag);
        }
      } catch {}
    }
  }

  let selectedTags;
  if (opts.tags && opts.tags.length > 0) {
    selectedTags = opts.tags.filter((t) => {
      if (!sourceByTag.has(t)) {
        console.warn(`[warn] Source tag not found (skipping): ${t}`);
        return false;
      }
      return true;
    });
  } else {
    const formalTags = sourceReleases
      .filter((r) => /^v\d+\./i.test(r.tagName))
      .sort(compareReleasesOldestFirst)
      .map((r) => r.tagName);

    const otaTags = opts.includeAllOta
      ? sourceReleases
          .filter((r) => r.tagName.startsWith("ota-") && r.tagName !== "ota-channel")
          .sort(compareReleasesOldestFirst)
          .map((r) => r.tagName)
      : activeOtaTag && sourceByTag.has(activeOtaTag)
        ? [activeOtaTag]
        : [];

    selectedTags = [...formalTags, ...otaTags];
    if (sourceByTag.has("ota-channel")) {
      selectedTags.push("ota-channel");
    }
  }

  const allSourceFormal = sourceReleases
    .filter((r) => /^v\d+\./i.test(r.tagName))
    .sort(compareReleasesOldestFirst);
  const newestFormalTag =
    allSourceFormal.length > 0 ? allSourceFormal[allSourceFormal.length - 1].tagName : null;

  console.log(
    `[migrate] Source: ${opts.fromRepo} (${sourceReleases.length} releases) -> Target: ${opts.toRepo} (branch=${targetBranch}, existing=${destTags.size})`
  );
  if (activeOtaTag) {
    console.log(`[migrate] Active OTA pointer in ${opts.fromRepo}: ota-channel -> ${activeOtaTag}`);
  }

  let copied = 0;
  let skipped = 0;

  for (const tag of selectedTags) {
    const srcMeta = sourceByTag.get(tag);
    if (!srcMeta) continue;

    const isOtaPointer = tag === "ota-channel";
    const isOtaRelease = isOtaPointer || tag.startsWith("ota-") || Boolean(srcMeta.isPrerelease);
    const shouldMarkLatest = !isOtaRelease && tag === newestFormalTag;
    const existsInDest = destTags.has(tag);

    if (existsInDest && !opts.force && !isOtaPointer) {
      console.log(`[skip] ${tag} (already exists in ${opts.toRepo}; pass --force to replace)`);
      skipped += 1;
      continue;
    }

    if (opts.dryRun) {
      const detail = ghJson(
        ["release", "view", tag, "--repo", opts.fromRepo, "--json", "name,assets,isPrerelease"],
        { allowFail: true }
      );
      const assetNames = Array.isArray(detail?.assets) ? detail.assets.map((a) => a.name) : [];
      const hasManifest = assetNames.includes("version-manifest.json");
      console.log(
        `[dry-run] ${existsInDest ? "REPLACE" : "CREATE"} ${tag} | title="${srcMeta.name}" | prerelease=${isOtaRelease} | latest=${shouldMarkLatest} | rewriteManifest=${hasManifest} | assets=${assetNames.length} (${assetNames.join(", ")})`
      );
      copied += 1;
      continue;
    }

    const detail = ghJson([
      "release",
      "view",
      tag,
      "--repo",
      opts.fromRepo,
      "--json",
      "tagName,name,body,isPrerelease,assets",
    ]);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-migrate-rel-"));
    try {
      const assetDir = path.join(workDir, "assets");
      fs.mkdirSync(assetDir, { recursive: true });

      if (Array.isArray(detail?.assets) && detail.assets.length > 0) {
        gh(["release", "download", tag, "--repo", opts.fromRepo, "--dir", assetDir]);
      }

      const manifestFile = path.join(assetDir, "version-manifest.json");
      if (fs.existsSync(manifestFile)) {
        const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        const rewritten = rewriteManifestRepoUrls(parsed, opts.fromRepo, opts.toRepo);
        fs.writeFileSync(manifestFile, JSON.stringify(rewritten, null, 2), "utf8");
      }

      const notesFile = path.join(workDir, "notes.md");
      const rawBody = String(detail?.body || "").trim();
      const bodyWithFooter = rawBody || `TwinkleBot ${tag}`;
      fs.writeFileSync(notesFile, `${bodyWithFooter}\n`, "utf8");

      if (existsInDest) {
        gh(["release", "delete", tag, "--repo", opts.toRepo, "--cleanup-tag", "--yes"], {
          allowFail: true,
        });
      }

      const assetFiles = fs
        .readdirSync(assetDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => path.join(assetDir, e.name));

      const createArgs = [
        "release",
        "create",
        tag,
        ...assetFiles,
        "--repo",
        opts.toRepo,
        "--target",
        targetBranch,
        "--title",
        String(detail?.name || tag),
        "--notes-file",
        notesFile,
      ];
      if (isOtaRelease) {
        createArgs.push("--prerelease");
      } else {
        createArgs.push(shouldMarkLatest ? "--latest" : "--latest=false");
      }

      gh(createArgs);
      console.log(
        `[ok] Migrated ${tag} (${assetFiles.length} asset(s), prerelease=${isOtaRelease}, latest=${shouldMarkLatest})`
      );
      copied += 1;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  console.log(`[migrate] Complete: planned/migrated=${copied}, skipped=${skipped}.`);
}

main();
