# Skills Store (技能商店) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 「连接应用」 with a unified GrokBot-style 「技能 / 技能商店」 (platform / office / custom skills), with installable/removable mail skills and chat-driven configuration of installed mail skills.

**Architecture:** A shared `lib/skills-catalog.js` defines categories, defaults and mail server presets; `lib/mail-accounts.js` holds the mail-account upsert/remove/default logic reused by REST and the new `skill_configure_mail` Bot tool. `settings.installedSkills` gates REST, Bot tool exposure and tool execution server-side. The frontend modal becomes three sub-views (store home ↔ manage added ↔ single-skill detail) reusing the existing mail forms.

**Tech Stack:** Node.js 22.13+ ESM, `node:test`, vanilla HTML/CSS/JS, `@google/genai` (unchanged).

**Spec:** `docs/superpowers/specs/2026-11-11-skills-store-design.md`

## Global Constraints

- Node.js 22.13+, plain ESM JavaScript, no new runtime dependencies.
- Default `installedSkills` when unset: `["qqmail", "custom-mail"]`.
- Platform skill ids: `desktop-control`, `shell-and-files`, `ai-image`, `multi-bot-collab`, `interactive-cards` — never removable (`400` `"平台技能为系统内置核心能力，不可关闭或移除"`).
- Mail credentials only in `data/mail-auth.json` (`0o600`); never in `/api/settings`, `/api/skills`, chat events, tool results, or logs.
- Not-installed skill error copy: REST `"请先在技能商店添加该邮箱技能后再配置"`; Bot tool `"该技能当前未添加，请先在左下角「技能商店」添加后再配置。"`
- UI copy: entry `技能` / title `技能商店`; filters `全部 | 办公 | 平台技能 | 自定义`; pill `已添加 N 个 ›`; manage view `管理已添加技能` with back `‹ 技能商店`.

## Review Focus

1. Removing a skill that owns the default account → another installed account must become effective default in `/api/settings` and Bot tools (Task 3 test `effective default after removal`).
2. Re-adding a removed skill without purge → dormant accounts reappear unchanged (Task 3 test `reinstall restores dormant accounts`).
3. User types the secret in chat and the model passes `secret` → the `action` event must show `secret: "••••"` (Task 4 test `action args redact secret`).
4. `skill_configure_mail` targeting an account whose provider is not installed via `account` lookup (not `skill_id`) → rejected (Task 4 test `rejects account of removed skill`).
5. Unknown company domain in generic-mail prefill → `imap.<domain>:993` / `smtp.<domain>:465` (Task 1 test `unknown domain fallback`).

---

### Task 1: Skills catalog & mail presets

**Files:**
- Create: `lib/skills-catalog.js`
- Test: `test/skills-catalog.test.js`

**Interfaces — Produces:**
- `SKILL_CATEGORIES = { platform, office, custom }` (labels `平台技能`, `办公`, `自定义`)
- `PLATFORM_SKILLS: Array<{id,name,desc,icon,category:"platform",toolCount}>` (5 items, spec §5.1)
- `OFFICE_SKILLS: Array<{id,name,desc,icon,category:"office"}>` (`qqmail` 「QQ 邮箱」, `custom-mail` 「通用邮箱」)
- `MAIL_SKILL_IDS = ["qqmail","custom-mail"]`, `DEFAULT_INSTALLED_SKILLS = ["qqmail","custom-mail"]`
- `isPlatformSkill(id): boolean`, `isInstallableSkill(id): boolean`
- `resolveInstalledSkillIds(settings): string[]`
- `inferMailServerPreset(email: string, preferredProtocol = "imap"): { inboundProtocol, inboundHost, inboundPort, inboundTls, smtpHost, smtpPort, smtpSecurity } | null`

- [ ] **Step 1: Write failing tests** — `resolveInstalledSkillIds(undefined)` and `({})` → `["qqmail","custom-mail"]`; `({installedSkills:[]})` → `[]`; `({installedSkills:["qqmail","qqmail","bogus","desktop-control"]})` → `["qqmail"]`; `inferMailServerPreset("a@163.com")` → `{inboundHost:"imap.163.com",inboundPort:993,smtpHost:"smtp.163.com",smtpPort:465,smtpSecurity:"ssl"}`; `("a@163.com","pop3")` → `pop.163.com:995`; `("a@outlook.com")` → `outlook.office365.com:993` + `smtp.office365.com:587` `starttls`; unknown domain fallback `("x@acme.cn")` → `imap.acme.cn:993`, `smtp.acme.cn:465`; invalid email → `null`; `PLATFORM_SKILLS.length === 5`, `isPlatformSkill("ai-image") === true`, `isInstallableSkill("ai-image") === false`.
- [ ] **Step 2:** `node --test test/skills-catalog.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement per spec §5.1/§5.2 preset table (domain keys: 163.com, 126.com, yeah.net, qq.com, foxmail.com, exmail.qq.com, aliyun.com, outlook.com, hotmail.com, live.com, gmail.com, feishu.cn). Module must be browser-safe (no node imports) so the frontend can import `/skills-catalog.js` — serve it via a static alias in `server.js` (`GET /skills-catalog.js` → `lib/skills-catalog.js`, `text/javascript`).
- [ ] **Step 4:** Tests PASS.

### Task 2: Shared mail-account operations

**Files:**
- Create: `lib/mail-accounts.js`
- Modify: `server.js` (`handleMailUpsertOrTest` save path + DELETE paths call into it)
- Test: `test/mail-accounts.test.js`; regression `test/mail-integration.test.js`

**Interfaces — Produces:**
- `async upsertMailAccount(store, body, { forcedProvider = null, explicitId = null, verify = true, verifyFn = verifyMailConnection }) → { ok:true, record, created:boolean, inboxStats } | { ok:false, status:number, error:string }` — same validation copy and matching rules as current server code (id → email+provider → single-account-of-provider).
- `findMailAccount(accounts, ref, { providers }) → account | null` (id, email, label exact, then substring; restricted to `providers`).
- `setDefaultMailAccount(store, id) → { ok, record } | { ok:false,status,error }`
- `removeMailAccount(store, id) → { ok, removed } | { ok:false,status:404,error }`
- `purgeProviderAccounts(store, provider) → number` (removed count)

- [ ] **Step 1: Failing tests** with a temp `createStore` and stub `verifyFn` resolving `{messages:3,latencyMs:1}`: create QQ account → `created:true`, file has 1 account, `record.password` present; second create with `forceNew` same provider different email → 2 accounts; missing secret → `{ok:false,status:400}`; `setDefaultMailAccount` flips `isDefault` exclusively; `removeMailAccount` unknown id → 404; `purgeProviderAccounts(store,"qqmail")` returns count and leaves custom-mail accounts.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Move the save branch of `handleMailUpsertOrTest` into `upsertMailAccount`; server keeps the test-only branch and response shaping.
- [ ] **Step 4:** `node --test test/mail-accounts.test.js test/mail-integration.test.js` → PASS.

### Task 3: Server skills API & gating

**Files:**
- Modify: `server.js` (`getSanitizedMailState`, `getMergedSettings`, new routes, mail route gating, `POST /api/settings` ignores `installedSkills`)
- Test: `test/skills-store.test.js`

**Interfaces:**
- Consumes: Task 1 catalog, Task 2 ops.
- Produces (JSON on `GET /api/settings` and `GET /api/skills`): `installedSkills: string[]`, `skillsCatalog: { platform: [...], office: [{...meta, installed, accountCount, savedAccountCount}] }`, `mailAccounts` (only installed providers; effective `isDefault`), `privateSkills`.
- Routes: `POST /api/skills/:id/install`, `DELETE /api/skills/:id` (body or `?purgeCredentials=true`); both broadcast `runner.broadcastGlobal({ type: "skills_updated" })` and return merged settings. Mail account writes (create/patch/delete/test) also broadcast `skills_updated`.

- [ ] **Step 1: Failing tests** (server on random port, temp data dir): fresh `GET /api/skills` → `installedSkills` `["qqmail","custom-mail"]`, `skillsCatalog.platform.length===5`; `DELETE /api/skills/ai-image` → 400 with spec copy; `DELETE /api/skills/bogus` → 404; seed a QQ default + custom account in `mail-auth.json`, `DELETE /api/skills/qqmail` → `mailAccounts` only custom, it has `isDefault:true` (**effective default after removal**), `mail-auth.json` still has 2 accounts, `savedAccountCount` for qqmail = 1; `POST /api/integrations/mail/accounts` with `provider:"qqmail"` → 400 spec copy; `POST /api/skills/qqmail/install` → qqmail account back (**reinstall restores dormant accounts**); `DELETE /api/skills/qqmail?purgeCredentials=true` → file keeps only custom; no response body contains the seeded password string; `POST /api/settings {installedSkills:[]}` does not change installed list.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → all PASS.

### Task 4: Bot tools, loop gating, prompt

**Files:**
- Modify: `agent/bot-tools.js`, `agent/loop.js`, `agent/prompt.js`
- Test: `test/skills-bot-tools.test.js`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: declarations `skill_list` (no params) and `skill_configure_mail` (params per spec §5.4: `action` enum `upsert_account|set_default|test_account|remove_account`, `skill_id`, `account`, `email`, `secret`, `label`, `sender_name`, `inbound_protocol`, `inbound_host`, `inbound_port`, `inbound_tls`, `smtp_host`, `smtp_port`, `smtp_security`, `is_default`, `send_test_mail`); `export function filterToolDeclarationsForSkills(decls, installedSkillIds)` (drops `mail_*` when no mail skill installed); `export function redactToolArgsForDisplay(name, args)` (replaces `secret` with `"••••"`).
- Behavior: `mail_*` tools resolve accounts only from installed providers. `upsert_account` without `secret` for a new account → `credential_request` `{ callId, service:"QQ 邮箱 · <email>", label, fieldType:"password", hideVaultCheckbox:true }`, waits, then `upsertMailAccount`; emits `credential_resolved { submitted, resolvedText:"🔒 已连接 QQ 邮箱 · <email>" }`. Tool results never include secrets. On success call `broadcastGlobal?.({type:"skills_updated"})`. Generic mail without hosts → `inferMailServerPreset`.
- Prompt: replace 「连接应用」 wording; add an 「Added Skills」 section listing installed office skills with account counts and instruct: use `skill_configure_mail` for mailbox config, omit `secret` when user hasn't given it (secure card appears), never ask for passwords in plain text.

- [ ] **Step 1: Failing tests**: `skill_list` returns 5 platform + office with `installed`; with `installedSkills:["custom-mail"]`, `skill_configure_mail {action:"upsert_account",skill_id:"qqmail",...}` → error spec copy; **rejects account of removed skill** (`action:"set_default", account:"<qq email>"` when qqmail removed); upsert with `secret` and stub verify (inject `ctx.verifyMailFn`) creates account, result has no `secret`/`password` keys and `broadcastGlobal` called with `skills_updated`; upsert without secret emits `credential_request` with `hideVaultCheckbox:true`, resolving the choice `{value:"abcdabcdabcdabcd"}` saves account and emits `credential_resolved` with `resolvedText`; `filterToolDeclarationsForSkills(BOT_COLLAB_TOOL_DECLARATIONS, [])` contains no `mail_` names but contains `skill_configure_mail`; **action args redact secret**: `redactToolArgsForDisplay("skill_configure_mail",{secret:"x",email:"a"})` → `{secret:"••••",email:"a"}`; `buildSystemInstruction({installedSkills:[...], ...})` contains `skill_configure_mail` and not `连接应用`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `loop.js` computes `installedSkills` per step, filters `allTools`, passes `installedSkills` into `promptConfig`, uses `redactToolArgsForDisplay` for the emitted `action` event.
- [ ] **Step 4:** `npm test` → all PASS.

### Task 5: Frontend Skills Store (GrokBot three-view modal)

**Files:**
- Modify: `public/index.html` (entry labels; replace `apps-directory-view`/`apps-installed-view` with `skills-store-view`, `skills-manage-view`, `skill-detail-view`; move existing `qqmail-config-form` / `custom-mail-config-form` into detail view, drop provider tabs; wrap QQ `发件人昵称` + protocol radios and generic `发件人昵称` in `<details class="mail-advanced-details"><summary>高级选项</summary>`), `public/style.css`, `public/app.js`
- Test: `test/skills-store-ui.test.js` (static HTML assertions)

**Interfaces:**
- Consumes: `/api/skills`, `/api/skills/:id/install`, `DELETE /api/skills/:id`, `/skills-catalog.js` (`inferMailServerPreset`), SSE `skills_updated`.
- Produces: `openSkillsStore(view = "store", opts = {})` replacing `openAppsModal` (views `"store" | "manage" | "detail"`, `opts.skillId`, `opts.from`); `renderSkillsStore()` replacing `renderAppsAndSkillsModal`.

- [ ] **Step 1: Failing static test**: `index.html` contains `id="skills-store-view"`, `id="skills-manage-view"`, `id="skill-detail-view"`, `技能商店`, `已添加`, `在技能中搜索`, data-skill-filter values `all|office|platform|custom`, two `mail-advanced-details`; does not contain `连接应用` or `provider-tab-qqmail`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement views per spec §5.3: store home (header + overlapping icons + `已添加 N 个 ›`, search, `Bot 模板 ↗`, filter pills, 2-column rows with `添加`/`配置`/`内置`); manage view (2-col added office+platform rows with `配置`/`移除` + inline confirm with `同时清除已保存的 N 个邮箱凭据`, custom skills list + `+ 新建技能`); detail view (account rows `设为默认`/`测试`/`编辑` + `+ 添加邮箱账号` when ≥1 account; otherwise form directly; after save return to list; `移除此账号` two-step confirm 4s; `移除技能` in header); search filters rows by name/desc/account emails; generic email `input` → prefill unless `dataset.userEdited`; credential card honors `hideVaultCheckbox` and `credential_resolved.resolvedText`; SSE `skills_updated` → `refreshSettingsFromServer()`; `/teach` + composer 「教它做一项任务」 open manage view with new-skill form.
- [ ] **Step 4:** `node --check public/app.js && npm test` → PASS.

### Task 6: Live verification

- [ ] Start `npm start` (background), verify via browser subagent on `http://127.0.0.1:3230`: open 技能 → store home; `已添加 2 个 ›` → manage; back; QQ `配置` → form (0 accounts) with collapsed 高级选项; generic email `a@163.com` prefills `imap.163.com`; remove 通用邮箱 → store shows `添加`; re-add. Screenshot evidence; update `walkthrough.md`.
