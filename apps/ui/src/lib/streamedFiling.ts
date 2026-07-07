/**
 * Pure helpers for the streamed (large-document) Prepare-for-Filing branch.
 *
 * Streamed docs never materialize bytes, so the filing preflight runs from
 * `path_op_document_facts` (qpdf `--json`) instead of pdf-lib/pdf.js, the
 * checklist enables steps by the closed-form rule in `isFilingStepEnabled`
 * [R7-1], and the run composes engine-side via `path_op_prepare_filing`.
 * Checks the engine cannot compute on very large files render as "not
 * evaluated" — never as a silent pass.
 */

import type {
  DocumentFacts,
  PreflightCheck,
  PreflightReport,
  PrepPlanStep,
  PrepPlanStepId,
} from "@raiopdf/rules";
import {
  isFilingStepEnabled,
  type PathOpsDocumentFacts,
  type PathOpsPartPreflight,
  type PathOpsPrepareFilingPlan,
  type PathOpsStatus,
} from "./pathOps";

const POINTS_PER_INCH = 72;

/** Disabled-checkbox reason for steps with no registered path op [R7-1]. */
export const STREAMED_STEP_UNAVAILABLE_REASON =
  "not available for very large files yet";

/** Disabled-checkbox reason for streamed docs that do not have a shell grant. */
export const STREAMED_NO_GRANT_STEP_UNAVAILABLE_REASON =
  "Reopen this large PDF with File > Open in the desktop app to run filing steps.";

/** Detail for checks the facts-based preflight cannot evaluate. */
export const STREAMED_CHECK_NOT_EVALUATED =
  "Not evaluated for very large files.";

const STREAMED_REPORT_AUTHORITY = "RaioPDF local verification (document facts)";

/**
 * Map the shell's qpdf-derived facts onto the rules-package `DocumentFacts`
 * shape so `preflight()` and `resolvePrepPlan()` run unchanged. Facts qpdf
 * cannot provide stay `undefined`, which the preflight reports as unknown.
 */
export function mapPathOpsFactsToDocumentFacts(
  facts: PathOpsDocumentFacts,
  options: { filename?: string | undefined } = {},
): DocumentFacts {
  return {
    pages: facts.pages.map((page) => {
      const [llx, lly, urx, ury] = page.mediaBox;
      const rotated = page.rotate % 180 !== 0;
      const widthIn = (urx - llx) / POINTS_PER_INCH;
      const heightIn = (ury - lly) / POINTS_PER_INCH;

      return {
        pageIndex: page.index,
        size: {
          w: rotated ? heightIn : widthIn,
          h: rotated ? widthIn : heightIn,
          in: true as const,
        },
        orientation: page.orientation,
      };
    }),
    fileBytes: facts.sizeBytes,
    ...(options.filename ? { filename: options.filename } : {}),
    signatureDetection: facts.signatureDetection,
    signatureFieldCount: facts.signatureDetection.standardAcroFormSignatureCount,
    // A streamed document that RENDERS cannot carry an open password (pdf.js
    // would have demanded it before the first page appeared), so an /Encrypt
    // dictionary here means owner restrictions — decryptable with an empty
    // password, exactly like the byte pipeline's usage_restricted branch.
    encryptionState: facts.encrypted ? "usage_restricted" : "none",
  };
}

/**
 * Re-detail every check the facts-based preflight could not evaluate. The
 * status stays "unknown" (the chip reads "not checked"); the detail names WHY
 * so a huge scanned filing never silently passes a check nobody ran.
 */
export function annotateStreamedPreflight(report: PreflightReport): PreflightReport {
  const annotate = (check: PreflightCheck): PreflightCheck =>
    check.status === "unknown"
      ? { ...check, detail: STREAMED_CHECK_NOT_EVALUATED }
      : check;

  return {
    checks: report.checks.map(annotate),
    ...(report.selectionChecks
      ? { selectionChecks: report.selectionChecks.map(annotate) }
      : {}),
  };
}

/**
 * The closed-form checklist rule [R7-1], applied to a prep plan: a streamed
 * step is enabled ⟺ a registered path op implements it AND its toolchain is
 * available. Everything else renders as a disabled checkbox with an honest
 * reason. A `null` status (still loading, or the status call failed) disables
 * every step — fail closed, never fail open.
 */
export function buildStreamedUnavailableSteps(
  prepPlan: readonly PrepPlanStep[],
  status: PathOpsStatus | null,
  options: { hasGrant?: boolean } = {},
): ReadonlyMap<PrepPlanStepId, string> {
  const unavailable = new Map<PrepPlanStepId, string>();
  const reason = options.hasGrant === false
    ? STREAMED_NO_GRANT_STEP_UNAVAILABLE_REASON
    : STREAMED_STEP_UNAVAILABLE_REASON;

  for (const step of prepPlan) {
    if (options.hasGrant === false || !status || !isFilingStepEnabled(status, step.id)) {
      unavailable.set(step.id, reason);
    }
  }

  return unavailable;
}

/**
 * Translate the user's checklist selection into the engine-side
 * `prepare_filing` plan. Steps with no path implementation never appear here
 * — `buildStreamedUnavailableSteps` already kept them out of the selection.
 */
export function buildPrepareFilingPlan(
  selectedStepIds: readonly PrepPlanStepId[],
  options: {
    decryptPassword?: string | undefined;
    splitMaxBytes?: number | null | undefined;
  } = {},
): PathOpsPrepareFilingPlan {
  const selected = new Set(selectedStepIds);

  return {
    ...(options.decryptPassword !== undefined
      ? { decryptPassword: options.decryptPassword }
      : {}),
    sanitize: selected.has("sanitize-content"),
    normalize: selected.has("normalize-pages"),
    ocr: selected.has("make-searchable"),
    scrub: selected.has("scrub-metadata"),
    ...(selected.has("split-by-size") &&
    typeof options.splitMaxBytes === "number" &&
    options.splitMaxBytes > 0
      ? { splitMaxBytes: options.splitMaxBytes }
      : {}),
  };
}

/**
 * Output preflight for a streamed filing run, built from the per-part
 * `document_facts` the engine recomputed [R6-1]. Only the checks qpdf can
 * answer appear as pass/warn; everything else is one explicit "not
 * evaluated" row.
 */
export function buildStreamedFilingOutputReport(
  factsReport: readonly PathOpsPartPreflight[],
): PreflightReport {
  if (factsReport.length === 0) {
    return {
      checks: [
        streamedCheck("streamed-output-facts", "Output preflight", "unknown", STREAMED_CHECK_NOT_EVALUATED),
      ],
    };
  }

  const partCount = factsReport.length;
  const partNoun = partCount === 1 ? "part" : "parts";
  const nonLetterParts = factsReport.filter((part) => !part.allLetterPortrait);
  const encryptedParts = factsReport.filter((part) => part.encrypted);
  const capChecked = factsReport.some((part) => part.withinByteCap !== null);
  const overCapParts = factsReport.filter((part) => part.withinByteCap === false);

  return {
    checks: [
      streamedCheck(
        "streamed-page-format",
        "Letter-size portrait pages",
        nonLetterParts.length === 0 ? "pass" : "warn",
        nonLetterParts.length === 0
          ? `All ${partCount} output ${partNoun} are letter-size portrait.`
          : `${describeParts(nonLetterParts)} ${nonLetterParts.length === 1 ? "has" : "have"} pages that are not letter-size portrait.`,
      ),
      streamedCheck(
        "streamed-encryption",
        "Encryption removed",
        encryptedParts.length === 0 ? "pass" : "warn",
        encryptedParts.length === 0
          ? "No output part is encrypted."
          : `${describeParts(encryptedParts)} still ${encryptedParts.length === 1 ? "reports" : "report"} encryption.`,
      ),
      streamedCheck(
        "streamed-size-cap",
        "Split byte cap",
        !capChecked ? "unknown" : overCapParts.length === 0 ? "pass" : "warn",
        !capChecked
          ? "No split cap was requested for this run."
          : overCapParts.length === 0
            ? `All ${partCount} ${partNoun} are within the configured byte cap.`
            : `${describeParts(overCapParts)} ${overCapParts.length === 1 ? "exceeds" : "exceed"} the byte cap (a single page may be larger than the cap).`,
      ),
      streamedCheck(
        "streamed-other-checks",
        "Other filing checks",
        "unknown",
        STREAMED_CHECK_NOT_EVALUATED,
      ),
    ],
  };
}

function streamedCheck(
  checkId: string,
  label: string,
  status: PreflightCheck["status"],
  detail: string,
): PreflightCheck {
  return {
    checkId,
    label,
    authority: STREAMED_REPORT_AUTHORITY,
    detail,
    kind: "rule",
    status,
  };
}

function describeParts(parts: readonly PathOpsPartPreflight[]): string {
  const numbers = parts.map((part) => part.partIndex + 1).join(", ");
  return `${parts.length === 1 ? "Part" : "Parts"} ${numbers}`;
}
