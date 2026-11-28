import type { BillingCurrency, ProviderEntry, RoutingSettings, SanitizedProvider, TokenUsage } from "./config.js";
import type { BotBrowserModeOverride, BrowserAutomationSettings } from "./browser-automation.js";
import type { LanguagePreference } from "./i18n.js";

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
  browserMode?: BotBrowserModeOverride;
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

export const VALID_MEMORY_CATEGORIES = [
  "identity",
  "preference",
  "rule",
  "context",
  "general",
] as const;

export type MemoryCategory = (typeof VALID_MEMORY_CATEGORIES)[number];

export const VALID_MEMORY_AUTO_MODES = ["strict", "explicit_only"] as const;

export type MemoryAutoMode = (typeof VALID_MEMORY_AUTO_MODES)[number];

export interface MemorySettings {
  autoMode: MemoryAutoMode;
}

export interface MemoryItem {
  id: string;
  name: string;
  content: string;
  enabled?: boolean;
  category?: MemoryCategory;
  source?: string;
  updatedAt?: string;
}

export function normalizeMemoryCategory(raw: unknown): MemoryCategory {
  const val = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (VALID_MEMORY_CATEGORIES as readonly string[]).includes(val)
    ? (val as MemoryCategory)
    : "general";
}

export function normalizeMemorySettings(raw: unknown): MemorySettings {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    autoMode: rec.autoMode === "explicit_only" ? "explicit_only" : "strict",
  };
}

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
  language?: LanguagePreference;
  theme: "system" | "light" | "dark" | string;
  accentMode: "bot" | "custom" | string;
  spellcheckEnabled?: boolean;
  profile: ProfileSettings;
  voice: VoiceSettings;
  autoExpandScreen?: boolean;
  hostComputer: { executionMode: HostExecutionMode | string };
  browserAutomation?: BrowserAutomationSettings;
  contextCompression?: ContextCompressionSettings;
  screenPool?: ScreenPoolSettings;
  mcpServers: Record<string, unknown>;
  policy: PolicySettings;
  privateSkills: unknown[];
  memorySettings?: MemorySettings;
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
  scope?: string;
  triggers?: string[];
  scripts?: Array<{ name: string; path: string; sizeBytes: number }>;
  createdByBotId?: string;
  createdByBotName?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ExperienceProposalItem {
  id: string;
  sessionId: string;
  botName: string;
  dimension: "domain" | "invariant";
  targetType: "custom_skill" | "skill_script" | "bot_playbook";
  title: string;
  cue: string;
  lesson: string;
  evidence: string;
  draftSkill?: {
    id?: string;
    name: string;
    description: string;
    instructions: string;
    triggers?: string[];
    scriptName?: string;
    scriptContent?: string;
  };
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  resolvedAt?: string;
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
  lastOptimizedAt?: string;
  [key: string]: unknown;
}

export interface ScheduleOptimizationResult {
  scheduleId: string;
  decision: "IMPROVED" | "KEEP_BASE";
  sideEffectNotice?: string;
  optimizedPrompt?: string;
  draftSkill?: {
    id?: string;
    name: string;
    description: string;
    instructions: string;
    scriptName?: string;
    scriptContent?: string;
  };
  comparison: {
    winner: "base" | "candidate" | "tie";
    reason: string;
    metricDelta: {
      stepsDelta: number;
      errorsDelta: number;
      usdDelta: number;
      promptCharsDelta: number;
    };
    regressions: string[];
  };
  metrics: {
    base: {
      steps: number;
      toolErrors: number;
      output: string;
      estimatedUsd: number;
    };
    candidate?: {
      steps: number;
      toolErrors: number;
      output: string;
      estimatedUsd: number;
    };
    spentUsd: number;
  };
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
