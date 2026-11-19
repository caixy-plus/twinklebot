# TwinkleBot E2E Diagnostic Report Template & Rubric

> Use this structure for all reports written to `test-results/reports/latest.md` (and archived snapshots in `docs/e2e-reports/`).

## 1. 4-Way Classification Rubric

Every atomic E2E case MUST be classified into exactly one status:

| Status | Meaning | Criteria & Required Evidence |
| :--- | :--- | :--- |
| **`PASS`** | Verified green | Assertions passed cleanly with zero uncaught `pageErrors` (and expected network/storage side effects confirmed). |
| **`BUG`** | Confirmed product defect | Reproduced end-to-end AND verified against source code. Must assign severity (`S0 Blocker` / `S1 Major` / `S2 Moderate` / `S3 Minor`), exact `file:line` root cause, repro command, and evidence path. |
| **`UX_DESIGN`** | UX / contract polish issue | Feature works functionally, but exhibits confusing UX, visual inconsistency, or awkward API ergonomics. Must cite exact `file:line` and concrete optimization suggestion. |
| **`ENV_SKIP`** | Environment-gated skip | Legitimately skipped due to missing optional runtime prerequisite (e.g. `TWINKLEBOT_E2E_LIVE` unset / no `.env`, no OrbStack `ubuntu` on Windows, no Electron binary). Never mark a real failure as `ENV_SKIP`. |

> **Important**: If a failure turns out to be a **test-script selector / timing / mock issue** rather than a product bug, label it transparently in a dedicated section (or fix the test script) — never inflate product bug counts with test harness noise.

---

## 2. Standard Markdown Report Structure

```markdown
# TwinkleBot 分级 E2E 测试与缺陷诊断报告

- **生成时间**: `YYYY-MM-DD HH:mm:ss`
- **Git 提交**: `<branch>` @ `<short-sha>`
- **执行范围**: `<tier / affected / suites>`
- **原始证据目录**: `test-results/`（截图与 JSON 现场位于 `test-results/evidence/<case-id>/`）

---

## 一、执行总览仪表盘

| 优先级 | 总用例数 | ✅ PASS | 🐞 BUG | 💡 UX_DESIGN | ⏭️ ENV_SKIP |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **P0** | ... | ... | ... | ... | ... |
| **P1** | ... | ... | ... | ... | ... |
| **P2** | ... | ... | ... | ... | ... |
| **P3** | ... | ... | ... | ... | ... |
| **合计** | ... | ... | ... | ... | ... |

---

## 二、失败项与白盒根因诊断

### `[BUG-XX]` [S0/S1/S2] <简明标题>
- **关联用例**：`<CASE-ID>`（`<F1/F2/F3> × <D1/D2/D3>`）
- **复现命令**：`node --test --test-force-exit dist-server/test/e2e/<suite>.e2e.js`
- **实测现象 vs 预期表现**：...
- **白盒源码根因**：`<path/to/file.ts#Lxx-Lyy>`
- **证据现场**：`test-results/evidence/<CASE-ID>/failure.png` & `details.json`
- **修复建议**：...

---

## 三、体验与契约瑕疵（`UX_DESIGN`）

| 编号 | 关联用例 | 现象描述 | 源码位置 | 优化建议 |
| :--- | :--- | :--- | :--- | :--- |

---

## 四、原子用例逐条执行明细

| 优先级 | 用例 ID | 维度 | 状态 | 耗时 | 模块 / 用例说明 |
| :--- | :--- | :---: | :---: | :---: | :--- |
```
