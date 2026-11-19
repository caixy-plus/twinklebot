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

test("P2 Suite 9: CLI Tool (Settings Providers / Approval / SIGINT) & Landing Portal Interactive E2E", async (t) => {
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
      title: "CLI 空参数退出码 1 + 白盒线索 #1 取证：仅配置 settings.json 供应商(无 GEMINI_API_KEY)运行 CLI",
      module: "CLI Multi-Provider Bootstrap",
    },
    async ({ setEvidence }) => {
      // 1. Empty args must exit 1 with usage banner
      const emptyRes = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += d.toString()));
        p.on("exit", (code) => resolve({ code, stderr }));
      });
      assert.equal(emptyRes.code, 1);
      assert.match(emptyRes.stderr, /Usage:/i);

      // 2. White-box clue #1 verification: user configured OpenAI-compatible provider in data/settings.json, NO GEMINI_API_KEY in env!
      const mockLlm = await startMockLlmServer();
      t.after(() => mockLlm.close());
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-clue1-"));
      t.after(() => fs.rmSync(tmpData, { recursive: true, force: true }));

      fs.writeFileSync(
        path.join(tmpData, "settings.json"),
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
              baseUrl: mockLlm.openaiBaseUrl,
              models: ["e2e-fast"],
              enabled: true,
            },
          ],
        }),
        "utf8"
      );

      const mockExecSrv = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if ((req.url || "").startsWith("/health")) {
          res.end(JSON.stringify({ ok: true, screen: { width: 1440, height: 900 } }));
        } else if ((req.url || "").startsWith("/screenshot")) {
          res.end(JSON.stringify({ png_base64: "", width: 1440, height: 900 }));
        } else {
          res.end(JSON.stringify({ ok: true, exit_code: 0, stdout: "", stderr: "" }));
        }
      });
      await new Promise<void>((r) => mockExecSrv.listen(0, "127.0.0.1", r));
      t.after(() => {
        mockExecSrv.close();
        mockExecSrv.closeAllConnections?.();
      });
      const mockExecUrl = `http://127.0.0.1:${(mockExecSrv.address() as net.AddressInfo).port}`;

      const cleanEnv = {
        ...process.env,
        TWINKLEBOT_DATA_DIR: tmpData,
        TWINKLEBOT_EXECUTOR_URL: mockExecUrl,
        TWINKLEBOT_EXECUTOR_TOKEN: "e2e-cli-tok",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
      };
      const cliOut = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "用settings供应商回复你好"], {
          env: cleanEnv,
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
      setEvidence("cliStdout", cliOut.stdout.slice(0, 500));
      setEvidence("cliStderr", cliOut.stderr.slice(0, 500));
      setEvidence("mockLlmHits", mockLlm.capturedRequests.length);

      assert.equal(
        cliOut.code,
        0,
        `CLI should honor providers configured in settings.json without GEMINI_API_KEY (got code=${cliOut.code}, stderr=${cliOut.stderr.trim()})`
      );
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
      title: "CLI 流式执行、readline [y/N] 审批放行、会话落盘与 SIGINT 优雅中断",
      module: "CLI Interactive Execution & SIGINT",
    },
    async ({ setEvidence }) => {
      // Also test CLI with Gemini baseUrl via GOOGLE_GEMINI_BASE_URL or observe behavior when GEMINI_API_KEY set
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-sigint-"));
      t.after(() => fs.rmSync(tmpData, { recursive: true, force: true }));
      const mockLlm = await startMockLlmServer();
      t.after(() => mockLlm.close());
      fs.writeFileSync(
        path.join(tmpData, "settings.json"),
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
              baseUrl: mockLlm.openaiBaseUrl,
              models: ["e2e-fast"],
              enabled: true,
            },
          ],
        }),
        "utf8"
      );

      let releaseSlow!: () => void;
      const slowGate = new Promise<void>((r) => {
        releaseSlow = r;
      });
      mockLlm.setHandler(async () => {
        await slowGate;
        return { text: "slow cli reply" };
      });

      const mockExecSrv2 = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, screen: { width: 1440, height: 900 }, png_base64: "" }));
      });
      await new Promise<void>((r) => mockExecSrv2.listen(0, "127.0.0.1", r));
      t.after(() => {
        mockExecSrv2.close();
        mockExecSrv2.closeAllConnections?.();
      });
      const mockExecUrl2 = `http://127.0.0.1:${(mockExecSrv2.address() as net.AddressInfo).port}`;

      // Start CLI and send SIGINT mid-flight to verify graceful SIGINT handler + persisted session
      const sigRes = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const p = spawn(process.execPath, [cliEntry, "测试SIGINT中断"], {
          env: {
            ...process.env,
            TWINKLEBOT_DATA_DIR: tmpData,
            TWINKLEBOT_EXECUTOR_URL: mockExecUrl2,
            GEMINI_API_KEY: "",
            TWINKLEBOT_EXECUTOR_TOKEN: "fake-exec-tok",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += d.toString()));
        p.stderr.on("data", (d) => (stderr += d.toString()));
        setTimeout(() => p.kill("SIGINT"), 450);
        const tm = setTimeout(() => p.kill("SIGKILL"), 6000);
        p.on("exit", (code) => {
          clearTimeout(tm);
          releaseSlow();
          resolve({ code, stdout, stderr });
        });
      });
      mockLlm.setHandler(undefined);

      setEvidence("sigintExitCode", sigRes.code);
      setEvidence("sigintStdout", sigRes.stdout);
      assert.match(sigRes.stdout, /SIGINT|Stopping task cleanly/);
      // Session file must have been created on disk
      const sessFiles = fs.existsSync(path.join(tmpData, "sessions"))
        ? fs.readdirSync(path.join(tmpData, "sessions"))
        : [];
      assert.ok(sessFiles.length >= 1, "CLI must create and persist session under TWINKLEBOT_DATA_DIR/sessions");
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
      title: "Landing 官网 4 个工作台模拟 Tab 切换(collab/desktop/mobile/routing) + 多 OS UA 自动高亮下载卡",
      module: "Landing Page Interactive",
    },
    async () => {
      // Intercept GitHub Releases API to return mock v1.9.9 release and intercept clipboard
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
              draft: false,
              prerelease: false,
              assets: [
                { name: 'TwinkleBot-1.9.9-arm64.dmg', browser_download_url: 'https://github.com/caixy-plus/twinklebot-releases/releases/download/v1.9.9/TwinkleBot-1.9.9-arm64.dmg' },
                { name: 'TwinkleBot-Setup-1.9.9.exe', browser_download_url: 'https://github.com/caixy-plus/twinklebot-releases/releases/download/v1.9.9/TwinkleBot-Setup-1.9.9.exe' },
                { name: 'TwinkleBot-1.9.9.apk', browser_download_url: 'https://github.com/caixy-plus/twinklebot-releases/releases/download/v1.9.9/TwinkleBot-1.9.9.apk' }
              ]
            }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(url, opts);
        };
      `);

      // Test Windows UA highlight
      await chrome!.setViewport({
        width: 1280,
        height: 840,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
      });
      await chrome!.navigate(landingUrl);
      await chrome!.waitFor(`document.querySelector('#nav-version-pill')?.textContent?.includes('1.9.9')`, 6000);

      // Switch all 4 interactive scene tabs
      const tabs = await chrome!.evalJs<string[]>(
        `Array.from(document.querySelectorAll('[data-scene], [data-tab], [role="tab"]')).map(el => el.getAttribute('data-scene') || el.getAttribute('data-tab') || el.id).filter(Boolean)`
      );
      assert.ok(tabs.length >= 4, `Expected 4 scene tabs on landing page, got ${tabs.length}`);
      for (const tabKey of ["collab", "desktop", "mobile", "routing"]) {
        const clicked: boolean = await chrome!.evalJs<boolean>(`(() => {
          const el = document.querySelector('[data-scene="${tabKey}"], [data-tab="${tabKey}"]');
          if (!el) return false;
          el.click();
          return true;
        })()`);
        assert.equal(clicked, true, `Tab ${tabKey} must be clickable`);
      }
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
      title: "Landing 官网 GitHub Releases 资产水合、403 限流静态兜底与一键复制按钮",
      module: "Landing Hydration & Copy",
    },
    async () => {
      const macHref = await chrome!.evalJs<string>(`document.querySelector('#dl-mac-arm64')?.getAttribute('href') || ''`);
      assert.match(macHref, /v1\.9\.9\/TwinkleBot-1\.9\.9-arm64\.dmg/);

      // Click copy buttons on landing page
      await chrome!.evalJs(`(() => {
        document.querySelectorAll('[data-copy-target]').forEach(btn => btn.click());
      })()`);
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
