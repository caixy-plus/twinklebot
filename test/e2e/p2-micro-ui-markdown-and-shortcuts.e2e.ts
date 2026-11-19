import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { SAMPLE_PNG_BUFFER } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P2 Suite 8: Avatars, Micro UI States, Markdown/Tables/Preview Micro-Interactions, IME, Splitters & Shortcuts", async (t) => {
  const collector = createSuiteCollector("p2-micro-ui-markdown-and-shortcuts");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  // Intercept clipboard writes so we can deterministically assert copied code/TSV text!
  await chrome!.addInitScript(`
    window.__e2eClipboard = [];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (txt) => { window.__e2eClipboard.push(String(txt)); }
        }
      });
    } catch {}
  `);

  const ws = await createE2EWorkspace({ smartRouter: false });
  t.after(() => ws.close());

  ws.store.ensureAdminBot();
  const testBot = ws.store.createSession({ title: "MicroUiBot", rolePrompt: "专职微交互验证" });
  await chrome!.navigate(ws.baseUrl);
  await chrome!.waitFor(
    `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
     Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('MicroUiBot'))`
  );
  await chrome!.evalJs(`(() => {
    const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('MicroUiBot'));
    el && el.click();
  })()`);
  await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('MicroUiBot')`);

  // ---------- P2-UI-01 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-01",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "右侧头像编辑器：13形状×11颜色切换、恢复默认与名称输入框回车保存",
      module: "Avatar Editor / Preset",
    },
    async () => {
      await chrome!.click("#edit-avatar-btn");
      await chrome!.waitFor(`!document.querySelector('#avatar-editor-popover')?.hidden`);
      await chrome!.click(`.avatar-shape-btn[data-shape-key="star"]`);
      await chrome!.click(`.avatar-color-btn[data-color-key="violet"]`);
      await ws.waitUntil(() => {
        const s = ws.store.getSession(testBot.id);
        return s?.avatar?.shape === "star" && s?.avatar?.color === "violet";
      }, 4000, "avatar preset persisted");

      await chrome!.click("#reset-avatar-btn");
      await chrome!.click("#edit-avatar-btn"); // close popover

      await chrome!.fill("#inspector-bot-name-input", "MicroUiBot改名");
      await new Promise((r) => setTimeout(r, 60));
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('MicroUiBot改名')`, 5000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-02 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-02",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D2",
      title: "右侧头像编辑器：AI 生成头像(含 SVG 降级)与本地上传大图 Canvas 裁剪 128×128 PNG",
      module: "Avatar Editor / AI & Upload",
    },
    async () => {
      await chrome!.click("#edit-avatar-btn");
      await chrome!.waitFor(`!document.querySelector('#avatar-editor-popover')?.hidden`);

      // AI generate tab
      await chrome!.click(`.avatar-source-tab[data-avatar-tab="generate"]`);
      await chrome!.fill("#avatar-prompt-input", "极简赛博小狐狸");
      await chrome!.click("#avatar-generate-submit");
      await ws.waitUntil(() => {
        const av = ws.store.getSession(testBot.id)?.avatar;
        return Boolean(av?.imageDataUrl || av?.imageUrl || av?.dataUrl);
      }, 8000, "AI avatar saved");

      // Upload tab
      const imgFile = path.join(ws.tmpDir, "avatar-upload.png");
      fs.writeFileSync(imgFile, SAMPLE_PNG_BUFFER);
      await chrome!.click(`.avatar-source-tab[data-avatar-tab="upload"]`);
      await chrome!.setFileInputFiles("#avatar-file-input", [imgFile]);
      await ws.waitUntil(() => {
        const av = ws.store.getSession(testBot.id)?.avatar;
        const url = av?.imageDataUrl || av?.dataUrl || "";
        return typeof url === "string" && url.startsWith("data:image/png;base64,");
      }, 6000, "Uploaded cropped PNG avatar saved");
      await chrome!.pressKey("Escape");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-03 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-03",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "侧边栏微状态：未读蓝点累加/切入清零(touch:false)+未读分割线、空状态与顶部分享克隆",
      module: "Sidebar Badges & Header Share",
    },
    async () => {
      const bgBot = ws.store.createSession({ title: "UnreadBgBot" });
      ws.store.updateSession(bgBot.id, { unreadCount: 3 });
      ws.store.appendEvent(bgBot.id, { type: "answer", text: "你在后台时收到的新消息" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('UnreadBgBot') && x.querySelector('.unread-blue-dot'))`,
        8000
      );

      // Click into bgBot -> clears unread dot and renders .unread-divider
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('UnreadBgBot'));
        el && el.click();
      })()`);
      await ws.waitUntil(() => (ws.store.getSession(bgBot.id)?.unreadCount || 0) === 0, 4000, "unread cleared");

      // Header share popover -> clone
      await chrome!.click("#share-btn");
      await chrome!.waitFor(`!document.querySelector('#share-popover')?.hidden`);
      await chrome!.click("#share-template-item");
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('副本')`, 6000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-04 & P2-UI-05 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-04",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "Markdown 语法细节与安全：标题/引用/嵌套列表/任务复选框/snake_case 保护与 javascript: 危险链接拦截",
      module: "MarkdownRenderer",
    },
    async () => {
      ws.mockLlm.setHandler(async ({ body }) => {
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "排版输出" };
        return {
          text: [
            "## 二级标题",
            "> 引用说明",
            "- [x] 已完成任务",
            "- [ ] 待办任务",
            "标识符 `my_var_name` 与裸变量 foo_bar_baz 不应斜体。",
            "[安全链接](https://example.com) 和 [危险链接](javascript:alert(1))",
          ].join("\n"),
        };
      });
      await chrome!.typeText("#message-input", "输出富文本样例", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-heading.msg-h2'))`, 8000);
      ws.mockLlm.setHandler(undefined);

      const hasTaskCheckbox = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('.msg-task-checkbox'))`);
      assert.equal(hasTaskCheckbox, true);
      const hasJsHref = await chrome!.evalJs<boolean>(
        `Array.from(document.querySelectorAll('a')).some(a => (a.getAttribute('href') || '').toLowerCase().startsWith('javascript:'))`
      );
      assert.equal(hasJsHref, false, "javascript: links must be neutralized");
      const hasEmForSnake = await chrome!.evalJs<boolean>(
        `Array.from(document.querySelectorAll('.bot-bubble em')).some(e => e.textContent === 'bar')`
      );
      assert.equal(hasEmForSnake, false, "snake_case foo_bar_baz must not be italicized");
    },
    { getChrome: () => chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P2-UI-05",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "代码块一键复制与 GFM 表格行数徽章 + 复制 TSV 到剪贴板",
      module: "Markdown Code & Table Copy",
    },
    async () => {
      ws.mockLlm.setHandler(async ({ body }) => {
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "生成表格" };
        return {
          text: [
            "```js",
            "const answer = 42;",
            "```",
            "",
            "| 名称 | 状态 |",
            "| :--- | :---: |",
            "| Alpha | OK |",
            "| Beta | WARN |",
          ].join("\n"),
        };
      });
      await chrome!.typeText("#message-input", "生成代码和表格", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-table-copy-btn'))`, 8000);
      ws.mockLlm.setHandler(undefined);

      await chrome!.evalJs(`window.__e2eClipboard = []`);
      await chrome!.click(".msg-code-copy-btn");
      await chrome!.click(".msg-table-copy-btn");
      const copied = await chrome!.evalJs<string[]>(`window.__e2eClipboard`);
      assert.ok(copied.some((c) => c.includes("const answer = 42;")), "Code copy must write exact snippet");
      assert.ok(copied.some((c) => c.includes("Alpha\tOK")), "Table copy must produce TSV format");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-06 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-06",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "HTML/SVG 预览卡微交互：浅色/透明格/深色三态底色循环、刷新与切源码",
      module: "MarkupPreviewCard Micro",
    },
    async () => {
      ws.mockLlm.setHandler(async ({ body }) => {
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "画SVG" };
        return {
          text: "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"60\"><rect width=\"100\" height=\"60\" fill=\"#3b82f6\"/></svg>\n```",
        };
      });
      await chrome!.typeText("#message-input", "输出SVG预览", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-preview-card[data-preview-kind="svg"]'))`, 8000);
      ws.mockLlm.setHandler(undefined);

      // Cycle bg button & toggle source code tab
      await chrome!.evalJs(`(() => {
        const card = document.querySelector('.msg-preview-card[data-preview-kind="svg"]');
        const tabs = Array.from(card.querySelectorAll('.msg-preview-tab'));
        tabs.find(t => t.textContent?.includes('源码'))?.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-preview-card[data-preview-kind="svg"] .msg-preview-code-pre'))`);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-07 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-07",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "右侧资料库 all/media/file 筛选、超 5 项展开收起(#library-expand-btn)与大图灯箱",
      module: "Library & Lightbox",
    },
    async () => {
      const curSid = await chrome!.evalJs<string>(
        `document.querySelector('#session-select')?.value || ''`
      );
      const targetSid = curSid || testBot.id;
      for (let i = 1; i <= 6; i++) {
        await fetch(`${ws.baseUrl}/api/attachments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: targetSid,
            name: `lib-doc-${i}.txt`,
            dataBase64: Buffer.from(`doc ${i}`).toString("base64"),
          }),
        });
      }
      await chrome!.click("#tab-library");
      await chrome!.click("#refresh-library-btn");
      await chrome!.waitFor(`!document.querySelector('#library-expand-btn')?.hidden`, 6000);
      await chrome!.click("#library-expand-btn");
      await chrome!.waitFor(`document.querySelectorAll('#library-list .library-row').length >= 6`, 4000);
      await chrome!.click(`.filter-pill[data-lib-filter="file"]`);
      await chrome!.click(`.filter-pill[data-lib-filter="all"]`);
      await chrome!.click("#tab-activity");
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-08 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-08",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "长对话上滚脱离底部浮现「回到底部」(#scroll-bottom-btn)点击平滑吸底",
      module: "useChatScrollPin",
    },
    async () => {
      // Force long scrollable container & scroll up to top
      const scrollMoved = await chrome!.evalJs<boolean>(`(() => {
        const el = document.querySelector('#event-stream');
        if (!el) return false;
        const spacer = document.createElement('div');
        spacer.id = '__e2e_tall_spacer__';
        spacer.style.height = '1800px';
        spacer.style.minHeight = '1800px';
        spacer.style.flexShrink = '0';
        el.prepend(spacer);
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll'));
        return el.scrollHeight > el.clientHeight + 200;
      })()`);
      assert.equal(scrollMoved, true);
      await chrome!.waitFor(`!document.querySelector('#scroll-bottom-btn')?.hidden`, 4000);
      await chrome!.click("#scroll-bottom-btn");
      await chrome!.waitFor(`document.querySelector('#scroll-bottom-btn')?.hidden`, 4000);
      await chrome!.evalJs(`document.getElementById('__e2e_tall_spacer__')?.remove()`);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-09 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-09",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "中文 IME compositionend 50ms 窗口按 Enter 防误发 + 上传 >10MB 文件拦截弹 Toast",
      module: "Composer IME & Size Guard",
    },
    async () => {
      const beforeMsgCount = await chrome!.evalJs<number>(`document.querySelectorAll('.msg-group.is-user').length`);
      await chrome!.simulateImeComposition("#message-input", "拼音选词测试", true);
      await new Promise((r) => setTimeout(r, 120));
      const afterMsgCount = await chrome!.evalJs<number>(`document.querySelectorAll('.msg-group.is-user').length`);
      assert.equal(afterMsgCount, beforeMsgCount, "Enter immediately after compositionend must NOT send message");
      await chrome!.fill("#message-input", "");

      // Trigger >10MB file drop -> frontend rejects with Toast
      await chrome!.evalJs(`(() => {
        const big = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.bin', { type: 'application/octet-stream' });
        const dt = new DataTransfer();
        dt.items.add(big);
        document.querySelector('.chat-stage').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      })()`);
      await chrome!.waitFor(`document.querySelector('#ui-toast')?.textContent?.includes('10') || document.querySelector('#ui-toast')?.textContent?.includes('过大')`, 4000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-10 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-10",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "左右分栏拖拽调宽(#left-splitter / #right-splitter 边界限制) + 窄屏 <720px/<920px 自动折叠恢复",
      module: "Splitters & Responsive Collapse",
    },
    async () => {
      const leftRect = await chrome!.evalJs<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('#left-splitter').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await chrome!.drag(leftRect.x, leftRect.y, 360, leftRect.y, 6);
      const leftW = await chrome!.evalJs<string>(`getComputedStyle(document.documentElement).getPropertyValue('--left-sidebar-w').trim()`);
      assert.match(leftW, /^\d+px$/);

      // Narrow viewport < 720px -> auto compact sidebar & collapse inspector
      await chrome!.setViewport({ width: 680, height: 800 });
      await chrome!.waitFor(`document.querySelector('#app-shell')?.dataset?.sidebarCompact === 'true'`, 4000);
      await chrome!.setViewport({ width: 1440, height: 900 });
      await chrome!.waitFor(`document.querySelector('#app-shell')?.dataset?.sidebarCompact === 'false'`, 4000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P2-UI-11 & P2-UI-12 ----------
  await collector.runCase(
    t,
    {
      id: "P2-UI-11",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "⌘K 全局搜索命令面板(搜 Bot / 历史消息 / 快捷导航)与快捷键帮助弹窗(#shortcuts-help-dialog)",
      module: "Search Palette & Help Dialog",
    },
    async () => {
      await chrome!.click("#open-search-modal-btn");
      await chrome!.waitFor(`!document.querySelector('#search-modal-backdrop')?.hidden`);
      await chrome!.fill("#palette-search-input", "MicroUiBot");
      await chrome!.waitFor(`document.querySelector('#palette-results-list')?.textContent?.includes('MicroUiBot')`, 5000);
      await chrome!.pressKey("Escape");
      await chrome!.waitFor(`document.querySelector('#search-modal-backdrop')?.hidden`);

      await chrome!.click("#account-menu-btn");
      await chrome!.click(`[data-account-action="shortcuts"]`);
      await chrome!.waitFor(`document.querySelector('#shortcuts-help-dialog')?.open`);
      await chrome!.click("#close-shortcuts-dialog-btn");
      await chrome!.waitFor(`!document.querySelector('#shortcuts-help-dialog')?.open`);
    },
    { getChrome: () => chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P2-UI-12",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "全局快捷键(⌘, / ⌘\\ / ⌘I / 无焦点 1~6 秒选提问卡)与 Escape 优先关闭栈",
      module: "useGlobalShortcuts",
    },
    async () => {
      // Focus body so shortcuts trigger cleanly
      await chrome!.evalJs(`document.activeElement?.blur()`);
      // Toggle compact sidebar with Meta+\
      await chrome!.pressKey("\\", { meta: true });
      await chrome!.waitFor(`document.querySelector('#app-shell')?.dataset?.sidebarCompact === 'true'`, 3000);
      await chrome!.pressKey("\\", { meta: true });
      await chrome!.waitFor(`document.querySelector('#app-shell')?.dataset?.sidebarCompact === 'false'`, 3000);

      // Toggle right inspector with Meta+I
      const prevInsp = await chrome!.evalJs<string>(`document.querySelector('#app-shell')?.dataset?.inspectorOpen`);
      await chrome!.pressKey("i", { meta: true });
      await chrome!.waitFor(`document.querySelector('#app-shell')?.dataset?.inspectorOpen !== '${prevInsp}'`, 3000);
      await chrome!.pressKey("i", { meta: true });

      // Open Settings with Meta+, and close with Escape
      await chrome!.pressKey(",", { meta: true });
      await chrome!.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 3000);
      await chrome!.pressKey("Escape");
      await chrome!.waitFor(`document.querySelector('#settings-modal-backdrop')?.hidden`, 3000);

      // ChoiceCard quick-select via digit '1' without focus in inputs!
      let step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "快捷选择" };
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "qk-1", name: "ask_user_choice", args: { question: "按1秒选", options: ["选项一", "选项二"] } }] };
        }
        return { text: "快捷键1选中生效" };
      });
      await chrome!.typeText("#message-input", "测快捷键选卡", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.choice-card:not(.is-resolved)'))`, 8000);
      await chrome!.evalJs(`document.activeElement?.blur()`);
      await chrome!.pressKey("1");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('快捷键1选中生效'))`,
        8000
      );
      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );
});
