import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOST_TOOL_DECLARATIONS,
  isHostTool,
  runHostTool,
} from "../src/agent/host-tools.js";
import { assessToolCall } from "../src/agent/policy.js";

test("HOST_TOOL_DECLARATIONS includes host_record_screen and clamps duration_sec [1..60]", async (t) => {
  assert.equal(isHostTool("host_record_screen"), true);
  assert.ok(HOST_TOOL_DECLARATIONS.some((d) => d.name === "host_record_screen"));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-host-rec-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const calls: any[] = [];
  const res = await runHostTool(
    "host_record_screen",
    { duration_sec: 120, display_index: 0 },
    {
      workspaceRoot: tmpDir,
      execRecordFn: async ({ outputPath, durationSec, displayIndex }) => {
        calls.push({ outputPath, durationSec, displayIndex });
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, Buffer.from("MP4MOCKBYTES"));
      },
    }
  );

  assert.equal(res.result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].durationSec, 60);
  assert.equal(calls[0].displayIndex, 0);
  assert.ok(res.result.path.startsWith(path.join(tmpDir, "deliverables")));
  assert.equal(res.result.mimeType, "video/mp4");
  assert.equal(res.result.size, 12);
  assert.match(res.result.url, /^\/api\/workspace\/file\?path=/);
  assert.match(res.result.downloadUrl, /download=1/);
});

test("policy splits Host Restricted Mode vs Sandbox Full-Privilege Mode and blocks accounts.json/desktop-config.json", () => {
  // Sandbox full mode allows sudo/rm/write_file inside Ubuntu/Cloud sandbox
  assert.equal(
    assessToolCall("run_shell", { command: "sudo apt-get update" }, { sandboxMode: "full" }).decision,
    "allow"
  );
  assert.equal(
    assessToolCall("write_file", { path: "/opt/app/config.json", content: "{}" }, { sandboxMode: "full", writeRoots: ["/tmp"] }).decision,
    "allow"
  );

  // Client Host remains strictly restricted even when sandboxMode is full
  assert.equal(
    assessToolCall("host_run_shell", { command: "sudo launchctl list" }, { sandboxMode: "full" }).decision,
    "confirm"
  );
  assert.equal(
    assessToolCall("host_run_shell", { command: "Remove-Item -Recurse C:\\temp" }, { sandboxMode: "full" }).decision,
    "confirm"
  );
  assert.equal(
    assessToolCall("host_record_screen", { duration_sec: 5 }, { sandboxMode: "full" }).decision,
    "confirm"
  );
  assert.equal(
    assessToolCall("host_read_file", { path: "~/Library/Application Support/TwinkleBot/accounts.json" }).decision,
    "deny"
  );
  assert.equal(
    assessToolCall("host_read_file", { path: "~/Library/Application Support/TwinkleBot/desktop-config.json" }).decision,
    "deny"
  );
});
