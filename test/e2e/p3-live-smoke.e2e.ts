import test from "node:test";
import assert from "node:assert/strict";
import { createSuiteCollector, EnvSkipSignal } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P3 Suite 12: Optional Live .env LLM & Sandbox Smoke", async (t) => {
  const collector = createSuiteCollector("p3-live-smoke");

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
    async () => {
      const wantLive = process.env.TWINKLEBOT_E2E_LIVE === "1";
      const realKey = String(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim();
      if (!wantLive || !realKey) {
        throw new EnvSkipSignal(
          !wantLive
            ? "未开启 TWINKLEBOT_E2E_LIVE=1（默认纯本地确定性离线模式，跳过真实公网 API 冒烟）"
            : "本机未配置 .env 真实大模型 API Key，自动跳过 Live 冒烟"
        );
      }

      const ws = await createE2EWorkspace({ seedDefaultProvider: false });
      t.after(() => ws.close());
      assert.ok(ws.baseUrl);
    }
  );
});
