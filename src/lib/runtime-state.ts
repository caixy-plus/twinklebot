import type { DeployEnv, RuntimeRole } from "../shared/config.js";

export const DEPLOY_ENVS: readonly DeployEnv[] = ["local", "cloud"];
export const RUNTIME_ROLES: readonly RuntimeRole[] = ["master", "host_executor"];

const HOST_EXECUTOR_ALLOWED_PATTERNS: RegExp[] = [
  /^\/api\/system\/(?:role|diagnostics|health)$/,
  /^\/api\/computer\/host-info$/,
  /^\/api\/host\/.+$/,
  /^\/api\/files\/(?:meta|open)$/,
  /^\/api\/workspace\/file$/,
  /^\/ws$/,
];

export function normalizeDeployEnv(raw: unknown = "local"): DeployEnv {
  const val = String(raw || "local").trim().toLowerCase();
  return val === "cloud" ? "cloud" : "local";
}

export function normalizeRuntimeRole(raw: unknown = "master"): RuntimeRole {
  const val = String(raw || "master").trim().toLowerCase();
  return val === "host_executor" ? "host_executor" : "master";
}

export interface RuntimeStateSnapshot {
  deployEnv: DeployEnv;
  role: RuntimeRole;
  cloudOrigin: string;
  updatedAt: string;
}

export interface RouteAccessResult {
  allowed: boolean;
  status?: number;
  reason?: string;
}

export interface RuntimeState {
  readonly deployEnv: DeployEnv;
  readonly role: RuntimeRole;
  readonly cloudOrigin: string;
  readonly updatedAt: string;
  isMaster(): boolean;
  isHostExecutor(): boolean;
  setRole(nextRole: unknown, opts?: { cloudOrigin?: unknown }): RuntimeStateSnapshot;
  canAccessRoute(pathname?: string, _method?: string): RouteAccessResult;
}

export function createRuntimeState({
  deployEnv = "local",
  initialRole = "master",
}: { deployEnv?: unknown; initialRole?: unknown } = {}): RuntimeState {
  const envMode = normalizeDeployEnv(deployEnv);
  let role: RuntimeRole =
    envMode === "cloud" ? "master" : normalizeRuntimeRole(initialRole);
  let cloudOrigin = "";
  let updatedAt = new Date().toISOString();

  return {
    get deployEnv() {
      return envMode;
    },
    get role() {
      return role;
    },
    get cloudOrigin() {
      return cloudOrigin;
    },
    get updatedAt() {
      return updatedAt;
    },
    isMaster() {
      return role === "master";
    },
    isHostExecutor() {
      return envMode === "local" && role === "host_executor";
    },
    setRole(nextRole: unknown, opts: { cloudOrigin?: unknown } = {}) {
      const normalized = normalizeRuntimeRole(nextRole);
      if (envMode === "cloud" && normalized === "host_executor") {
        throw new Error("cannot switch to host_executor in cloud deployEnv");
      }
      if (!RUNTIME_ROLES.includes(normalized)) {
        throw new Error(`Invalid runtime role: ${String(nextRole)}`);
      }
      role = normalized;
      cloudOrigin =
        normalized === "host_executor" ? String(opts?.cloudOrigin || "").trim() : "";
      updatedAt = new Date().toISOString();
      return {
        deployEnv: envMode,
        role,
        cloudOrigin,
        updatedAt,
      };
    },
    canAccessRoute(pathname = "/", _method = "GET") {
      if (envMode === "cloud" || role === "master") {
        return { allowed: true };
      }
      if (!pathname.startsWith("/api/") && pathname !== "/ws") {
        return { allowed: true };
      }
      const allowed = HOST_EXECUTOR_ALLOWED_PATTERNS.some((re) => re.test(pathname));
      if (allowed) {
        return { allowed: true };
      }
      return {
        allowed: false,
        status: 409,
        reason: "suspended in host_executor mode",
      };
    },
  };
}
