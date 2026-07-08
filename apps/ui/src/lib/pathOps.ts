/**
 * Typed client for the PathOpsEngine — the shell's path-based delegated-ops
 * layer for large documents (large-pdf-handling plan, Phase 3).
 *
 * Every op is file→file on the shell side: inputs are FILE GRANTS (the opaque
 * identifiers the shell hands out for paths — see the grant-vs-path invariant
 * in `filePort.ts`), outputs come back as fresh grants plus metadata. Document
 * bytes never cross into the WebView.
 *
 * This module is Tauri-only: the browser runtime has no file grants, so every
 * call throws `PathOpsUnavailableError` there (callers gate on
 * `isPathOpsRuntime()` first).
 */

import type {
  PdfApplyEditsOptions,
  PdfBatesStampOptions,
  PdfBinderOptions,
  PdfCoverStyle,
  PdfEdit,
  PdfPageNumbersOptions,
  PdfRedactionArea,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import type { PrepPlanStepId, SignatureDetectionFacts } from "@raiopdf/rules";
import type { FileGrant } from "./filePort";

/** A shell file grant — the branded `FileGrant` from `filePort.ts` [R1-9]. */
export type PathOpsFileGrant = FileGrant;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PathOpErrorCode =
  | "TOOLCHAIN_MISSING"
  | "INVALID_INPUT"
  | "OP_FAILED"
  | "VERIFICATION_FAILED"
  | "IO_ERROR"
  | "FILE_CHANGED"
  | "PATH_OP_CANCELLED"
  // Native print pipeline (print.rs shares the PathOpError wire shape).
  | "PRINT_NOT_SUPPORTED"
  | "PRINT_CANCELLED"
  | "PRINT_FALLBACK_SELF_HANDLER";

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
    super("This tool only works in the installed RaioPDF app.");
    this.name = "PathOpsUnavailableError";
  }
}

/**
 * Shared user-facing mapping for path-op failures:
 * - `FILE_CHANGED` → the Phase 1 snapshot message ("reopen it").
 * - `VERIFICATION_FAILED` → the op's message verbatim (fail-closed redaction
 *   reports exactly what it found; softening it would hide the finding).
 * - `TOOLCHAIN_MISSING` → the op's message (it names the missing tool).
 * - anything else → the caller's fallback copy.
 */
export function pathOpErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PathOpsUnavailableError) {
    return error.message;
  }

  if (error instanceof PathOpsError) {
    if (error.code === "FILE_CHANGED") {
      return "This file changed on disk — reopen it.";
    }

    if (error.code === "VERIFICATION_FAILED" || error.code === "TOOLCHAIN_MISSING") {
      return error.message;
    }

    if (error.code === "PATH_OP_CANCELLED") {
      return "Operation cancelled. The document was left unchanged.";
    }
  }

  return fallback;
}

export function isPathOpCancelledError(error: unknown): boolean {
  return (
    error instanceof PathOpsError && error.code === "PATH_OP_CANCELLED"
  ) || (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PATH_OP_CANCELLED"
  );
}

// ---------------------------------------------------------------------------
// Response types (mirror apps/shell/src-tauri/src/path_ops.rs)
// ---------------------------------------------------------------------------

export interface PathOpsToolchainStatus {
  qpdf: boolean;
  ghostscript: boolean;
  ocrmypdf: boolean;
  node: boolean;
}

export interface PathOpStatusEntry {
  name: string;
  available: boolean;
  missingTools: string[];
  filingStep: string | null;
  maxInputBytes: number | null;
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
  signatureDetection: SignatureDetectionFacts;
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

export function pathOpStatusEntry(
  status: PathOpsStatus | null,
  opName: string,
): PathOpStatusEntry | null {
  return status?.ops.find((entry) => entry.name === opName) ?? null;
}

export function isPathOpAvailableForInput(
  status: PathOpsStatus | null,
  opName: string,
  inputSizeBytes: number | null,
): boolean {
  const entry = pathOpStatusEntry(status, opName);
  if (!entry?.available) {
    return false;
  }
  if (entry.maxInputBytes !== null && inputSizeBytes !== null) {
    return inputSizeBytes <= entry.maxInputBytes;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Runtime guard + invoke plumbing
// ---------------------------------------------------------------------------

export function isPathOpsRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** Shared invoke plumbing — also used by the print pipeline (`printPipeline.ts`). */
export async function invokePathOp<T>(
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

export function pathOpCancel(jobToken: string): Promise<boolean> {
  return invokePathOp("path_op_cancel", { jobToken });
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

/**
 * Insert every page of `insertGrant` into `grant` after its first `atIndex`
 * pages (`0` prepends, `pageCount` appends) — qpdf `--pages` composition,
 * file→file.
 */
export function pathOpInsertPages(
  grant: PathOpsFileGrant,
  insertGrant: PathOpsFileGrant,
  atIndex: number,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_insert_pages", { grant, insertGrant, atIndex });
}

export interface PathOpBuildBinderExhibit {
  bytes: Uint8Array;
  label: string;
  description?: string | undefined;
  sourceFileName?: string | undefined;
}

function pathOpBinderOptions(options: PdfBinderOptions): PdfBinderOptions {
  return {
    slipSheets: options.slipSheets,
    ...(options.coverStyle === undefined
      ? {}
      : { coverStyle: options.coverStyle satisfies PdfCoverStyle }),
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.placement === undefined ? {} : { placement: options.placement }),
    ...(options.stampPages === undefined ? {} : { stampPages: options.stampPages }),
    ...(options.fontSizePt === undefined ? {} : { fontSizePt: options.fontSizePt }),
    ...(options.marginIn === undefined ? {} : { marginIn: options.marginIn }),
  };
}

export function pathOpBuildBinder(
  grant: PathOpsFileGrant,
  exhibits: readonly PathOpBuildBinderExhibit[],
  options: PdfBinderOptions,
  outputName: string,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_build_binder", {
    grant,
    exhibits: exhibits.map((exhibit) => ({
      bytes: Array.from(exhibit.bytes),
      label: exhibit.label,
      ...(exhibit.description === undefined ? {} : { description: exhibit.description }),
      ...(exhibit.sourceFileName === undefined
        ? {}
        : { sourceFileName: exhibit.sourceFileName }),
    })),
    options: pathOpBinderOptions(options),
    outputName,
  });
}

export function pathOpApplyEdits(
  grant: PathOpsFileGrant,
  edits: readonly PdfEdit[],
  applyOptions: PdfApplyEditsOptions,
  outputName: string,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_apply_edits", {
    grant,
    payload: {
      edits: edits.map(serializePathOpEdit),
      applyOptions,
      outputName,
    },
  });
}

function serializePathOpEdit(edit: PdfEdit): Record<string, unknown> {
  if (edit.type === "image" || edit.type === "signature") {
    return {
      ...edit,
      bytes: edit.bytes instanceof ArrayBuffer
        ? Array.from(new Uint8Array(edit.bytes))
        : Array.from(edit.bytes),
    };
  }

  return { ...edit };
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
  jobToken?: string,
): Promise<PathOpsPrepareFilingResult> {
  // When present, the shell emits per-page OCR progress under this token so
  // the filing loader can report "page X of Y" during the make-searchable step.
  return invokePathOp("path_op_prepare_filing", {
    grant,
    plan,
    ...(jobToken ? { jobToken } : {}),
  });
}

/** OCR text-layer strategy, mirroring the byte engine's `OcrType`. */
export type PathOpOcrMode = "skip-text" | "force-ocr";

export function pathOpOcr(
  grant: PathOpsFileGrant,
  mode: PathOpOcrMode = "skip-text",
  jobToken?: string,
  pageIndexes?: readonly number[],
): Promise<PathOpOutput> {
  return invokePathOp("path_op_ocr", {
    grant,
    mode,
    ...(jobToken ? { jobToken } : {}),
    ...(pageIndexes?.length ? { pageIndexes: [...pageIndexes] } : {}),
  });
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

/**
 * Stamping path ops (overlay technique): a generated text-overlay PDF plus a
 * single qpdf `--overlay` pass, file→file. Options are the SAME shapes the
 * byte-based engine API uses, so the existing dialogs feed either path.
 */
export function pathOpBatesStamp(
  grant: PathOpsFileGrant,
  options: PdfBatesStampOptions,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_bates_stamp", { grant, options });
}

export function pathOpPageNumbers(
  grant: PathOpsFileGrant,
  options: PdfPageNumbersOptions,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_page_numbers", { grant, options });
}

export function pathOpWatermark(
  grant: PathOpsFileGrant,
  options: PdfWatermarkOptions,
): Promise<PathOpOutput> {
  return invokePathOp("path_op_watermark", { grant, options });
}

/**
 * Eagerly delete one path-op temp output (the page-range print flow reads the
 * extracted bytes and has no further use for the file). The startup sweep
 * covers anything this misses, so callers may treat it as best-effort.
 */
export function pathOpReleaseOutput(grant: PathOpsFileGrant): Promise<void> {
  return invokePathOp("path_op_release_output", { grant });
}
