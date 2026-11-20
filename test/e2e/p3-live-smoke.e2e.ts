import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createExecutorClient } from "../../src/agent/executor-client.js";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import {
  createSuiteCollector,
  EnvSkipSignal,
  PROJECT_ROOT,
} from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

interface ResolvedLiveConfig {
  source: string;
  providers: Array<Record<string, any>>;
  routing: Record<string, any>;
  secretValues: string[];
}

function resolveLiveProviderConfig(): ResolvedLiveConfig | null {
  const dotEnv = parseDotEnvFile(path.join(PROJECT_ROOT, ".env"));
  const readEnv = (k: string) => String(process.env[k] || dotEnv[k] || "").trim();

  const geminiKey = readEnv("GEMINI_API_KEY");
  if (geminiKey) {
    const model = readEnv("GEMINI_MODEL") || "gemini-2.5-flash";
    const provider = {
      id: "live-gemini",
      type: "gemini",
      name: "Live Gemini",
      apiKey: geminiKey,
      models: [model],
      billingCurrency: "USD",
      enabled: true,
    };
    return {
      source: "env:GEMINI_API_KEY",
      providers: [provider],
      routing: {
        smartRouter: true,
        mode: "balanced",
        maxTurnUsd: 0.25,
        tiers: {
          fast: { providerId: provider.id, model },
          medium: { providerId: provider.id, model },
          advanced: { providerId: provider.id, model },
        },
      },
      secretValues: [geminiKey],
    };
  }

  const deepseekKey = readEnv("DEEPSEEK_API_KEY");
  if (deepseekKey) {
    const model = readEnv("DEEPSEEK_MODEL") || "deepseek-chat";
    const provider = {
      id: "live-deepseek",
      type: "deepseek",
      name: "Live DeepSeek",
      apiKey: deepseekKey,
      baseUrl: readEnv("DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1",
      models: [model],
      billingCurrency: "CNY",
      enabled: true,
    };
    return {
      source: "env:DEEPSEEK_API_KEY",
      providers: [provider],
      routing: {
        smartRouter: true,
        mode: "balanced",
        maxTurnUsd: 0.25,
        tiers: {
          fast: { providerId: provider.id, model },
          medium: { providerId: provider.id, model },
          advanced: { providerId: provider.id, model },
        },
      },
      secretValues: [deepseekKey],
    };
  }

  const openaiKey = readEnv("OPENAI_API_KEY");
  if (openaiKey) {
    const model = readEnv("OPENAI_MODEL") || "gpt-4o-mini";
    const provider = {
      id: "live-openai",
      type: "openai",
      name: "Live OpenAI",
      apiKey: openaiKey,
      baseUrl: readEnv("OPENAI_BASE_URL") || "https://api.openai.com/v1",
      models: [model],
      billingCurrency: "USD",
      enabled: true,
    };
    return {
      source: "env:OPENAI_API_KEY",
      providers: [provider],
      routing: {
        smartRouter: true,
        mode: "balanced",
        maxTurnUsd: 0.25,
        tiers: {
          fast: { providerId: provider.id, model },
          medium: { providerId: provider.id, model },
          advanced: { providerId: provider.id, model },
        },
      },
      secretValues: [openaiKey],
    };
  }

  // Fallback: read local TwinkleBot data/settings.json enabled providers (never mutates real data/)
  const settingsPath = path.join(PROJECT_ROOT, "data", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
        providers?: Array<Record<string, any>>;
        routing?: Record<string, any>;
      };
      const enabledProviders = (raw.providers || []).filter(
        (p) => p && p.enabled !== false && String(p.apiKey || "").trim().length > 0
      );
      if (enabledProviders.length > 0) {
        const first = enabledProviders[0];
        const fallbackModel = (first.models || [])[0] || "";
        const baseRouting = raw.routing || {
          smartRouter: true,
          mode: "balanced",
          maxTurnUsd: 0.25,
          tiers: {
            fast: { providerId: first.id, model: fallbackModel },
            medium: { providerId: first.id, model: fallbackModel },
            advanced: { providerId: first.id, model: fallbackModel },
          },
        };
        const cappedBudget = Math.min(Number(baseRouting.maxTurnUsd || 0.25), 0.25);
        return {
          source: `data/settings.json:${first.id}`,
          providers: enabledProviders,
          routing: {
            ...baseRouting,
            maxTurnUsd: cappedBudget,
          },
          secretValues: enabledProviders
            .map((p) => String(p.apiKey || "").trim())
            .filter((k) => k.length >= 8),
        };
      }
    } catch {
      // Ignore malformed local settings.json
    }
  }

  return null;
}

function hasOrbUbuntu(): boolean {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("orb", ["list"], { encoding: "utf8" });
  return r.status === 0 && /\bubuntu\b/i.test(r.stdout || "");
}

const PY_LIVE_SANDBOX_BOOTSTRAP = `
import json, os, shutil, signal, sys, tempfile
sys.path.insert(0, sys.argv[1])
import executor as ex

TOKEN = sys.argv[2]
tmp_dir = tempfile.mkdtemp(prefix="tb-live-sbox-")
actions = ex.Actions(browser="google-chrome", display=":1", cdp_port=9222, profile_dir=tmp_dir)
srv = ex.make_server(actions, TOKEN, host="0.0.0.0", port=0)
exec_port = srv.server_address[1]

def cleanup(*_):
    try: srv.shutdown()
    except Exception: pass
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os._exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)
print(json.dumps({"exec_port": exec_port, "tmp_dir": tmp_dir}), flush=True)
srv.serve_forever()
`;

async function spawnLightweightSandboxExecutor(token: string) {
  const useOrb = hasOrbUbuntu();
  if (!useOrb && process.platform !== "linux") return null;

  const executorDir = path.join(PROJECT_ROOT, "executor");
  const cmd = useOrb ? "orb" : "python3";
  const args = useOrb
    ? ["-m", "ubuntu", "python3", "-u", "-c", PY_LIVE_SANDBOX_BOOTSTRAP, executorDir, token]
    : ["-u", "-c", PY_LIVE_SANDBOX_BOOTSTRAP, executorDir, token];

  const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const info = await new Promise<{ exec_port: number; tmp_dir: string }>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`Lightweight sandbox executor boot timeout: ${stderr}`)),
      15_000
    );
    proc.stdout?.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (err) {
          reject(err);
        }
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Lightweight sandbox executor exited (${code}): ${stderr}`));
    });
  });

  let baseUrl = `http://127.0.0.1:${info.exec_port}`;
  try {
    const r = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("not ok");
  } catch {
    baseUrl = `http://ubuntu.orb.local:${info.exec_port}`;
  }

  return {
    baseUrl,
    close: async () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
      try {
        proc.kill("SIGKILL");
      } catch {}
    },
  };
}

test("P3 Suite 12: Optional Live .env LLM & Sandbox Smoke", async (t) => {
  const collector = createSuiteCollector("p3-live-smoke");
  let chrome: HeadlessChromeSession | null = null;
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  await collector.runCase(
    t,
    {
      id: "P3-LIVE-01",
      priority: "P3",
      featureTier: "F1",
      difficulty: "D3",
      title: "可选真实 .env 大模型与真实沙盒端到端冒烟(需配置 TWINKLEBOT_E2E_LIVE=1 与真实 API Key)",
      module: "Live API Smoke",
    },
    async (ctx) => {
      const wantLive = process.env.TWINKLEBOT_E2E_LIVE === "1";
      if (!wantLive) {
        throw new EnvSkipSignal(
          "未开启 TWINKLEBOT_E2E_LIVE=1（默认纯本地确定性离线模式，跳过真实公网 API 冒烟）"
        );
      }

      const liveConfig = resolveLiveProviderConfig();
      if (!liveConfig) {
        throw new EnvSkipSignal(
          "本机未配置 .env 或 data/settings.json 真实大模型 API Key，自动跳过 Live 冒烟"
        );
      }

      const sboxToken = `tb-live-${crypto.randomBytes(12).toString("hex")}`;
      const realSbox = await spawnLightweightSandboxExecutor(sboxToken);
      if (realSbox) {
        t.after(() => realSbox.close());
      }

      const customExecutor = realSbox
        ? createExecutorClient({ url: realSbox.baseUrl, token: sboxToken, timeoutMs: 30_000 })
        : undefined;
      if (customExecutor) {
        const health = await customExecutor.health();
        assert.equal(health.ok, true, "Real Ubuntu sandbox executor /health should return ok=true");
      }

      const ws = await createE2EWorkspace({
        seedDefaultProvider: false,
        sandboxMode: "full",
        maxSteps: 6,
        customExecutor,
      });
      t.after(() => ws.close());

      // Seed real provider config into the isolated temporary E2E store
      ws.store.writeSettings({
        onboardingCompleted: true,
        providers: liveConfig.providers as any,
        routing: liveConfig.routing as any,
      });
      const admin = ws.store.ensureAdminBot();
      const smokeBot = ws.store.createSession({
        title: "LiveSmokeBot",
        role: "你是一个简洁精准的助手。收到执行命令请求时，优先使用沙盒工具 run_shell 执行命令并按要求直接返回结果。",
      });

      chrome = await launchHeadlessChrome();
      await chrome.navigate(ws.baseUrl);
      await chrome.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(el => el.textContent?.includes('LiveSmokeBot'))`,
        10_000
      );
      await chrome.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('LiveSmokeBot'));
        if (el) el.click();
      })()`);
      await chrome.waitFor(
        `document.querySelector('#session-list .session-item.is-active')?.textContent?.includes('LiveSmokeBot') && Boolean(document.querySelector('#message-input'))`,
        5_000
      );

      const marker = "TWINKLE_LIVE_SMOKE_OK_9421";
      const prompt = `请立即调用 run_shell 工具执行命令 \`uname -s && echo ${marker}\`，拿到标准输出后只回复该命令的 stdout 原文，不要多余解释。`;
      await chrome.typeText("#message-input", prompt, { clear: true });
      await chrome.pressKey("Enter");

      // Wait for real LLM + real sandbox tool roundtrip to complete (up to 60s)
      const deadline = Date.now() + 60_000;
      let finalSession: any = null;
      while (Date.now() < deadline) {
        const cur = ws.store.getSession(smokeBot.id);
        const evs = ws.store.readEvents(smokeBot.id) as Array<Record<string, any>>;
        const hasAnswer = evs.some(
          (e) => e.type === "answer" && String(e.text || "").trim().length > 0
        );
        const hasError = evs.some((e) => e.type === "error");
        if (cur && !ws.runner.isSessionBusy(smokeBot.id) && cur.status !== "running" && (hasAnswer || hasError)) {
          finalSession = cur;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      const events = ws.store.readEvents(smokeBot.id) as Array<Record<string, any>>;
      const errEv = events.find((e) => e.type === "error");
      assert.ok(
        finalSession,
        `Live smoke session (${liveConfig.source}) did not finish within 60s`
      );
      assert.equal(
        errEv,
        undefined,
        `Live LLM returned error: ${JSON.stringify(errEv || {})}`
      );
      assert.ok(
        finalSession.status === "done" || finalSession.status === "idle",
        `Expected done/idle status, got ${finalSession.status}`
      );

      // Verify rendered assistant reply in Web UI
      await chrome.waitFor(
        `Array.from(document.querySelectorAll('#event-stream .msg-group.is-bot')).some(el => (el.textContent || '').includes('${marker}'))`,
        10_000
      );
      const chatText = await chrome.evalJs<string>(
        `document.querySelector('#event-stream')?.innerText || ''`
      );
      assert.ok(chatText.includes(marker), "Web UI event stream must render live marker");

      // Verify real run_shell tool execution on real Ubuntu sandbox
      const shellResult = events.find(
        (e) => e.type === "result" && String(e.name || "") === "run_shell"
      );
      assert.ok(shellResult, "Live LLM must have invoked run_shell tool");
      const shellPayload = JSON.stringify(shellResult.result || shellResult || {});
      assert.ok(shellPayload.includes(marker), "run_shell tool_result must contain live marker");
      if (realSbox) {
        assert.ok(
          /Linux/i.test(shellPayload),
          "Real Ubuntu OrbStack sandbox run_shell stdout must contain Linux"
        );
      }

      // Verify real token usage recorded via /api/usage
      const usageResp = await fetch(
        `${ws.baseUrl}/api/usage?sessionId=${encodeURIComponent(smokeBot.id)}`
      );
      assert.equal(usageResp.status, 200);
      const usageBody = (await usageResp.json()) as any;
      const totalTokens = Number(usageBody?.totalTokens || 0);
      assert.ok(
        totalTokens > 0,
        `Expected real LLM totalTokens > 0, got ${JSON.stringify(usageBody)}`
      );

      // Zero secret leakage across DOM and events
      const serializedEvents = JSON.stringify(events);
      for (const secret of liveConfig.secretValues) {
        assert.equal(chatText.includes(secret), false, "API key must never appear in Web UI DOM");
        assert.equal(
          serializedEvents.includes(secret),
          false,
          "API key must never appear in session events"
        );
      }

      // Sanity check admin bot unaffected
      assert.ok(ws.store.getSession(admin.id), "Admin bot remains intact");

      ctx.setEvidence("liveSmoke", {
        source: liveConfig.source,
        realSandbox: Boolean(realSbox),
        totalTokens,
        costUsd: usageBody?.costUsd,
        costCny: usageBody?.costCny,
        markerVerified: true,
      });
    },
    { getChrome: () => chrome }
  );
});
