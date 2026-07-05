import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type AppUpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installed"
  | "error";

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  message: string;
  currentVersion?: string | undefined;
  availableVersion?: string | undefined;
  progress?: number | null | undefined;
}

export const UPDATE_UNAVAILABLE_STATUS: AppUpdateStatus = {
  phase: "unavailable",
  message: "Update checks run in the signed desktop app.",
};

export const UPDATE_IDLE_STATUS: AppUpdateStatus = {
  phase: "idle",
  message: "RaioPDF checks GitHub for signed release metadata.",
};

export function isUpdaterRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function checkForSignedUpdate(): Promise<Update | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: 15_000 });
}

export async function installSignedUpdate(
  update: Update,
  onProgress: (progress: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      downloaded = 0;
      total = event.data.contentLength ?? null;
      onProgress(total ? 0 : null);
      return;
    }

    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress(total ? Math.min(1, downloaded / total) : null);
      return;
    }

    onProgress(1);
  }, { timeout: 10 * 60_000 });
}

export async function relaunchForInstalledUpdate(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
