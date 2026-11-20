import readline from "node:readline";
import { loadConfig } from "../lib/config.js";
import { createExecutorClient } from "../agent/executor-client.js";
import { createModel } from "../agent/model.js";
import { isProviderUsable } from "../agent/providers/registry.js";
import { createStore } from "../store/index.js";
import { runTask, createControl } from "../agent/loop.js";

async function main() {
  const taskText = process.argv.slice(2).join(" ").trim();
  if (!taskText) {
    console.error("Usage: npm run cli -- \"<task>\"");
    process.exit(1);
  }

  const config = loadConfig({
    ...process.env,
    TWINKLEBOT_ALLOW_UNCONFIGURED: "1",
  });
  const store = createStore(config.dataDir);
  const settings = store.readSettings() || {};
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const hasUsableProvider = providers.some((p: any) => isProviderUsable(p, process.env));
  if (!config.geminiApiKey && !hasUsableProvider) {
    const vertexRequested =
      process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" ||
      process.env.GOOGLE_GENAI_USE_VERTEXAI === "1";
    if (vertexRequested && config.deployEnv !== "cloud") {
      throw new Error(
        "Vertex AI 仅支持 GCP 云服务器部署，当前环境请配置 GEMINI_API_KEY (AI Studio)"
      );
    }
    throw new Error("GEMINI_API_KEY is not set");
  }

  const executor = createExecutorClient({
    url: config.executorUrl,
    token: config.executorToken,
  });
  const model = createModel({
    apiKey: config.geminiApiKey,
    getProviders: () => store.readSettings()?.providers || [],
    getRouting: () => store.readSettings()?.routing || {},
  });

  const session = store.createSession({
    title: taskText.slice(0, 40),
  });

  const control = createControl();

  let sigintCount = 0;
  process.on("SIGINT", () => {
    sigintCount++;
    if (sigintCount === 1) {
      console.log("\n[SIGINT] Stopping task cleanly... (press Ctrl+C again to force exit)");
      control.stop();
    } else {
      process.exit(1);
    }
  });

  function emit(event: Record<string, any>) {
    try {
      store.appendEvent(session.id, event);
    } catch {
      // ignore
    }

    if (event.type === "usage") {
      try {
        const s = store.getSession(session.id);
        const prevUsage = s?.usage || { input: 0, output: 0 };
        store.updateSession(session.id, {
          usage: {
            input: (prevUsage.input || 0) + (event.input || 0),
            output: (prevUsage.output || 0) + (event.output || 0),
          },
        });
      } catch {
        // ignore
      }
    }

    switch (event.type) {
      case "thought":
        console.log(`💭 ${event.text}`);
        break;
      case "action":
        console.log(`🖱 ${event.name} ${JSON.stringify(event.args)}`);
        break;
      case "result":
        console.log(
          `✅ ${event.name} -> ${JSON.stringify(event.result)}${event.screenshot ? ` [${event.screenshot}]` : ""}`
        );
        break;
      case "approval_request": {
        const prompt = `⚠ ${event.name} ${JSON.stringify(event.args)} (${event.reason}) — approve? [y/N] `;
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        let resolved = false;
        rl.question(prompt, (ans) => {
          if (!resolved) {
            resolved = true;
            rl.close();
            const approved = /^y(es)?$/i.test(ans.trim());
            control.resolveApproval(event.callId, approved);
          }
        });
        rl.on("close", () => {
          if (!resolved) {
            resolved = true;
            control.resolveApproval(event.callId, false);
          }
        });
        break;
      }
      case "answer":
        console.log(`\n${event.text}`);
        break;
      case "route_notice":
        if (event.text) console.log(`\n⚠️ ${event.text}`);
        break;
      case "error":
        console.error(`❌ ${event.message}`);
        break;
      default:
        // status, user, usage, approval are recorded to store
        break;
    }
  }

  const modelName = store.readSettings().model || config.defaultModel;

  const res = await runTask({
    sessionId: session.id,
    userText: taskText,
    modelName,
    deps: {
      model,
      executor,
      store,
      config,
      emit,
    },
    control,
  });

  if (res.status === "done") {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message || err}`);
  process.exit(1);
});
