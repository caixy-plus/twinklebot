import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../src/cli/index.js");

test("cli exits 1 with usage when no task arguments are passed", () => {
  const result = spawnSync(process.execPath, [cliPath], {
    encoding: "utf-8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run cli -- "<task>"/);
});

test("cli exits 1 with usage when empty or whitespace task is passed", () => {
  const result = spawnSync(process.execPath, [cliPath, "   ", ""], {
    encoding: "utf-8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run cli -- "<task>"/);
});
