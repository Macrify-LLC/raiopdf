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

import { getTauriInvoke } from "./tauriInvoke";

/**
 * A diagnostic event, retained in memory so the user can attach the most recent
 * one to an email report ("Email a report" button on the error surfaces). This
 * is the same data already sent to the Tauri log -- kept here only so the report
 * builder can read the last failure without threading error objects through
 * every workflow's React state.
 */
export interface DiagnosticEntry {
  kind: string;
  /** Raw error chain (from `describeErrorChain`) or the raw message the caller logged. */
  message: string;
  details: string | null;
  /** Epoch milliseconds when the event was recorded. */
  at: number;
}

// Small ring buffer of the most recent diagnostic events. Errors are the only
// thing recorded through this funnel today (workflow failures + the window-level
// error/unhandledrejection handlers), so the last entry is the last error.
const RECENT_DIAGNOSTICS_LIMIT = 10;
const recentDiagnostics: DiagnosticEntry[] = [];

/** Newest-last snapshot of the recent diagnostics ring buffer. */
export function getRecentDiagnostics(): readonly DiagnosticEntry[] {
  return recentDiagnostics.slice();
}

/** The most recently recorded diagnostic event, or null if none this session. */
export function getLastDiagnostic(): DiagnosticEntry | null {
  return recentDiagnostics.at(-1) ?? null;
}

export async function recordDiagnosticEvent(
  kind: string,
  message: string,
  details: ReadonlyArray<string | null | undefined> = [],
): Promise<void> {
  const joinedDetails =
    details.filter((detail): detail is string => Boolean(detail)).join(" | ") || null;

  // Retain in memory first, unconditionally: the report builder must still see
  // the last error even when the Tauri log write is unavailable (browser/tests)
  // or fails. Capturing here also covers every caller (logWorkflowFailure and
  // the window-level handlers) with no per-site change.
  recentDiagnostics.push({ kind, message, details: joinedDetails, at: Date.now() });
  if (recentDiagnostics.length > RECENT_DIAGNOSTICS_LIMIT) {
    recentDiagnostics.shift();
  }

  try {
    const invoke = await getTauriInvoke();
    await invoke("diagnostics_record_event", {
      event: {
        source: "ui",
        kind,
        message,
        details: joinedDetails,
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

// getTauriInvoke is provided by ./tauriInvoke (single shared seam).
