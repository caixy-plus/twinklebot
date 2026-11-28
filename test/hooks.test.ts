import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTurnHookState,
  runPreToolHooks,
  runPostToolHooks,
  verifyWrittenContent,
} from "../src/agent/hooks.js";

test("PreToolUse mechanical loop guard blocks 3rd consecutive identical failing call and resets on arg change or success", () => {
  const state = createTurnHookState();
  const ctx = {
    sessionId: "s-1",
    toolName: "run_shell",
    args: { command: "cat /missing.txt" },
    stepNo: 1,
  };

  assert.equal(runPreToolHooks(state, ctx).action, "pass");
  runPostToolHooks(state, ctx, { ok: false, error: "No such file or directory" });

  assert.equal(runPreToolHooks(state, ctx).action, "pass");
  runPostToolHooks(state, { ...ctx, stepNo: 2 }, { ok: false, error: "No such file or directory" });

  // 3rd identical retry must be blocked
  const third = runPreToolHooks(state, { ...ctx, stepNo: 3 });
  assert.equal(third.action, "block");
  assert.match(String(third.reason || ""), /连续 2 次|相同/);

  // Different args are allowed
  const changed = runPreToolHooks(state, { ...ctx, args: { command: "ls -la /tmp" }, stepNo: 3 });
  assert.equal(changed.action, "pass");

  // Once a call succeeds, identical call is allowed again later
  runPostToolHooks(state, { ...ctx, stepNo: 4 }, { ok: true, stdout: "ok" });
  assert.equal(runPreToolHooks(state, { ...ctx, stepNo: 5 }).action, "pass");
});

test("PostToolUse error-signature hinting injects targeted recovery hints", () => {
  const state = createTurnHookState();

  const tabHook = runPostToolHooks(
    state,
    { sessionId: "s-1", toolName: "browser_tabs", args: { action: "switch", target_id: "t9" }, stepNo: 1 },
    { ok: false, error: "target_id not found", tabs: [{ target_id: "t1" }] }
  );
  assert.match(String(tabHook.hint || ""), /browser_tabs/);

  const challengeHook = runPostToolHooks(
    state,
    { sessionId: "s-1", toolName: "browser_snapshot", args: { url: "https://example.com" }, stepNo: 2 },
    { ok: true, challenge_detected: true }
  );
  assert.match(String(challengeHook.hint || ""), /取得控制权/);

  const iframeHook = runPostToolHooks(
    state,
    { sessionId: "s-1", toolName: "browser_snapshot", args: {}, stepNo: 3 },
    { ok: true, iframes: [{ src: "https://appleid.apple.com", cross_origin: true }] }
  );
  assert.match(String(iframeHook.hint || ""), /cross_origin|screenshot/);

  const shellHook = runPostToolHooks(
    state,
    { sessionId: "s-1", toolName: "host_run_shell", args: { command: "foo-cli" }, stepNo: 4 },
    { ok: false, exit_code: 127, stderr: "zsh: command not found: foo-cli" }
  );
  assert.match(String(shellHook.hint || ""), /单条命令/);
});

test("PostToolUse write verification flags broken JSON, SVG, HTML, and SKILL.md frontmatter while passing valid writes", (t) => {
  assert.match(String(verifyWrittenContent("/tmp/out.json", "{ bad json") || ""), /JSON/);
  assert.equal(verifyWrittenContent("/tmp/out.json", '{"ok":true}'), undefined);

  assert.match(String(verifyWrittenContent("/tmp/icon.svg", "<svg><circle/>") || ""), /svg/i);
  assert.equal(verifyWrittenContent("/tmp/icon.svg", "<svg><circle/></svg>"), undefined);

  assert.match(String(verifyWrittenContent("/tmp/page.html", "<html><script>alert(1)</html>") || ""), /<script>/);
  assert.equal(verifyWrittenContent("/tmp/page.html", "<html><script>alert(1)</script></html>"), undefined);

  assert.match(String(verifyWrittenContent("/tmp/custom-skills/demo/SKILL.md", "---\nname: demo\n# missing close") || ""), /frontmatter/);
  assert.equal(verifyWrittenContent("/tmp/custom-skills/demo/SKILL.md", "---\nname: demo\n---\nBody"), undefined);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-hook-verify-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const badJsonPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(badJsonPath, "{broken:", "utf8");

  const state = createTurnHookState();
  const postHostEdit = runPostToolHooks(
    state,
    { sessionId: "s-1", toolName: "host_edit_file", args: { path: badJsonPath }, stepNo: 1 },
    { ok: true, path: badJsonPath }
  );
  assert.match(String(postHostEdit.verifyWarning || ""), /JSON/);
});
