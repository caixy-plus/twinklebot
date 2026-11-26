---
name: twinklebot-e2e
description: >-
  Run, maintain, and report TwinkleBot's tiered E2E test suite (P0–P3, 14 suites / 110 atomic cases
  with 100% 6-dimension coverage across Web Desktop, OrbStack Ubuntu Sandbox, Mobile dist-web,
  Electron, CLI, Landing, and SSR). Use when running targeted or full E2E verification, auditing
  coverage, updating the E2E catalog and tests after adding or modifying features, or generating
  standardized diagnostic test reports.
compatibility: >-
  Requires Node.js >= 22.13, Google Chrome (CDP), and optionally Python 3 + OrbStack Ubuntu
  (or Linux Xvfb/Xtigervnc) for X11/sandbox suites. Follows the open Agent Skills standard and
  is compatible with Antigravity, Claude Code, OpenCode, Pi, Codex, Cursor, Windsurf, and Copilot.
metadata:
  author: TwinkleBot
  version: "1.0.0"
  report-dir: "test-results/reports"
  archive-dir: "docs/e2e-reports"
---

# TwinkleBot Tiered E2E Testing Skill (`/twinklebot-e2e`)

This skill governs how coding agents **run**, **maintain**, and **report** TwinkleBot's full-coverage E2E test suite across all 5 runtime surfaces (Web Desktop, Ubuntu Sandbox `executor.py`/X11/Chrome, Mobile `dist-web`, Electron Shell/Tray/OTA, CLI & Landing).

> **Core Principles**
> 1. **Silent during small local edits**: Never auto-trigger E2E runs when the user is making small local tweaks or previewing locally. Only run E2E on explicit request (`/twinklebot-e2e ...`) or at the **GitHub Release / version build** boundary.
> 2. **Interactive GitHub Release Gate (local default `affected+p0`, CI build-only `skip`)**: Before any GitHub version build (`v*` / `ota-*` tag push or `release.yml` dispatch), auto-inspect impacted suites via `npm run e2e:sync-check -- --since-last-tag` and **actively ask the user** whether to run automated E2E tests **locally** and which level to use (`affected+p0` default, `all`, `p0+p1`, `p0`, `affected`, or `skip`). `release.yml` itself defaults `e2e_level=skip` (CI opt-in via workflow input).
> 3. **Targeted first, full on demand**: Never blindly re-run all 110 cases when only a few files changed — use `npm run test:e2e:affected` (or `--suite=<id>` / `--case=<ID>` / `affected+p0` for releases) for fast, high-signal verification.
> 4. **Diagnose before modifying**: When asked to test/audit, keep business source code untouched until you produce the diagnostic report and the user confirms what to fix (unless the user explicitly invokes `fix`).
> 5. **Deterministic offline by default**: All external LLM / IMAP / POP3 / SMTP / MCP / OTA / static site endpoints use local loopback fixtures (`test/helpers/e2e-protocol-fixtures.ts`). Never hit live public APIs unless `TWINKLEBOT_E2E_LIVE=1` is explicitly requested.
> 6. **Security**: Never commit, print, or log `.env`, API keys, the executor token, or `data/`.

---

## Invocation Modes

Determine the user's intent from their prompt or slash-command arguments:

| Mode / Argument | Purpose | Primary Command(s) |
| :--- | :--- | :--- |
| *(default)* or `affected` | Detect `git diff` impact and run **only** affected E2E suites | `npm run e2e:sync-check` → `npm run test:e2e:affected` |
| `release` or `affected+p0` | Pre-release smart gate: changed suites + P0 core (21 cases) | `npm run test:e2e:release` (`--tier=affected+p0 --since-last-tag`) |
| `p0` / `p1` / `p2` / `p3` / `p0+p1` / `all` | Run a specific priority tier or the complete 14-suite / 110-case suite | `npm run test:e2e:<tier>` or `node scripts/run-e2e.mjs --tier=<tier>` |
| `--suite=<id>` / `--case=<ID>` | Precision filter for specific suite(s) or case ID(s)/wildcards (e.g. `P1-NET-*`) | `node scripts/run-e2e.mjs --suite=<id>` / `--case=<ID>` |
| `list` | List all registered suites and atomic case IDs from `catalog.json` | `npm run test:e2e:list` (`node scripts/run-e2e.mjs --list`) |
| `audit` | Run 6-dimension full-codebase static coverage audit (Files/Routes/Tools/Executor/UI/Capabilities) | `npm run e2e:audit` (`check-e2e-sync.mjs --audit`) |
| `live` | Opt-in live public API smoke test (requires `.env`) | `npm run test:e2e:live` |
| `update` / `sync` | Sync E2E catalog, test plan & test cases after adding new features | `npm run e2e:sync-check -- --verbose --audit` (see **Update Workflow** below) |
| `report` / `report --archive` | Generate standardized Markdown report from latest run | `npm run e2e:report` or `npm run e2e:report:archive` |
| `fix` | White-box fix confirmed `BUG` items and run targeted re-test + unit baseline | Fix code → targeted `--case=` / `--suite=` → `npm run typecheck && npm run test:py && npm test` |

---

## Standard Locations & References

Read reference files on demand (progressive disclosure):
- **Machine-readable mapping (SSOT)**: [references/catalog.json](./references/catalog.json) — maps every suite & atomic case ID to source globs, runtime surface, priority, and feature tier.
- **2D Priority Matrix & Full Plan**: [references/test-plan.md](./references/test-plan.md) — `F1/F2/F3 × D1/D2/D3 → P0–P3` rules, naming conventions, and master case checklist.
- **Report Template & 4-Way Rubric**: [references/report-template.md](./references/report-template.md) — exact Markdown structure and `PASS / BUG / UX_DESIGN / ENV_SKIP` classification rules.

### Report & Evidence Output Convention
- **Raw run data & failure evidence** *(gitignored)*:
  - `test-results/e2e-summary.json` — aggregated JSON across suites
  - `test-results/cases/<suite>.json` — per-suite atomic records
  - `test-results/evidence/<case-id>/` — CDP screenshot (`failure.png`) + `details.json` (DOM excerpt, console/page errors, extra evidence)
- **Human-readable Markdown reports**:
  - Default *(gitignored)*: `test-results/reports/e2e-report-YYYYMMDD-HHmmss.md` and `test-results/reports/latest.md` (automatically refreshed after every `scripts/run-e2e.mjs` execution or via `npm run e2e:report`).
  - Milestone archive *(Git-tracked, opt-in)*: `docs/e2e-reports/YYYY-MM-DD-e2e-report.md` via `npm run e2e:report:archive`.

### Browser Visibility Controls
- Chrome defaults to **headless mode** (`--headless=new`, `slowMoMs = 0`) across all platforms (including local macOS runs) so E2E runs silently and quickly without popping up browser windows.
- Override via environment variables only when explicitly debugging visually:
  - `TWINKLEBOT_E2E_HEADED=1` — opt-in visible Chrome window with HUD status pill
  - `TWINKLEBOT_E2E_HEADLESS=1` — explicitly force headless (takes precedence over `HEADED`)
  - `TWINKLEBOT_E2E_SLOWMO_MS=80` — slow down UI interactions for visual inspection

---

## Workflows

### 1. Targeted / Tiered Execution Workflow
1. Run `npm run e2e:sync-check` to see which suites are impacted by current changes (and whether any newly added features lack E2E coverage).
2. Run the appropriate scope:
   - Changed-files only: `npm run test:e2e:affected`
   - Single tier: `npm run test:e2e:p0` (fastest golden baseline, ~10s) / `p1` / `p2` / `p3` / `all`
   - Single suite directly (after `npm run build:ts`):
     ```bash
     node --test --test-force-exit dist-server/test/e2e/<suite>.e2e.js
     ```
   - Physical X11 Ubuntu desktop suite:
     ```bash
     orb -m ubuntu env TWINKLEBOT_RUN_CHROME_E2E=1 python3 -m unittest executor/test_e2e_x11_desktop.py -v
     ```
3. Inspect `test-results/reports/latest.md` and `test-results/evidence/<case-id>/` for any non-PASS cases.
4. Classify every failure truthfully using [references/report-template.md](./references/report-template.md) (`BUG` vs `UX_DESIGN` vs test-script timing vs `ENV_SKIP`), citing exact `file:line` root causes.

> **Execution Notes**:
> - To keep `test-results/e2e-summary.json` and `test-results/reports/latest.md` in sync, prefer `node scripts/run-e2e.mjs --suite=<id>` (or `--tier=...`) over raw `node --test`, which only updates `test-results/cases/<suite>.json`.
> - On headless Ubuntu X11 test displays (`executor/test_e2e_x11_desktop.py`), always launch `xfwm4` inside an isolated `dbus-run-session -- xfwm4 --compositor=off` with `DBUS_SESSION_BUS_ADDRESS` unset; otherwise `xfwm4` exits with `Xfconf could not be initialized` and `wmctrl -l` returns empty.

### 2. Feature Update Workflow (`/twinklebot-e2e update`)
Run this workflow whenever a new user-facing feature, API route, UI modal/component, bot tool, or executor endpoint is added or substantially changed:
1. Run:
   ```bash
   node .agents/skills/twinklebot-e2e/scripts/check-e2e-sync.mjs --verbose
   ```
2. Review every reported **unmapped new feature** (new file under `src/server/routes/`, `src/web/components/`, `src/agent/bot-tools/`, `src/agent/providers/`, or newly added `/api/...` route / bot tool / executor endpoint).
3. Assign each new feature a priority using the 2D matrix in [references/test-plan.md](./references/test-plan.md):
   - `F1 Core` (`D1/D2` → `P0`, `D3` → `P1`)
   - `F2 Module` (`D1/D2` → `P1`, `D3` → `P3`)
   - `F3 Micro / Edge` (`D1/D2` → `P2`, `D3` → `P3`)
4. Add or update the atomic test case in the matching `test/e2e/<suite>.e2e.ts` (using `collector.runCase(...)` with unique ID like `P1-NEW-01`) or `executor/test_e2e_*.py`.
5. Update **both**:
   - [references/catalog.json](./references/catalog.json) (register new case ID + any new `sourceGlobs` / `routes` / `tools`)
   - [references/test-plan.md](./references/test-plan.md) (append to the master case table)
6. Verify catalog integrity and run targeted verification:
   ```bash
   npm run typecheck
   node --test dist-server/test/e2e-skill-sync.test.js
   npm run test:e2e:affected
   ```

### 3. Report & Archive Workflow (`/twinklebot-e2e report`)
1. Generate the latest Markdown report:
   ```bash
   npm run e2e:report
   ```
   (Or `npm run e2e:report:archive` when archiving a release/milestone snapshot to `docs/e2e-reports/`.)
2. Read `test-results/reports/latest.md`. If there are `BUG` or `UX_DESIGN` items, enrich the root-cause analysis section with exact source `file:line` links and reproduction commands per [references/report-template.md](./references/report-template.md).

### 4. Fix & Targeted Re-Test Workflow (`/twinklebot-e2e fix`)
1. Fix confirmed bugs in priority order (`S0 → S1 → S2 → UX`).
2. Rebuild affected targets (`npm run typecheck && npm run build:ts`, plus `npm run mobile:build:web` if `src/web/` changed).
3. Run **only** the targeted E2E suites covering the fixed cases (`npm run test:e2e:affected` or the specific `dist-server/test/e2e/*.e2e.js` / `test_e2e_x11_desktop.py`).
4. Run full regression baselines: `npm run test:py` and `npm test`.
5. Refresh the report via `npm run e2e:report`.
