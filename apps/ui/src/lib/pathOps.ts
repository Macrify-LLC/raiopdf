/**
 * Typed client for the PathOpsEngine — the shell's path-based delegated-ops
 * layer for large documents (large-pdf-handling plan, Phase 3).
 *
 * Every op is file→file on the shell side: inputs are FILE GRANTS (the opaque
 * identifiers the shell hands out for paths — see the grant-vs-path invariant
 * in `filePort.ts`), outputs come back as fresh grants plus metadata. Document
 * bytes never cross into the WebView.
 *
 * This module is intentionally NOT wired into App.tsx or any workspace —
 * integration owns that. It is also Tauri-only: the browser runtime has no
 * file grants, so every call throws `PathOpsUnavailableError` there (callers
 * gate on `isPathOpsRuntime()` first).
 */

import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { PrepPlanStepId } from "@raiopdf/rules";

/**
 * A shell file grant. Integration note: once Lane A's branded `FileGrant`
 * alias lands in `filePort.ts`, this alias should point at it.
 */
export type PathOpsFileGrant = string;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PathOpErrorCode =
  | "TOOLCHAIN_MISSING"
  | "INVALID_INPUT"
  | "OP_FAILED"
  | "VERIFICATION_FAILED"
  | "IO_ERROR"
  | "FILE_CHANGED";

/** Shape of the serialized Rust `PathOpError`. */
export interface PathOpErrorPayload {
  code: PathOpErrorCode;
  message: string;
}

export class PathOpsError extends Error {
  readonly code: PathOpErrorCode;

  constructor(payload: PathOpErrorPayload) {
    super(payload.message);
    this.name = "PathOpsError";
    this.code = payload.code;
  }
}

export class PathOpsUnavailableError extends Error {
  constructor() {
    super("Path-based engine ops are only available in the desktop app.");
    this.name = "PathOpsUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Response types (mirror apps/shell/src-tauri/src/path_ops.rs)
// ---------------------------------------------------------------------------

export interface PathOpsToolchainStatus {
  qpdf: boolean;
  ghostscript: boolean;
  ocrmypdf: boolean;
}

export interface PathOpStatusEntry {
  name: string;
  available: boolean;
  missingTools: string[];
  filingStep: string | null;
}

export interface PathOpsStatus {
  ops: PathOpStatusEntry[];
  toolchain: PathOpsToolchainStatus;
  /**
   * Every `PrepPlanStepId` → the registered path op implementing it, or null.
   * See `isFilingStepEnabled` for the closed-form checklist rule.
   */
  filingSteps: Record<string, string | null>;
}

export interface PathOpsPageFacts {
  index: number;
  /** Raw MediaBox `[llx, lly, urx, ury]` in PDF points (pre-rotation). */
  mediaBox: [number, number, number, number];
  rotate: number;
  orientation: "portrait" | "landscape";
  letterPortrait: boolean;
}

export interface PathOpsDocumentFacts {
  pageCount: number;
  sizeBytes: number;
  encrypted: boolean;
  pages: PathOpsPageFacts[];
}

export interface PathOpReport {
  op: string;
  tool: string;
  durationMs: number;
  inputSizeBytes: number;
  outputSizeBytes: number;
  notes: string[];
}

export interface PathOpOutput {
  outputGrant: PathOpsFileGrant;
  name: string;
  sizeBytes: number;
  pageCount: number;
  opReport: PathOpReport;
}

export interface PathOpsSplitPart {
  outputGrant: PathOpsFileGrant;
  name: string;
  /** Zero-based source page indexes included in this part (contiguous). */
  pageIndexes: number[];
  byteLength: number;
  /** True when a single source page cannot fit within the byte cap. */
  oversized: boolean;
}

export interface PathOpsSplitResult {
  parts: PathOpsSplitPart[];
  opReport: PathOpReport;
}

export interface PathOpsAreaVerification {
  pageIndex: number;
  pass: boolean;
}

export interface PathOpsRedactionVerification {
  /** Always true on success — verification failure rejects the whole op. */
  verified: boolean;
  method: string;
  areas: PathOpsAreaVerification[];
}

export interface PathOpsRedactResult {
  outputGrant: PathOpsFileGrant;
  name: string;
  sizeBytes: number;
  pageCount: number;
  verification: PathOpsRedactionVerification;
  opReport: PathOpReport;
}

/** Steps for the reduced, fully path-based filing pipeline. */
export interface PathOpsPrepareFilingPlan {
  /** remove-encryption: decrypt with this password ("" = owner-restricted). */
  decryptPassword?: string;
  /** sanitize-content (Ghostscript rewrite). */
  sanitize?: boolean;
  /** normalize-pages to letter portrait (Ghostscript). */
  normalize?: boolean;
  /** make-searchable (OCRmyPDF by-path). */
  ocr?: boolean;
  /** scrub-metadata (qpdf). */
  scrub?: boolean;
  /** split-by-size cap in bytes; omit for a single output part. */
  splitMaxBytes?: number;
}

export interface PathOpsPartPreflight {
  partIndex: number;
  pageCount: number;
  sizeBytes: number;
  encrypted: boolean;
  allLetterPortrait: boolean;
  /** Null when no split cap was requested. */
  withinByteCap: boolean | null;
}

export interface PathOpsFilingStepReport {
  step: string;
  tool: string;
  outputSizeBytes: number;
}

export interface PathOpsPrepareFilingResult {
  parts: PathOpsSplitPart[];
  factsReport: PathOpsPartPreflight[];
  steps: PathOpsFilingStepReport[];
  opReport: PathOpReport;
}

// ---------------------------------------------------------------------------
// The closed-form filing checklist rule [R7-1]
// ---------------------------------------------------------------------------

/**
 * A streamed-mode filing checklist step is enabled ⟺ a registered path op
 * implements it AND that op's toolchain is available. This function IS the
 * rule — the UI must not hand-maintain a step list.
 */
export function isFilingStepEnabled(
  status: PathOpsStatus,
  stepId: PrepPlanStepId,
): boolean {
  const opName = status.filingSteps[stepId];
  if (!opName) {
    return false;
  }
  const op = status.ops.find((entry) => entry.name === opName);
  return op?.available ?? false;
}

// ---------------------------------------------------------------------------
// Runtime guard + invoke plumbing
// ---------------------------------------------------------------------------

export function isPathOpsRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function invokePathOp<T>(
  command: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (!isPathOpsRuntime()) {
    throw new PathOpsUnavailableError();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(command, payload);
  } catch (error) {
    if (isPathOpErrorPayload(error)) {
      throw new PathOpsError(error);
    }
    throw error;
  }
}

function isPathOpErrorPayload(value: unknown): value is PathOpErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PathOpErrorPayload).code === "string" &&
    typeof (value as PathOpErrorPayload).message === "string"
  );
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export function pathOpsStatus(): Promise<PathOpsStatus> {
  return invokePathOp("path_ops_status", {});
}

export async function pathOpPageCount(grant: PathOpsFileGrant): Promise<number> {
  const response = await invokePathOp<{ pageCount: number }>(
    "path_op_page_count",
    { grant },
  );
  return response.pageCount;
}

export function pathOpDocumentFacts(
  grant: PathOpsFileGrant,
): Promise<PathOpsDocumentFacts> {
  return invokePathOp("path_op_document_facts", { grant });
}

export function pathOpDecrypt(
  grant: PathOpsFileGrant,
  password: string,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_decrypt", { grant, password });
}

export function pathOpExtractPages(
  grant: PathOpsFileGrant,
  pageIndexes: readonly number[],
): Promise<PathOpOutput> {
  return invokePathOp("path_op_extract_pages", {
    grant,
    pageIndexes: [...pageIndexes],
  });
}

export function pathOpMerge(
  inputGrants: readonly PathOpsFileGrant[],
): Promise<PathOpOutput> {
  return invokePathOp("path_op_merge", { inputGrants: [...inputGrants] });
}

export function pathOpSplitByMaxBytes(
  grant: PathOpsFileGrant,
  maxBytes: number,
): Promise<PathOpsSplitResult> {
  return invokePathOp("path_op_split_by_max_bytes", { grant, maxBytes });
}

export function pathOpPrepareFiling(
  grant: PathOpsFileGrant,
  plan: PathOpsPrepareFilingPlan,
): Promise<PathOpsPrepareFilingResult> {
  return invokePathOp("path_op_prepare_filing", { grant, plan });
}

export function pathOpOcr(grant: PathOpsFileGrant): Promise<PathOpOutput> {
  return invokePathOp("path_op_ocr", { grant });
}

export function pathOpRepair(grant: PathOpsFileGrant): Promise<PathOpOutput> {
  return invokePathOp("path_op_repair", { grant });
}

/**
 * True area redaction with engine-side, fail-closed verification: the shell
 * re-extracts text from the redacted regions of the OUTPUT file; any
 * recoverable text (or any inability to verify) rejects with
 * `VERIFICATION_FAILED` and no output grant ever exists.
 */
export function pathOpRedactAreas(
  grant: PathOpsFileGrant,
  areas: readonly PdfRedactionArea[],
): Promise<PathOpsRedactResult> {
  return invokePathOp("path_op_redact_areas", { grant, areas: [...areas] });
}

export function pathOpLinearize(grant: PathOpsFileGrant): Promise<PathOpOutput> {
  return invokePathOp("path_op_linearize", { grant });
}

export function pathOpCompress(grant: PathOpsFileGrant): Promise<PathOpOutput> {
  return invokePathOp("path_op_compress", { grant });
}

export function pathOpSanitize(grant: PathOpsFileGrant): Promise<PathOpOutput> {
  return invokePathOp("path_op_sanitize", { grant });
}

export function pathOpNormalize(grant: PathOpsFileGrant): Promise<PathOpOutput> {
  return invokePathOp("path_op_normalize", { grant });
}

export function pathOpScrubMetadata(
  grant: PathOpsFileGrant,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_scrub_metadata", { grant });
}
