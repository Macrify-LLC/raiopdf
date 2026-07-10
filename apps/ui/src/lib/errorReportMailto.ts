import type { DiagnosticEntry } from "./diagnostics";

/**
 * The address the "Email a report" button on the error surfaces drafts to. Same
 * alias the crash-report dialog uses, so all self-reported problems land in one
 * inbox. Nothing is sent automatically -- the button only opens the user's own
 * mail client with a prefilled draft they review and send themselves.
 */
export const ERROR_REPORT_EMAIL = "crash-reports@macrify.me";

export const ERROR_REPORT_SUBJECT = "RaioPDF error report";

// A whole `mailto:` URL longer than this risks being truncated or rejected by
// the OS handler, so the technical detail is trimmed to fit under it. The rest
// of the body (labels, version, system) is tiny, so in practice only a very
// long error chain ever triggers trimming.
export const ERROR_REPORT_MAILTO_MAX_LENGTH = 1800;

const TECHNICAL_TRUNCATION_NOTE =
  " […trimmed — use File → Export Diagnostics for the full log]";

export interface ErrorReportContext {
  /** The most recent captured error, or null to draft a blank report. */
  diagnostic: DiagnosticEntry | null;
  /** App version (best-effort; null when it can't be read). */
  appVersion: string | null;
  /** `navigator.userAgent` — carries the OS/build for triage. */
  userAgent: string;
}

/**
 * Build a `mailto:` link that drafts an error report to {@link ERROR_REPORT_EMAIL}.
 * The body leads with a prompt the user can fill in, then a technical block
 * (app version, system, and the captured error) with any file paths scrubbed so
 * a local path never leaves the machine. The user sees and edits the whole draft
 * before it sends — nothing leaves until they hit send in their mail client.
 */
export function buildErrorReportMailto(context: ErrorReportContext): string {
  const body = fitBodyToMailtoLength(context);
  const query = `subject=${encodeURIComponent(ERROR_REPORT_SUBJECT)}&body=${encodeURIComponent(body)}`;
  return `mailto:${ERROR_REPORT_EMAIL}?${query}`;
}

function fitBodyToMailtoLength(context: ErrorReportContext): string {
  const full = composeBody(context, null);
  if (mailtoLength(full) <= ERROR_REPORT_MAILTO_MAX_LENGTH) {
    return full;
  }

  // Only the technical detail is unbounded, so binary-search its length until
  // the whole mailto fits. Everything else (prompt, version, system) is fixed.
  const detail = technicalDetail(context.diagnostic);
  let low = 0;
  let high = detail.length;
  let fitted = composeBody(context, "");

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateDetail = `${detail.slice(0, mid).trimEnd()}${TECHNICAL_TRUNCATION_NOTE}`;
    const candidate = composeBody(context, candidateDetail);
    if (mailtoLength(candidate) <= ERROR_REPORT_MAILTO_MAX_LENGTH) {
      fitted = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return fitted;
}

/**
 * Assemble the email body. When `detailOverride` is null the full technical
 * detail is used; pass a string to substitute a trimmed version (see fitting).
 */
function composeBody(context: ErrorReportContext, detailOverride: string | null): string {
  const { diagnostic, appVersion, userAgent } = context;
  const detail = detailOverride ?? technicalDetail(diagnostic);

  const lines: string[] = [
    "What were you doing when this happened? (optional — it helps a lot)",
    "",
    "",
    "———",
    "Technical details (please keep these):",
    `App version: ${appVersion ?? "unknown"}`,
    `System: ${scrubFilePaths(userAgent) || "unknown"}`,
  ];

  if (diagnostic) {
    lines.push(`When: ${new Date(diagnostic.at).toISOString()}`);
    lines.push(`Where: ${diagnostic.kind}`);
    lines.push("");
    lines.push(detail);
  } else {
    lines.push("");
    lines.push("(No recent error was captured — describe the problem above.)");
  }

  return lines.join("\n");
}

function technicalDetail(diagnostic: DiagnosticEntry | null): string {
  if (!diagnostic) {
    return "";
  }

  const parts = [diagnostic.message];
  if (diagnostic.details) {
    parts.push(diagnostic.details);
  }
  return scrubFilePaths(parts.join("\n"));
}

function mailtoLength(body: string): number {
  return `mailto:${ERROR_REPORT_EMAIL}?subject=${encodeURIComponent(
    ERROR_REPORT_SUBJECT,
  )}&body=${encodeURIComponent(body)}`.length;
}

// Replace absolute filesystem paths with a placeholder so a local path (which
// can carry a client/matter name) never rides along in the report.
//
// Spaces are deliberately allowed *inside* a path: Windows paths routinely
// contain them (`C:\Users\Jane Doe\Matter\complaint.pdf`), so a scrubber that
// stopped at the first space would leave the rest of the path exposed. Instead
// a path runs until a hard terminator -- a line break, a quote/backtick, the
// error-chain separator's angle brackets, or a Windows-illegal filename char
// (`| ? * :`). That can over-remove a trailing word of prose, which is the safe
// direction for a privacy scrubber, and it stops at ` <- ` so later clauses in
// an error chain survive.
// `[^\r\n"'`<>|?*:]` is the "path body" character set: everything except the
// hard terminators. Note it includes space, `\`, `/`, and `.`.
const WINDOWS_PATH = /[A-Za-z]:[\\/][^\r\n"'`<>|?*:]*/gu;
const UNC_PATH = /\\\\[^\r\n"'`<>|?*:]+/gu;
// A unix path must start with `/` at a word boundary (so "and/or" or "6/9" in
// prose isn't matched) and have a non-space first segment char.
const UNIX_PATH = /(?<=^|[\s("'`])\/[^\s\r\n"'`<>|?*:][^\r\n"'`<>|?*:]*/gu;

export function scrubFilePaths(value: string): string {
  return value
    .replace(UNC_PATH, "[path removed]")
    .replace(WINDOWS_PATH, "[path removed]")
    .replace(UNIX_PATH, "[path removed]");
}
