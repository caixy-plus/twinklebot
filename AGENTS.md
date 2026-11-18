# TwinkleBot

Multi-Bot AI desktop & mobile agent: orchestrates Gemini / OpenAI / DeepSeek / Anthropic / Vertex AI models with a local or cloud runtime, OrbStack Ubuntu XFCE sandbox (`:1`, 1440x900), and cross-platform Host Executor bridge.

- **Stack & Build**: Node.js 22.13+, ESM, TypeScript (`tsc`). `tsconfig.json` compiles `src/` (server/agent/store/electron/shared/tests) to `dist-server/`; `tsconfig.web.json` compiles `src/web/` to `public/dist/`; `tsconfig.landing.json` compiles `src/landing/` to `landing/dist/`. Only runtime dependency: `@google/genai` (>= 2.29.1; use the Interactions API only for Gemini, never `generateContent` or legacy `@google/generative-ai`).
- **Architecture**:
  - `src/shared/` holds shared entity types, DTOs, and browser-safe modules (`accounts-store.ts`, `skills-catalog.ts`, `context-compression.ts`).
  - `src/server/` serves `127.0.0.1:3230` (via `dist-server/src/server/index.js`, split into `context.ts`, `http-utils.ts`, `static.ts`, and `routes/*.ts`).
  - `src/agent/` holds the agent loop, smart router, context compression, policy, model adapters (`providers/*.ts`), and bot tools (`bot-tools/*.ts`).
  - `src/store/` owns JSON/NDJSON session, event, history, skill, schedule, and vault persistence under `data/`.
  - `src/web/` (`app.ts`, `modules/*.ts`, `mobile-*.ts`) + `public/` form the Web/Desktop/Mobile UI; `APP_TARGET=mobile node scripts/build-web.mjs` strips backend/Electron files into `dist-web/` for Capacitor (`android/` with native `LanDiscoveryPlugin`, `ios/`).
  - `src/electron/` + `electron/preload.cjs` package the Electron app; `executor/executor.py` runs inside Ubuntu (Python 3 stdlib only, `twinklebot-executor.service`, port `7300`, bearer token).
- **Commands**: `npm run typecheck`, `npm run build:ts`, `npm run build:ota`, `npm test` (builds TS then runs `node --test`), `npm run electron:pack:mac` / `electron:dist`, `npm run mobile:build:web` / `mobile:apk:debug`, and `orb -m ubuntu python3 -m unittest discover -s executor -v`. For automated UI/E2E testing, prefer `http://127.0.0.1:3230` directly.
- **Versioning & GitHub Releases (`v1.0.0` Baseline)**:
  - `version-policy.json` is the single source of truth for decoupled `shells.{desktop, android, ios}` versions vs `minVersionForOta` / `minBuildCodeForOta` and `backend` `apiCapabilities` (enforced by unit tests against `package.json`, `android/app/build.gradle`, and `ios/App/App.xcodeproj/project.pbxproj`).
  - Pushing to `main` runs `.github/workflows/ci.yml` only (never auto-publishes client updates). Push tag `ota-*` (or dispatch `release.yml` with `mode=ota-only`) for pure-frontend OTA hot updates; push tag `v*` (or `mode=full`) for full multi-platform installers + OTA.
  - Because Mobile/Web clients may switch dynamically between LAN and Cloud backend nodes running different versions, gate any post-`1.0.0` backend-dependent UI feature via `hasConnectedNodeCapability("<cap>")` (`src/web/services/ota-updater.ts`) while keeping `v1.0.0` baseline features backward-compatible.
- **Security**: Never commit or log `.env`, API keys, the executor token, or `data/`.
