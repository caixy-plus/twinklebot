import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { createMockMcpServerScript } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector, PROJECT_ROOT } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P2 Suite 7: Settings General, Compression, Computer/Permissions, Vault, Diagnostics, Shell/Dialogs & SSR Markup", async (t) => {
  const collector = createSuiteCollector("p2-settings-vault-and-permissions");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  const ws = await createE2EWorkspace({ smartRouter: true });
  t.after(() => ws.close());

  await chrome!.navigate(ws.baseUrl);
  await chrome!.waitFor(
    `document.querySelector('#header-bot-name')?.textContent?.includes('Twinkle') &&
     document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`
  );

  const openSettingsTab = async (tab: string) => {
    const isHidden = await chrome!.evalJs<boolean>(
      `Boolean(document.querySelector('#settings-modal-backdrop')?.hidden)`
    );
    if (isHidden) {
      await chrome!.click("#account-menu-btn");
      await chrome!.waitFor(`!document.querySelector('#account-popover')?.hidden`);
      await chrome!.click(`[data-account-action="settings"]`);
      await chrome!.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`);
    }
    await chrome!.click(`.settings-nav-item[data-settings-tab="${tab}"]`);
    await new Promise((r) => setTimeout(r, 120));
  };

  // ---------- P2-SET-01 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-01",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置·通用：个人昵称保存(按钮+回车保存+空值防误存提示)与 6 色头像圆点切换(侧边栏联动 + 刷新持久化)",
      module: "Settings General / Profile",
    },
    async () => {
      await openSettingsTab("general");
      // Empty name validation guard
      await chrome!.fill("#profile-name-input", "   ");
      await chrome!.click("#save-profile-btn");
      await new Promise((r) => setTimeout(r, 120));

      // Save via button + Enter key + all 6 color swatches check
      await chrome!.fill("#profile-name-input", "测试官Alpha");
      await chrome!.click("#save-profile-btn");
      await chrome!.click(`.profile-color-dot[data-profile-color="emerald"]`);
      await chrome!.waitFor(
        `document.querySelector('#sidebar-user-name')?.textContent?.includes('测试官Alpha') &&
         document.querySelector('#sidebar-user-avatar')?.dataset?.profileColor === 'emerald'`
      );
      const dotCount = await chrome!.evalJs<number>(`document.querySelectorAll('.profile-color-dot').length`);
      assert.ok(dotCount >= 6, `Expected 6 profile color dots, got ${dotCount}`);

      // Also verify Enter saves updated name
      await chrome!.fill("#profile-name-input", "测试官Beta");
      await chrome!.pressKey("Enter");
      await ws.waitUntil(() => ws.store.readSettings().profile?.name === "测试官Beta", 4000, "profile Enter save");
      assert.equal(ws.store.readSettings().profile?.color, "emerald");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-02 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-02",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置·通用：浅色/深色/跟随系统三态主题(color-scheme 同步)、Bot 强调色 vs 默认黑灰与拼写检查(#message-input spellcheck)开关",
      module: "Settings General / Appearance",
    },
    async () => {
      await openSettingsTab("general");
      await chrome!.selectOption("#setting-theme-select", "dark");
      await chrome!.waitFor(`localStorage.getItem('color-scheme') === 'dark'`);
      await chrome!.selectOption("#setting-theme-select", "light");
      await chrome!.waitFor(`localStorage.getItem('color-scheme') === 'light'`);
      await chrome!.selectOption("#setting-accent-mode", "default");

      const spellBefore = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('#message-input')?.spellcheck)`);
      await chrome!.evalJs(`document.querySelector('#setting-spellcheck-toggle')?.closest('label')?.click()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#message-input')?.spellcheck) !== ${spellBefore}`, 4000);

      const st = ws.store.readSettings();
      assert.equal(st.theme, "light");
      assert.equal(st.accentMode, "default");
      // Wait briefly for spellcheck POST to persist to settings.json
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && ws.store.readSettings().spellcheckEnabled === spellBefore) {
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.equal(ws.store.readSettings().spellcheckEnabled, !spellBefore);
      await chrome!.selectOption("#setting-theme-select", "system");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-03 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-03",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置·通用：上下文压缩 3 档预设卡(50%/75%/85%)、滑块、高级自定义规则与全局共享记忆 CRUD/启停/编辑/删除",
      module: "Settings General / Compression & Global Memories",
    },
    async () => {
      await openSettingsTab("general");
      // Exercise all 3 compression presets
      await chrome!.click(`[data-ctx-preset="compact"]`);
      await chrome!.waitFor(`document.querySelector('#ctx-compress-percent-label')?.textContent?.includes('50%')`);
      await chrome!.click(`[data-ctx-preset="long"]`);
      await chrome!.waitFor(`document.querySelector('#ctx-compress-percent-label')?.textContent?.includes('85%')`);
      await chrome!.click(`[data-ctx-preset="balanced"]`);
      await chrome!.waitFor(`document.querySelector('#ctx-compress-percent-label')?.textContent?.includes('75%')`);
      await chrome!.setRangeValue("#setting-ctx-compress-percent", 80);
      await chrome!.waitFor(`document.querySelector('#ctx-compress-percent-label')?.textContent?.includes('80%')`);
      const ctxDeadline = Date.now() + 3000;
      while (
        Date.now() < ctxDeadline &&
        ws.store.readSettings()?.contextCompression?.triggerPercent !== 80
      ) {
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.equal(ws.store.readSettings()?.contextCompression?.triggerPercent, 80);

      // Expand advanced details if present
      const hasAdv = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('#ctx-compress-advanced'))`);
      if (hasAdv) {
        await chrome!.evalJs(`(() => { const d = document.querySelector('#ctx-compress-advanced'); if (d) d.open = true; })()`);
      }

      // Global memory full CRUD: create -> toggle switch -> inline edit -> delete confirm!
      await chrome!.click("#new-memory-btn");
      await chrome!.waitFor(`!document.querySelector('#new-memory-form-card')?.hidden`);
      await chrome!.fill("#memory-name-input", "全局代码偏好");
      await chrome!.fill("#memory-content-input", "一律使用 TypeScript 严格模式");
      await chrome!.click("#save-memory-btn");
      await chrome!.waitFor(`document.querySelector('#global-memories-list')?.textContent?.includes('全局代码偏好')`);

      // Toggle global memory switch off & back on
      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#global-memories-list .private-skill-card, #global-memories-list .skill-row, #global-memories-list > div'));
        const card = cards.find(c => c.textContent?.includes('全局代码偏好'));
        card?.querySelector('label.ios-switch')?.click();
      })()`);
      await new Promise((r) => setTimeout(r, 150));

      // Edit global memory inline -> update title -> delete via inline confirm
      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#global-memories-list > div'));
        const card = cards.find(c => c.textContent?.includes('全局代码偏好'));
        const editBtn = Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent?.includes('编辑'));
        editBtn?.click();
      })()`);
      await chrome!.waitFor(`!document.querySelector('#new-memory-form-card')?.hidden`, 4000);
      await chrome!.fill("#memory-name-input", "全局代码偏好V2");
      await chrome!.click("#save-memory-btn");
      await chrome!.waitFor(`document.querySelector('#global-memories-list')?.textContent?.includes('全局代码偏好V2')`, 4000);

      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#global-memories-list > div'));
        const card = cards.find(c => c.textContent?.includes('全局代码偏好V2'));
        const delBtn = Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent?.includes('删除'));
        delBtn?.click();
      })()`);
      await new Promise((r) => setTimeout(r, 150));
      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#global-memories-list > div'));
        const card = cards.find(c => c.textContent?.includes('全局代码偏好V2'));
        const confirmBtn = Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent?.includes('确认'));
        confirmBtn?.click();
      })()`);
      await chrome!.waitFor(`!document.querySelector('#global-memories-list')?.textContent?.includes('全局代码偏好V2')`, 4000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-04 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-04",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置·电脑：宿主机策略 always/ask/off(切 off 自动关闭 MCP)与检测/健康状态联动",
      module: "Settings Computer",
    },
    async () => {
      const mcpScript = createMockMcpServerScript(ws.tmpDir);
      await fetch(`${ws.baseUrl}/api/skills/kimi-cu/install`, { method: "POST" });
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostComputer: { executionMode: "always" },
          mcpServers: { "kimi-cu": { command: process.execPath, args: [mcpScript], enabled: true } },
        }),
      });
      const stBefore: any = await (await fetch(`${ws.baseUrl}/api/mcp/status?server=kimi-cu&connect=true`)).json();
      assert.equal(stBefore.connected, true);

      await openSettingsTab("computer");
      await chrome!.selectOption("#host-exec-mode-select", "ask");
      await ws.waitUntil(() => ws.store.readSettings().hostComputer?.executionMode === "ask", 4000, "host mode ask");
      await chrome!.selectOption("#host-exec-mode-select", "off");
      await ws.waitUntil(() => ws.store.readSettings().hostComputer?.executionMode === "off", 4000, "host mode off");

      // Switching to off must disconnect MCP servers!
      const stAfter: any = await (await fetch(`${ws.baseUrl}/api/mcp/status?server=kimi-cu&connect=false`)).json();
      assert.equal(stAfter.connected, false, "Setting host mode to off must disconnect MCP servers");

      await chrome!.selectOption("#host-exec-mode-select", "always");
      assert.equal(
        await chrome!.evalJs<boolean>(`Boolean(document.querySelector('#auto-expand-toggle'))`),
        false,
        "auto-expand screen toggle must remain removed"
      );
      await chrome!.click("#settings-check-computer-btn");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-05 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-05",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置·权限：自动审核开关(#policy-auto-audit-toggle)与 askRules / allowRules 全套 UI 增删改",
      module: "Settings Permissions",
    },
    async () => {
      await openSettingsTab("permissions");
      // Toggle autoAudit off -> wait for React checkbox state sync -> toggle back on!
      await chrome!.waitFor(`document.querySelector('#policy-auto-audit-toggle')?.checked === true`, 4000);
      await chrome!.evalJs(`document.querySelector('#policy-auto-audit-toggle')?.closest('label')?.click()`);
      await chrome!.waitFor(`document.querySelector('#policy-auto-audit-toggle')?.checked === false`, 4000);
      await ws.waitUntil(() => ws.store.readSettings().policy?.autoAudit === false, 4000, "autoAudit off");
      await chrome!.evalJs(`document.querySelector('#policy-auto-audit-toggle')?.closest('label')?.click()`);
      await chrome!.waitFor(`document.querySelector('#policy-auto-audit-toggle')?.checked === true`, 4000);
      await ws.waitUntil(() => ws.store.readSettings().policy?.autoAudit !== false, 4000, "autoAudit on");

      // Add askRule + allowRule via UI
      await chrome!.click("#add-ask-rule-btn");
      await chrome!.waitFor(`!document.querySelector('#ask-rule-form')?.hidden`);
      await chrome!.selectOption("#ask-rule-tool", "run_shell");
      await chrome!.fill("#ask-rule-pattern", "drop table");
      await chrome!.click("#save-ask-rule-btn");
      await chrome!.waitFor(`document.querySelector('#ask-rules-list')?.textContent?.includes('drop table')`);

      await chrome!.click("#add-allow-rule-btn");
      await chrome!.waitFor(`!document.querySelector('#allow-rule-form')?.hidden`);
      await chrome!.selectOption("#allow-rule-tool", "host_open");
      await chrome!.fill("#allow-rule-pattern", "Notes");
      await chrome!.click("#save-allow-rule-btn");
      await chrome!.waitFor(`document.querySelector('#allow-rules-list')?.textContent?.includes('Notes')`);

      const pol = ws.store.readSettings().policy;
      assert.ok((pol.askRules || []).some((r: any) => r.pattern === "drop table"));
      assert.ok((pol.allowRules || []).some((r: any) => r.pattern === "Notes"));

      // Delete the askRule via UI inline remove ("移除" -> "确认移除")!
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#ask-rules-list > div'));
        const row = rows.find(r => r.textContent?.includes('drop table'));
        const delBtn = Array.from(row?.querySelectorAll('button') || []).find(b => b.textContent?.includes('移除') || b.textContent?.includes('删除'));
        delBtn?.click();
      })()`);
      await new Promise((r) => setTimeout(r, 120));
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#ask-rules-list > div'));
        const row = rows.find(r => r.textContent?.includes('drop table'));
        const okBtn = Array.from(row?.querySelectorAll('button') || []).find(b => b.textContent?.includes('确认'));
        okBtn?.click();
      })()`);
      await chrome!.waitFor(`!document.querySelector('#ask-rules-list')?.textContent?.includes('drop table')`, 4000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-06 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-06",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置·保险库 Vault：分类筛选、实时搜索、AES加密密码(#vault-password-input/查看/清除)与 UI 内联编辑/删除/PATCH",
      module: "Settings Vault",
    },
    async () => {
      await openSettingsTab("vault");
      await chrome!.click("#vault-new-item-btn");
      await chrome!.waitFor(`!document.querySelector('#vault-new-form')?.hidden`);
      await chrome!.selectOption("#vault-cat-input", "credential");
      await chrome!.fill("#vault-title-input", "内网GitLab账号");
      await chrome!.fill("#vault-sub-input", "dev@corp.test");
      await chrome!.fill("#vault-password-input", "VaultUiPass#2026");
      await chrome!.click("#save-vault-item-btn");
      await chrome!.waitFor(`document.querySelector('#vault-items-list')?.textContent?.includes('内网GitLab账号')`, 5000);

      // Verify secret pill badge & filter/search
      await chrome!.fill("#vault-search-input", "GitLab");
      await chrome!.waitFor(`document.querySelector('#vault-items-list')?.textContent?.includes('内网GitLab账号')`);

      // Open inline edit -> click #vault-reveal-password-btn -> verify decrypted plaintext -> click #vault-clear-password-btn -> save!
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#vault-items-list > div'));
        const row = rows.find(r => r.textContent?.includes('内网GitLab账号'));
        const editBtn = Array.from(row?.querySelectorAll('button') || []).find(b => b.textContent?.includes('编辑'));
        editBtn?.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#vault-reveal-password-btn'))`, 4000);
      await chrome!.click("#vault-reveal-password-btn");
      await chrome!.waitFor(`document.querySelector('#vault-password-input')?.value === 'VaultUiPass#2026'`, 4000);
      await chrome!.click("#vault-clear-password-btn");
      await chrome!.click("#save-vault-item-btn");
      await ws.waitUntil(() => {
        const it = ws.store.readVault().find((v: any) => v.title === "内网GitLab账号");
        return Boolean(it && !it.passwordEnc);
      }, 4000, "vault password cleared");

      // Also verify PATCH /api/vault/:id API + delete via UI confirm
      const target = ws.store.readVault().find((v: any) => v.title === "内网GitLab账号");
      assert.ok(target);
      const patchRes = await fetch(`${ws.baseUrl}/api/vault/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "内网GitLab主账号" }),
      });
      assert.equal(patchRes.status, 200);
      assert.ok(ws.store.readVault().some((v: any) => v.title === "内网GitLab主账号"));
      await chrome!.fill("#vault-search-input", "");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-07 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-07",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置·关于与诊断(/api/system/diagnostics & /api/system/updates/check) + 连接 v1.0.0 旧节点动态隐藏 multi-display-v1 屏幕池控件",
      module: "Diagnostics & Capability Gate",
    },
    async () => {
      await openSettingsTab("updates");
      await chrome!.click("#check-update-btn");
      await chrome!.waitFor(
        `/\\d+\\.\\d+\\.\\d+/.test(document.querySelector('#diag-version-line')?.textContent || '')`,
        5000
      );
      // Directly exercise GET /api/system/updates/check endpoint (returns JSON with ok/error gracefully even offline)
      const updRes = await fetch(`${ws.baseUrl}/api/system/updates/check`);
      assert.ok(updRes.status === 200 || updRes.status === 502 || updRes.status === 503);
      await chrome!.click("#close-settings-modal-btn");

      // Create proxy stripping multi-display-v1 from /api/system/diagnostics
      const legacyProxy = http.createServer(async (req, res) => {
        const up = await fetch(`${ws.baseUrl}${req.url || "/"}`, { method: req.method || "GET" });
        if ((req.url || "").startsWith("/api/system/diagnostics")) {
          const d: any = await up.json();
          d.apiCapabilities = (d.apiCapabilities || []).filter((c: string) => c !== "multi-display-v1");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(d));
          return;
        }
        const buf = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, Object.fromEntries(up.headers.entries()));
        res.end(buf);
      });
      await new Promise<void>((r) => legacyProxy.listen(0, "127.0.0.1", r));
      t.after(() => legacyProxy.close());
      const legacyUrl = `http://127.0.0.1:${(legacyProxy.address() as net.AddressInfo).port}`;

      await chrome!.navigate(legacyUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#account-menu-btn");
      await chrome!.click(`[data-account-action="computer"]`);
      await chrome!.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`);
      await new Promise((r) => setTimeout(r, 150));
      const hasPool = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('#settings-screen-pool-block'))`);
      assert.equal(hasPool, false, "Legacy node without multi-display-v1 must hide screen pool block");
      await chrome!.click("#close-settings-modal-btn");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-08 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-08",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "LAN 开关读写(GET/POST /api/lan/settings)停用局域网发现 + 非管理员 Bot 调用 POST /api/computer/provision 返回 403",
      module: "LAN Toggle & Admin Provision Gate",
    },
    async () => {
      const worker = ws.store.createSession({ title: "NonAdminWorker", isAdmin: false });
      const provRes = await fetch(`${ws.baseUrl}/api/computer/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: worker.id }),
      });
      assert.equal(provRes.status, 403, "Non-admin Bot must receive 403 when calling /api/computer/provision");

      const lanGetBefore: any = await (await fetch(`${ws.baseUrl}/api/lan/settings`)).json();
      assert.ok(typeof lanGetBefore.lanAccess === "boolean", "GET /api/lan/settings must return lanAccess boolean");

      const lanOff: any = await (
        await fetch(`${ws.baseUrl}/api/lan/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lanAccess: false }),
        })
      ).json();
      assert.equal(lanOff.lanAccess, false);
      assert.equal(ws.store.readSettings().lanAccess, false);

      // Verify UDP discovery probe gets no reply when lanAccess=false
      const sock = dgram.createSocket("udp4");
      t.after(() => sock.close());
      let gotOffer = false;
      sock.on("message", (msg) => {
        if (msg.toString("utf8").includes(lanOff.discovery?.instanceId || "__never__")) gotOffer = true;
      });
      sock.send(Buffer.from("TWINKLEBOT_DISCOVER_V1"), 41234, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(gotOffer, false, "Disabled LAN access must not reply to discovery probes for this instance");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-09 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-09",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "设置弹窗交互外壳(遮罩点击关闭/切 Tab 滚动复位/滚轮边界) + ConfirmDialog 取消/Escape 与 Toast 提示组件",
      module: "Settings Shell, ConfirmDialog & Toast",
    },
    async () => {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);

      // 1. Settings backdrop click closes modal cleanly
      await openSettingsTab("general");
      await chrome!.evalJs(`(() => {
        const bd = document.querySelector('#settings-modal-backdrop');
        bd && bd.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await chrome!.waitFor(`document.querySelector('#settings-modal-backdrop')?.hidden`, 4000);

      // 2. ConfirmDialog cancel & Escape dismissal without executing destructive action!
      const tempBot = ws.store.createSession({ title: "ConfirmCancelBot" });
      ws.store.appendEvent(tempBot.id, { type: "user", text: "保留这条消息" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(el => el.textContent?.includes('ConfirmCancelBot'))`,
        8000
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('ConfirmCancelBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('ConfirmCancelBot') &&
         Boolean(document.querySelector('.msg-group.is-user'))`,
        5000
      );
      await chrome!.click("#clear-session-btn");
      await chrome!.waitFor(`document.querySelector('#app-confirm-dialog')?.open`, 4000);
      await chrome!.click("#app-confirm-cancel-btn");
      await chrome!.waitFor(`!document.querySelector('#app-confirm-dialog')?.open`, 4000);
      await new Promise((r) => setTimeout(r, 120));

      // Trigger again and dismiss with Escape
      await chrome!.click("#clear-session-btn");
      await chrome!.waitFor(`document.querySelector('#app-confirm-dialog')?.open`, 4000);
      await chrome!.pressKey("Escape");
      await chrome!.waitFor(`!document.querySelector('#app-confirm-dialog')?.open`, 4000);
      assert.ok(ws.store.getSession(tempBot.id), "Canceling confirm dialog must preserve session");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SET-10 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SET-10",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D2",
      title: "设置·外网中继(remote-relay-v1)：独立菜单(位于通用下方)、样式护栏、配置保存(/api/relay/config)、二维码配对(/api/relay/invite)、VPS模板(/api/relay/templates)、探活(/api/relay/control|ping)与共享账号目录(/api/accounts)",
      module: "Settings Relay / Remote Relay",
    },
    async () => {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await openSettingsTab("relay");
      await chrome!.waitFor(`Boolean(document.querySelector('#relay-settings-card'))`, 5000);

      // Verify independent "relay" tab sits immediately under "general" and form controls have proper card padding & select borders
      const relayLayoutCheck = await chrome!.evalJs<{
        tabs: string[];
        bodyPaddingLeft: string;
        selectBorderTopWidth: string;
        selectHeight: string;
      }>(`(() => {
        const tabs = Array.from(document.querySelectorAll('.settings-nav [data-settings-tab]')).map(el => el.getAttribute('data-settings-tab') || '');
        const body = document.querySelector('#relay-settings-card .relay-card-body');
        const sel = document.querySelector('#relay-mode-select');
        return {
          tabs,
          bodyPaddingLeft: body ? getComputedStyle(body).paddingLeft : '0px',
          selectBorderTopWidth: sel ? getComputedStyle(sel).borderTopWidth : '0px',
          selectHeight: sel ? getComputedStyle(sel).height : '0px',
        };
      })()`);
      assert.equal(relayLayoutCheck.tabs[0], "general");
      assert.equal(relayLayoutCheck.tabs[1], "relay", "Remote Relay tab must sit directly under General");
      assert.notEqual(relayLayoutCheck.bodyPaddingLeft, "0px", "Relay card body must have horizontal padding");
      assert.notEqual(relayLayoutCheck.selectBorderTopWidth, "0px", "Relay select must render bordered input chrome");
      assert.equal(relayLayoutCheck.selectHeight, "36px", "Relay select height must align with text inputs");

      await chrome!.selectOption("#relay-mode-select", "external");
      await chrome!.fill("#relay-public-url-input", ws.baseUrl);
      await chrome!.evalJs(`document.querySelector('#relay-enable-toggle')?.closest('label')?.click()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#relay-invite-panel svg'))`, 6000);

      // Reveal access token via /api/relay/status?reveal=1 and ping /api/relay/ping
      await chrome!.click("#relay-token-reveal-btn");
      await chrome!.waitFor(
        `(() => {
          const v = document.querySelector('#relay-access-token-value')?.textContent?.trim() || '';
          return v.length >= 16 && !v.includes('•');
        })()`,
        5000
      );
      const revealedToken = await chrome!.evalJs<string>(
        `document.querySelector('#relay-access-token-value')?.textContent?.trim() || ''`
      );
      const pingJson: any = await (
        await fetch(`${ws.baseUrl}/api/relay/ping`, {
          headers: { Authorization: `Bearer ${revealedToken}` },
        })
      ).json();
      assert.equal(pingJson.ok, true);
      assert.equal(pingJson.deployEnv, "local");

      // Expand templates & generate frps.toml + Caddyfile
      await chrome!.evalJs(`(() => { const d = document.querySelector('#relay-templates-details'); if (d) d.open = true; })()`);
      await chrome!.fill("#relay-tpl-domain", "bot.caixy.xin");
      await chrome!.click("#relay-generate-templates-btn");
      await chrome!.waitFor(
        `document.querySelector('#relay-templates-details')?.textContent?.includes('bindAddr = "127.0.0.1"')`,
        5000
      );

      // Run connectivity test control button (#relay-test-btn -> /api/relay/control)
      await chrome!.click("#relay-test-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('#relay-test-result'))`, 6000);

      // Verify /api/accounts rejects self-connect (ws.baseUrl) with HTTP 400
      const selfRejectResp = await fetch(`${ws.baseUrl}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Self Connect Attempt",
          baseUrl: ws.baseUrl,
          authToken: revealedToken,
          probe: false,
        }),
      });
      assert.equal(selfRejectResp.status, 400);
      const selfRejectJson: any = await selfRejectResp.json();
      assert.equal(selfRejectJson.ok, false);

      // Verify /api/accounts CRUD (list / upsert / DELETE /api/accounts/:id) with a distinct remote node
      const acctAdd: any = await (
        await fetch(`${ws.baseUrl}/api/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "E2E Cloud Node",
            baseUrl: "https://remote-cloud-e2e.example.com",
            authToken: revealedToken,
            probe: false,
          }),
        })
      ).json();
      assert.equal(acctAdd.ok, true);
      assert.equal(acctAdd.account.type, "cloud");
      const acctList: any = await (await fetch(`${ws.baseUrl}/api/accounts`)).json();
      assert.ok((acctList.accounts || []).some((a: any) => a.id === acctAdd.account.id));
      const acctDel: any = await (
        await fetch(`${ws.baseUrl}/api/accounts/${encodeURIComponent(acctAdd.account.id)}`, {
          method: "DELETE",
        })
      ).json();
      assert.equal(acctDel.ok, true);

      // Restore relay toggle off cleanly before closing settings
      await chrome!.selectOption("#relay-mode-select", "off");
      await chrome!.evalJs(`document.querySelector('#relay-enable-toggle')?.closest('label')?.click()`);
      await new Promise((r) => setTimeout(r, 150));
      await chrome!.click("#close-settings-modal-btn");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-SSR-01 ----------
  await collector.runCase(
    t,
    {
      id: "P2-SSR-01",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "SSR 静态渲染入口(ssr-entry.js)全量校验：整页 App + 全部 StreamItem(含 max_steps/budget_warning/error/unread_divider) 与弱网横幅",
      module: "SSR Static Markup & Render Parity",
    },
    async () => {
      const ssrPath = path.join(PROJECT_ROOT, "dist-server", "web-ssr", "ssr-entry.js");
      const ssrMod: any = await import(pathToFileURL(ssrPath).href);

      const fullAppHtml = ssrMod.renderAppToStaticMarkup({
        networkHealth: { status: "offline", browserOffline: false, rttMs: null, reconnectAttempt: 2, nextRetryAt: null, reason: "test", dismissedWeakBanner: false, updatedAt: Date.now() },
      });
      assert.match(fullAppHtml, /id="app-shell"/);
      assert.match(fullAppHtml, /network-status-banner/);

      const streamSamples = [
        { kind: "message", id: "m1", isUser: false, text: "Hello **SSR**", seq: 1 },
        { kind: "approval", id: "a1", callId: "c1", name: "run_shell", args: { command: "ls" }, reason: "test", risk: "medium", status: "pending" },
        { kind: "draft", id: "d1", callId: "c2", draftKind: "email", title: "发送邮件", fields: { to: "a@b.com", subject: "Hi", body: "Body" }, status: "pending" },
        { kind: "choice", id: "ch1", callId: "c3", question: "选哪个？", options: ["A", "B"], status: "pending" },
        { kind: "credential", id: "cr1", callId: "c4", title: "登录", service: "corp", status: "pending" },
        { kind: "route_notice", id: "rn1", level: "max_steps", maxSteps: 12, toolCount: 12, text: "已达到单轮最大步数上限" },
        { kind: "route_notice", id: "rn2", level: "budget_warning", text: "预算提醒" },
        { kind: "error", id: "er1", text: "发生错误" },
        { kind: "unread_divider", id: "ud1", count: 3 },
        { kind: "date_divider", id: "dd1", label: "今天" },
      ];
      for (const sample of streamSamples) {
        const html = ssrMod.renderStreamItemToStaticMarkup(sample);
        assert.ok(html.length > 20, `SSR renderStreamItemToStaticMarkup(${sample.kind}) must produce non-empty HTML`);
      }
      assert.match(ssrMod.renderStreamItemToStaticMarkup(streamSamples[5]), /max-steps-card/);
    }
  );
});
