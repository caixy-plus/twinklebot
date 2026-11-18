export type DeployEnv = "local" | "cloud";
export type RuntimeRole = "master" | "host_executor";

export type ProviderType =
  | "gemini"
  | "openai"
  | "deepseek"
  | "anthropic"
  | "openai-compatible";

export type BillingCurrency = "USD" | "CNY";

export interface ProviderEntry {
  id: string;
  type: ProviderType;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  imageModels: string[];
  billingCurrency?: BillingCurrency;
  enabled: boolean;
}

export interface SanitizedProvider extends Omit<ProviderEntry, "apiKey"> {
  hasApiKey: boolean;
  apiKeySource: "env" | "literal" | "";
  apiKeyEnvName?: string;
  maskedApiKey: string;
  authMode?: "ai-studio" | "gcp-vertex";
  gcpVertexLabel?: string;
}

export interface RoutingTierRef {
  providerId: string;
  model: string;
}

export type RoutingMode = "economy" | "balanced" | "quality";

export interface RoutingSettings {
  smartRouter: boolean;
  mode: RoutingMode;
  maxTurnUsd: number;
  tiers?: {
    fast?: RoutingTierRef;
    medium?: RoutingTierRef;
    advanced?: RoutingTierRef;
    image?: RoutingTierRef;
    [key: string]: RoutingTierRef | undefined;
  };
}

export interface ScreenConfig {
  width: number;
  height: number;
}

export interface AppConfig {
  deployEnv: DeployEnv;
  initialRole: RuntimeRole;
  sandboxMode: string;
  host: string;
  port: number;
  lanAccess: boolean;
  geminiApiKey: string;
  useVertexAi: boolean;
  vertexProject: string;
  vertexLocation: string;
  cloudAuthToken: string;
  localControlToken: string;
  executorUrl: string;
  executorToken: string;
  novncUrl: string;
  novncProxyTarget: string;
  defaultModel: string;
  deepModel: string;
  fastModel: string;
  thinkingSummaryModel: string;
  imageModel: string;
  proImageModel: string;
  fallbackImageModel: string;
  models: string[];
  maxSteps: number;
  keepScreenshots: number;
  shellTimeoutSec: number;
  screen: ScreenConfig;
  writeRoots: string[];
  dataDir: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cached?: number;
  thoughts?: number;
  total?: number;
  costUsd?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  parseError?: string;
}

export interface ToolResult {
  error?: string;
  [key: string]: unknown;
}

export interface ModelTurnResult {
  thoughts?: string[];
  text?: string;
  calls?: ToolCall[];
  outputSteps?: unknown[];
  usage?: TokenUsage;
  usedModel?: string;
  usedProviderId?: string;
  finishReason?: string;
}

export interface ImageGenerationResult {
  images: Array<{ data: string; mimeType: string }>;
  text?: string;
  usage?: TokenUsage | null;
  usedModel: string;
  usedProviderId?: string;
}

export interface ModelAdapter {
  planTurn?(opts: Record<string, unknown>): Promise<ModelTurnResult>;
  summarizeTurn?(opts: Record<string, unknown>): Promise<ModelTurnResult>;
  nextTurn(opts: Record<string, unknown>): Promise<ModelTurnResult>;
  generateImage?(opts: Record<string, unknown>): Promise<ImageGenerationResult>;
}

export interface ExecutorClient {
  health(opts?: Record<string, unknown>): Promise<{ ok: boolean; [key: string]: unknown }>;
  call(
    route: string,
    body?: Record<string, unknown>,
    opts?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}
