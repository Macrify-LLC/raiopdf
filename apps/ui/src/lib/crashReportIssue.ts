import type { CrashReportPayload } from "../components/CrashReportDialog";

export const CRASH_REPORT_ISSUE_URL_MAX_LENGTH = 6500;
export const CRASH_REPORT_ISSUE_TRUNCATION_NOTE =
  "\n[Truncated to fit a shareable link — open File → Export Diagnostics in RaioPDF for the complete report.]";

export function fitCrashReportPayloadToIssueUrl(
  payload: CrashReportPayload,
  maxUrlLength = CRASH_REPORT_ISSUE_URL_MAX_LENGTH,
): CrashReportPayload {
  if (buildCrashReportIssueUrl(payload).length <= maxUrlLength) {
    return payload;
  }

  let low = 0;
  let high = payload.body.length;
  let fittedBody = appendCrashReportTruncationNote("");

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidateBody = appendCrashReportTruncationNote(
      trimCrashReportBodyToLineBoundary(payload.body, midpoint),
    );
    const candidatePayload = { ...payload, body: candidateBody };

    if (buildCrashReportIssueUrl(candidatePayload).length <= maxUrlLength) {
      fittedBody = candidateBody;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return { ...payload, body: fittedBody };
}

export function buildCrashReportIssueUrl(payload: CrashReportPayload): string {
  const params = new URLSearchParams({
    title: payload.title,
    body: payload.body,
    labels: "crash",
  });

  return `https://github.com/Macrify-LLC/raiopdf/issues/new?${params.toString()}`;
}

function trimCrashReportBodyToLineBoundary(body: string, maxChars: number): string {
  if (body.length <= maxChars) {
    return body.trimEnd();
  }

  const prefix = body.slice(0, Math.max(0, maxChars));
  const lineBreakIndex = prefix.lastIndexOf("\n");

  if (lineBreakIndex <= 0) {
    return prefix.trimEnd();
  }

  return prefix.slice(0, lineBreakIndex).trimEnd();
}

function appendCrashReportTruncationNote(body: string): string {
  return `${body.trimEnd()}${CRASH_REPORT_ISSUE_TRUNCATION_NOTE}`;
}
