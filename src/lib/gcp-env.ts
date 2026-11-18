import type { DeployEnv } from "../shared/config.js";

export interface GcpEnvironmentProbe {
  isGcpServer: boolean;
  projectId: string;
  reason:
    | "verified_gcp_metadata"
    | "local_deploy_env"
    | "metadata_missing_google_flavor"
    | "metadata_unreachable";
}

export interface GeminiVertexRuntime {
  isGcpServer: boolean;
  vertexRequested: boolean;
  vertexActive: boolean;
  project: string;
  location: string;
  blockedReason: string;
}

const GCP_METADATA_PROJECT_URL =
  "http://169.254.169.254/computeMetadata/v1/project/project-id";

/**
 * Verifies whether the current process is genuinely running on Google Cloud (GCP)
 * server infrastructure (GCE VM / Cloud Run / GKE) in `DEPLOY_ENV=cloud` mode.
 *
 * - Local mode (`DEPLOY_ENV !== "cloud"`) is unconditionally rejected without network I/O.
 * - Non-GCP cloud providers (e.g. Alibaba Cloud ECS, AWS EC2, Tencent Cloud) either do not
 *   implement `/computeMetadata/v1/project/project-id` or do not return `Metadata-Flavor: Google`.
 */
export async function probeGcpServerEnvironment({
  deployEnv,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1200,
}: {
  deployEnv: DeployEnv | string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<GcpEnvironmentProbe> {
  if (deployEnv !== "cloud") {
    return {
      isGcpServer: false,
      projectId: "",
      reason: "local_deploy_env",
    };
  }

  if (typeof fetchImpl !== "function") {
    return {
      isGcpServer: false,
      projectId: "",
      reason: "metadata_unreachable",
    };
  }

  try {
    const signal =
      typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    const res = await fetchImpl(GCP_METADATA_PROJECT_URL, {
      method: "GET",
      headers: {
        "Metadata-Flavor": "Google",
      },
      ...(signal ? { signal } : {}),
    });

    const flavor = String(res.headers?.get?.("metadata-flavor") || "")
      .trim()
      .toLowerCase();
    if (!res.ok || flavor !== "google") {
      return {
        isGcpServer: false,
        projectId: "",
        reason: "metadata_missing_google_flavor",
      };
    }

    const projectId = String(await res.text()).trim();
    if (!projectId || !/^[a-z][a-z0-9.:-]{2,62}$/i.test(projectId)) {
      return {
        isGcpServer: false,
        projectId: "",
        reason: "metadata_missing_google_flavor",
      };
    }

    return {
      isGcpServer: true,
      projectId,
      reason: "verified_gcp_metadata",
    };
  } catch {
    return {
      isGcpServer: false,
      projectId: "",
      reason: "metadata_unreachable",
    };
  }
}

export function isVertexEnvRequested(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = String(env?.GOOGLE_GENAI_USE_VERTEXAI || "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "1";
}

/**
 * Computes the effective Vertex AI runtime policy for `Google Gemini`.
 * Vertex AI is ONLY activated when running on a verified GCP Cloud Server with
 * `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`.
 */
export function resolveGeminiVertexRuntime({
  deployEnv,
  env = process.env,
  gcpProbe,
}: {
  deployEnv: DeployEnv | string;
  env?: Record<string, string | undefined>;
  gcpProbe?: GcpEnvironmentProbe | null;
}): GeminiVertexRuntime {
  const isGcpServer = deployEnv === "cloud" && Boolean(gcpProbe?.isGcpServer);
  const vertexRequested = isVertexEnvRequested(env);

  if (!vertexRequested) {
    return {
      isGcpServer,
      vertexRequested: false,
      vertexActive: false,
      project: "",
      location: "",
      blockedReason: "",
    };
  }

  if (!isGcpServer) {
    return {
      isGcpServer: false,
      vertexRequested: true,
      vertexActive: false,
      project: "",
      location: "",
      blockedReason:
        "Vertex AI 仅支持 GCP 云服务器部署，当前环境请配置 GEMINI_API_KEY (AI Studio)",
    };
  }

  const project = String(
    env?.GOOGLE_CLOUD_PROJECT || gcpProbe?.projectId || ""
  ).trim();
  const location = String(env?.GOOGLE_CLOUD_LOCATION || "").trim();

  if (!project || !location) {
    return {
      isGcpServer: true,
      vertexRequested: true,
      vertexActive: false,
      project,
      location,
      blockedReason:
        "GCP Vertex AI 需同时设置 GOOGLE_GENAI_USE_VERTEXAI=true、GOOGLE_CLOUD_PROJECT 与 GOOGLE_CLOUD_LOCATION",
    };
  }

  return {
    isGcpServer: true,
    vertexRequested: true,
    vertexActive: true,
    project,
    location,
    blockedReason: "",
  };
}
