/**
 * Shared UI-side diagnostics logging.
 *
 * Every UI error path funnels through the existing Tauri
 * `diagnostics_record_event` command -- the same one the window-level
 * `error`/`unhandledrejection` handlers in `main.tsx` already use -- so
 * there is one log file (app.log) and one place to look, per the
 * 2026-07-03 live-test fix plan (decided: reuse app.log, tag `source: "ui"`,
 * no new logging command).
 */

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __RAIOPDF_TEST_TAURI_INVOKE__?: TauriInvoke;
  }
}

export async function recordDiagnosticEvent(
  kind: string,
  message: string,
  details: ReadonlyArray<string | null | undefined> = [],
): Promise<void> {
  try {
    const invoke = await getTauriInvoke();
    await invoke("diagnostics_record_event", {
      event: {
        source: "ui",
        kind,
        message,
        details: details.filter((detail): detail is string => Boolean(detail)).join(" | ") || null,
      },
    });
  } catch {
    // Diagnostics must never create a second user-facing failure.
  }
}

async function getTauriInvoke(): Promise<TauriInvoke> {
  if (window.__RAIOPDF_TEST_TAURI_INVOKE__) {
    return window.__RAIOPDF_TEST_TAURI_INVOKE__;
  }

  const { invoke } = await import("@tauri-apps/api/core");

  return invoke;
}
