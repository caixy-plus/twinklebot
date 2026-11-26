export interface BackendTraySnapshot {
  botCount: number;
  groupCount: number;
  scheduleCount: number;
  activeRunCount: number;
  relayConfigured: boolean;
}

export type ParentToWorkerMessage =
  | {
      type: "bootstrap";
      config: Record<string, any>;
      otaStatus?: Record<string, any> | null;
      effectivePublicDir?: string;
    }
  | {
      type: "graceful_shutdown";
      reason?: string;
    }
  | {
      type: "get_activity_status";
      reqId: string;
    }
  | {
      type: "wake_window_result";
      reqId: string;
      ok?: boolean;
      pid: number;
      windowVisible: boolean;
    }
  | {
      type: "ota_status_result";
      reqId: string;
      status: Record<string, any> | null;
    }
  | {
      type: "ota_confirm_result";
      reqId: string;
      status: Record<string, any> | null;
    }
  | {
      type: "ota_rollback_result";
      reqId: string;
      status: Record<string, any> | null;
      ok?: boolean;
      queuedForIdle?: boolean;
      activeRunCount?: number;
      error?: string;
    }
  | {
      type: "ota_apply_result";
      reqId: string;
      ok: boolean;
      queuedForIdle?: boolean;
      activeRunCount?: number;
      status?: Record<string, any> | null;
      deferredSwitch?: Record<string, any> | null;
      error?: string;
    }
  | {
      type: "ota_status_update";
      status: Record<string, any> | null;
    };

export type WorkerToParentMessage =
  | {
      type: "ready";
      pid: number;
      port: number;
      host: string;
      backendUrl: string;
      coreBuild: string;
      coreVersion: string;
      appVersion: string;
    }
  | {
      type: "tray_snapshot";
      snapshot: BackendTraySnapshot;
    }
  | {
      type: "activity_status";
      reqId: string;
      activeRunCount: number;
    }
  | {
      type: "wake_window";
      reqId: string;
    }
  | {
      type: "quit_app";
    }
  | {
      type: "ota_status_request";
      reqId: string;
    }
  | {
      type: "ota_confirm";
      reqId: string;
      webBuild?: string;
    }
  | {
      type: "ota_apply";
      reqId: string;
      bundleUrl: string;
      sha256: string;
      coreBuild: string;
      force?: boolean;
    }
  | {
      type: "ota_rollback";
      reqId: string;
      reason?: string;
      mode?: "previous" | "builtin";
      restart?: boolean;
    };
