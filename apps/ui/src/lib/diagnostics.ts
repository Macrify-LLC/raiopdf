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

/**
 * Serialize an error and its full `cause` chain (plus any `code`) into one
 * compact line. The user-facing message deliberately hides the underlying
 * engine / transport / subprocess text (e.g. a fetch transport failure behind
 * "Local engine request failed.", or an "os error 10035" the friendly copy
 * never shows) — this preserves it for the diagnostics log so the real cause of
 * a mapped error stays recoverable from app.log / the diagnostics export.
 */
export function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; current != null && depth < 8; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);

    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      const label = typeof code === "string" && code ? `${current.name}[${code}]` : current.name;
      parts.push(`${label}: ${current.message}`);
      current = (current as { cause?: unknown }).cause;
      continue;
    }

    parts.push(typeof current === "string" ? current : String(current));
    break;
  }

  return parts.join(" <- ") || "unknown error";
}

/**
 * Record a workflow failure to the diagnostics log with the RAW error chain
 * (not the user-facing message), so the true cause behind a mapped message like
 * "could not find one of the selected files" is recoverable from app.log and
 * the diagnostics export. Fire-and-forget; never throws.
 */
export function logWorkflowFailure(
  kind: string,
  error: unknown,
  details: ReadonlyArray<string | null | undefined> = [],
): void {
  void recordDiagnosticEvent(kind, describeErrorChain(error), [
    ...details,
    error instanceof Error && error.stack ? error.stack : null,
  ]);
}

async function getTauriInvoke(): Promise<TauriInvoke> {
  if (window.__RAIOPDF_TEST_TAURI_INVOKE__) {
    return window.__RAIOPDF_TEST_TAURI_INVOKE__;
  }

  const { invoke } = await import("@tauri-apps/api/core");

  return invoke;
}
