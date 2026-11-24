import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const _UP_ONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.basename(_UP_ONE) === "dist-server" ? path.dirname(_UP_ONE) : _UP_ONE;

test("package.json keeps pure-JS runtime dependencies only and defines mobile scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "@google/genai",
    "@larksuiteoapi/node-sdk",
    "grammy",
  ]);
  assert.ok(pkg.scripts["mobile:build:web"]);
  assert.ok(pkg.scripts["mobile:sync"]);
  assert.ok(pkg.scripts["mobile:apk:debug"]);
});

test("buildWebBundle(target=mobile) copies pure frontend assets and physically strips backend/data", async () => {
  const { buildWebBundle } = await import(pathToFileURL(path.join(ROOT, "scripts", "build-web.mjs")).href);
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "gb-dist-web-"));
  try {
    const res = await buildWebBundle({ target: "mobile", outDir: tmpOut });
    assert.equal(res.target, "mobile");
    assert.ok(fs.existsSync(path.join(tmpOut, "index.html")));
    assert.ok(fs.existsSync(path.join(tmpOut, "dist", "app.js")));
    assert.ok(fs.existsSync(path.join(tmpOut, "dist", "mobile-bridge.js")));
    assert.ok(fs.existsSync(path.join(tmpOut, "accounts-store.js")));
    assert.ok(fs.existsSync(path.join(tmpOut, "skills-catalog.js")));

    const html = fs.readFileSync(path.join(tmpOut, "index.html"), "utf8");
    assert.ok(html.includes('window.__TWINKLEBOT_APP_TARGET__ = "mobile"'));
    assert.ok(html.includes('dataset.appTarget = "mobile"'));
    const mobileCss = fs.readFileSync(path.join(tmpOut, "mobile.css"), "utf8");
    assert.ok(mobileCss.includes("@media all"), "mobile bundle must keep mobile layout at all widths");

    for (const forbidden of ["server.js", "store.js", "agent", "executor", "electron", "data", ".env"]) {
      assert.equal(
        fs.existsSync(path.join(tmpOut, forbidden)),
        false,
        `${forbidden} must not exist in mobile bundle`
      );
    }
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
});
