---
description: Locked 3-zone permission invariants, prompt/schema anti-over-prompting rules, and KimiCU MCP self-discovery constraints.
---

# TwinkleBot Permission Gate & KimiCU Constraints

## 1. Locked Invariant Tests (`test/policy-invariants.test.ts`)
- `test/policy-invariants.test.ts` encodes approved product decisions in a table-driven matrix.
- Whenever modifying permission evaluation, system prompts, or tool `risk` schema descriptions, `test/policy-invariants.test.ts` **must stay completely green**.
- **Never** modify, relax, or delete expectations in `test/policy-invariants.test.ts` without explicit user approval.

## 2. 3-Zone Permission Behavior Model
- **Zone 1 — Bot's Computer (`sandboxMode === "full"`)**:
  - The isolated Ubuntu XFCE desktop is free-roam. Every sandbox tool — including GUI and browser interaction (`click`, `type_text`, `key`, `browser_click`, `browser_type`, `write_file`, `edit_file`, `run_shell`) — must auto-allow in `full` mode even if the model passes spurious `risk: "high"`, and must never be blocked by host `writeRoots`.
  - No sandbox interaction tool may trigger high-risk auto-audit confirmation in `full` mode. Only hardcoded security redlines (secrets, keychains, cross-Bot private workspaces, self-control MCP) and explicit user `askRules` / `denyRules` apply.
- **Zone 2 — Your Computer (`hostExecutionMode === "always"`)**:
  - Auto-allow routine host shell commands, non-sensitive host writes/edits, safe cleanup (`rm` inside temp directories or the current Bot's own workspace), read-only host/MCP tools, and routine KimiCU actions — ignoring spurious model `risk: "high"` on safe/read-only actions.
  - Deterministically require confirmation for genuinely destructive commands (`sudo`, non-scratch home/system `rm`, `git push --force`, pipe-to-shell scripts), sensitive config edits, host screen recording, and non-allowlisted high-risk KimiCU actions.
  - Explicit wildcard allow rules apply in host `always` and sandbox `full` modes, while `hostExecutionMode === "ask"` and `sandboxMode === "restricted"` must never let global wildcards bypass high-risk confirmation.
- **Live Settings & Clean Defaults**:
  - Re-read live policy settings before evaluating each tool call inside batched multi-tool turns.
  - Never pre-seed hidden default `askRules` (such as `"sudo"`); deduplicate user-saved rules by `(tool, pattern)` and keep draft-approved reuse working for typing and KimiCU actions.

## 3. Prompt & Tool Schema Anti-Over-Prompting
- Keep `risk` as an optional 3-level enum (`["low", "medium", "high"]`) and omit `risk` on sandbox-internal and read-only MCP tools.
- Never reintroduce coercive phrasing (`ALWAYS`, `"or submitting forms"`, `"Always use 'low'"`, or bottom-of-prompt warnings) in prompts or tool schemas that nudges LLMs into flagging routine clicks or navigation as `risk: "high"`.
- Keep Settings' smart high-risk confirmation toggle accurately labeled (`高风险操作智能确认` / Smart High-Risk Confirmation).

## 4. KimiCU MCP Self-Discovery & Platform Gating
- Never hardcode a fixed KimiCU tool count or static schema in prompts, policy, or UI; rely on live MCP `tools/list`, binary `(mtimeMs, size)` auto-reload, tool-list-changed notifications, dynamic read-only classification, and schema-adaptive prompt generation so KimiCU upgrades adapt without an OTA.
- Gate OS-specific skills (e.g., macOS-only `kimi-cu`) on unsupported hosts while preserving the `添加` button label and hover tooltip copy.
