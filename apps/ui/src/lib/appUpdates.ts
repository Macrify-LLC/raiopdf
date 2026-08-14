import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type AppUpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
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

/**
 * Ceiling on a single update download.
 *
 * The updater plugin's `timeout` is a TOTAL request deadline — it maps onto the
 * HTTP client's request timeout, so it covers the whole body transfer rather
 * than stalls between chunks. That turns it into a minimum sustained connection
 * speed for the update artifact (roughly 400 MB): 60 minutes works out to about
 * 0.9 Mbps, where the previous 10-minute cap demanded ~5 Mbps and failed at
 * exactly ten minutes on every retry below it.
 *
 * It stays bounded rather than removed because the JS updater API offers no
 * idle timeout and no cancellation — without a deadline, a dead connection
 * would leave the UI sitting at "Downloading..." forever instead of reaching a
 * terminal state the user can act on.
 */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

const UPDATE_DOWNLOAD_ERROR_HEADLINE =
  "Update download could not be completed. Try again, or download the latest installer "
  + "directly from the RaioPDF GitHub releases page.";

/** Keeps a long or noisy underlying error from swamping the update pill. */
const UPDATE_ERROR_DETAIL_LIMIT = 200;

/**
 * Best-effort readable text for whatever the updater threw. Errors surfacing
 * from the Tauri plugin may be `Error` instances, plain strings, or bare
 * objects, so every shape gets handled instead of collapsing to
 * "[object Object]".
 */
function describeUpdateError(error: unknown): string {
  let text = "";

  if (typeof error === "string") {
    text = error;
  } else if (error instanceof Error) {
    text = error.message;
  } else if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      text = message;
    } else {
      try {
        const serialized = JSON.stringify(error);
        text = serialized && serialized !== "{}" ? serialized : "";
      } catch {
        text = "";
      }
    }
  } else if (error !== undefined && error !== null) {
    text = String(error);
  }

  text = text.replace(/\s+/g, " ").trim();
  if (text.length > UPDATE_ERROR_DETAIL_LIMIT) {
    text = `${text.slice(0, UPDATE_ERROR_DETAIL_LIMIT - 1).trimEnd()}...`;
  }
  return text;
}

/**
 * Message shown when an update download fails. Friendly headline first, then
 * the underlying error and how far the transfer got — enough to tell a timeout
 * apart from a dropped connection in a later report.
 */
export function formatUpdateDownloadError(
  error: unknown,
  lastProgress: number | null,
): string {
  const details: string[] = [];

  if (typeof lastProgress === "number" && Number.isFinite(lastProgress)) {
    const percent = Math.round(Math.min(1, Math.max(0, lastProgress)) * 100);
    details.push(`stopped at ${percent}%`);
  }

  const described = describeUpdateError(error);
  if (described) {
    details.push(described);
  }

  return details.length > 0
    ? `${UPDATE_DOWNLOAD_ERROR_HEADLINE} Details: ${details.join(" - ")}`
    : UPDATE_DOWNLOAD_ERROR_HEADLINE;
}

export async function checkForSignedUpdate(): Promise<Update | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: 15_000 });
}

/**
 * Downloads the update bytes only — does NOT install. The bytes are held in the
 * plugin's in-memory `Update` handle for this session; pass the SAME handle to
 * `installDownloadedUpdate` to finish. Nothing is written to the app or run
 * until the user explicitly installs.
 */
export async function downloadSignedUpdate(
  update: Update,
  onProgress: (progress: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await update.download((event: DownloadEvent) => {
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
  }, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
}

/**
 * Runs the installer for an already-downloaded update (the same `Update` handle
 * passed to `downloadSignedUpdate`). Only called on an explicit user action.
 */
export async function installDownloadedUpdate(update: Update): Promise<void> {
  await update.install();
}

export async function relaunchForInstalledUpdate(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
