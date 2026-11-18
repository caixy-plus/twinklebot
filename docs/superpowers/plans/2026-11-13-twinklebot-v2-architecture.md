# TwinkleBot v2.0（二期改造）Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor TwinkleBot from a single-host, Gemini-only v1 MVP into the v2.0 dual-role (`DEPLOY_ENV=local|cloud`, `RUNTIME_ROLE=master|host_executor`), multi-account, multi-provider (Gemini / OpenAI / DeepSeek / OpenAI-compatible), Admin-Bot-governed desktop & cloud agent platform.

**Architecture:** Maintain one unified frontend (`public/`) and one unified Node.js backend (`server.js` + `agent/` + `lib/`). In `local` mode (bundled in Electron on a fixed `127.0.0.1` port), the backend stays resident across account switches and dynamically toggles between `master` (full local control) and `host_executor` (only restricted host execution + screen recording, bridged via WebSocket through Client UI to an active `cloud` backend). Multi-provider LLM drivers translate to/from TwinkleBot's existing canonical step IR so `store.js`, `context.js`, and `loop.js` preserve full backward compatibility.

**Tech Stack:** Node.js 22.13+ ESM (plain JavaScript), `node:test`, `@google/genai` (>= 2.29.1, Google Interactions API only for Gemini), built-in `fetch` + RFC 6455 `node:http` WebSocket upgrade (zero new npm runtime dependencies), Electron 45, vanilla HTML/CSS/JS, Python 3 `executor/executor.py`.

**Spec:** Inline `Gmini Bot v2.0（二期改造）技术架构与开发需求规范 (SPEC)` (mapped directly to Steps 1–6 below).

---

## Global Constraints

- **Runtime & Dependencies**: Node.js 22.13+, ESM plain JavaScript; `@google/genai` (>= 2.29.1) remains the ONLY npm runtime dependency (Gemini calls MUST use `interactions.create`, never `generateContent` or `@google/generative-ai`; OpenAI/DeepSeek drivers MUST use built-in `fetch`; WebSocket server MUST use built-in `node:http` + `node:crypto`).
- **Single Codebase Principle**: Maintain strictly **1** Client UI (`public/`) and **1** Server (`server.js`); never spawn a separate third host-agent codebase.
- **Role Isolation (`RUNTIME_ROLE=host_executor`)**: Switching to a cloud account MUST NOT stop or restart the local backend; it MUST lock/reject local DB, LLM routing, and local VM sandbox routes with `409 Conflict` while keeping host execution & recording endpoints active.
- **Account Cardinality**: Globally **1** immutable `local` account (non-creatable, non-deletable) and **0..N** `cloud` accounts.
- **Admin Bot Governance**: Every initialized workspace MUST auto-create 1 Admin Bot (`isAdmin: true`) which permanently holds the sole top pinned slot (`adminPinned`), can edit `title`/`avatar`, can NEVER be deleted (`403`), and holds exclusive permission in `local` mode to provision/create the local Bot Computer. Regular Bots lose all pin toggles.
- **Dual-Environment Privilege Boundary**: Client Host (`host_*` tools) runs in **Restricted** mode (high-risk regex interception, sensitive path denial, user approval cards); Bot Computer (`run_shell`, `write_file`, GUI inside Ubuntu/Cloud Linux) runs in **High-Privilege** sandbox mode (full operations inside sandbox without sudo/writeRoots friction, while still blocking host credential leakage).
- **Secret Isolation**: Provider API keys, Cloud auth tokens, and local control tokens are never logged, never exposed in plaintext in `/api/settings` or `/api/system/diagnostics`, and scrubbed from all host shell child environments (`buildScrubbedEnv`).
- **Existing Bug Fix Prerequisite**: Fix bare `broadcastGlobal(...)` calls in `server.js:1296, 1321, 1331` (`/api/schedules`) to `runner?.broadcastGlobal?.(...)`.

## Review Focus

1. **Account Switch Mid-Run / In-Flight Request Race**: Switching from Local to Cloud account while a fetch or SSE stream is active must abort pending UI requests via an epoch/AbortController, close the old WebSocket/SSE cleanly, and never apply stale Local data onto the Cloud UI state (tested in Task 12 `stale account fetch ignored after switch`).
2. **Host-Bridge RPC Timeout & Disconnect Cleanup**: If the Client UI disconnects or the local `host_executor` crashes mid-command during a Cloud Bot's `host_run_shell` call, the Cloud Backend's pending RPC promise must reject cleanly within timeout and never hang the Agent Loop forever (tested in Task 10 `host bridge rejects pending rpc on ws disconnect`).
3. **`host_executor` Lockout Bypass Attempt**: Calling `GET/POST /api/sessions`, `/api/settings`, `/api/custom-skills`, or `/api/computer/provision` directly on `127.0.0.1` while `RUNTIME_ROLE=host_executor` must consistently return `409` even with a valid local token, while `/api/host/execute` succeeds (tested in Task 2 `host_executor locks master routes and allows host execute`).
4. **Admin Bot Deletion / Unpin / Non-Admin Provisioning**: Attempting `DELETE /api/sessions/:adminId`, `PATCH /api/sessions/:adminId { pinned: false }`, `PATCH /api/sessions/:otherId { pinned: true }`, or calling `computer_provision` from a regular Bot must all fail cleanly with `403`/`400` (tested in Task 8 `admin bot deletion and pin protection` and Task 11 `regular bot blocked from computer provisioning`).
5. **OpenAI/DeepSeek Tool-Call & Reasoning IR Roundtrip**: Multi-step tool calling (`function_call` -> `function_result` -> final answer) through `openai-compat-driver.js` must preserve canonical step pairing in `context.js` (`trimHistory`/`pruneScreenshots`) without breaking Gemini-stored session histories, and gracefully ignore `thinking_level` when a custom OpenAI endpoint rejects `reasoning_effort` (tested in Task 4 `openai compat tool roundtrip preserves canonical IR`).

---

## Target File Map (v2.0)

| File | Responsibility | Status |
| :--- | :--- | :--- |
| `lib/config.js` | Parse `DEPLOY_ENV`, `RUNTIME_ROLE`, `CLOUD_AUTH_TOKEN`, `LOCAL_CONTROL_TOKEN`, multi-provider env defaults | Modify |
| `electron/env-loader.js` | Fixed default port (`3230` with fallback), `DEPLOY_ENV=local`, `accounts.json` path, `localControlToken` | Modify |
| `electron/main.js` | Fixed local port binding, role/account IPC helpers, keep backend alive across account switches | Modify |
| `electron/preload.cjs` | Expose `getDesktopInfo()`, `getAccounts()`, `saveAccounts()`, `switchRole()`, `selectScreenSource()` | Modify |
| `lib/ws-server.js` | Zero-dependency RFC 6455 WebSocket server over `http.Server` `upgrade` + JSON RPC framing | Create |
| `lib/runtime-state.js` | `DEPLOY_ENV` & `RUNTIME_ROLE` (`master`/`host_executor`) state machine & route access guard | Create |
| `agent/providers/gemini-driver.js` | `@google/genai` Interactions API driver (chat, plan, summarize, image gen) | Create |
| `agent/providers/openai-compat-driver.js` | OpenAI / DeepSeek / custom OpenAI-compatible `/chat/completions` driver + canonical IR translator | Create |
| `agent/providers/registry.js` | Provider registry, connection tester (`testProviderConnection`), masked credential helpers, 3-tier binding resolver | Create |
| `agent/model.js` | Unified multi-provider `createModel` router facade (`nextTurn`, `planTurn`, `summarizeTurn`, `generateImage`) | Modify |
| `agent/pricing.js` | Multi-provider pricing table (Gemini + OpenAI + DeepSeek + custom fallback) | Modify |
| `agent/router.js`, `route-planner.js`, `route-stats.js`, `route-signals.js` | Explicit 3-tier (`fast`/`medium`/`advanced`) provider+model resolution; decouple `"hydrogen"`/`"argon"`/`"carbon"` hardcoding | Modify |
| `store.js` | `ensureAdminBot()`, `isAdmin` delete/pin invariants, `listSessions()` admin-first sorting, `providers` & `tierRouting` persistence | Modify |
| `agent/host-tools.js` | Add `host_record_screen` (macOS `screencapture`/`ffmpeg`, Windows `ffmpeg`/`PowerShell`), restricted host execution | Modify |
| `agent/policy.js` | Separate **Host Restricted Policy** vs **Sandbox High-Privilege Policy** + Admin Bot privilege checks | Modify |
| `agent/loop.js`, `agent/runner.js`, `agent/bot-tools.js`, `agent/prompt.js` | Inject `isAdminBot`, support remote `hostBridge` dispatch in cloud mode, add `computer_provision` tool | Modify |
| `lib/bot-computer-provisioner.js` | Cross-platform Bot Computer state probe & auto-installer (Windows WSL+Ubuntu+GUI, macOS OrbStack+Ubuntu+GUI, Cloud Ready) | Create |
| `lib/mcp-client.js` | Scrub `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `CUSTOM_LLM_API_KEY`, `TWINKLEBOT_CLOUD_TOKEN` in `buildScrubbedEnv` | Modify |
| `server.js` | Mount `/ws`, Cloud Bearer Auth + CORS, `RUNTIME_ROLE` route gate, `/api/providers*`, `/api/host/execute`, Admin Bot guards, `/api/computer/provision` | Modify |
| `public/markdown-utils.js` | Accept active `baseUrl`-prefixed `/api/workspace/file` URLs safely | Modify |
| `public/index.html`, `public/style.css`, `public/app.js` | `apiClient` (`BaseURL` + Auth + WS), Onboarding Wizard, 3-Tier Provider Config UI, 1-Local + N-Cloud Account Switcher, Admin Exclusive Pin UI, Bot Computer Jump-to-Admin-Bot State Machine | Modify |

---

## Module Execution Sequence (Aligned with SPEC §6)

### Step 1 — Backend Deployment Mode & Dynamic Runtime Role (`DEPLOY_ENV` & `RUNTIME_ROLE`)

#### Task 1: Runtime State Machine & Config Extension
**Files:**
- Create: `lib/runtime-state.js`
- Modify: `lib/config.js:14-57`
- Modify: `electron/env-loader.js:36-145`
- Test: `test/runtime-state.test.js` (Create), `test/config.test.js` (Modify)

**Interfaces:**
- Produces (`lib/runtime-state.js`):
  - `DEPLOY_ENVS = ["local", "cloud"]`, `RUNTIME_ROLES = ["master", "host_executor"]`
  - `createRuntimeState({ deployEnv = "local", initialRole } = {})` -> `{ deployEnv, role, cloudOrigin, updatedAt, setRole(nextRole, opts), isMaster(), isHostExecutor(), canAccessRoute(pathname, method) }`
- Produces (`lib/config.js`):
  - `loadConfig(env)` extended with `deployEnv: "local" | "cloud"`, `initialRole: "master" | "host_executor"`, `host: deployEnv === "cloud" ? (env.HOST || "0.0.0.0") : "127.0.0.1"`, `cloudAuthToken: env.TWINKLEBOT_CLOUD_TOKEN || ""`, `localControlToken: env.TWINKLEBOT_LOCAL_TOKEN || ""`. Note: when `deployEnv === "cloud"` or onboarding mode is enabled (`TWINKLEBOT_ALLOW_UNCONFIGURED=1`), `loadConfig` does NOT throw on missing `GEMINI_API_KEY` (instead `geminiApiKey: env.GEMINI_API_KEY || ""`).
- Produces (`electron/env-loader.js`):
  - `resolveDesktopConfig(...)` sets `deployEnv: "local"`, `port: Number(merged.TWINKLEBOT_DESKTOP_PORT || 3230)`, and generates/persists a per-user `localControlToken` in `<userDataDir>/desktop-config.json` if absent.

- [x] **Step 1: Write failing tests in `test/runtime-state.test.js` & `test/config.test.js`**
  - Assert `createRuntimeState({ deployEnv: "cloud" })`: `role` locks to `"master"`, calling `setRole("host_executor")` throws `"cannot switch to host_executor in cloud deployEnv"`.
  - Assert `createRuntimeState({ deployEnv: "local" })`: starts as `"master"`; `setRole("host_executor", { cloudOrigin: "https://bot.example.com" })` switches role; `canAccessRoute("/api/sessions", "GET")` returns `{ allowed: false, status: 409, reason: "suspended in host_executor mode" }`; `canAccessRoute("/api/host/execute", "POST")`, `canAccessRoute("/api/system/role", "POST")`, `canAccessRoute("/api/system/diagnostics", "GET")` return `{ allowed: true }`.
  - Assert `loadConfig({ DEPLOY_ENV: "cloud", TWINKLEBOT_EXECUTOR_TOKEN: "t", TWINKLEBOT_CLOUD_TOKEN: "c" })` sets `host: "0.0.0.0"`, `deployEnv: "cloud"`, and does not throw when `GEMINI_API_KEY` is omitted.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/runtime-state.test.js test/config.test.js` -> FAIL (module not found / missing fields).
- [x] **Step 3: Implement `lib/runtime-state.js`, update `lib/config.js` and `electron/env-loader.js`**
  - Route whitelist in `host_executor` mode: `^/api/system/(role|diagnostics)$`, `^/api/host/`, `^/api/computer/host-info$`, `^/api/files/(meta|open)$`, `^/api/workspace/file$`, and static UI assets (`/`, `/index.html`, `/app.js`, `/style.css`, `/skills-catalog.js`, etc.). All `master` business/DB/LLM/sandbox routes (`/api/sessions`, `/api/settings`, `/api/providers`, `/api/skills`, `/api/custom-skills`, `/api/integrations`, `/api/schedules`, `/api/vault`, `/api/usage`, `/api/billing`, `/api/images`, `/api/computer/update|reset|provision`) return `{ allowed: false, status: 409 }`.
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/runtime-state.test.js test/config.test.js test/electron-config.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add lib/runtime-state.js lib/config.js electron/env-loader.js test/runtime-state.test.js test/config.test.js && GIT_MASTER=1 git commit -m "feat(runtime): add DEPLOY_ENV and RUNTIME_ROLE state machine and config support"`

#### Task 2: RFC 6455 WebSocket Server & Server Role/Auth Gate
**Files:**
- Create: `lib/ws-server.js`
- Modify: `server.js:214-428, 2105-2285`
- Modify: `electron/main.js:58-106, 318-330`
- Modify: `electron/preload.cjs:1-32`
- Test: `test/ws-and-role-gate.test.js` (Create)

**Interfaces:**
- Produces (`lib/ws-server.js`):
  - `attachWebSocketServer(httpServer, { path = "/ws", authenticate, onConnection })` -> `{ broadcast(payload), sendToClient(clientId, payload), getClients(), close() }` using RFC 6455 SHA-1 handshake + text frame encode/decode + ping/pong heartbeat (`20s`).
- Produces (`server.js` routes):
  - `GET /api/system/role` -> `{ ok: true, deployEnv, role, cloudOrigin, updatedAt }`
  - `POST /api/system/role` (requires `localControlToken` when set in `local` mode) -> `{ role: "master" | "host_executor", cloudOrigin? }` -> calls `runtimeState.setRole(...)`, pauses `scheduler` & stops active local runs when switching to `host_executor`, resumes when returning to `master`, broadcasts `{ type: "runtime_role_changed", role }` on SSE/WS.
  - `WS /ws` -> subscribes to `runner.subscribe(...)` events and handles bidirectional `host_rpc_response` / `ping` frames.
  - Cloud Auth & CORS middleware: when `deployEnv === "cloud"`, sets CORS headers for `http://127.0.0.1:*` / `app://` and requires `Authorization: Bearer <cloudAuthToken>` (or `?token=` on `/ws` and `/api/events` and `/api/screens/*`) on all `/api/*` routes except `GET /api/system/health` (`{ ok: true, deployEnv: "cloud" }`).
  - Role gate middleware: checks `runtimeState.canAccessRoute(pathname, method)` before route dispatch -> returns `409 Conflict` when locked in `host_executor`.
- Produces (`electron/main.js` & `preload.cjs`):
  - Fixed port binding in `startEmbeddedBackend`: tries `desktopConfig.port` (`3230`), falls back to ephemeral `0` only on `EADDRINUSE`. Never recreates backend on account switch; exposes `localControlToken` via `getDesktopInfo()`.

- [x] **Step 1: Write failing tests in `test/ws-and-role-gate.test.js`**
  - Test `host_executor locks master routes and allows host execute`: boot `createServer` with `deployEnv: "local"`, call `POST /api/system/role { role: "host_executor" }` -> `GET /api/sessions` returns `409`, `POST /api/settings` returns `409`, `GET /api/system/role` returns `200 { role: "host_executor" }`; switch back to `"master"` -> `GET /api/sessions` returns `200`.
  - Test cloud auth gate: boot `createServer` with `deployEnv: "cloud", cloudAuthToken: "sec-123"` -> unauthenticated `GET /api/sessions` returns `401`; with `Authorization: Bearer sec-123` returns `200`.
  - Test WebSocket `/ws`: connect using Node 22 `new WebSocket("ws://127.0.0.1:<port>/ws?token=sec-123")`, verify `runner.broadcastGlobal({ type: "ping_test" })` arrives as JSON over WS, and client-to-server JSON frame is received by handler.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/ws-and-role-gate.test.js` -> FAIL.
- [x] **Step 3: Implement `lib/ws-server.js`, wire role/auth/WS into `server.js` (also fix bare `broadcastGlobal` at lines `1296, 1321, 1331`), and update `electron/main.js` + `preload.cjs`**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/ws-and-role-gate.test.js test/server.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add lib/ws-server.js server.js electron/main.js electron/preload.cjs test/ws-and-role-gate.test.js && GIT_MASTER=1 git commit -m "feat(server): add RFC6455 WebSocket server, cloud auth, and RUNTIME_ROLE route gating"`

---

### Step 2 — Multi-Provider LLM Adapter, 3-Tier Routing & Onboarding

#### Task 3: Provider Registry & Multi-Vendor Drivers (`Gemini`, `OpenAI`, `DeepSeek`, `Custom`)
**Files:**
- Create: `agent/providers/gemini-driver.js`
- Create: `agent/providers/openai-compat-driver.js`
- Create: `agent/providers/registry.js`
- Modify: `lib/mcp-client.js:16` (`buildScrubbedEnv` key list)
- Test: `test/llm-providers.test.js` (Create)

**Interfaces:**
- Produces (`agent/providers/registry.js`):
  - `PROVIDER_TYPES = ["gemini", "openai", "deepseek", "openai-compatible"]`
  - `DEFAULT_PROVIDER_PRESETS` (`gemini`: Google AI Studio; `openai`: `https://api.openai.com/v1`; `deepseek`: `https://api.deepseek.com/v1`; `openai-compatible`: custom base URL)
  - `normalizeProvidersConfig(rawProviders, fallbackEnvKey)` -> `Array<{ id, type, name, apiKey, baseUrl, models: string[], enabled: boolean }>`
  - `sanitizeProvidersForClient(providers)` -> strips/masks `apiKey` as `"••••" + last4` (`hasApiKey: boolean`)
  - `testProviderConnection({ type, apiKey, baseUrl, model }, { fetchImpl, client })` -> `Promise<{ ok: boolean, latencyMs: number, model: string, error?: string }>`
- Produces (`agent/providers/gemini-driver.js`):
  - `createGeminiDriver({ apiKey, client, timeoutMs })` -> `{ nextTurn(...), generateImage(...) }` preserving exact `@google/genai` `interactions.create` behavior from `agent/model.js`.
- Produces (`agent/providers/openai-compat-driver.js`):
  - `canonicalToOpenAiMessages(systemInstruction, inputSteps)` -> `Array<ChatMessage>` (maps `user_input` text + base64 `image_url`, `thought`/`model_output` -> `assistant` + `reasoning_content`, `function_call` -> `assistant.tool_calls`, `function_result` -> `tool` message with `tool_call_id`).
  - `openAiResponseToTurn(json, model)` -> `{ thoughts, text, calls, outputSteps, usage, usedModel }` emitting TwinkleBot's canonical `outputSteps` IR (`thought`, `model_output`, `function_call`).
  - `createOpenAiCompatDriver({ apiKey, baseUrl, providerType, fetchImpl = fetch, timeoutMs = 45000 })` -> `{ nextTurn({ model, thinkingLevel, timeoutMs, systemInstruction, tools, input, signal }) }`. Maps `thinkingLevel` (`low`/`medium`/`high`/`xhigh`) to `reasoning_effort` (`low`/`medium`/`high`) for OpenAI reasoning models and gracefully retries without `reasoning_effort` if endpoint returns 400 `"unsupported parameter"`.

- [x] **Step 1: Write failing tests in `test/llm-providers.test.js`**
  - Test `openai compat tool roundtrip preserves canonical IR`: convert `input = [userStep("hi", pngBuf), { type: "function_call", id: "c1", name: "run_shell", args: { command: "ls" } }, ...toolResultSteps({ id: "c1", name: "run_shell" }, { stdout: "a.txt" }, null)]`, mock `fetchImpl` returning OpenAI `tool_calls` then final `content`, verify `outputSteps` work identically with `pruneScreenshots`/`trimHistory`, and verify retry without `reasoning_effort` when endpoint returns 400 on `reasoning_effort`.
  - Test `sanitizeProvidersForClient` never exposes raw `apiKey` and `testProviderConnection` returns `{ ok: true, latencyMs }`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/llm-providers.test.js` -> FAIL.
- [x] **Step 3: Implement `gemini-driver.js`, `openai-compat-driver.js`, `registry.js`, and extend `SCRUBBED_ENV_KEYS` in `lib/mcp-client.js`**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/llm-providers.test.js test/mcp-client.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add agent/providers/ lib/mcp-client.js test/llm-providers.test.js && GIT_MASTER=1 git commit -m "feat(model): add multi-provider LLM registry and Gemini/OpenAI/DeepSeek drivers"`

#### Task 4: Model Facade, Dynamic 3-Tier Router Mapping & Provider Pricing
**Files:**
- Modify: `agent/model.js:103-415`
- Modify: `agent/pricing.js:1-210`
- Modify: `agent/router.js:100-340`
- Modify: `agent/route-planner.js:80-340`
- Modify: `agent/route-stats.js:1-285`
- Modify: `agent/route-signals.js:15-245`
- Test: `test/model.test.js` (regression), `test/v2-tier-routing.test.js` (Create)

**Interfaces:**
- Produces (`agent/model.js`):
  - `createModel({ apiKey, client, providers = [], getProviders, timeoutMs = 15000 } = {})` — if invoked with `{ providerId, model }` (or `"providerId::model"`), dispatches to the matching provider driver from `providers`; if no providers configured and `apiKey` is present, builds implicit default Gemini provider so all existing v1 tests keep passing unchanged.
- Produces (`agent/route-stats.js` & `agent/router.js`):
  - `tierRouting` config schema inside `routing`: `{ tiers: { fast: { providerId, model, thinkingLevel? }, medium: { providerId, model, thinkingLevel? }, advanced: { providerId, model, thinkingLevel? } } }` (also accepting legacy aliases `standard` -> `medium`, `deep` -> `advanced`).
  - `resolveTierModels(config = {}, now = Date.now(), routingSettings = {})` resolves `{ fast, standard, deep }` with `{ providerId, model, label }` from `routingSettings.tiers` first, falling back to `config.models` defaults.
  - `route-planner.js`: `parseStepModelTier` maps `"fast"`/`"极速"`/`"hydrogen"` -> `fast`, `"medium"`/`"standard"`/`"中等"`/`"argon"` -> `standard`, `"advanced"`/`"deep"`/`"高级"`/`"carbon"` -> `deep`, regardless of underlying vendor model ID (e.g. `gpt-4o-mini`, `deepseek-chat`, `deepseek-reasoner`).
- Produces (`agent/pricing.js`):
  - Add OpenAI (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1*`, `o3*`, `o4-mini`) and DeepSeek (`deepseek-chat`, `deepseek-reasoner`) entries to `MODEL_PRICING_CATALOG` and `getModelPricing`.

- [x] **Step 1: Write failing tests in `test/v2-tier-routing.test.js`**
  - Configure `providers` with `[deepseek(sk-ds), openai(sk-oa)]` and `routing.tiers = { fast: { providerId: "ds", model: "deepseek-chat" }, medium: { providerId: "oa", model: "gpt-4o" }, advanced: { providerId: "ds", model: "deepseek-reasoner" } }`.
  - Verify `resolveTierModels` picks `deepseek-chat` for `fast`, `gpt-4o` for `medium`, `deepseek-reasoner` for `advanced`.
  - Verify `createModel({ providers })` dispatches `model: "ds::deepseek-reasoner"` to DeepSeek driver and `model: "oa::gpt-4o"` to OpenAI driver without needing a Google key.
  - Verify `route-planner.js` accepts `{ tier: "advanced", model: "deepseek-reasoner" }` in `step_plan`.
  - Verify `getModelPricing("deepseek-chat")` and `getModelPricing("gpt-4o")` return accurate non-Argon rates.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/v2-tier-routing.test.js` -> FAIL.
- [x] **Step 3: Update `model.js`, `pricing.js`, `router.js`, `route-planner.js`, `route-stats.js`, `route-signals.js`**
- [x] **Step 4: Run tests to verify pass (including existing router/model regression suites)**
  - Run: `node --test test/v2-tier-routing.test.js test/model.test.js test/router-and-pricing.test.js test/smart-router.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add agent/model.js agent/pricing.js agent/router.js agent/route-planner.js agent/route-signals.js agent/route-stats.js test/v2-tier-routing.test.js && GIT_MASTER=1 git commit -m "feat(router): bind 3-tier routing to configurable multi-provider models"`

#### Task 5: Provider CRUD & Connection Test APIs + Onboarding State
**Files:**
- Modify: `store.js:480-520` (`readSettings`/`writeSettings` provider support)
- Modify: `server.js:355-455, 595-730, 1129-1164`
- Test: `test/provider-settings-api.test.js` (Create)

**Interfaces:**
- Produces (`server.js` endpoints, active in `master` / `cloud` modes):
  - `GET /api/providers` -> `{ providers: SanitizedProvider[], routingTiers, onboardingRequired: boolean }`
  - `POST /api/providers` -> creates/updates provider `{ id?, type, name, apiKey?, baseUrl?, models?, enabled? }` (blank `apiKey` on update preserves existing stored key), returns sanitized list
  - `DELETE /api/providers/:id` -> removes provider, clears dangling `routing.tiers` refs
  - `POST /api/providers/test` -> runs `testProviderConnection(...)`, returns `{ ok, latencyMs, error? }`
  - `POST /api/onboarding/complete` -> validates >=1 enabled provider with key & non-empty `models`, persists provider + initial `routing.tiers`, sets `onboardingCompleted: true`, broadcasts `settings_updated`.
  - `getMergedSettings()` includes `providers: SanitizedProvider[]`, `onboardingRequired: boolean`, and `routing.tiers`. `GET /api/system/diagnostics` reports `llmConfigured: !onboardingRequired` (keeping `geminiKeyConfigured` for backward compatibility).

- [x] **Step 1: Write failing tests in `test/provider-settings-api.test.js`**
  - Boot `createServer` with empty `geminiApiKey` and empty `settings.json`: verify `GET /api/settings` returns `onboardingRequired: true`.
  - `POST /api/providers/test` with stubbed `testProviderFn` verifies connectivity without saving.
  - `POST /api/onboarding/complete` with OpenAI provider + `fast`/`medium`/`advanced` tier mapping -> `GET /api/settings` returns `onboardingRequired: false`, `providers[0].apiKey` is absent/masked (`hasApiKey: true`), and `routing.tiers` reflects saved mapping.
  - Updating provider with blank `apiKey` preserves stored secret.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/provider-settings-api.test.js` -> FAIL.
- [x] **Step 3: Implement provider persistence in `store.js` and routes in `server.js` (passing `getProviders: () => store.readSettings()?.providers || []` into `createModel`)**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/provider-settings-api.test.js test/account-and-diagnostics.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add store.js server.js test/provider-settings-api.test.js && GIT_MASTER=1 git commit -m "feat(server): expose multi-provider CRUD, connection test, and onboarding endpoints"`

---

### Step 3 — Account System (`1 Local + N Cloud`) & Seamless Switching

#### Task 6: Account Directory Persistence (Electron IPC + Client Store)
**Files:**
- Create: `lib/accounts-store.js` (browser + Node safe validation/normalization; single-local invariant)
- Modify: `electron/main.js:318-331`
- Modify: `electron/preload.cjs:15-32`
- Test: `test/accounts-store.test.js` (Create)

**Interfaces:**
- Produces (`lib/accounts-store.js`, also served at `/accounts-store.js` in `server.js`):
  - `LOCAL_ACCOUNT_ID = "local"`
  - `normalizeAccountsState(raw, localBaseUrl)` -> `{ activeAccountId: string, accounts: Array<{ id, type: "local"|"cloud", name, baseUrl, wsUrl, authToken?, createdAt }> }`:
    - Always guarantees **exactly 1** `type: "local"` account (`id: "local"`). Rejects creating a second `local` account or deleting `"local"`.
  - `upsertCloudAccount(state, { id?, name, baseUrl, authToken })` -> validates `https?://` URL, normalizes trailing slash, generates `wsUrl` (`ws://` or `wss://` + `/ws`).
  - `removeCloudAccount(state, id)` -> throws if `id === "local"`; if deleting `activeAccountId`, falls back `activeAccountId` to `"local"`.
- Produces (`electron/main.js` & `preload.cjs`):
  - IPC handlers `twinklebot:accounts-load` & `twinklebot:accounts-save` persisting `<userDataDir>/accounts.json` (`0o600` on POSIX) so cloud tokens survive app restarts and port changes, while browser-only web mode falls back cleanly to `localStorage`.

- [x] **Step 1: Write failing tests in `test/accounts-store.test.js`**
  - Verify `normalizeAccountsState(null, "http://127.0.0.1:3230")` produces 1 `local` account and `activeAccountId === "local"`.
  - Verify attempting to add a second `type: "local"` account throws `"only one local account is allowed"`.
  - Verify `removeCloudAccount(state, "local")` throws `"local account cannot be deleted"`.
  - Verify adding 2 cloud accounts, switching `activeAccountId`, and removing the active cloud account falls back to `"local"`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/accounts-store.test.js` -> FAIL.
- [x] **Step 3: Implement `lib/accounts-store.js`, serve `/accounts-store.js` in `server.js`, and wire Electron IPC in `main.js` + `preload.cjs`**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/accounts-store.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add lib/accounts-store.js server.js electron/main.js electron/preload.cjs test/accounts-store.test.js && GIT_MASTER=1 git commit -m "feat(accounts): add 1-local plus N-cloud account store and Electron persistence"`

---

### Step 4 — Admin Bot Lifecycle, Exclusive Pinning & Privilege Separation

#### Task 7: Admin Bot Store Invariants & Server API Guards
**Files:**
- Modify: `store.js:94-260` (`ensureAdminBot`, `deleteSession`, `listSessions`, `updateSession`)
- Modify: `server.js:1003-1044, 1699-1760`
- Test: `test/admin-bot.test.js` (Create)

**Interfaces:**
- Produces (`store.js`):
  - `ensureAdminBot(defaults = {})` -> returns the single `isAdmin: true` Bot session; if missing, creates `{ title: "Nori", type: "dm", isAdmin: true, pinned: true, rolePrompt: ... }` (or promotes legacy primary root Bot if migrating existing v1 `data/sessions`).
  - `listSessions()`: calls `ensureAdminBot()` (or preserves existing admin), always places `session.isAdmin === true` first, then sorts remaining sessions by `updatedAt` descending.
  - `deleteSession(id)`: throws `Error("管理员 Bot 不可删除")` if `session.isAdmin === true`.
  - `updateSession(id, patch)`: ignores/rejects `isAdmin` mutation; if `session.isAdmin`, rejects `pinned: false`; if `!session.isAdmin`, forces `pinned: false` (cannot hijack top pinned slot).
- Modifies (`server.js`):
  - `POST /api/sessions`: ignores `pinned: true` and `isAdmin: true` on new sessions (`pinned: false, isAdmin: false`).
  - `PATCH /api/sessions/:id`: rejects `pinned: true` on non-admin Bots (`400`) and `pinned: false` on Admin Bot (`400`); allows updating `title` and `avatar` on Admin Bot.
  - `DELETE /api/sessions/:id`: returns `403 { error: "管理员 Bot 严禁删除" }` when target `session.isAdmin === true`.

- [x] **Step 1: Write failing tests in `test/admin-bot.test.js`**
  - Test `admin bot deletion and pin protection`:
    - Fresh `createStore` -> `ensureAdminBot()` creates Admin Bot with `isAdmin: true, pinned: true`; `listSessions()[0].isAdmin === true`.
    - Create 2 regular Bots -> Admin Bot remains at index `0` even after regular Bots are updated later.
    - `DELETE /api/sessions/:adminId` returns `403`.
    - `PATCH /api/sessions/:adminId { pinned: false }` returns `400`; `PATCH /api/sessions/:adminId { title: "主控官", avatar: { color: "violet" } }` returns `200` and persists.
    - `PATCH /api/sessions/:regularId { pinned: true }` returns `400` and does not set `pinned: true`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/admin-bot.test.js` -> FAIL.
- [x] **Step 3: Implement Admin Bot invariants in `store.js` and guards in `server.js`**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/admin-bot.test.js test/store.test.js test/server.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add store.js server.js test/admin-bot.test.js && GIT_MASTER=1 git commit -m "feat(admin-bot): enforce auto-creation, delete protection, and exclusive pinning"`

---

### Step 5 — Dual-Layer Execution Environments, Local Screen Recording & Cloud-to-Host Bridge

#### Task 8: Restricted Host Executor + Local Screen Recording (`host_record_screen`)
**Files:**
- Modify: `agent/host-tools.js:17-325`
- Modify: `agent/policy.js:1-245`
- Test: `test/host-recording-and-policy.test.js` (Create)

**Interfaces:**
- Produces (`agent/host-tools.js`):
  - Add `host_record_screen` to `HOST_TOOL_DECLARATIONS` (`parameters: { duration_sec (1..60, default 8), display_index?, risk }`).
  - `runHostTool("host_record_screen", args, { workspaceRoot, execRecordFn, signal })` -> captures local screen video (`.mp4`/`.mov` saved inside `<workspaceRoot>/deliverables/screen_<ts>.mp4`) using macOS `screencapture -v -T <sec>` (or `ffmpeg -f avfoundation`) / Windows `ffmpeg -f gdigrab` (with PowerShell screenshot-sequence fallback if `ffmpeg` absent) and returns `{ ok, path, url, downloadUrl, size, durationSec, mimeType: "video/mp4" }`.
  - Cross-platform `host_open`: macOS `/usr/bin/open`, Windows `cmd /c start` / `explorer /select,`, Linux `xdg-open`.
- Produces (`agent/policy.js`):
  - `assessToolCall(name, args = {}, config = {})` accepts `{ envRole, isAdminBot, sandboxMode = "full" }`:
    - **Bot Computer Sandbox (`isSandboxTool`: `run_shell`, `write_file`, `read_file`, GUI/browser tools)**:
      - When `sandboxMode === "full"` (v2.0 default for Bot Computer), `sudo`, `rm`, `mv`, and `write_file` inside the Ubuntu/Cloud sandbox return `decision: "allow"` without confirmation friction, while `isPathDenied` still protects host-leaked credential files.
    - **Client Host (`isHostTool` / `isMcpToolName`)**:
      - Always **Restricted**: `host_run_shell` dangerous commands (`sudo`, `rm`, `mv`, `dd`, `mkfs`, `shutdown`, `reboot`, `format`, `diskpart`, `Remove-Item -Recurse`, `curl|sh`), `host_write_file` outside `writeRoots`, `host_record_screen` (unless explicitly allowed by policy rule or `allowHostRecord`), and `risk: "high"` return `decision: "confirm"`.
      - Sensitive paths (`.ssh`, `.aws`, `.gnupg`, `Keychains`, `.env`, `*auth*.json`, `accounts.json`, `desktop-config.json`) return `decision: "deny"`.

- [x] **Step 1: Write failing tests in `test/host-recording-and-policy.test.js`**
  - Test `host_record_screen` with stub `execRecordFn`: clamps `duration_sec` to `[1, 60]`, saves deliverable under `<workspaceRoot>/deliverables/`, returns `url` and `downloadUrl`.
  - Test `policy.js` privilege boundary: `assessToolCall("run_shell", { command: "sudo apt-get update" }, { sandboxMode: "full" })` -> `"allow"`; `assessToolCall("host_run_shell", { command: "sudo launchctl ..." }, { sandboxMode: "full" })` -> `"confirm"`; `assessToolCall("host_read_file", { path: "~/Library/Application Support/TwinkleBot/accounts.json" })` -> `"deny"`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/host-recording-and-policy.test.js` -> FAIL.
- [x] **Step 3: Implement `host_record_screen` & cross-platform `host_open` in `agent/host-tools.js`, and split host vs sandbox rules in `agent/policy.js`**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/host-recording-and-policy.test.js test/host-tools.test.js test/policy.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add agent/host-tools.js agent/policy.js test/host-recording-and-policy.test.js && GIT_MASTER=1 git commit -m "feat(host): add local host_record_screen tool and split host-restricted vs sandbox-full policy"`

#### Task 9: Cloud-to-Local `host_executor` Bridge Endpoint & Agent RPC Dispatch
**Files:**
- Create: `lib/host-bridge.js`
- Modify: `server.js` (mount `POST /api/host/execute`, `POST /api/host/approvals/:callId`, `GET /api/computer/host-info`; wire `hostBridge` on `/ws`)
- Modify: `agent/loop.js` (accept `deps.hostBridge`, route `host_*` through `hostBridge` in `deployEnv=cloud`)
- Test: `test/host-bridge.test.js` (Create)

**Interfaces:**
- Produces (`lib/host-bridge.js`):
  - `createHostBridge({ wsServer, timeoutMs = 120_000 })` -> `{ hasConnectedHost(clientId?), execute({ name, args, callId, sessionId, signal }) -> Promise<{ result, screenshot }>, resolveRpc(rpcId, payload), rejectAllForClient(clientId) }`:
    - Sends `{ type: "host_rpc_request", rpcId, callId, sessionId, tool: name, args }` over `/ws` to connected Client UI.
    - Awaits matching `{ type: "host_rpc_response", rpcId, ok, result, error }` frame.
    - On WS client disconnect, immediately calls `rejectAllForClient(clientId)` so pending tool calls never hang.
- Produces (`server.js` on `local` backend):
  - `POST /api/host/execute` (allowed in both `master` and `host_executor`, guarded by `localControlToken` if set): validates `isHostTool(body.tool)`, runs `assessToolCall(body.tool, body.args, settingsPolicy)` on local host; if `"deny"` -> `403`; if `"confirm"` and `!body.approved` -> returns `200 { needsApproval: true, reason }` (so Cloud Backend triggers its normal `approval_request` card in chat and re-invokes with `approved: true` after user clicks Allow!); else runs `runHostTool(...)` and returns `200 { ok: true, result, screenshot }`.

- [x] **Step 1: Write failing tests in `test/host-bridge.test.js`**
  - Test end-to-end Cloud -> WS -> Local `host_executor` bridge: boot two `createServer` instances (`cloudServer` with `deployEnv: "cloud"` and `localServer` in `RUNTIME_ROLE=host_executor`), connect a mock bridge client over `new WebSocket(...)` forwarding `host_rpc_request` to `localServer`'s `POST /api/host/execute`, run a mocked `runTask` on `cloudServer` that calls `host_run_shell`, assert result returns from `localServer` back to `cloudServer`!
  - Test `host bridge rejects pending rpc on ws disconnect`: start a `hostBridge.execute(...)` call, close the WS client before replying -> promise rejects within `<200ms` with `"host bridge client disconnected"`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/host-bridge.test.js` -> FAIL.
- [x] **Step 3: Implement `lib/host-bridge.js`, add `/api/host/execute` in `server.js`, and wire `deps.hostBridge` in `agent/loop.js`**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/host-bridge.test.js test/ws-and-role-gate.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add lib/host-bridge.js server.js agent/loop.js test/host-bridge.test.js && GIT_MASTER=1 git commit -m "feat(bridge): implement cloud-to-local host_executor WebSocket RPC bridge"`

---

### Step 6 — Bot Computer Provisioner, Admin Bot Exclusive Privileges & Frontend v2.0

#### Task 10: Cross-Platform Bot Computer State Probe & Provisioner (`WSL` / `OrbStack` / `Cloud`)
**Files:**
- Create: `lib/bot-computer-provisioner.js`
- Modify: `agent/bot-tools.js` (`computer_provision`, Admin-only gate on `computer_provision` & `update_bot_computer`)
- Modify: `agent/prompt.js` (Admin Bot vs Regular Bot instructions + preset init workflow)
- Modify: `server.js:1188-1255` (`GET /api/computer/status` unified status schema, `POST /api/computer/provision`)
- Test: `test/bot-computer-provisioner.test.js` (Create)

**Interfaces:**
- Produces (`lib/bot-computer-provisioner.js`):
  - `COMPUTER_STATES = ["uncreated", "creating", "ready", "unsupported", "error"]`
  - `probeBotComputerState({ deployEnv, platform = process.platform, executor, execFileFn, store })` -> `Promise<{ state: "uncreated"|"creating"|"ready"|"unsupported"|"error", platform, provider: "cloud-linux"|"orbstack"|"wsl"|"unsupported", online: boolean, detail: string, novncUrl?: string, hostComputer }>`
    - When `deployEnv === "cloud"` -> always `{ state: "ready", provider: "cloud-linux", online: true }`.
    - When `deployEnv === "local"` & `platform === "linux"` -> `{ state: "unsupported", provider: "unsupported", online: false, detail: "二期暂不支持 Linux 桌面端本地容器" }`.
    - When `deployEnv === "local"` & `platform === "darwin"` -> checks `orb list` / `ubuntu` VM / `executor.health()`.
    - When `deployEnv === "local"` & `platform === "win32"` -> checks `wsl -l -q` / Ubuntu distro / `executor.health()`.
  - `provisionBotComputer({ deployEnv, platform, projectRoot, executor, execFileFn, onProgress })`: runs platform detection -> installs/starts WSL+Ubuntu+XFCE+noVNC+executor (Windows) or OrbStack+Ubuntu+XFCE+noVNC+executor (macOS) -> generates/syncs `TWINKLEBOT_EXECUTOR_TOKEN` -> runs `executor.health()` self-check -> persists `computerCreated: true` & broadcasts `{ type: "computer_status_updated", ... }`.
- Produces (`agent/bot-tools.js`):
  - Add `computer_provision` tool declaration (`action: "probe" | "install" | "verify"`).
  - **RBAC guard** (`regular bot blocked from computer provisioning`): if `!ctx.senderBot?.isAdmin`, calling `computer_provision` or `system_diagnostics(action: "update_bot_computer")` immediately returns `{ ok: false, error: "权限不足：仅管理员 Bot 有权初始化或管理 Bot 电脑环境。" }`.

- [x] **Step 1: Write failing tests in `test/bot-computer-provisioner.test.js`**
  - Test `probeBotComputerState`: `deployEnv: "cloud"` -> `state: "ready"`; `deployEnv: "local", platform: "linux"` -> `state: "unsupported"`; `deployEnv: "local", platform: "darwin"` with stubbed `orb` returning empty list & offline executor -> `state: "uncreated"`; with healthy executor -> `state: "ready"`.
  - Test `regular bot blocked from computer provisioning`: call `runBotCollabTool("computer_provision", { action: "install" }, { senderBot: { id: "b2", isAdmin: false } })` -> `{ ok: false, error: /仅管理员 Bot/ }`; call with `senderBot: { id: "admin", isAdmin: true }` and stubbed `provisionFn` -> `{ ok: true, state: "ready" }`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/bot-computer-provisioner.test.js` -> FAIL.
- [x] **Step 3: Implement `lib/bot-computer-provisioner.js`, add `computer_provision` & Admin RBAC checks in `agent/bot-tools.js` + `agent/prompt.js`, and wire into `server.js`**
- [x] **Step 4: Run tests to verify pass**
  - Run: `node --test test/bot-computer-provisioner.test.js test/skills-bot-tools.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add lib/bot-computer-provisioner.js agent/bot-tools.js agent/prompt.js server.js test/bot-computer-provisioner.test.js && GIT_MASTER=1 git commit -m "feat(sandbox): add cross-platform Bot Computer probe/provisioner and Admin Bot RBAC"`

#### Task 11: Frontend Core Transport Refactor (`apiClient`, WebSocket + BaseURL Switching, Markdown URLs)
**Files:**
- Modify: `public/app.js:23, 150-275, 563-618, 1859-2065, 3348, 3682-3761, 4207-4290, 7871, 8841-8906`
- Modify: `public/markdown-utils.js:12-20`
- Test: `test/frontend-v2-transport.test.js` (Create), `test/markdown-rendering.test.js` (Modify)

**Interfaces:**
- Produces (`public/app.js`):
  - `apiUrl(pathOrUrl)` -> resolves relative `/api/...` paths against `state.activeBaseUrl` (empty string `""` for same-origin web, or `"http://127.0.0.1:3230"` / `"https://cloud.example.com"`).
  - `apiFetch(url, options)` & `apiJson(url, options)` -> inject `Authorization: Bearer <state.activeAuthToken>` when present, attach `state.accountAbortController.signal`, and reject/ignore stale responses if `epoch !== state.accountEpoch` (`stale account fetch ignored after switch`).
  - Refactor ALL 4 raw `fetch()` calls (`1868, 2011, 2057, 7871`), screenshot `img.src` (`3348`), download `href` (`1859`), library URLs (`4262, 4288`), and `buildNovncSrc()` (`563`) to use `apiUrl(...)`.
  - `connectRealtimeTransport()` -> connects `WebSocket` to `state.activeWsUrl` (with token) + reconnect backoff; handles `host_rpc_request` frames by calling `localBackendUrl/api/host/execute` (with `localControlToken`) and replying `host_rpc_response` over WS; falls back to `EventSource` if WS unavailable.
- Produces (`public/markdown-utils.js`):
  - `isSafeMarkdownUrl(rawUrl)` permits `https?://.../api/workspace/file...` in addition to `/api/workspace/file...`.

- [x] **Step 1: Write failing tests in `test/frontend-v2-transport.test.js` & `test/markdown-rendering.test.js`**
  - Verify `isSafeMarkdownUrl("https://cloud.example.com/api/workspace/file?path=a.png")` returns `true`.
  - Static/module verification on `public/app.js`: zero raw unprefixed `fetch("/api/` or `fetch(\`/api/` calls outside `apiFetch`; all image/file URLs pass through `apiUrl`; `stale account fetch ignored after switch` epoch check cancels/ignores responses from previous `accountEpoch`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/frontend-v2-transport.test.js test/markdown-rendering.test.js` -> FAIL.
- [x] **Step 3: Refactor transport layer, media URLs, and WebSocket + host-bridge forwarder in `public/app.js` and `public/markdown-utils.js`**
- [x] **Step 4: Run tests & syntax check**
  - Run: `node --check public/app.js && node --test test/frontend-v2-transport.test.js test/markdown-rendering.test.js` -> PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add public/app.js public/markdown-utils.js test/frontend-v2-transport.test.js test/markdown-rendering.test.js && GIT_MASTER=1 git commit -m "feat(ui): centralize BaseURL/auth transport, WebSocket realtime, and host bridge"`

#### Task 12: Frontend Onboarding, Multi-Vendor 3-Tier Settings, Account Switcher, Admin Pin & Bot Computer State Machine
**Files:**
- Modify: `public/index.html:26-225, 483-852, 1687-2193`
- Modify: `public/style.css`
- Modify: `public/app.js`
- Test: `test/frontend-v2-ui.test.js` (Create)

**Interfaces:**
- Produces (`public/index.html` + `public/app.js`):
  1. **Onboarding View (`#onboarding-overlay`)**: full-screen guided setup shown whenever `state.settings.onboardingRequired === true`; lets user select Provider (`Gemini` / `OpenAI` / `DeepSeek` / `自定义 OpenAI 兼容`), enter API Key + optional Base URL + Models, click **测试连接** (`POST /api/providers/test`), assign `极速档 / 中等档 / 高级档`, and click **完成连接并进入** (`POST /api/onboarding/complete`).
  2. **Settings -> 模型接入与路由 Tab (`[data-settings-tab="models"]`)**: manages multiple Providers (add/edit/delete/toggle/test) and 3-tier dropdown bindings (`#tier-fast-select`, `#tier-medium-select`, `#tier-advanced-select`). Make `getClientModelMeta` / `CLIENT_MODEL_RATES` support Gemini/OpenAI/DeepSeek/custom models dynamically.
  3. **Bottom-Left Account Switcher (`#account-popover`)**: renders the single **本地账号** + saved **云端账号** list + **+ 添加云端账号** modal (`#cloud-account-modal` with server URL, name, auth token); switching triggers `switchAccount(accountId)` -> aborts in-flight epoch, calls `POST <localBackend>/api/system/role`, switches `activeBaseUrl` & WS, refreshes Onboarding/Sessions/Computer status.
  4. **Admin Bot Exclusive Pin**: `#pinned-primary-bot` binds strictly to `session.isAdmin === true`; `#sidebar-context-menu` hides `pin` for all Bots and hides `delete` for Admin Bot (`#ctx-delete-btn` disabled/hidden when `isAdmin`).
  5. **Bot Computer State Machine (`#bot-computer-card`)**:
     - Renders `state.computerStatus.state`: `"uncreated"` (`待创建`), `"creating"` (`创建中…`), `"ready"` (`已就绪` / `运行中` / `休眠中`), `"unsupported"` (`暂不支持`).
     - Click/Enter handler on `#bot-computer-card`:
       - If `state === "ready"` -> `openBotScreenOverlay()` (or remote server status card in Cloud mode).
       - If `state === "uncreated"` -> finds `adminBot = state.sessions.find(s => s.isAdmin)` -> if `state.activeSessionId !== adminBot.id`, calls `await selectSession(adminBot.id)` -> injects & sends `PRESET_BOT_COMPUTER_INIT_PROMPT` via `POST /api/sessions/${adminBot.id}/messages`!

- [x] **Step 1: Write failing static & behavior tests in `test/frontend-v2-ui.test.js`**
  - Assert `public/index.html` contains `#onboarding-overlay`, `[data-settings-tab="models"]`, `#tier-fast-select`, `#tier-medium-select`, `#tier-advanced-select`, `#account-list-section`, `#add-cloud-account-btn`, `#cloud-account-modal`.
  - Assert `public/app.js` no longer permits non-admin pinning in context menu, includes `switchAccount`, `PRESET_BOT_COMPUTER_INIT_PROMPT`, and jump-to-Admin-Bot logic on `computerStatus.state === "uncreated"`.
- [x] **Step 2: Run tests to verify failure**
  - Run: `node --test test/frontend-v2-ui.test.js` -> FAIL.
- [x] **Step 3: Implement HTML, CSS, and JS controllers in `public/index.html`, `public/style.css`, and `public/app.js`**
- [x] **Step 4: Run full test suite & syntax checks**
  - Run: `node --check public/app.js && npm test` -> all tests PASS.
- [x] **Step 5: Commit**
  - `GIT_MASTER=1 git add public/index.html public/style.css public/app.js test/frontend-v2-ui.test.js && GIT_MASTER=1 git commit -m "feat(ui): add onboarding, multi-provider 3-tier UI, account switcher, admin pin, and computer init flow"`

---

## Final Verification Gate (Before Declaring v2.0 Complete)

- [x] Run full Node.js test suite: `npm test` (0 failures).
- [x] Run Python executor tests: `orb -m ubuntu python3 -m unittest discover -s executor -v`.
- [x] Verify `DEPLOY_ENV=cloud` startup (`DEPLOY_ENV=cloud TWINKLEBOT_EXECUTOR_TOKEN=... TWINKLEBOT_CLOUD_TOKEN=... node server.js`) serves authenticated requests and rejects unauthenticated requests.
- [x] Verify Web UI E2E at `http://127.0.0.1:3230`: Onboarding flow -> 3-tier model binding -> Admin Bot non-deletable/exclusive pin -> Bot Computer `待创建` click from regular Bot jumps to Admin Bot and dispatches init prompt -> Account switch toggles local `RUNTIME_ROLE` cleanly.
