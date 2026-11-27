import http from "node:http";
import type { updateBotComputer } from "../lib/bot-computer-updater.js";
import type { probeBotComputerState } from "../lib/bot-computer-provisioner.js";
import type { testProviderConnection } from "../agent/providers/registry.js";
import type { GeminiVertexRuntime } from "../lib/gcp-env.js";

export interface ServerContext {
  projectRoot: string;
  publicDir: string;
  getEffectivePublicDir?: () => string;
  otaController?: {
    getStatus: () => any;
    getStatusAsync?: () => Promise<any>;
    confirmReady: (webBuild?: string) => any;
    rollback: (reason?: string) => any;
    applyUpdate?: (payload: {
      bundleUrl: string;
      sha256: string;
      coreBuild: string;
      force?: boolean;
    }) => Promise<{
      ok: boolean;
      queuedForIdle?: boolean;
      activeRunCount?: number;
      status?: any;
      deferredSwitch?: any;
      error?: string;
    }>;
    rollbackAsync?: (opts?: {
      reason?: string;
      mode?: "previous" | "builtin";
      restart?: boolean;
    }) => Promise<{
      ok: boolean;
      queuedForIdle?: boolean;
      activeRunCount?: number;
      status?: any;
      error?: string;
    }>;
  };
  desktopController?: {
    wakeWindow: () => Promise<{ ok?: boolean; pid: number; windowVisible: boolean }>;
    quitApp: () => void;
  };
  appVersion: string;
  server: http.Server & { hostBridge?: any };
  finalConfig: Record<string, any>;
  geminiVertexRuntime: GeminiVertexRuntime;
  effectiveNovncProxyTarget: string;
  runtimeState: any;
  deviceAuth: any;
  store: any;
  runner: any;
  executor: any;
  model: any;
  scheduler: any;
  activeMcpManager: any;
  channelManager?: any;
  relayManager?: any;
  accountDirectoryActions?: any;
  syncRelayListener?: () => Promise<void>;
  waitRelayListener?: () => Promise<void>;
  getRelayListeningPort?: () => number | null;
  getInstanceId?: () => string;
  hostBridge: any;
  updateBotComputerFn: typeof updateBotComputer;
  probeBotComputerFn: typeof probeBotComputerState;
  testProviderFn: typeof testProviderConnection;
  getDiscoveryPayload: () => any;
  isLanAccessEnabled: () => boolean;
  getInstalledSkills: () => string[];
  broadcastSkillsUpdated: () => void;
  getSanitizedMailState: () => any;
  sanitizeMcpServersMap: (rawMap: unknown) => Record<string, any>;
  hostPlatform?: string;
  getHostDeviceInfo: (executionMode?: string) => Record<string, any>;
  resolveRawProviders: () => any[];
  hasUsableProviderConfig: (providers?: any[]) => boolean;
  getMergedSettings: () => Record<string, any>;
  billingFetchImpl?: typeof globalThis.fetch;
  broadcastEvent?: (event: Record<string, unknown>) => void;
}

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
) => Promise<boolean> | boolean;
