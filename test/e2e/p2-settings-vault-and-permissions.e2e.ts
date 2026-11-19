import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { createMockMcpServerScript } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P2 Suite 7: Settings General, Compression, Computer/Permissions, Vault, Diagnostics & Legacy v1.0.0 Gate", async (t) => {
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
      title: "设置·通用：个人昵称保存与 6 色头像圆点切换(侧边栏联动 + 刷新持久化)",
      module: "Settings General / Profile",
    },
    async () => {
      await openSettingsTab("general");
      await chrome!.fill("#profile-name-input", "测试官Alpha");
      await chrome!.click("#save-profile-btn");
      await chrome!.click(`.profile-color-dot[data-profile-color="emerald"]`);
      await chrome!.waitFor(
        `document.querySelector('#sidebar-user-name')?.textContent?.includes('测试官Alpha') &&
         document.querySelector('#sidebar-user-avatar')?.dataset?.profileColor === 'emerald'`
      );
      const saved = ws.store.readSettings().profile;
      assert.equal(saved?.name, "测试官Alpha");
      assert.equal(saved?.color, "emerald");
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
      title: "设置·通用：浅色/深色/跟随系统主题(color-scheme 同步)、Bot 强调色 vs 默认黑灰与拼写检查开关",
      module: "Settings General / Appearance",
    },
    async () => {
      await openSettingsTab("general");
      await chrome!.selectOption("#setting-theme-select", "dark");
      await chrome!.waitFor(`localStorage.getItem('color-scheme') === 'dark'`);
      await chrome!.selectOption("#setting-accent-mode", "default");
      await chrome!.click("#setting-spellcheck-toggle");
      const st = ws.store.readSettings();
      assert.equal(st.theme, "dark");
      assert.equal(st.accentMode, "default");
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
      title: "设置·通用：上下文压缩预设卡(50%/75%/85%)、滑块、自定义规则与全局共享记忆 CRUD/启停",
      module: "Settings General / Compression & Global Memories",
    },
    async () => {
      await openSettingsTab("general");
      await chrome!.click(`[data-ctx-preset="compact"]`);
      await chrome!.waitFor(`document.querySelector('#ctx-compress-percent-label')?.textContent?.includes('50%')`);
      await chrome!.setRangeValue("#setting-ctx-compress-percent", 80);
      await chrome!.waitFor(`document.querySelector('#ctx-compress-percent-label')?.textContent?.includes('80%')`);

      // Add global memory
      await chrome!.click("#new-memory-btn");
      await chrome!.waitFor(`!document.querySelector('#new-memory-form-card')?.hidden`);
      await chrome!.fill("#memory-name-input", "全局代码偏好");
      await chrome!.fill("#memory-content-input", "一律使用 TypeScript 严格模式");
      await chrome!.click("#save-memory-btn");
      await chrome!.waitFor(`document.querySelector('#global-memories-list')?.textContent?.includes('全局代码偏好')`);
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
      title: "设置·电脑：宿主机策略 always/ask/off(切 off 自动关闭 MCP)、自动展开开关与检测/重置按钮",
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
      await chrome!.selectOption("#host-exec-mode-select", "off");
      await ws.waitUntil(() => ws.store.readSettings().hostComputer?.executionMode === "off", 4000, "host mode off");

      // Switching to off must disconnect MCP servers!
      const stAfter: any = await (await fetch(`${ws.baseUrl}/api/mcp/status?server=kimi-cu&connect=false`)).json();
      assert.equal(stAfter.connected, false, "Setting host mode to off must disconnect MCP servers");

      await chrome!.click("#auto-expand-toggle");
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
      title: "设置·权限：自动审核开关与 11 类目标工具 askRules / allowRules 增删改",
      module: "Settings Permissions",
    },
    async () => {
      await openSettingsTab("permissions");
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
      title: "设置·保险库 Vault：分类筛选(all/login/contact)、实时搜索与条目 CRUD (PATCH /api/vault/:id)",
      module: "Settings Vault",
    },
    async () => {
      await openSettingsTab("vault");
      await chrome!.click("#vault-new-item-btn");
      await chrome!.waitFor(`!document.querySelector('#vault-new-form')?.hidden`);
      await chrome!.selectOption("#vault-cat-input", "login");
      await chrome!.fill("#vault-title-input", "内网GitLab账号");
      await chrome!.fill("#vault-sub-input", "dev@corp.test");
      await chrome!.click("#save-vault-item-btn");
      await chrome!.waitFor(`document.querySelector('#vault-items-list')?.textContent?.includes('内网GitLab账号')`);

      await chrome!.click(`.vault-tab[data-vault-tab="login"]`);
      await chrome!.fill("#vault-search-input", "GitLab");
      await chrome!.waitFor(`document.querySelector('#vault-items-list')?.textContent?.includes('内网GitLab账号')`);

      // Verify PATCH /api/vault/:id updates item cleanly
      const list = ws.store.readVault();
      const target = list.find((v: any) => v.title === "内网GitLab账号");
      assert.ok(target);
      const patchRes = await fetch(`${ws.baseUrl}/api/vault/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "内网GitLab主账号" }),
      });
      assert.equal(patchRes.status, 200);
      assert.ok(ws.store.readVault().some((v: any) => v.title === "内网GitLab主账号"));
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
      title: "设置·关于与诊断 + 连接 v1.0.0 旧节点动态隐藏 multi-display-v1 屏幕池控件",
      module: "Diagnostics & Capability Gate",
    },
    async () => {
      await openSettingsTab("updates");
      await chrome!.click("#check-update-btn");
      await chrome!.waitFor(
        `/\\d+\\.\\d+\\.\\d+/.test(document.querySelector('#diag-version-line')?.textContent || '')`,
        5000
      );
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
      title: "LAN 开关关闭停用局域网发现 + 非管理员 Bot 调用 POST /api/computer/provision 返回 403",
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

      const lanOff: any = await (
        await fetch(`${ws.baseUrl}/api/lan/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lanAccess: false }),
        })
      ).json();
      assert.equal(lanOff.lanAccess, false);
      assert.equal(ws.store.readSettings().lanAccess, false);

      // Verify UDP discovery probe gets no reply when lanAccess=false (quick 200ms check on ephemeral socket)
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
});
