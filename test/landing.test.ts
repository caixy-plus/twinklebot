import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _UP_ONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.basename(_UP_ONE) === "dist-server" ? path.dirname(_UP_ONE) : _UP_ONE;

test("landing page assets are self-contained and subpath-safe for /twinklebot/", () => {
  const html = fs.readFileSync(path.join(ROOT, "landing/index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "landing/styles.css"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "landing/dist/app.js"), "utf8");

  assert.ok(fs.existsSync(path.join(ROOT, "landing/icon.png")));
  assert.ok(html.includes('href="./styles.css"'));
  assert.ok(html.includes('src="./dist/app.js"'));
  assert.ok(html.includes('href="./icon.png"'));
  assert.ok(html.includes("caixy-plus/twinklebot"));
  assert.equal(html.includes("YOUR_USERNAME/twinklebot"), false);
  assert.ok(css.includes(".live-activity-row") === false && css.includes(".sim-thinking-pill"));
  assert.ok(js.includes("hydrateLatestReleaseLinks"));
});

test("GCP Nginx and Caddy configs serve /twinklebot/ and return 404 on /", () => {
  const nginx = fs.readFileSync(path.join(ROOT, "deploy/gcp/nginx-landing.conf"), "utf8");
  assert.ok(nginx.includes("server_name example.com;"));
  assert.ok(nginx.includes("location = /twinklebot"));
  assert.ok(nginx.includes("location /twinklebot/"));
  assert.ok(nginx.includes("return 404;"));

  const caddy = fs.readFileSync(path.join(ROOT, "deploy/gcp/Caddyfile.landing"), "utf8");
  assert.ok(caddy.includes("example.com"));
  assert.ok(caddy.includes("handle_path /twinklebot/*"));
  assert.ok(caddy.includes("respond 404"));
});
