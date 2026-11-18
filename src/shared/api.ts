import type { AppConfig, RoutingSettings, SanitizedProvider, TokenUsage } from "./config.js";
import type { AppSettings, ComputerStatus, CustomSkillItem, ScheduleItem, SessionSummary } from "./entities.js";

export interface PublicConfigResponse {
  deployEnv: AppConfig["deployEnv"];
  role: AppConfig["initialRole"];
  defaultModel: string;
  models: string[];
  imageModel: string;
  proImageModel: string;
  onboardingRequired?: boolean;
  [key: string]: unknown;
}

export interface SettingsResponse {
  settings: AppSettings;
  sanitizedProviders?: SanitizedProvider[];
  routing?: RoutingSettings;
}

export interface SessionsListResponse {
  sessions: SessionSummary[];
  primarySessionId?: string | null;
}

export interface UsageSummaryResponse {
  usage: TokenUsage;
  byModel?: Record<string, TokenUsage>;
  [key: string]: unknown;
}

export interface GcpBillingResponse {
  configured: boolean;
  balanceUsd?: number | null;
  calibratedAt?: string | null;
  workspaceSpendUsd?: number;
  [key: string]: unknown;
}

export interface SystemDiagnosticsResponse {
  ok: boolean;
  version: string;
  computer: ComputerStatus;
  [key: string]: unknown;
}

export interface CustomSkillsResponse {
  skills: CustomSkillItem[];
}

export interface SchedulesResponse {
  schedules: ScheduleItem[];
}
