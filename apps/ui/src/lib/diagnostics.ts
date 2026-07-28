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
// Value import is safe: errorReportMailto only imports a TYPE from here, which is
// erased, so there is no runtime cycle.
import { scrubFilePaths } from "./errorReportMailto";

/**
 * A diagnostic event, retained in memory so a report surface can attach the
 * failure it is displaying. This is the same data already sent to the Tauri log
 * -- kept here only so a report builder can read a failure back by id without
 * threading error objects through every workflow's React state.
 */
export interface DiagnosticEntry {
  /**
   * Short correlation id, minted when the event is recorded and echoed into the
   * `app.log` line as `id=<id>`.
   *
   * This is what makes a report about *this* failure rather than "whatever
   * happened most recently." A failure surface stores the id its own catch block
   * produced, so the report it offers can never pick up an unrelated error --
   * and because the id is in the log, it survives the process boundary and a
   * later reader can grep the durable log for the same failure.
   */
  id: string;
  kind: string;
  /** Raw error chain (from `describeErrorChain`) or the raw message the caller logged. */
  message: string;
  details: string | null;
  /** Epoch milliseconds when the event was recorded. */
  at: number;
}

/**
 * A failure as displayed to the user: the message on screen, paired with the
 * correlation id of the diagnostic behind it (null when the message is a gate or
 * a nudge, which record nothing).
 *
 * Kept as ONE value rather than two parallel fields so the pair cannot drift.
 * With two fields, every path that clears the message has to remember to clear
 * the id too, and a missed one leaves a stale id attached to the next message.
 */
export interface DisplayedFailure {
  message: string;
  diagnosticId: string | null;
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


/**
 * Look a retained diagnostic back up by the id its recording returned. Null once
 * the entry has aged out of the ring buffer (or in a later process -- the log is
 * the durable copy).
 */
export function getDiagnosticById(id: string): DiagnosticEntry | null {
  return recentDiagnostics.find((entry) => entry.id === id) ?? null;
}

/** Drop all retained diagnostics. Tests only -- the ring is module state. */
export function resetDiagnosticsForTests(): void {
  recentDiagnostics.length = 0;
}

/**
 * Mint a correlation id. Short and log-token-safe (the shell's `log_token`
 * keeps only `[A-Za-z0-9_.-]`) so it stays greppable in `app.log` and readable
 * when a human or an assistant has to quote it back.
 */
export function newDiagnosticId(): string {
  const bytes = new Uint8Array(4);
  const webCrypto = globalThis.crypto;

  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    // Non-Tauri/older test environments. Uniqueness only has to hold within one
    // log tail, so Math.random is sufficient here.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `d-${suffix}`;
}

/**
 * Record a diagnostic event and return its correlation id.
 *
 * Synchronous by design: the caller is usually a catch block that has to put the
 * id straight into React state alongside the user-facing message, which it can't
 * do if the id is only available a microtask later. The Tauri log write is fired
 * as a floating promise -- no caller has ever awaited this for ordering.
 */
export function recordDiagnosticEvent(
  kind: string,
  message: string,
  details: ReadonlyArray<string | null | undefined> = [],
): string {
  const joinedDetails =
    details.filter((detail): detail is string => Boolean(detail)).join(" | ") || null;
  const id = newDiagnosticId();

  // Retain in memory first, unconditionally: a report surface must still resolve
  // its id even when the Tauri log write is unavailable (browser/tests) or fails.
  // Capturing here also covers every caller (logWorkflowFailure and the
  // window-level handlers) with no per-site change.
  recentDiagnostics.push({ id, kind, message, details: joinedDetails, at: Date.now() });
  if (recentDiagnostics.length > RECENT_DIAGNOSTICS_LIMIT) {
    recentDiagnostics.shift();
  }

  void writeDiagnosticToLog({ id, kind, message, details: joinedDetails });

  return id;
}

/**
 * Hand one diagnostic to the shell's log. Fire-and-forget by design: a failed log
 * write must never surface as a second failure to the user.
 */
async function writeDiagnosticToLog(event: {
  id: string;
  kind: string;
  message: string;
  details: string | null;
}): Promise<void> {
  try {
    const invoke = await getTauriInvoke();
    await invoke("diagnostics_record_event", { event: { source: "ui", ...event } });
  } catch {
    // Diagnostics must never create a second user-facing failure.
  }
}

/**
 * Run text through the shell's canonical redaction policy.
 *
 * This is the ONE policy: the same Rust scrubber the diagnostics export, the crash
 * payload, and the MCP diagnostics tool all use. It removes file paths (Windows,
 * UNC/network-share and POSIX), file names, email addresses, SSN- and phone-shaped
 * digits, long digit runs and long quoted strings, while deliberately preserving
 * `unix:<seconds>` timestamps so events stay orderable.
 *
 * FAILS CLOSED in the packaged app. If the shell is present but the call fails,
 * this throws rather than quietly downgrading to the renderer's path-only
 * {@link scrubFilePaths} — because the copy the user is about to make asserts the
 * text was already scrubbed, and the weaker path leaves email addresses,
 * SSN/phone-shaped digits and quoted names in place. A shell that can't answer is
 * also entirely plausible here: it may be the very failure being diagnosed.
 *
 * Outside a Tauri runtime (a browser dev server, a unit test) there is no shell to
 * ask, and the path-only scrubber is used as defence in depth. That is why anything
 * user-facing describing what gets removed must describe the PACKAGED app's
 * behaviour, i.e. the Rust policy.
 */
export class RedactionUnavailableError extends Error {
  constructor(cause: unknown) {
    super("RaioPDF could not redact the diagnostic text.", { cause });
    this.name = "RedactionUnavailableError";
  }
}

export async function scrubDiagnosticText(text: string): Promise<string> {
  if (!text) {
    return text;
  }

  const inShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  try {
    const invoke = await getTauriInvoke();
    return await invoke<string>("diagnostics_scrub_text", { text });
  } catch (error: unknown) {
    if (inShell) {
      throw new RedactionUnavailableError(error);
    }
    return scrubFilePaths(text);
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
 * the diagnostics export. Never throws.
 *
 * Returns the correlation id. Store it next to the user-facing message you set
 * in the same catch block -- that pairing is what lets the failure's own report
 * surface offer a report about this failure and nothing else.
 */
export function logWorkflowFailure(
  kind: string,
  error: unknown,
  details: ReadonlyArray<string | null | undefined> = [],
): string {
  return recordDiagnosticEvent(kind, describeErrorChain(error), [
    ...details,
    error instanceof Error && error.stack ? error.stack : null,
  ]);
}

// getTauriInvoke is provided by ./tauriInvoke (single shared seam).
