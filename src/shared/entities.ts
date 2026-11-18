import type { BillingCurrency, ProviderEntry, RoutingSettings, SanitizedProvider, TokenUsage } from "./config.js";

export type SessionType = "single" | "group";

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_screen"
  | "paused"
  | "awaiting_approval"
  | "awaiting_choice"
  | "stopped"
  | "completed"
  | "error"
  | "interrupted";

export interface BotAvatar {
  shape?: string;
  color?: string;
  imageDataUrl?: string | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  type: SessionType;
  status: SessionStatus;
  model?: string;
  persona?: string;
  avatar?: BotAvatar;
  isAdmin?: boolean;
  pinned?: boolean;
  memberBotIds?: string[];
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  usage?: TokenUsage;
  stepCount?: number;
  [key: string]: unknown;
}

export interface PolicySettings {
  autoAudit: boolean;
  askRules: string[];
  allowRules: string[];
}

export interface ProfileSettings {
  name: string;
  color: string;
}

export interface VoiceSettings {
  name: string;
  speed: number | string;
  lang: string;
}

export type HostExecutionMode = "always" | "ask" | "off";

export interface ContextCompressionSettings {
  enabled: boolean;
  /** Percentage of the active model's context window (30–95) that triggers auto-compression */
  triggerPercent: number;
  customInstruction: string;
}

export interface ScreenPoolBudget {
  min: number;
  defaultBalanced: number;
  max: number;
  totalMemGiB: number;
  cpuCores: number;
}

export interface ScreenPoolSettings {
  mode: "auto" | "custom";
  maxConcurrentScreens: number;
  budget?: ScreenPoolBudget;
}

export type ProviderBillingMode = "live_api" | "local_calibrated";

export interface ProviderBillingEntry {
  mode: ProviderBillingMode;
  currency: BillingCurrency;
  baselineRemainingNative: number | null;
  baselineTotalCreditsNative: number | null;
  baselineProviderSpentNative: number;
  calibratedAt: number | null;
  note?: string;
  autoRefreshMinutes: number;
  liveAvailable: boolean | null;
  liveTotalNative: number | null;
  liveGrantedNative: number | null;
  liveToppedUpNative: number | null;
  liveCurrency: BillingCurrency | null;
  lastRefreshedAt: number | null;
  lastError: string | null;
  lastUpdatedAt: number | null;
}

export interface AppSettings {
  theme: "system" | "light" | "dark" | string;
  accentMode: "bot" | "custom" | string;
  profile: ProfileSettings;
  voice: VoiceSettings;
  autoExpandScreen: boolean;
  hostComputer: { executionMode: HostExecutionMode | string };
  contextCompression?: ContextCompressionSettings;
  screenPool?: ScreenPoolSettings;
  mcpServers: Record<string, unknown>;
  policy: PolicySettings;
  privateSkills: unknown[];
  connectedApps: unknown[];
  mailAccounts: unknown[];
  providers?: ProviderEntry[];
  sanitizedProviders?: SanitizedProvider[];
  routing?: RoutingSettings;
  providerBilling?: Record<string, ProviderBillingEntry>;
  onboardingCompleted?: boolean;
  [key: string]: unknown;
}

export interface CustomSkillItem {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdByBotId?: string;
  createdByBotName?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ScheduleItem {
  id: string;
  title: string;
  prompt: string;
  cron?: string;
  runAt?: string;
  enabled: boolean;
  sessionId?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  [key: string]: unknown;
}

export interface VaultSecretMeta {
  id: string;
  name: string;
  domain?: string;
  username?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ComputerStatus {
  state: string;
  provider: string;
  online: boolean;
  detail?: string;
  hostId?: string;
  [key: string]: unknown;
}

export interface LanDeviceInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  baseUrl?: string;
  paired?: boolean;
  lastSeenAt?: string;
  [key: string]: unknown;
}

export interface SSEEvent {
  seq?: number;
  type: string;
  sessionId?: string;
  ts?: string;
  [key: string]: unknown;
}
