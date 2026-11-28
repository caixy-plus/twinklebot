---
trigger: model_decision
description: Governs when to stay silent on small local edits, how to interactively gate GitHub Release builds with configurable E2E levels (default affected+p0), and how to keep the E2E catalog synchronized with new features.
---

# TwinkleBot E2E Trigger, Release Gate & Feature Sync Rule

## 1. Local Small Edits & Preview — DO NOT Trigger E2E
- When the user is tweaking a small feature, adjusting UI/CSS, prototyping, or checking results locally, **DO NOT** automatically run E2E tests and **DO NOT** interrupt them with E2E prompts.
- Keep local iteration fast (`npm run typecheck` / `npm test` only when appropriate, or direct local preview). Only execute E2E locally when the user explicitly requests it (`/twinklebot-e2e ...`) or at the **GitHub Release / version build** boundary below.

## 2. GitHub Release / Version Build — Auto-Analyze & Actively Ask
Whenever the user asks to trigger or prepare a **GitHub Release / version build** — including:
- Bumping version for release (`npm run version:bump`)
- Pushing a release tag (`v*` or `ota-*`)
- Dispatching `.github/workflows/release.yml` (`gh workflow run release.yml` or GitHub UI)
- Building release bundles (`npm run build:ota` / `npm run electron:dist*`) for publishing

You MUST execute this automatic analysis + interactive confirmation flow **before** pushing tags or dispatching the release:

1. **Auto-analyze impacted suites since the previous release tag**:
   ```bash
   npm run e2e:sync-check -- --since-last-tag
   ```
2. **Actively ask the user** (using a multiple-choice question tool if available, or a concise choice prompt) whether to trigger automated E2E testing and which **test level** to run, presenting the smart default first:
   - **`affected+p0` (Recommended Default)**: 本次版本有动到的受影响套件 + P0 核心功能基线（21 项）
   - **`all`**: 全量自动化测试（P0–P3 全部 14 套件 / 以 `catalog.json` 为准，当前 110 项）
   - **`p0+p1`**: P0 核心 + P1 跨栈与核心业务（67 项）
   - **`p0`**: 仅 P0 核心主链路（21 项）
   - **`affected`**: 仅本次版本改动涉及的受影响套件
   - **`skip`**: 跳过 E2E，直接进行 GitHub 版本构建
3. **Honor the chosen level**:
   - Local pre-release verification: `node scripts/run-e2e.mjs --tier=<chosen-level> --since-last-tag` (or `npm run test:e2e:release` for default `affected+p0`).
   - GitHub Actions dispatch: `release.yml` defaults `e2e_level=skip` (build-only; E2E runs locally). Optionally pass `-f e2e_level=<chosen-level>` to run in CI as well.
4. **Block, Fix & Re-Verify Before Tagging / Publishing**:
   - In **release gate mode** (when the user explicitly requests a release/build with E2E enabled), any non-`ENV_SKIP` failure (`BUG`) **blocks** pushing release tags or publishing: distinguish true product regressions/races from test-fixture drift, apply the fix, and re-run the affected E2E suite(s) + `npm run typecheck && npm test` to green before continuing the release. (Standalone read-only `/twinklebot-e2e` audits still diagnose and report without modifying business code until confirmed.)

## 3. Keeping the E2E Catalog Synchronized on Brand-New Features
When committing genuinely **new** user-facing features (new API route files/endpoints under `src/server/routes/`, new UI components/modals under `src/web/components/`, new bot tools under `src/agent/bot-tools/`, or new `executor/executor.py` endpoints):
1. Run `npm run e2e:sync-check -- --staged` (also checked non-blockingly by `.githooks/pre-commit`).
2. If unmapped new features are reported, update `.agents/skills/twinklebot-e2e/references/catalog.json`, `references/test-plan.md`, and add/update the corresponding atomic case in `test/e2e/*.e2e.ts` (following `.agents/skills/twinklebot-e2e/SKILL.md` `update` mode).
3. Keep reports under `test-results/reports/latest.md` (gitignored); archive milestone baselines into `docs/e2e-reports/` via `npm run e2e:report:archive` only when releasing or explicitly asked.
