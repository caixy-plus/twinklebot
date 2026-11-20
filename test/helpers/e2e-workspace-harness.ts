import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createModel } from "../../src/agent/model.js";
import { createRunner } from "../../src/agent/runner.js";
import { createScheduler } from "../../src/agent/scheduler.js";
import { createServer } from "../../src/server/index.js";
import { createStore } from "../../src/store/index.js";
import { SAMPLE_PNG_BASE64, startMockLlmServer } from "./e2e-protocol-fixtures.js";

export interface E2EWorkspaceOptions {
  seedDefaultProvider?: boolean;
  providerType?: "openai-compatible" | "openai" | "deepseek" | "gemini";
  deployEnv?: "local" | "cloud";
  host?: string;
  cloudAuthToken?: string;
  localControlToken?: string;
  lanAccess?: boolean;
  sandboxMode?: "full" | "restricted";
  smartRouter?: boolean;
  maxSteps?: number;
  settleMs?: number;
  schedulerTickMs?: number;
  startScheduler?: boolean;
  customExecutor?: any;
  customModel?: any;
  getEffectivePublicDir?: () => string;
  otaController?: any;
  env?: Record<string, string | undefined>;
  extraWriteRoots?: string[];
  mockLlm?: Awaited<ReturnType<typeof startMockLlmServer>>;
}

export async function createE2EWorkspace(opts: E2EWorkspaceOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-e2e-ws-"));
  const dataDir = path.join(tmpDir, "data");
  const workspaceDir = path.join(tmpDir, "workspace");
  const downloadsDir = path.join(tmpDir, "downloads");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  const ownsMockLlm = !opts.mockLlm;
  const mockLlm = opts.mockLlm || (await startMockLlmServer());

  // Lightweight noVNC HTML + WS upstream stub
  const novncSrv = http.createServer((req, res) => {
    const u = req.url || "/";
    if (u.startsWith("/vnc.html") || u.startsWith("/vnc_auto.html") || u.startsWith("/vnc_lite.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>noVNC</title></head><body><div id="noVNC_control_bar">Bar</div><div id="noVNC_status">Connected</div><div id="novnc-ready">OK</div></body></html>`
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  novncSrv.on("upgrade", (req, socket) => {
    const key = String(req.headers["sec-websocket-key"] || "");
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
  });
  await new Promise<void>((resolve) => novncSrv.listen(0, "127.0.0.1", resolve));
  const novncPort = (novncSrv.address() as net.AddressInfo).port;

  const store = createStore(dataDir);
  if (opts.seedDefaultProvider !== false) {
    const pType = opts.providerType || "openai-compatible";
    store.writeSettings({
      onboardingCompleted: true,
      routing: {
        smartRouter: opts.smartRouter ?? true,
        mode: "balanced",
        tiers: {
          fast: { providerId: "e2e-primary", model: "e2e-fast" },
          medium: { providerId: "e2e-primary", model: "e2e-medium" },
          advanced: { providerId: "e2e-primary", model: "e2e-advanced" },
          image: { providerId: "e2e-primary", model: "e2e-image" },
        },
      },
      providers: [
        {
          id: "e2e-primary",
          type: pType,
          name: "E2E Mock Provider",
          apiKey: "e2e-mock-key-123456",
          baseUrl: pType === "gemini" ? mockLlm.baseUrl : mockLlm.openaiBaseUrl,
          models: ["e2e-fast", "e2e-medium", "e2e-advanced"],
          imageModels: ["e2e-image"],
          billingCurrency: pType === "deepseek" ? "CNY" : "USD",
          enabled: true,
        },
      ],
      ...(typeof opts.lanAccess === "boolean" ? { lanAccess: opts.lanAccess } : {}),
    });
  } else if (typeof opts.lanAccess === "boolean") {
    store.writeSettings({ lanAccess: opts.lanAccess });
  }

  const executorCalls: Array<{ route: string; body: any; opts: any }> = [];
  const executor =
    opts.customExecutor ||
    ({
      health: async () => ({ ok: true, screen: { width: 1440, height: 900 } }),
      call: async (route: string, body?: any, callOpts?: any) => {
        executorCalls.push({ route, body, opts: callOpts });
        if (route === "/displays") {
          return {
            ok: true,
            mode: "shared-profile-multi-tab",
            bindings: { __primary__: "标签 #1" },
            displays: [{ display_num: 1, display: ":1", novnc_online: true, cdp_online: true }],
          };
        }
        if (route === "/displays/ensure") {
          return { ok: true, novnc_port: novncPort, display: ":1", acquired: true };
        }
        if (route === "/displays/config" || route === "/displays/release") {
          return { ok: true, released: true };
        }
        if (route === "/screenshot") {
          return { png_base64: SAMPLE_PNG_BASE64, width: 1440, height: 900 };
        }
        if (route === "/browser/snapshot" || route === "/browser/click" || route === "/browser/type") {
          return {
            ok: true,
            url: body?.url || "https://example.test",
            title: "Mock Page",
            elements: [{ ref: "e1", tag: "input", name: "Password" }],
            ...(route === "/browser/type"
              ? { typed: { ref: body?.ref || "e1", submit: Boolean(body?.submit) } }
              : {}),
            text_excerpt: route === "/browser/type" ? "Password: ***" : "Portal Page Ready",
          };
        }
        if (route === "/shell") {
          return { exit_code: 0, stdout: `shell-ok: ${body?.command || ""}`, stderr: "", truncated: false };
        }
        if (route === "/read") {
          return { content: "mock-file-content", truncated: false };
        }
        if (route === "/write") {
          return { bytes: Buffer.byteLength(String(body?.content || ""), "utf8") };
        }
        return { ok: true };
      },
    });

  const model =
    opts.customModel ||
    createModel({
      apiKey: opts.providerType === "gemini" ? "e2e-mock-key-123456" : "",
      getProviders: () => store.readSettings()?.providers || [],
    });

  const config: Record<string, any> = {
    deployEnv: opts.deployEnv || "local",
    sandboxMode: opts.sandboxMode || "full",
    host: opts.host || "127.0.0.1",
    port: 0,
    geminiApiKey: "",
    models: ["e2e-fast", "e2e-medium", "e2e-advanced"],
    defaultModel: "e2e-medium",
    fastModel: "e2e-fast",
    deepModel: "e2e-advanced",
    thinkingSummaryModel: "e2e-fast",
    imageModel: "e2e-image",
    maxSteps: opts.maxSteps ?? 12,
    settleMs: opts.settleMs ?? 0,
    novncUrl: `http://127.0.0.1:${novncPort}/vnc.html`,
    novncProxyTarget: `http://127.0.0.1:${novncPort}`,
    screen: { width: 1440, height: 900 },
    writeRoots: [workspaceDir, downloadsDir, ...(opts.extraWriteRoots || [])],
    dataDir,
    ...(opts.cloudAuthToken !== undefined ? { cloudAuthToken: opts.cloudAuthToken } : {}),
    ...(opts.localControlToken !== undefined ? { localControlToken: opts.localControlToken } : {}),
    ...(typeof opts.lanAccess === "boolean" ? { lanAccess: opts.lanAccess } : {}),
  };

  const runner = createRunner({ store, config, model, executor });
  const scheduler = createScheduler({
    store,
    runner,
    tickMs: opts.schedulerTickMs ?? 15_000,
  });
  if (opts.startScheduler) {
    scheduler.start();
  }

  const server = createServer({
    store,
    config,
    runner,
    executor,
    model,
    scheduler,
    probeBotComputerFn: async () => {
      try {
        const h = await executor.health({ timeoutMs: 2500, skipWake: true });
        if (h && h.ok !== false) {
          return {
            state: "ready",
            provider: config.deployEnv === "cloud" ? "cloud-linux" : "orbstack",
            platform: process.platform,
            online: true,
            vmInstalled: true,
            vmRunning: true,
            screen: h.screen || { width: 1440, height: 900 },
            detail: "E2E Sandbox Ready",
          };
        }
      } catch (err: any) {
        const msg = String(err?.message || "executor offline");
        const unauth = err?.status === 401 || /\bunauthorized\b|401/i.test(msg);
        return {
          state: "error",
          provider: config.deployEnv === "cloud" ? "cloud-linux" : "orbstack",
          platform: process.platform,
          online: false,
          errorCode: unauth ? "unauthorized" : "unreachable",
          healthError: msg,
          detail: msg,
        };
      }
      return {
        state: "error",
        provider: config.deployEnv === "cloud" ? "cloud-linux" : "orbstack",
        platform: process.platform,
        online: false,
        errorCode: "unreachable",
        detail: "executor offline",
      };
    },
    ...(opts.getEffectivePublicDir ? { getEffectivePublicDir: opts.getEffectivePublicDir } : {}),
    ...(opts.otaController ? { otaController: opts.otaController } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });

  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const port = (server.address() as net.AddressInfo).port;
  const connectHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const baseUrl = `http://${connectHost}:${port}`;

  const waitUntil = async (pred: () => boolean | Promise<boolean>, timeoutMs = 8000, label = "condition") => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`waitUntil timed out (${timeoutMs}ms): ${label}`);
  };

  const close = async () => {
    try {
      scheduler.stop();
    } catch {}
    try {
      runner.stop();
    } catch {}
    try {
      (server as any).closeAllConnections?.();
    } catch {}
    try {
      (novncSrv as any).closeAllConnections?.();
    } catch {}
    await new Promise<void>((resolve) => {
      const tm = setTimeout(resolve, 1500);
      server.close(() => {
        clearTimeout(tm);
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      const tm = setTimeout(resolve, 1500);
      novncSrv.close(() => {
        clearTimeout(tm);
        resolve();
      });
    });
    if (ownsMockLlm) {
      await mockLlm.close();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  return {
    tmpDir,
    dataDir,
    workspaceDir,
    downloadsDir,
    port,
    novncPort,
    baseUrl,
    store,
    config,
    runner,
    scheduler,
    executor,
    executorCalls,
    model,
    server,
    mockLlm,
    waitUntil,
    close,
  };
}
