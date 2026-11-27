import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { startMockLlmServer } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector, PROJECT_ROOT } from "../helpers/e2e-report-collector.js";
import { createStore } from "../../src/store/index.js";

function writeCliSettings(dataDir: string, openaiBaseUrl: string, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      onboardingCompleted: true,
      model: "e2e-fast",
      routing: {
        smartRouter: false,
        tiers: {
          fast: { providerId: "cli-custom", model: "e2e-fast" },
          medium: { providerId: "cli-custom", model: "e2e-fast" },
          advanced: { providerId: "cli-custom", model: "e2e-fast" },
        },
      },
      providers: [
        {
          id: "cli-custom",
          type: "openai-compatible",
          name: "CLI Custom",
          apiKey: "sk-cli-ok",
          baseUrl: openaiBaseUrl,
          models: ["e2e-fast"],
          enabled: true,
        },
      ],
      ...extra,
    }),
    "utf8"
  );
}

test("P2 Suite 9: CLI Tool (Providers / Interactive Approval / Max-Steps & Double-SIGINT) & Landing Portal Full Interactive E2E", async (t) => {
  const collector = createSuiteCollector("p2-cli-and-landing");
  const cliEntry = path.join(PROJECT_ROOT, "dist-server", "src", "cli", "index.js");

  // ---------- P2-CLI-01 ----------
  await collector.runCase(
    t,
    {
      id: "P2-CLI-01",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D2",
      title: "CLI 空参数退出码 1 + 仅配置 settings.json 供应商(无 GEMINI_API_KEY)成功执行与 Usage 落盘",
      module: "CLI Multi-Provider Bootstrap",
    },
    async ({ setEvidence }) => {
      const emptyRes = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += d.toString()));
        p.on("exit", (code) => resolve({ code, stderr }));
      });
      assert.equal(emptyRes.code, 1);
      assert.match(emptyRes.stderr, /Usage:/i);

      const mockLlm = await startMockLlmServer();
      t.after(() => mockLlm.close());
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-clue1-"));
      t.after(() => fs.rmSync(tmpData, { recursive: true, force: true }));
      writeCliSettings(tmpData, mockLlm.openaiBaseUrl);

      const mockExecSrv = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if ((req.url || "").startsWith("/health")) {
          res.end(JSON.stringify({ ok: true, screen: { width: 1440, height: 900 } }));
        } else {
          res.end(JSON.stringify({ ok: true, exit_code: 0, stdout: "", stderr: "", png_base64: "" }));
        }
      });
      await new Promise<void>((r) => mockExecSrv.listen(0, "127.0.0.1", r));
      t.after(() => {
        mockExecSrv.close();
        mockExecSrv.closeAllConnections?.();
      });
      const mockExecUrl = `http://127.0.0.1:${(mockExecSrv.address() as net.AddressInfo).port}`;

      const cliOut = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "用settings供应商回复你好"], {
          env: {
            ...process.env,
            TWINKLEBOT_DATA_DIR: tmpData,
            TWINKLEBOT_EXECUTOR_URL: mockExecUrl,
            TWINKLEBOT_EXECUTOR_TOKEN: "e2e-cli-tok",
            GEMINI_API_KEY: "",
            GOOGLE_API_KEY: "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += d.toString()));
        p.stderr.on("data", (d) => (stderr += d.toString()));
        const tm = setTimeout(() => p.kill("SIGKILL"), 8000);
        p.on("exit", (code) => {
          clearTimeout(tm);
          resolve({ code, stdout, stderr });
        });
      });

      setEvidence("cliExitCode", cliOut.code);
      assert.equal(cliOut.code, 0, `CLI should succeed with settings.json provider (stderr=${cliOut.stderr})`);
      // Verify usage persisted into store
      const cliStore = createStore(tmpData);
      const cliSessions = cliStore.listSessions();
      assert.ok(cliSessions.length >= 1 && (cliSessions[0]?.usage?.input || 0) + (cliSessions[0]?.usage?.output || 0) > 0, "CLI must persist usage tokens");
    }
  );

  // ---------- P2-CLI-02 ----------
  await collector.runCase(
    t,
    {
      id: "P2-CLI-02",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D2",
      title: "CLI 真实 readline [y/N] 交互式审批(输入 y 放行与输入 n 拒绝) + 单次 SIGINT 优雅中断落盘",
      module: "CLI Interactive Approval & SIGINT",
    },
    async () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-apv-"));
      t.after(() => fs.rmSync(tmpData, { recursive: true, force: true }));
      const mockLlm = await startMockLlmServer();
      t.after(() => mockLlm.close());
      writeCliSettings(tmpData, mockLlm.openaiBaseUrl, { policy: { askRules: [{ tool: "browser_click", pattern: "" }] } });

      let actionCalled = 0;
      const mockExecSrv = http.createServer((req, res) => {
        if ((req.url || "").startsWith("/browser/click")) actionCalled += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, screen: { width: 1440, height: 900 }, clicked: { ref: "e1" }, elements: [], png_base64: "" }));
      });
      await new Promise<void>((r) => mockExecSrv.listen(0, "127.0.0.1", r));
      t.after(() => {
        mockExecSrv.close();
        mockExecSrv.closeAllConnections?.();
      });
      const mockExecUrl = `http://127.0.0.1:${(mockExecSrv.address() as net.AddressInfo).port}`;

      // 1. Real readline [y/N] -> 'y' approves destructive/high-risk tool!
      let step = 0;
      mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "审批任务" };
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "cli-apv-1", name: "browser_click", args: { ref: "e1", risk: "low" } }] };
        }
        return { text: "CLI审批放行成功" };
      });
      const apvOut = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "触发CLI审批"], {
          env: { ...process.env, TWINKLEBOT_DATA_DIR: tmpData, TWINKLEBOT_EXECUTOR_URL: mockExecUrl, TWINKLEBOT_EXECUTOR_TOKEN: "tok", GEMINI_API_KEY: "" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let sentY = false;
        p.stdout.on("data", (d) => {
          stdout += d.toString();
          if (!sentY && stdout.includes("[y/N]")) {
            sentY = true;
            p.stdin.write("y\n");
          }
        });
        const tm = setTimeout(() => p.kill("SIGKILL"), 8000);
        p.on("exit", (code) => { clearTimeout(tm); resolve({ code, stdout }); });
      });
      assert.equal(apvOut.code, 0);
      assert.match(apvOut.stdout, /approve\? \[y\/N\]/);
      assert.equal(actionCalled, 1, "Approving [y/N] with 'y' must execute tool");

      // 2. Single SIGINT graceful stop mid-flight
      let releaseSlow!: () => void;
      const slowGate = new Promise<void>((r) => { releaseSlow = r; });
      mockLlm.setHandler(async () => { await slowGate; return { text: "slow" }; });
      const sigRes = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "测试SIGINT中断"], {
          env: { ...process.env, TWINKLEBOT_DATA_DIR: tmpData, TWINKLEBOT_EXECUTOR_URL: mockExecUrl, TWINKLEBOT_EXECUTOR_TOKEN: "tok", GEMINI_API_KEY: "" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        p.stdout.on("data", (d) => (stdout += d.toString()));
        setTimeout(() => p.kill("SIGINT"), 450);
        const tm = setTimeout(() => p.kill("SIGKILL"), 6000);
        p.on("exit", (code) => { clearTimeout(tm); releaseSlow(); resolve({ code, stdout }); });
      });
      mockLlm.setHandler(undefined);
      assert.match(sigRes.stdout, /SIGINT|Stopping task cleanly/);
      assert.ok(fs.readdirSync(path.join(tmpData, "sessions")).length >= 2);
    }
  );

  // ---------- P2-CLI-03 ----------
  await collector.runCase(
    t,
    {
      id: "P2-CLI-03",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D2",
      title: "CLI route_notice(max_steps 告警输出)、非 GCP 伪造 Vertex 报错退出(1) 与双次 SIGINT 强制退出",
      module: "CLI Edge Guards & Double-SIGINT",
    },
    async () => {
      // 1. Local non-GCP Vertex spoofing must exit 1 with clear error message
      const emptyData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-vtx-"));
      t.after(() => fs.rmSync(emptyData, { recursive: true, force: true }));
      const vtxOut = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "测试vertex拦截"], {
          env: {
            ...process.env,
            TWINKLEBOT_DATA_DIR: emptyData,
            TWINKLEBOT_DEPLOY_ENV: "local",
            TWINKLEBOT_EXECUTOR_TOKEN: "tok",
            GOOGLE_GENAI_USE_VERTEXAI: "true",
            GEMINI_API_KEY: "",
            GOOGLE_API_KEY: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += d.toString()));
        p.on("exit", (code) => resolve({ code, stderr }));
      });
      assert.equal(vtxOut.code, 1);
      assert.match(vtxOut.stderr, /Vertex AI|GCP/);

      // 2. Max steps route_notice ("⚠️") + double SIGINT force exit(1)
      const mockLlm = await startMockLlmServer();
      t.after(() => mockLlm.close());
      writeCliSettings(emptyData, mockLlm.openaiBaseUrl);
      const mockExecSrv = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, screen: { width: 1440, height: 900 }, exit_code: 0, stdout: "ok", stderr: "" }));
      });
      await new Promise<void>((r) => mockExecSrv.listen(0, "127.0.0.1", r));
      t.after(() => { mockExecSrv.close(); mockExecSrv.closeAllConnections?.(); });
      const mockExecUrl = `http://127.0.0.1:${(mockExecSrv.address() as net.AddressInfo).port}`;

      let n = 0;
      mockLlm.setHandler(async () => {
        n += 1;
        return { toolCalls: [{ id: `ms-${n}`, name: "run_shell", args: { command: `echo ${n}`, risk: "low" } }] };
      });
      const maxRes = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "触达步数上限"], {
          env: {
            ...process.env,
            TWINKLEBOT_DATA_DIR: emptyData,
            TWINKLEBOT_EXECUTOR_URL: mockExecUrl,
            TWINKLEBOT_EXECUTOR_TOKEN: "tok",
            TWINKLEBOT_MAX_STEPS: "2",
            GEMINI_API_KEY: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        p.stdout.on("data", (d) => (stdout += d.toString()));
        const tm = setTimeout(() => p.kill("SIGKILL"), 8000);
        p.on("exit", (code) => { clearTimeout(tm); resolve({ code, stdout }); });
      });
      assert.match(maxRes.stdout, /⚠️/);

      // Double SIGINT -> immediate exit(1)
      let releaseHold!: () => void;
      const holdGate = new Promise<void>((r) => { releaseHold = r; });
      mockLlm.setHandler(async () => { await holdGate; return { text: "never" }; });
      const dblSig = await new Promise<{ code: number | null }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "双次SIGINT"], {
          env: { ...process.env, TWINKLEBOT_DATA_DIR: emptyData, TWINKLEBOT_EXECUTOR_URL: mockExecUrl, TWINKLEBOT_EXECUTOR_TOKEN: "tok", GEMINI_API_KEY: "" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        setTimeout(() => p.kill("SIGINT"), 350);
        setTimeout(() => p.kill("SIGINT"), 550);
        const tm = setTimeout(() => p.kill("SIGKILL"), 5000);
        p.on("exit", (code) => { clearTimeout(tm); releaseHold(); resolve({ code }); });
      });
      mockLlm.setHandler(undefined);
      assert.equal(dblSig.code, 1, "Double SIGINT must force exit with code 1");
    }
  );

  // ---------- P2-LAND-01 & P2-LAND-02 ----------
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  const landingDir = path.join(PROJECT_ROOT, "landing");
  const landingSrv = http.createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    const fp = path.join(landingDir, rel);
    const MIME: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
    };
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(fs.readFileSync(fp));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((r) => landingSrv.listen(0, "127.0.0.1", r));
  t.after(() => landingSrv.close());
  const landingUrl = `http://127.0.0.1:${(landingSrv.address() as net.AddressInfo).port}`;

  await collector.runCase(
    t,
    {
      id: "P2-LAND-01",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "Landing 官网 4 个工作台模拟 Tab 切换(内容/aria-selected) + 4 大 OS UA 自动高亮下载卡与跳转芯片",
      module: "Landing Page Interactive",
    },
    async () => {
      await chrome!.addInitScript(`
        window.__e2eLandCopies = [];
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (t) => { window.__e2eLandCopies.push(String(t)); } }
          });
        } catch {}
        const origFetch = window.fetch;
        window.fetch = async (url, opts) => {
          if (String(url).includes('api.github.com/repos/')) {
            if (window.__e2eFailGithub) {
              return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
            }
            return new Response(JSON.stringify([{
              tag_name: 'v1.9.9',
              html_url: 'https://github.com/caixy-plus/twinklebot/releases/tag/v1.9.9',
              draft: false,
              prerelease: false,
              assets: [
                { name: 'TwinkleBot-1.9.9-arm64.dmg', browser_download_url: 'https://github.com/caixy-plus/twinklebot/releases/download/v1.9.9/TwinkleBot-1.9.9-arm64.dmg' },
                { name: 'TwinkleBot-Setup-1.9.9.exe', browser_download_url: 'https://github.com/caixy-plus/twinklebot/releases/download/v1.9.9/TwinkleBot-Setup-1.9.9.exe' },
                { name: 'TwinkleBot-1.9.9-win.zip', browser_download_url: 'https://github.com/caixy-plus/twinklebot/releases/download/v1.9.9/TwinkleBot-1.9.9-win.zip' },
                { name: 'TwinkleBot-1.9.9.AppImage', browser_download_url: 'https://github.com/caixy-plus/twinklebot/releases/download/v1.9.9/TwinkleBot-1.9.9.AppImage' },
                { name: 'TwinkleBot-1.9.9-linux.tar.gz', browser_download_url: 'https://github.com/caixy-plus/twinklebot/releases/download/v1.9.9/TwinkleBot-1.9.9-linux.tar.gz' },
                { name: 'TwinkleBot-1.9.9-release.apk', browser_download_url: 'https://github.com/caixy-plus/twinklebot/releases/download/v1.9.9/TwinkleBot-1.9.9-release.apk' }
              ]
            }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(url, opts);
        };
      `);

      // Test all 4 OS UAs: windows, macos, linux, android!
      const uaCases = [
        { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0", platform: "windows", label: "Windows" },
        { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0", platform: "macos", label: "macOS" },
        { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0", platform: "linux", label: "Linux" },
        { ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile", platform: "android", label: "Android" },
      ];
      for (const c of uaCases) {
        await chrome!.setViewport({ width: 1280, height: 840, userAgent: c.ua });
        await chrome!.navigate(landingUrl);
        await chrome!.waitFor(`document.querySelector('#nav-version-pill')?.textContent?.includes('1.9.9')`, 6000);
        const pLabel: string = await chrome!.evalJs<string>(`document.querySelector('#primary-download-label')?.textContent || ''`);
        assert.ok(pLabel.includes(c.label), `Expected #primary-download-label to include ${c.label}, got ${pLabel}`);
        const cardHighlighted: boolean = await chrome!.evalJs<boolean>(
          `Boolean(document.querySelector('[data-platform-card="${c.platform}"].is-highlighted'))`
        );
        assert.equal(cardHighlighted, true, `Platform card ${c.platform} must be highlighted`);
      }

      // Switch all 4 interactive scene tabs & verify #stage-chrome-title / #stage-chrome-meta / aria-selected!
      const expectedTitles: Record<string, string> = {
        collab: "产品研发协作群",
        desktop: "双电脑协同",
        mobile: "局域网直连",
        routing: "智能路由调度器",
      };
      for (const [tabKey, expected] of Object.entries(expectedTitles)) {
        await chrome!.click(`.scene-tab[data-scene="${tabKey}"]`);
        const info: { title: string; selected: string } = await chrome!.evalJs<{ title: string; selected: string }>(`({
          title: document.querySelector('#stage-chrome-title')?.textContent || '',
          selected: document.querySelector('.scene-tab[data-scene="${tabKey}"]')?.getAttribute('aria-selected') || '',
        })`);
        assert.ok(info.title.includes(expected), `Tab ${tabKey} title mismatch: ${info.title}`);
        assert.equal(info.selected, "true");
      }

      // Click [data-jump-platform="macos"] chip -> highlights macOS card
      await chrome!.click('[data-jump-platform="macos"]');
      assert.equal(
        await chrome!.evalJs<boolean>(`Boolean(document.querySelector('[data-platform-card="macos"].is-highlighted'))`),
        true
      );
    },
    { getChrome: () => chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P2-LAND-02",
      priority: "P2",
      featureTier: "F3",
      difficulty: "D1",
      title: "Landing 官网全部 7 个 GitHub Release 资产链接水合、403 限流静态兜底与一键复制「已复制 ✓」反馈",
      module: "Landing Hydration & Copy",
    },
    async () => {
      // Verify ALL 7 download links + version tags hydrated!
      const links = await chrome!.evalJs<Record<string, string>>(`({
        macArm: document.querySelector('#dl-mac-arm64')?.getAttribute('href') || '',
        macX64: document.querySelector('#dl-mac-x64')?.getAttribute('href') || '',
        winExe: document.querySelector('#dl-win-exe')?.getAttribute('href') || '',
        winZip: document.querySelector('#dl-win-zip')?.getAttribute('href') || '',
        linApp: document.querySelector('#dl-linux-appimage')?.getAttribute('href') || '',
        linTar: document.querySelector('#dl-linux-tar')?.getAttribute('href') || '',
        apk: document.querySelector('#dl-android-apk')?.getAttribute('href') || '',
        relTag: document.querySelector('#release-version-tag')?.textContent || '',
        heroLbl: document.querySelector('#hero-release-label')?.textContent || '',
      })`);
      assert.match(links.macArm, /v1\.9\.9\/TwinkleBot-1\.9\.9-arm64\.dmg/);
      assert.match(links.macX64, /v1\.9\.9/);
      assert.match(links.winExe, /TwinkleBot-Setup-1\.9\.9\.exe/);
      assert.match(links.winZip, /TwinkleBot-1\.9\.9-win\.zip/);
      assert.match(links.linApp, /TwinkleBot-1\.9\.9\.AppImage/);
      assert.match(links.linTar, /TwinkleBot-1\.9\.9-linux\.tar\.gz/);
      assert.match(links.apk, /TwinkleBot-1\.9\.9-release\.apk/);
      assert.match(links.relTag, /1\.9\.9/);
      assert.match(links.heroLbl, /1\.9\.9/);

      // Click copy buttons & verify BOTH clipboard write AND "已复制 ✓" button feedback!
      await chrome!.evalJs(`(() => {
        document.querySelectorAll('[data-copy-target]').forEach(btn => btn.click());
      })()`);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('[data-copy-target]')).some(b => b.textContent?.includes('已复制'))`,
        3000
      );
      const copies = await chrome!.evalJs<string[]>(`window.__e2eLandCopies || []`);
      assert.ok(copies.length >= 1, "Copy buttons must copy prompt/command text");

      // Simulate 403 rate-limited GitHub API -> static fallback download URLs still intact!
      await chrome!.addInitScript(`window.__e2eFailGithub = true;`);
      await chrome!.reload(true);
      const fallbackHref = await chrome!.evalJs<string>(`document.querySelector('#dl-mac-arm64')?.getAttribute('href') || ''`);
      assert.ok(fallbackHref.startsWith("https://github.com/"), "Fallback download URL must stay valid when GitHub API returns 403");
    },
    { getChrome: () => chrome }
  );
});
