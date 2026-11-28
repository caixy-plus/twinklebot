# TwinkleBot

Multi-Bot AI desktop & mobile agent: orchestrates Gemini / Vertex AI / OpenAI / DeepSeek / OpenAI-compatible models with a local or cloud runtime, OrbStack / WSL2 / cloud Ubuntu XFCE sandbox (`:1`, 1440x900), and cross-platform Host Executor bridge.

## Stack & Architecture

- **Runtime**: Node.js 22.13+, ESM, TypeScript. Pure-JS runtime deps only (`@google/genai` >= 2.29.1 via **Interactions API only** —
  never `generateContent` or legacy `@google/generative-ai`; `@larksuiteoapi/node-sdk`; `grammy`), bundled into `dist-server/core-runtime/server-bundle.mjs` for `ota-only`.
- **Build pipeline** (`npm run build:ts`): `tsconfig.shared.json` -> `npm run build:web` (`build:css` + React 19 Vite SPA + SSR + `--public-meta`, checked via `tsconfig.web.json`) -> `tsconfig.json` -> `copy-prompts` -> `build-core-bundle` -> `tsconfig.landing.json`.
- **Source map**:
  - `src/shared/` — Shared types, DTOs, browser-safe helpers (`accounts-store.ts`, `skills-catalog.ts`, `context-compression.ts`, `versioning.ts`).
  - `src/server/` — HTTP/WS server on `127.0.0.1:3230` (`index.ts`, `context.ts`, `http-utils.ts`, `static.ts`, `routes/*.ts`).
  - `src/agent/` — Loop, router, compression, `policy.ts`, `providers/` (`gemini-driver.ts`, `openai-compat-driver.ts`, `registry.ts`), `bot-tools/*.ts`, `prompts/`, `knowledge/`.
  - `src/lib/` — LAN discovery, pairing, remote relay (`127.0.0.1:3231`), Feishu/Telegram channels, mail, MCP (`mcp-client.ts`), web search, billing, host bridge.
  - `src/store/` — Atomic JSON/NDJSON persistence under `data/`.
  - `src/web/` + `public/` — React 19 + Vite SPA (`APP_TARGET=mobile` strips backend/Electron files into `dist-web/` for Capacitor `android/` & `ios/`).
  - `src/electron/` + `electron/preload.cjs` — Electron shell spawning `server-bundle.mjs`; guard standalone CLI entrypoints with `TWINKLEBOT_DESKTOP_WORKER !== "1"`.
  - `executor/executor.py` — Ubuntu sandbox daemon (Python 3 stdlib only, `:7300`, bearer token).
- **Commands**: `npm run typecheck`, `npm run build:ts`, `npm run build:ota`, `npm test`, `npm run electron:pack:mac`, `npm run mobile:build:web`, `orb -m ubuntu python3 -m unittest discover -s executor -v`. Prefer `http://127.0.0.1:3230` for automated UI/E2E testing.

## Core Invariants & Gotchas

- **Permission Gate Lock (CRITICAL)**:
  - `test/policy-invariants.test.ts` encodes approved product decisions. Changing `policy.ts`, prompts, or tool `risk` schemas MUST keep `test/policy-invariants.test.ts` passing; **never** modify its expectations without explicit user approval.
  - **Bot's Computer (`sandboxMode === "full"`)**: Every sandbox tool (clicks, typing, browser clicks/inputs, file writes, shell)
    auto-allows inside the Ubuntu sandbox even on spurious `risk: "high"` or paths outside host `writeRoots` — only security redlines and explicit `askRules`/`denyRules` apply.
  - **Your Computer (`hostExecutionMode === "always"`)**: Auto-allow routine commands, safe temp/own-workspace cleanup,
    non-sensitive writes, read-only host/MCP tools, and routine KimiCU actions while confirming destructive commands (`sudo`, non-scratch `rm`, force push, sensitive configs) and screen recording.
  - **No over-prompting**: Keep `risk` as an optional 3-level enum (`["low", "medium", "high"]`), omit it on sandbox-internal/read-only MCP tools,
    never pre-seed hidden `askRules`, and never add coercive wording (`ALWAYS`, `"or submitting forms"`). Details: `.agents/rules/permission-and-mcp.md`.
- **KimiCU MCP Self-Discovery & Platform Gating**: Never hardcode tool counts or static schemas; rely on live `tools/list`,
  binary reload, `notifications/tools/list_changed`, and adaptive prompts (no OTA needed on KimiCU upgrades). Gate OS-specific skills on unsupported platforms while keeping the `添加` label and hover tooltip.
- **Unified Client Account Model & Clean Defaults**: UI uses strictly `本地账号 / Local Account` and `云端账号 / Cloud Account`
  (never expose engineering jargon like `节点`). Keep fresh installs empty (no pre-seeded memories, schedules, or vault entries) and use Cron as the sole schedule format.
- **Electron Worker `AbortSignal`**: Normalize polyfilled signals (e.g. `grammy`) to `globalThis.AbortSignal` under `ELECTRON_RUN_AS_NODE=1` (`wrapFetchWithNativeAbortSignal` in `src/lib/channel-integrations.ts`).

## Versioning, CI & Releases

- **Default Hot-Update Rule (`ota-only`)**: When changes touch only hot-updatable layers (`src/server/**`, `src/agent/**`, `src/store/**`,
  `src/lib/**`, `src/shared/**`, `src/web/**`, `public/**`, `executor/executor.py`, bundled JS deps) without touching native shell layers
  (`src/electron/**`, `electron/*`, `android/**`, `ios/**`, `capacitor.config.*`, native deps), **do NOT run `npm run version:bump`** —
  release via `ota-*` / `mode=ota-only`, keeping shell `X.Y.Z` & native `buildCode` unchanged. Each `ota-only` release dispatches
  `refresh-shell-installers.yml` asynchronously to rebuild & overwrite all current-version platform installers (`macos`/`windows`/`linux`/`android`)
  using the same `WEB_BUILD_ID` (so fresh downloads need no second OTA), `cancel-in-progress: true` on build jobs, and serialized partial manifest hash updates
  on `ota-channel` without blocking OTA reporting (enforced by `test/versioning-and-ota.test.ts`).
- **Shell Version Rollover** (when native shells change or user requests full installers):
  - `PATCH` ranges **0–9** (`1.0.9 -> 1.1.0`); `MINOR` ranges **0–19** (`1.19.9 -> 2.0.0`); mobile `buildCode` increments `+1`.
  - Sync atomically via `npm run version:bump`; always check `version-policy.json` (`shells.*`, `minVersionFor*`, `apiCapabilities`). When raising shell capabilities, also raise `minVersionForOta` / `minVersionForCoreOta` / `minBuildCodeForOta`.
  - Gate post-`1.0.0` backend-dependent UI features with `hasConnectedNodeCapability("<cap>")` (`src/web/services/ota-updater.ts`) + `CURRENT_API_CAPABILITIES` (`src/shared/versioning.ts`).
- **Release Discipline** (`caixy-plus/twinklebot`):
  - Before `vX.Y.Z` tags, ensure `package.json` matches `version-policy.json`. Never bump or tag autonomously; keep release notes bilingual (`中文 / English`).
  - Android full releases sign `TwinkleBot-mobile-release.apk` (`PortraitCaptureActivity`, 4KB `zipalign -p -f 4` + `apksigner verify`; never ship `-unsigned.apk`).
  - `ci.yml` on `main` is build/package-only (no tests, no auto-publish, ignores `README*.md`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, `docs/**`, `.agents/**`). Bilingual docs: `README.md` (EN) + `README.zh-CN.md` (ZH).
  - **Monitor CI & Release runs to green**: After pushing or triggering `ci.yml`/`release.yml`, run `gh run watch <id> --exit-status`
    until every required job passes, and verify the published release (`isDraft: false`, expected assets, updated `ota-channel`).
    For `ota-only`, report as soon as `release.yml` + `ota-channel` turn green — do not block waiting on background `refresh-shell-installers.yml`.
  - Keep `scripts/build-ota-packages.mjs` free of top-level third-party imports (lazy-import core bundling)
    so zero-`node_modules` shell-refresh jobs can patch manifest hashes directly (enforced by `test/versioning-and-ota.test.ts`).

## Testing, E2E Gate & Backlog

- **Tiered E2E (`/twinklebot-e2e` & `.agents/rules/twinklebot-e2e-sync.md`)**:
  - Default headless Chrome (`--headless=new`, `slowMoMs = 0`); do not trigger E2E on small local edits/previews.
  - At GitHub Release / version build boundaries, run `npm run e2e:sync-check -- --since-last-tag` and actively ask the user which E2E level to run locally (`affected+p0` default, `all`, `p0+p1`, `p0`, `affected`, `skip`).
  - Keep `catalog.json`, `test-plan.md`, and `test/e2e/*.e2e.ts` in sync on new user-facing features and pass `npm run e2e:audit` (100% across 6 dimensions). Raw results stay in `test-results/`; archive milestone reports to `docs/e2e-reports/`.
- **Product Backlog (`docs/product-issues.md`)**: Append-only `PI-XXX` log recording problem + exact `file:line` root cause only (no fix proposals); update status to `FIXED (<short-sha>)` once fixed.
- **Security**: Never commit or log `.env`, API keys, the executor token, or `data/`.
