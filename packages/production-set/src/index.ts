import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PdfDocumentHandle, PdfEngine, PdfPageSelection, PdfStampPlacement } from "@raiopdf/engine-api";
import { formatPageRangeSpec, parsePageRanges, PageRangeError } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { createPackage, readPackageManifest } from "@raiopdf/package-writer";
import type { PackageManifest } from "@raiopdf/package-writer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { formatProductionDat, type ProductionDatRow } from "./loadFiles";
import { createSlipSheetPageBytes, SLIP_SHEET_PAGE_GEOMETRY } from "./slipSheet";

export {
  createSlipSheetPageBytes,
  layoutSlipSheetText,
  SLIP_SHEET_BASIS_MAX_CHARS,
  SLIP_SHEET_MIN_BODY_FONT_SIZE_PT,
  SLIP_SHEET_PAGE_GEOMETRY,
  truncateSlipSheetBasis,
  type SlipSheetContentInput,
  type SlipSheetTextLayout,
} from "./slipSheet";

export {
  formatProductionDat,
  type FormatProductionDatOptions,
  type ProductionDatRow,
} from "./loadFiles";

export interface ProductionSourceInput {
  path: string;
  designation?: string | undefined;
  /**
   * 1-based, human-entered page range restricting the confidentiality
   * designation to specific pages of THIS source (e.g. "1-3,7"). Parsed by
   * the shared `parsePageRanges` (`@raiopdf/engine-api`) against this
   * source's actual page count at build time. `undefined`/`""` (the
   * default) designates every page, matching the prior behavior. Ignored
   * when `designation` is empty -- there's nothing to restrict.
   */
  designationPages?: string | undefined;
  /**
   * Custodian name recorded on this source's load-file (DAT) row. Package
   * and MCP callers only -- the desktop UI has no per-file custodian input
   * in v1, so UI-originated rows simply never set this and the resulting
   * `CUSTODIAN` column is blank for them.
   */
  custodian?: string | undefined;
  /**
   * Whether this source is produced normally, produced with redactions the
   * caller applied upstream (RaioPDF performs and verifies NO redaction as
   * part of a production build -- see the `Redact` tool for that), or
   * withheld entirely. Default `"produce"`.
   *
   * How a withheld source appears in the produced set is controlled by the
   * run-level `BuildProductionSetInput.withheldHandling` -- default
   * `"slip-sheet"`, a generated one-page Bates-stamped placeholder in its
   * original ordering position; `"omit"` is a pure omission (filtered out
   * before Bates numbers are assigned -- same mechanism as a
   * `"produce-once"`-omitted duplicate -- so it consumes no Bates number
   * and never appears in `upload/`, the production index, or the DAT).
   * Either way, its planning hash is recorded in the `privilegeLog`
   * manifest detail. See `docs/PRODUCTION-SETS.md` for the full spec.
   */
  status?: ProductionSourceStatus | undefined;
  /**
   * The privilege basis asserted for this source (e.g. "Attorney-client
   * privilege", "Work product"). REQUIRED when `status` is `"withhold"` --
   * a withheld document with no asserted privilege is a pre-output
   * validation error naming the file. Optional (but encouraged -- shown in
   * the draft privilege log alongside `basis`) when `status` is
   * `"produce-redacted"`; ignored when `status` is `"produce"` (the
   * default).
   */
  privilegeAsserted?: string | undefined;
  /**
   * Free-text description of the withholding or redaction, recorded as the
   * draft privilege log's `Description` column. Always optional -- never
   * required, even for a withheld source -- but encouraged for both
   * `"withhold"` and `"produce-redacted"` rows.
   */
  basis?: string | undefined;
}

/**
 * Per-source production disposition. `"produce"` (default) is the ordinary
 * path, unchanged. `"produce-redacted"` still produces the document
 * normally -- RaioPDF applies and verifies NO redaction as part of a
 * production build; the caller redacts upstream with the `Redact` tool
 * first -- but records a draft privilege log row for it. `"withhold"`
 * excludes the source from the production entirely (see
 * `ProductionSourceInput.status`).
 */
export type ProductionSourceStatus = "produce" | "produce-redacted" | "withhold";

/**
 * How a withheld (`status: "withhold"`) source's canonical occurrence
 * appears in the produced set. Default `"slip-sheet"`.
 *
 * - `"slip-sheet"` -- a generated, one-page pdf-lib PDF ("DOCUMENT WITHHELD",
 *   the privilege asserted, an optional wrapped basis) takes the withheld
 *   document's place in production order, consuming exactly ONE Bates number
 *   there, Bates-stamped like any produced page (same placement/font
 *   options), and landing in `upload/`, the production index, the DAT (with
 *   a blank `CONFIDENTIALITY` value), and the combined PDF when requested.
 *   The withheld source's own bytes are never read for its content -- only
 *   re-hashed for drift detection (see `readPlannedSourceBytes`). A
 *   withheld duplicate group produces exactly ONE slip sheet (its canonical
 *   occurrence), regardless of `duplicateHandling`, mirroring the single
 *   privilege-log-row rule.
 * - `"omit"` -- the prior (pre-slip-sheet) behavior: the withheld source is
 *   a pure omission, consuming no Bates number and never appearing anywhere
 *   in the produced set.
 *
 * See `docs/PRODUCTION-SETS.md` for the full spec, including the
 * zero-produced-output edge case when every source is withheld under
 * `"omit"`.
 */
export type WithheldHandling = "slip-sheet" | "omit";

export interface ProductionContinuationOverrideInput {
  reason: string;
}

/**
 * How a run handles two or more sources that hash identical (same
 * `sourceSha256`, computed during the bounded planning pass -- see
 * `ProductionSourcePlan`):
 *
 * - `"produce-all"` -- every occurrence is Bates-stamped and produced with
 *   its own range, same as before duplicate detection existed. Default,
 *   because silently dropping a document from a discovery production is the
 *   dangerous failure mode, not the safe one -- an over-inclusive production
 *   is a nuisance; an under-inclusive one is a discovery problem.
 * - `"produce-once"` -- only the first occurrence (input order) is
 *   Bates-stamped, uploaded, and indexed; every later occurrence is
 *   `"omitted"` and consumes NO Bates numbers, so numbering stays
 *   contiguous. The cross-reference lives only in the manifest/audit detail
 *   (`duplicateGroups` below and the `productionDuplicates` package detail)
 *   -- never a synthesized column in the index CSV.
 */
export type ProductionDuplicateHandling = "produce-all" | "produce-once";

/** One occurrence of a source that shares its `sourceSha256` with at least
 * one other source in the run. `batesRange` is `null` exactly when `action`
 * is `"omitted"` (produce-once mode, not the first occurrence). */
export interface ProductionDuplicateOccurrence {
  sourceFilename: string;
  /** 1-based position of this occurrence in the run's overall `sources`
   * input order (not its position within the group). */
  sourceOrdinal: number;
  action: "produced" | "omitted";
  /** `"${batesStart}-${batesEnd}"` when produced; `null` when omitted. */
  batesRange: string | null;
}

/** A group of two or more sources sharing one `sourceSha256`. */
export interface ProductionDuplicateGroup {
  sourceSha256: string;
  occurrences: readonly ProductionDuplicateOccurrence[];
  /** `sourceOrdinal` of the first-encountered (and, in `"produce-once"`
   * mode, the only produced) occurrence in this group. */
  canonicalOccurrenceOrdinal: number;
}

export interface BuildProductionSetInput {
  sources: readonly ProductionSourceInput[];
  outputDir: string;
  prefix: string;
  start?: number | undefined;
  digits?: number | undefined;
  includeFilenameInIndex?: boolean | undefined;
  includeIndex?: boolean | undefined;
  combinedPdf?: boolean | undefined;
  volumeSizeMb?: number | undefined;
  appVersion?: string | undefined;
  createdAt?: string | undefined;
  /**
   * Page edge and horizontal alignment for the Bates number. Defaults to
   * `{ edge: "footer", align: "right" }`, unchanged from before this option
   * existed.
   */
  batesPlacement?: PdfStampPlacement | undefined;
  /**
   * Page edge and horizontal alignment for the confidentiality designation.
   * Defaults to `{ edge: "header", align: "center" }`, unchanged from
   * before this option existed. Rejected (pre-output) if it shares an edge
   * with `batesPlacement` -- see `assertPlacementsDoNotShareEdge`.
   */
  designationPlacement?: PdfStampPlacement | undefined;
  /**
   * Font size, in points, for BOTH the Bates numbers and the confidentiality
   * designation. Defaults to 10 (unchanged). Must be between 6 and 24; the
   * engine's own width-fitting can still shrink the RENDERED size below the
   * configured value on a narrow page, which is checked separately and
   * pre-output by `assertStampsFitAtMinimumSize`.
   */
  stampFontSizePt?: number | undefined;
  /**
   * Root folder of a prior production package to continue the same Bates
   * series from. When set, this run re-verifies that package (defense in
   * depth -- the caller has usually already called `readProductionContinuation`
   * once to prefill the form) and, absent `continuationOverride`, requires an
   * EXACT match: `prefix` case-sensitive-identical, `digits` identical, and
   * `start` equal to the prior package's `nextNumber`. Any mismatch is a
   * pre-output error -- nothing is written.
   */
  continueFrom?: string | undefined;
  /**
   * Permits `start` and/or `digits` to differ from the prior production (a
   * deliberate gap, a reserved range, a digit-width change) while still
   * requiring `prefix` to match exactly. Only meaningful together with
   * `continueFrom`; a non-empty `reason` is required and is recorded on the
   * package via `recordOverride`.
   */
  continuationOverride?: ProductionContinuationOverrideInput | undefined;
  /**
   * How to handle two or more sources whose bytes hash identical. Default
   * `"produce-all"` -- see `ProductionDuplicateHandling`.
   */
  duplicateHandling?: ProductionDuplicateHandling | undefined;
  /**
   * Writes a litigation load file (`production.dat`, "Relativity-compatible
   * Concordance DAT defaults" -- see `./loadFiles.ts`) at the package root
   * alongside `upload/`. Default `false`. Only produced files get a row --
   * a combined production PDF and any produce-once-omitted duplicate
   * occurrence never appear in it. An OPT/Opticon image cross-reference is
   * deliberately NOT written -- see `docs/PRODUCTION-SETS.md` for why.
   */
  includeLoadFiles?: boolean | undefined;
  /**
   * Includes each row's produced (or, for a withheld row, source) filename
   * as the `Filename` column of `draft-privilege-log.csv`. Default `true` --
   * a log row with no identifier at all is close to useless. Independent of
   * `includeFilenameInIndex`: turning off the production index's filename
   * column has no effect here, and vice versa. `false` blanks every row's
   * `Filename` value; the column itself (and its header) still exists,
   * matching how the DAT's `FILENAME` column behaves under
   * `includeFilenameInIndex`.
   */
  includeFilenameInPrivilegeLog?: boolean | undefined;
  /**
   * How a withheld source's canonical occurrence appears in the produced
   * set. Default `"slip-sheet"` -- see `WithheldHandling`.
   */
  withheldHandling?: WithheldHandling | undefined;
}

export type ProductionContinuationErrorCode =
  | "not-a-production-package"
  | "tampered"
  | "inconsistent";

/**
 * Typed failure from `readProductionContinuation`. `code` distinguishes three
 * cases so callers (the UI, the build-time re-verification) can react
 * differently: the folder simply isn't a RaioPDF production package, its
 * Bates report doesn't match what the package manifest recorded (or is
 * missing), or the report is self-inconsistent (numbering doesn't add up).
 */
export class ProductionContinuationError extends Error {
  readonly code: ProductionContinuationErrorCode;

  constructor(code: ProductionContinuationErrorCode, message: string) {
    super(message);
    this.name = "ProductionContinuationError";
    this.code = code;
  }
}

export interface ProductionContinuationSummary {
  prefix: string;
  digits: number;
  nextNumber: number;
  /** The prior production's last Bates number, formatted (e.g. "SMITH000122"). */
  lastBates: string;
  /** The prior package's creation timestamp (ISO 8601), from its manifest. */
  createdAt: string;
  fileCount: number;
}

export interface ProductionSetFileResult {
  sourcePath: string;
  sourceFilename: string;
  sourceSha256: string;
  outputName: string;
  packageRelativePath: string;
  batesStart: string;
  batesEnd: string;
  firstNumber: number;
  lastNumber: number;
  pages: number;
  designation: string;
  /**
   * Normalized 1-based spec string (e.g. "1-3,7") when the designation was
   * restricted to a strict subset of this source's pages; `null` when the
   * designation covers the whole document (including when it's empty, or
   * when an explicit spec happened to resolve to every page anyway).
   */
  designationPages: string | null;
  /** Custodian name, or `""` when none was set for this source (the desktop
   * UI never sets one in v1 -- see `ProductionSourceInput.custodian`). */
  custodian: string;
  /** `"produce"` or `"produce-redacted"` for an ordinary produced file. A
   * `"withhold"` source reaches `files` ONLY as a generated slip sheet
   * (`withheldHandling: "slip-sheet"`) -- an `"omit"`-handled withheld
   * source never reaches `files` at all. */
  status: ProductionSourceStatus;
  /** `""` when not set for this source. */
  privilegeAsserted: string;
  /** `""` when not set for this source. */
  basis: string;
  sha256: string;
  bytes: number;
  volume: string | null;
}

export interface ProductionVolumeResult {
  name: string;
  files: readonly string[];
  bytes: number;
  oversizedFiles: readonly string[];
}

export interface ProductionSetResult {
  packageRoot: string;
  prefix: string;
  digits: number;
  firstNumber: number;
  lastNumber: number;
  nextNumber: number;
  files: readonly ProductionSetFileResult[];
  volumes: readonly ProductionVolumeResult[];
  indexPdf: string | null;
  indexCsv: string | null;
  combinedPdf: string | null;
  /** Package-root-relative location of `production.dat`, or `null` when
   * `includeLoadFiles` was `false`. */
  loadFileDat: string | null;
  manifest: PackageManifest;
  /** Set when `continueFrom` was used for this build; `null` otherwise. */
  continuation: { mode: "strict" | "override"; priorLastBates: string } | null;
  /** Every group of two or more sources sharing a `sourceSha256`; `[]` when
   * none were found. */
  duplicateGroups: readonly ProductionDuplicateGroup[];
  /** Occurrences beyond the first in each duplicate group (total sources
   * minus unique hashes) -- 0 when no duplicates were found, regardless of
   * `duplicateHandling`. */
  duplicateCount: number;
  /** Number of `draft-privilege-log.csv` rows with `Status: "Withheld"` --
   * one per distinct withheld document (a withheld duplicate group collapses
   * to its canonical occurrence's single row; see
   * `ProductionSourceInput.status`). `0` when nothing was withheld. */
  withheldCount: number;
  /** Number of `draft-privilege-log.csv` rows with
   * `Status: "Produced with redactions"`. `0` when nothing was marked
   * `"produce-redacted"`, or when every such source was excluded by
   * `duplicateHandling: "produce-once"` before it could reach output. */
  redactedCount: number;
  /** Package-root-relative location of `draft-privilege-log.csv`, or `null`
   * when no source had a non-`"produce"` status (the file is never written
   * in that case). Written whenever `withheldCount + redactedCount > 0`. */
  privilegeLogLocation: string | null;
  /** Number of generated slip-sheet placeholders produced for withheld
   * sources -- one per canonical withheld occurrence, ONLY when
   * `withheldHandling` was `"slip-sheet"`. Always `0` under `"omit"`. */
  slipSheetCount: number;
}

interface VolumeState {
  index: number;
  bytes: number;
  files: string[];
  oversizedFiles: string[];
}

interface VolumeUploadArtifact {
  outputName: string;
  bytes: number;
  volume: string | null;
}

/**
 * One planned source. Deliberately scalars only -- no open engine handle and no
 * bytes -- so planning a 1,000-document production costs kilobytes of metadata
 * instead of holding 1,000 parsed PDFs open before the first output is written.
 */
interface ProductionSourcePlan {
  sourcePath: string;
  sourceFilename: string;
  sourceSha256: string;
  sourceBytes: number;
  /** 1-based position in the run's overall (pre-exclusion) `sources` input
   * order -- carried through from `ScannedSource` so a produced plan can be
   * matched back to its `ProductionDuplicateOccurrence`. */
  sourceOrdinal: number;
  pages: number;
  /** Per-page visual geometry (width/height/rotation), used only to
   * pre-check that stamps stay at or above the minimum rendered size. */
  pageGeometry: readonly PlannedPageGeometry[];
  firstNumber: number;
  lastNumber: number;
  batesStart: string;
  batesEnd: string;
  designation: string;
  /** Zero-based pages the designation is stamped on; only meaningful when
   * `designation !== ""`. */
  designationPageIndexes: PdfPageSelection;
  /** Normalized spec string to record on the result/manifest/index, or
   * `null` when the designation covers the whole document. */
  designationPagesSpec: string | null;
  /** Custodian name, or `""` when none was set -- see
   * `ProductionSourceInput.custodian`. */
  custodian: string;
  /** `"withhold"` reaches a plan ONLY as a slip-sheet placeholder's status
   * (`isSlipSheet: true`, `withheldHandling: "slip-sheet"`) -- an
   * `"omit"`-handled withheld source (or any withheld source under the
   * default `"omit"`) is filtered out of `included` before plans are built
   * (see `prepareProductionSourcePlans`) and never reaches this type. */
  status: ProductionSourceStatus;
  /** `""` when none was set -- see `ProductionSourceInput.privilegeAsserted`. */
  privilegeAsserted: string;
  /** `""` when none was set -- see `ProductionSourceInput.basis`. */
  basis: string;
  /** `true` for a generated slip-sheet placeholder standing in for a
   * withheld source's canonical occurrence (`withheldHandling:
   * "slip-sheet"`) -- `pages`/`pageGeometry` describe the GENERATED page
   * (always 1, Letter-size), not the withheld source's own document, and
   * `designation` is always forced to `""` (a slip sheet is never
   * confidentiality-designated). `false` for every ordinary plan. */
  isSlipSheet: boolean;
}

/** A source page's size and rotation, as read directly from the PDF (independent
 * of which `PdfEngine` implementation will actually perform the stamp) -- used
 * only for the pre-output minimum-rendered-size check. */
interface PlannedPageGeometry {
  widthPt: number;
  heightPt: number;
  rotationDegrees: number;
}

interface NormalizedInput {
  sources: readonly ProductionSourceInput[];
  outputDir: string;
  prefix: string;
  start: number;
  digits: number;
  includeFilenameInIndex: boolean;
  includeIndex: boolean;
  combinedPdf: boolean;
  appVersion: string;
  createdAt: string;
  volumeBytes: number | null;
  continueFrom: string | null;
  continuationOverride: ProductionContinuationOverrideInput | null;
  batesPlacement: PdfStampPlacement;
  designationPlacement: PdfStampPlacement;
  stampFontSizePt: number;
  duplicateHandling: ProductionDuplicateHandling;
  includeLoadFiles: boolean;
  includeFilenameInPrivilegeLog: boolean;
  withheldHandling: WithheldHandling;
}

const DEFAULT_DIGITS = 6;
const DEFAULT_START = 1;
const DEFAULT_APP_VERSION = "0.1.0";
const DEFAULT_BATES_PLACEMENT: PdfStampPlacement = { edge: "footer", align: "right" };
const DEFAULT_DESIGNATION_PLACEMENT: PdfStampPlacement = { edge: "header", align: "center" };
const DEFAULT_STAMP_FONT_SIZE_PT = 10;
const DEFAULT_PRODUCTION_STATUS: ProductionSourceStatus = "produce";
/** Silently dropping a document from a discovery production is the
 * dangerous default; producing every occurrence (with its own Bates range,
 * cross-referenced) is the safe one. */
const DEFAULT_DUPLICATE_HANDLING: ProductionDuplicateHandling = "produce-all";
/** A slip-sheet placeholder holds a withheld document's place in the
 * production and its Bates sequence -- the owner's decided default. */
const DEFAULT_WITHHELD_HANDLING: WithheldHandling = "slip-sheet";
const MIN_STAMP_FONT_SIZE_PT = 6;
const MAX_STAMP_FONT_SIZE_PT = 24;
/** Matches `engine-local`/`engine-sidecar`'s own default `marginIn` for
 * `stampText`/`batesStamp` -- production-set never overrides it, so the
 * pre-output fit check has to assume the same margin the real stamp uses. */
const STAMP_MARGIN_IN = 0.5;
const POINTS_PER_INCH = 72;

/**
 * Soft cap on how many sources a run may combine into one production PDF.
 *
 * The default (per-document) path is O(1) in document count: each source is
 * opened, stamped, written, and closed before the next one starts. The combined
 * PDF cannot be: `PdfEngine.merge` takes every document handle at once, so every
 * stamped document must still be open when the merge runs, and one stamped
 * document costs roughly its own byte size. Rather than let that grow without
 * limit, a combined run refuses up front with a clear error and points at the
 * per-document outputs, which have no such bound. Raising this cap means
 * changing the engine merge API to accept documents incrementally -- a pairwise
 * merge would nest each accumulated outline under the previous document's
 * bookmark root and change the combined PDF's bookmark tree, so it is not a
 * drop-in substitute.
 */
export const MAX_COMBINED_PRODUCTION_SOURCES = 200;

const PRODUCTION_REPORT_NAME = "production.json";

/**
 * Reads and verifies a prior production package's Bates continuation report
 * (`raio-manifest/production.json`), returning where the NEXT production in
 * the same series should start.
 *
 * Verification (all must pass, or this throws a `ProductionContinuationError`):
 * 1. `production.json` is listed in the package's `manifest.json`
 *    `machineReports` with a matching SHA-256 (catches a report edited or
 *    replaced after the package was produced).
 * 2. The report parses to the expected shape (prefix, digit width, and a
 *    file list whose `batesStart`/`batesEnd` match that prefix and digit
 *    width).
 * 3. Every file's Bates range is contiguous with the one before it (no gaps,
 *    no overlaps) and the first/last numbers line up with the report's own
 *    `firstNumber`/`lastNumber`.
 * 4. `lastNumber + 1 === nextNumber`.
 *
 * This is deliberately re-run by `buildProductionSet` itself when
 * `continueFrom` is set -- callers that already ran it once (e.g. the UI, to
 * prefill the form) still get it re-verified at build time.
 */
export async function readProductionContinuation(
  packageRoot: string,
): Promise<ProductionContinuationSummary> {
  const manifest = await readPackageManifest(packageRoot).catch(() => {
    throw new ProductionContinuationError(
      "not-a-production-package",
      "This folder doesn't look like a RaioPDF production package.",
    );
  });

  const reportEntry = manifest.machineReports.find((entry) => entry.name === PRODUCTION_REPORT_NAME);
  if (reportEntry === undefined) {
    throw new ProductionContinuationError(
      "not-a-production-package",
      "This folder doesn't look like a RaioPDF production package -- it has no Bates continuation report.",
    );
  }

  const reportPath = path.join(path.resolve(packageRoot), "raio-manifest", PRODUCTION_REPORT_NAME);
  let reportBytes: Uint8Array;
  try {
    reportBytes = await fs.readFile(reportPath);
  } catch {
    throw new ProductionContinuationError(
      "tampered",
      "This production's Bates report is missing, even though the package manifest lists it. " +
        "Verify against the served copy before continuing.",
    );
  }

  if (sha256Hex(reportBytes) !== reportEntry.sha256) {
    throw new ProductionContinuationError(
      "tampered",
      "This production's Bates report doesn't match the package manifest -- the folder may have " +
        "changed since it was produced. Verify against the served copy before continuing.",
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(reportBytes));
  } catch {
    throw new ProductionContinuationError(
      "inconsistent",
      "This production's Bates report could not be read.",
    );
  }

  const report = parseProductionReport(parsedJson);
  const rows = report.files.map((file, index) => parseBatesRow(file, report.prefix, report.digits, index));
  assertContiguousAndOrdered(rows, report);

  return {
    prefix: report.prefix,
    digits: report.digits,
    nextNumber: report.nextNumber,
    lastBates: formatBates(report.prefix, report.lastNumber, report.digits),
    createdAt: manifest.provenance.createdAt,
    fileCount: rows.length,
  };
}

interface ProductionReportFileShape {
  batesStart: string;
  batesEnd: string;
}

interface ProductionReportShape {
  prefix: string;
  digits: number;
  firstNumber: number;
  lastNumber: number;
  nextNumber: number;
  files: readonly ProductionReportFileShape[];
}

function parseProductionReport(value: unknown): ProductionReportShape {
  if (!isRecord(value)) {
    throw inconsistentReport("This production's Bates report is not in the expected format.");
  }

  const { prefix, digits, firstNumber, lastNumber, nextNumber, files } = value;

  if (typeof prefix !== "string") {
    throw inconsistentReport("This production's Bates report is missing its prefix.");
  }
  if (!isInteger(digits) || digits < 1) {
    throw inconsistentReport("This production's Bates report has an invalid digit width.");
  }
  if (!isInteger(firstNumber) || firstNumber < 0) {
    throw inconsistentReport("This production's Bates report has an invalid first number.");
  }
  if (!isInteger(lastNumber)) {
    throw inconsistentReport("This production's Bates report has an invalid last number.");
  }
  if (!isInteger(nextNumber) || nextNumber < 0) {
    throw inconsistentReport("This production's Bates report has an invalid next number.");
  }
  if (!Array.isArray(files)) {
    throw inconsistentReport("This production's Bates report is missing its file list.");
  }

  const parsedFiles = files.map((file, index) => {
    if (!isRecord(file) || typeof file.batesStart !== "string" || typeof file.batesEnd !== "string") {
      throw inconsistentReport(
        `This production's Bates report is missing Bates range data for file ${index + 1}.`,
      );
    }
    return { batesStart: file.batesStart, batesEnd: file.batesEnd };
  });

  return { prefix, digits, firstNumber, lastNumber, nextNumber, files: parsedFiles };
}

interface BatesRowRange {
  start: number;
  end: number;
}

function parseBatesRow(
  file: ProductionReportFileShape,
  prefix: string,
  digits: number,
  index: number,
): BatesRowRange {
  const start = parseBatesNumber(file.batesStart, prefix, digits, index, "start");
  const end = parseBatesNumber(file.batesEnd, prefix, digits, index, "end");
  if (end < start) {
    throw inconsistentReport(`This production's Bates report has an invalid range at file ${index + 1}.`);
  }
  return { start, end };
}

/** Also doubles as the "digits/prefix consistent across rows" check: a row
 * whose Bates string doesn't start with the report's own prefix, or whose
 * numeric tail isn't exactly `digits` zero-padded digits, fails here. */
function parseBatesNumber(
  value: string,
  prefix: string,
  digits: number,
  index: number,
  which: "start" | "end",
): number {
  if (!value.startsWith(prefix)) {
    throw inconsistentReport(
      `This production's Bates report has a ${which} number at file ${index + 1} that doesn't match its prefix.`,
    );
  }
  const numeric = value.slice(prefix.length);
  if (numeric.length !== digits || !/^[0-9]+$/.test(numeric)) {
    throw inconsistentReport(
      `This production's Bates report has a ${which} number at file ${index + 1} that doesn't match its digit width.`,
    );
  }
  return Number.parseInt(numeric, 10);
}

function assertContiguousAndOrdered(rows: readonly BatesRowRange[], report: ProductionReportShape): void {
  if (report.lastNumber + 1 !== report.nextNumber) {
    throw inconsistentReport(
      "This production's Bates report numbering is inconsistent -- its last and next numbers don't line up.",
    );
  }

  if (rows.length === 0) {
    if (report.lastNumber !== report.firstNumber - 1) {
      throw inconsistentReport("This production's Bates report numbering is inconsistent.");
    }
    return;
  }

  if (rows[0]!.start !== report.firstNumber) {
    throw inconsistentReport(
      "This production's Bates report's first file doesn't match its recorded first number.",
    );
  }

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (current.start !== previous.end + 1) {
      throw inconsistentReport(
        `This production's Bates report has a gap or overlap between files ${index} and ${index + 1}.`,
      );
    }
  }

  if (rows[rows.length - 1]!.end !== report.lastNumber) {
    throw inconsistentReport(
      "This production's Bates report's last file doesn't match its recorded last number.",
    );
  }
}

function inconsistentReport(message: string): ProductionContinuationError {
  return new ProductionContinuationError("inconsistent", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

interface ProductionContinuationCheck {
  mode: "strict" | "override";
  summary: ProductionContinuationSummary;
}

/**
 * Re-verifies `options.continueFrom` at build time (defense in depth against
 * a caller reusing a stale prefill) and enforces the strict-vs-override
 * numbering contract described on `BuildProductionSetInput.continueFrom`.
 */
async function verifyProductionContinuation(options: NormalizedInput): Promise<ProductionContinuationCheck> {
  const continueFrom = options.continueFrom;
  if (continueFrom === null) {
    throw new Error("Internal error: no prior production selected to continue from.");
  }

  const summary = await readProductionContinuation(continueFrom);

  if (summary.prefix !== options.prefix) {
    throw new Error(
      `Continuing prefix mismatch: the prior production used "${summary.prefix}", but this run is set ` +
        `to "${options.prefix}". The prefix must match exactly to continue the same Bates series.`,
    );
  }

  if (options.continuationOverride === null) {
    if (summary.digits !== options.digits) {
      throw new Error(
        `Continuing digit-width mismatch: the prior production used ${summary.digits}-digit Bates ` +
          `numbers (last: ${summary.lastBates}), but this run is set to ${options.digits}. Use ` +
          '"Adjust start" with a reason to override, or match the prior digit width.',
      );
    }
    if (summary.nextNumber !== options.start) {
      const expected = formatBates(summary.prefix, summary.nextNumber, summary.digits);
      const actual = formatBates(options.prefix, options.start, options.digits);
      throw new Error(
        `Continuing start mismatch: the prior production's next available number is ${expected}, but ` +
          `this run starts at ${actual}. Use "Adjust start" with a reason to override, or start at ${expected}.`,
      );
    }
  }

  return {
    mode: options.continuationOverride === null ? "strict" : "override",
    summary,
  };
}

export async function buildProductionSet(
  input: BuildProductionSetInput,
  engine: PdfEngine = createLocalPdfEngine(),
): Promise<ProductionSetResult> {
  const options = normalizeInput(input);
  // Only the combined-PDF path retains stamped documents past their own write;
  // the default path closes each one before opening the next.
  const stampedForCombined: PdfDocumentHandle[] = [];
  const files: ProductionSetFileResult[] = [];
  const volumeArtifacts: VolumeUploadArtifact[] = [];
  const volume: VolumeState | null = options.volumeBytes === null ? null : createVolume(1);
  let combinedHandle: PdfDocumentHandle | null = null;
  let session: ReturnType<typeof createPackage> | undefined;
  let finalized = false;

  try {
    // Pre-output: re-verify the prior production and enforce the numbering
    // contract BEFORE anything is read or written -- a mismatch here must
    // leave no half-built package behind, same as the Bates-digit-overflow
    // check below.
    const continuation = options.continueFrom === null
      ? null
      : await verifyProductionContinuation(options);

    const { plans: sourcePlans, duplicateGroups, duplicateCount, withheldLogSources } =
      await prepareProductionSourcePlans(options, engine);
    const slipSheetCount = sourcePlans.filter((plan) => plan.isSlipSheet).length;
    session = createPackage(options.outputDir, {
      appVersion: options.appVersion,
      createdAt: options.createdAt,
      confirmCurrentRequirements:
        "Confirm current production protocol, protective order, and delivery format before service.",
    });
    const running = sourcePlans.length === 0 ? options.start : sourcePlans[sourcePlans.length - 1]!.lastNumber + 1;

    for (const plan of sourcePlans) {
      // Output pass: reopen exactly one source, stamp it, write it, and close
      // every handle it produced before moving to the next plan entry.
      const produced = await stampPlannedSource(plan, options, engine);
      let retained = false;

      try {
        const outputBytes = await engine.saveToBytes(produced);
        // The whole composed name goes through safePdfName: the Bates prefix
        // can legally carry characters the DAT LINK field must substitute,
        // and physical filename and LINK must stay byte-identical.
        const outputName = safePdfName(`${plan.batesStart} - ${plan.batesEnd} - ${plan.sourceFilename}`);
        const volumeName = assignVolume(volume, outputName, outputBytes.byteLength, options.volumeBytes);
        const packageName = volumeName === null ? outputName : `${volumeName}/${outputName}`;
        const entry = await session.addUploadFile(outputBytes, packageName, {
          pages: plan.pages,
          sourceFilename: plan.sourceFilename,
          sourceSha256: plan.sourceSha256,
          batesStart: plan.batesStart,
          batesEnd: plan.batesEnd,
          designation: plan.designation,
          designationPages: plan.designationPagesSpec,
          status: plan.status,
          privilegeAsserted: plan.privilegeAsserted,
          basis: plan.basis,
        });
        volumeArtifacts.push({
          outputName,
          bytes: entry.bytes,
          volume: volumeName,
        });

        files.push({
          sourcePath: plan.sourcePath,
          sourceFilename: plan.sourceFilename,
          sourceSha256: plan.sourceSha256,
          outputName,
          packageRelativePath: entry.relativePath,
          batesStart: plan.batesStart,
          batesEnd: plan.batesEnd,
          firstNumber: plan.firstNumber,
          lastNumber: plan.lastNumber,
          pages: plan.pages,
          designation: plan.designation,
          designationPages: plan.designationPagesSpec,
          custodian: plan.custodian,
          status: plan.status,
          privilegeAsserted: plan.privilegeAsserted,
          basis: plan.basis,
          sha256: entry.sha256,
          bytes: entry.bytes,
          volume: volumeName,
        });

        if (options.combinedPdf) {
          stampedForCombined.push(produced);
          retained = true;
        }
      } finally {
        if (!retained) {
          await engine.close(produced).catch(() => undefined);
        }
      }
    }

    const indexRows = files.map(toIndexRow);
    let indexPdf: string | null = null;
    let indexCsv: string | null = null;
    if (options.includeIndex) {
      const csvEntry = await session.addRootDocument(
        "production-index.csv",
        new TextEncoder().encode(formatProductionCsv(indexRows, options.includeFilenameInIndex)),
      );
      const pdfEntry = await session.addRootDocument(
        "production-index.pdf",
        await createProductionIndexPdf(indexRows, options.includeFilenameInIndex),
      );
      indexCsv = csvEntry.relativePath;
      indexPdf = pdfEntry.relativePath;
    }

    // A withheld source's canonical occurrence has a produced plan ONLY
    // under `withheldHandling: "slip-sheet"` (the slip sheet itself) -- this
    // is how the privilege log's new `Bates` column tells the two modes
    // apart for a "Withheld" row (see `ProductionPrivilegeLogRow.bates`).
    const sourcePlansByOrdinal = new Map(sourcePlans.map((plan) => [plan.sourceOrdinal, plan]));

    // Draft privilege log: one row per withheld document's canonical
    // occurrence (produced-name for a slip sheet, source name otherwise)
    // plus one row per produced "produce-redacted" file (filename is the
    // Bates-stamped output name, matching the production index). Written
    // ONLY when at least one row exists -- a source marked withhold or
    // produce-redacted that a produce-once duplicate exclusion dropped
    // before output never gets its own row (see `selectCanonicalWithheldSources`
    // and the duplicate-status conflict check above).
    const privilegeLogRows: ProductionPrivilegeLogRowPlan[] = [
      ...withheldLogSources.map((source) => {
        const slipSheetPlan = sourcePlansByOrdinal.get(source.sourceOrdinal);
        return {
          status: "Withheld" as const,
          privilegeAsserted: source.privilegeAsserted,
          basis: source.basis,
          filename: source.sourceFilename,
          pages: source.pages,
          // "" under "omit" (no Bates number was ever consumed); the slip
          // sheet's own range under "slip-sheet".
          bates: slipSheetPlan === undefined ? "" : `${slipSheetPlan.batesStart}-${slipSheetPlan.batesEnd}`,
          sourceOrdinal: source.sourceOrdinal,
          sourceFilename: source.sourceFilename,
          sourcePath: source.sourcePath,
          sourceSha256: source.sourceSha256,
        };
      }),
      // `files` is built by pushing exactly one entry per `sourcePlans` entry,
      // in the same loop, in the same order -- a direct index zip, not a
      // lookup, is what ties a produced file back to its plan's ordinal.
      ...sourcePlans
        .map((plan, index) => ({ plan, file: files[index]! }))
        .filter(({ plan }) => plan.status === "produce-redacted")
        .map(({ plan, file }) => ({
          status: "Produced with redactions" as const,
          privilegeAsserted: file.privilegeAsserted,
          basis: file.basis,
          filename: file.outputName,
          pages: file.pages,
          // A "produce-redacted" source is always produced (independent of
          // withheldHandling), so it always has a real Bates range.
          bates: `${file.batesStart}-${file.batesEnd}`,
          sourceOrdinal: plan.sourceOrdinal,
          sourceFilename: file.sourceFilename,
          sourcePath: file.sourcePath,
          sourceSha256: file.sourceSha256,
        })),
    ].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal)
      .map((row, index) => ({ ...row, rowId: formatPrivilegeLogRowId(index + 1) }));

    const withheldCount = privilegeLogRows.filter((row) => row.status === "Withheld").length;
    const redactedCount = privilegeLogRows.filter((row) => row.status === "Produced with redactions").length;

    let privilegeLogLocation: string | null = null;
    if (privilegeLogRows.length > 0) {
      const privilegeLogEntry = await session.addRootDocument(
        "draft-privilege-log.csv",
        new TextEncoder().encode(
          formatPrivilegeLogCsv(privilegeLogRows, options.includeFilenameInPrivilegeLog),
        ),
      );
      privilegeLogLocation = privilegeLogEntry.relativePath;
      session.recordDetail("privilegeLog", {
        includeFilenameInPrivilegeLog: options.includeFilenameInPrivilegeLog,
        withheldCount,
        redactedCount,
        rows: privilegeLogRows.map((row) => ({
          rowId: row.rowId,
          status: row.status,
          bates: row.bates,
          privilegeAsserted: row.privilegeAsserted,
          basis: row.basis,
          sourceFilename: row.sourceFilename,
          sourcePath: row.sourcePath,
          sourceSha256: row.sourceSha256,
          pages: row.pages,
        })),
      });
      session.recordCheck({
        checkId: "privilege-log-draft",
        status: "pass",
        detail: formatPrivilegeLogCheckDetail(withheldCount, redactedCount),
      });
    }

    let loadFileDat: string | null = null;
    if (options.includeLoadFiles) {
      // Only ever built from `files` -- the per-document produced set --
      // so a combined production PDF and any produce-once-omitted duplicate
      // never get a row, matching the production index.
      const datEntry = await session.addRootDocument(
        "production.dat",
        formatProductionDat(files.map(toDatRow), {
          includeFilenameInIndex: options.includeFilenameInIndex,
        }),
      );
      loadFileDat = datEntry.relativePath;
    }

    let combinedPdf: string | null = null;
    // Zero-produced-output guard: with `withheldHandling: "omit"` and every
    // source withheld, `files` is empty and `stampedForCombined` (only ever
    // populated inside the per-plan loop above) is empty too -- merging
    // zero documents, and formatting a "last produced Bates" string from
    // `running - 1` (which here equals `options.start - 1`, a number that
    // was never actually stamped on anything), would both be nonsensical.
    // No combined PDF is produced in that case; see the
    // `production-zero-output` check recorded below.
    if (options.combinedPdf && files.length > 0) {
      const merged = await engine.merge(stampedForCombined, {
        labels: files.map((file) => file.sourceFilename),
      });
      const combined = merged.document;
      combinedHandle = combined;
      const combinedBytes = await engine.saveToBytes(combined);
      const combinedName = safePdfName(`${formatBates(options.prefix, options.start, options.digits)} - ${formatBates(
        options.prefix,
        running - 1,
        options.digits,
      )} - combined-production.pdf`);
      const volumeName = assignVolume(volume, combinedName, combinedBytes.byteLength, options.volumeBytes);
      const packageName = volumeName === null ? combinedName : `${volumeName}/${combinedName}`;
      const entry = await session.addUploadFile(combinedBytes, packageName, {
        pages: files.reduce((sum, file) => sum + file.pages, 0),
        sourceFilename: "combined-production.pdf",
        batesStart: formatBates(options.prefix, options.start, options.digits),
        batesEnd: formatBates(options.prefix, running - 1, options.digits),
        designation: "",
        combinedProduction: true,
      });
      volumeArtifacts.push({
        outputName: combinedName,
        bytes: entry.bytes,
        volume: volumeName,
      });
      combinedPdf = entry.relativePath;
    }

    const volumeResults = volume === null ? [] : collectVolumes(volumeArtifacts, options.volumeBytes);

    session.recordDetail("productionSources", files.map((file) => ({
      sourcePath: file.sourcePath,
      sourceFilename: file.sourceFilename,
      sourceSha256: file.sourceSha256,
      outputName: file.outputName,
      batesStart: file.batesStart,
      batesEnd: file.batesEnd,
      pages: file.pages,
      designation: file.designation,
      designationPages: file.designationPages,
      custodian: file.custodian,
      status: file.status,
      // Only ever true for a produced "withhold"-status file -- a generated
      // slip-sheet placeholder -- since that's the only way `status`
      // reaches `files` as "withhold" at all (see `ProductionSourcePlan.isSlipSheet`).
      isSlipSheet: file.status === "withhold",
      privilegeAsserted: file.privilegeAsserted,
      basis: file.basis,
    })));
    session.recordDetail("productionOptions", {
      prefix: options.prefix,
      digits: options.digits,
      start: options.start,
      includeFilenameInIndex: options.includeFilenameInIndex,
      combinedPdf: options.combinedPdf,
      volumeSizeMb: input.volumeSizeMb ?? null,
      batesPlacement: options.batesPlacement,
      designationPlacement: options.designationPlacement,
      stampFontSizePt: options.stampFontSizePt,
      duplicateHandling: options.duplicateHandling,
      includeLoadFiles: options.includeLoadFiles,
      includeFilenameInPrivilegeLog: options.includeFilenameInPrivilegeLog,
      withheldHandling: options.withheldHandling,
    });
    // JsonValue is a mutable-array shape; copy every readonly array into a
    // plain one rather than widen the public `ProductionDuplicateGroup` type.
    const duplicateGroupsDetail = duplicateGroups.map((group) => ({
      sourceSha256: group.sourceSha256,
      canonicalOccurrenceOrdinal: group.canonicalOccurrenceOrdinal,
      occurrences: group.occurrences.map((occurrence) => ({ ...occurrence })),
    }));
    // Recorded in both modes and even when nothing was found -- an auditor
    // reading the manifest later should be able to see that duplicate
    // detection ran, not just infer it from an absent check.
    session.recordCheck({
      checkId: "duplicate-sources",
      status: "pass",
      detail: formatDuplicateCheckDetail(options.duplicateHandling, duplicateGroups, duplicateCount),
    });
    if (duplicateGroups.length > 0) {
      // The cross-reference between an omitted duplicate and the occurrence
      // that was actually produced lives ONLY here (and in production.json
      // below) -- never as a synthesized column in the index CSV/PDF, which
      // only ever lists what was actually produced.
      session.recordDetail("productionDuplicates", {
        duplicateHandling: options.duplicateHandling,
        duplicateCount,
        groups: duplicateGroupsDetail,
      });
    }
    if (input.volumeSizeMb !== undefined) {
      session.recordOverride({
        type: "production-volume-size",
        valueMb: input.volumeSizeMb,
      });
    }
    if (continuation !== null) {
      session.recordCheck({
        checkId: "bates-continuation",
        status: "pass",
        detail: {
          priorLastBates: continuation.summary.lastBates,
          priorCreatedAt: continuation.summary.createdAt,
          priorFileCount: continuation.summary.fileCount,
          mode: continuation.mode,
        },
      });
      // The absolute prior-package path is allowed here on the same terms as
      // `productionSources[].sourcePath` above: this is an internal audit
      // detail, never routed through `addManifestJson` (whose absolute-path
      // guard covers machine reports meant for review/upload, not this).
      session.recordDetail("productionContinuationSource", {
        priorPackageRoot: path.resolve(options.continueFrom!),
        mode: continuation.mode,
      });
      if (continuation.mode === "override") {
        session.recordOverride({
          type: "production-bates-continuation",
          reason: options.continuationOverride!.reason,
          priorPrefix: continuation.summary.prefix,
          priorDigits: continuation.summary.digits,
          priorNextNumber: continuation.summary.nextNumber,
          appliedStart: options.start,
          appliedDigits: options.digits,
        });
      }
    }
    session.recordCheck({
      checkId: "production-index-path-hygiene",
      status: "pass",
      detail: "Production index PDF and CSV use produced filenames only; source paths are in manifest detail.",
    });
    if (options.combinedPdf && files.length > 0) {
      // The per-document path holds one document at a time; the combined PDF
      // cannot, so record the bound it ran under next to the output it applies to.
      session.recordCheck({
        checkId: "production-combined-memory-bound",
        status: "pass",
        detail: `Combined production PDF held ${files.length} stamped documents open at once (cap ${MAX_COMBINED_PRODUCTION_SOURCES}); the per-document outputs hold one at a time.`,
      });
    }
    // Explicit, plain-language record of the zero-produced-output edge case:
    // every source was withheld and `withheldHandling` is "omit", so no
    // document was ever stamped -- `nextNumber` stays at `options.start`
    // and `upload/` is empty. The package is still a normal, complete
    // AUDIT-ONLY package: the draft privilege log (naming every withheld
    // document and its asserted privilege), the manifest, and every other
    // check are still written.
    if (files.length === 0) {
      session.recordCheck({
        checkId: "production-zero-output",
        status: "pass",
        detail:
          'Every source was withheld and withheldHandling is "omit" -- no documents were produced. This ' +
          "package is audit-only: upload/ is empty, but the draft privilege log, manifest, and checks are " +
          "still written.",
      });
    }
    await session.addManifestJson("production.json", {
      prefix: options.prefix,
      digits: options.digits,
      firstNumber: options.start,
      lastNumber: running - 1,
      nextNumber: running,
      includeFilenameInIndex: options.includeFilenameInIndex,
      combinedPdf,
      batesPlacement: options.batesPlacement,
      designationPlacement: options.designationPlacement,
      stampFontSizePt: options.stampFontSizePt,
      duplicateHandling: options.duplicateHandling,
      duplicateCount,
      duplicateGroups: duplicateGroupsDetail,
      includeLoadFiles: options.includeLoadFiles,
      loadFileDat,
      includeFilenameInPrivilegeLog: options.includeFilenameInPrivilegeLog,
      privilegeLogLocation,
      withheldCount,
      redactedCount,
      withheldHandling: options.withheldHandling,
      slipSheetCount,
      files: files.map((file) => ({
        sourceFilename: file.sourceFilename,
        outputName: file.outputName,
        packageRelativePath: file.packageRelativePath,
        batesStart: file.batesStart,
        batesEnd: file.batesEnd,
        pages: file.pages,
        designation: file.designation,
        designationPages: file.designationPages,
        custodian: file.custodian,
        status: file.status,
        isSlipSheet: file.status === "withhold",
        privilegeAsserted: file.privilegeAsserted,
        basis: file.basis,
        sha256: file.sha256,
        volume: file.volume,
      })),
      volumes: volumeResults.map((productionVolume) => ({
        name: productionVolume.name,
        files: [...productionVolume.files],
        bytes: productionVolume.bytes,
        oversizedFiles: [...productionVolume.oversizedFiles],
      })),
    });

    await session.finalize();
    finalized = true;
    const manifest = await readPackageManifest(options.outputDir);

    return {
      packageRoot: path.resolve(options.outputDir),
      prefix: options.prefix,
      digits: options.digits,
      firstNumber: options.start,
      lastNumber: running - 1,
      nextNumber: running,
      files,
      volumes: volumeResults,
      indexPdf,
      indexCsv,
      combinedPdf,
      loadFileDat,
      manifest,
      continuation: continuation === null
        ? null
        : { mode: continuation.mode, priorLastBates: continuation.summary.lastBates },
      duplicateGroups,
      duplicateCount,
      withheldCount,
      redactedCount,
      privilegeLogLocation,
      slipSheetCount,
    };
  } finally {
    if (combinedHandle !== null) {
      await engine.close(combinedHandle).catch(() => undefined);
    }
    for (const handle of stampedForCombined.reverse()) {
      await engine.close(handle).catch(() => undefined);
    }
    if (!finalized && session !== undefined) {
      await session.abort().catch(() => undefined);
    }
  }
}

type ScannedSource = Omit<ProductionSourcePlan, "firstNumber" | "lastNumber" | "batesStart" | "batesEnd">;

interface ProductionSourcePlanningResult {
  plans: ProductionSourcePlan[];
  duplicateGroups: ProductionDuplicateGroup[];
  duplicateCount: number;
  /** One `ScannedSource` per distinct content hash among withheld sources --
   * the canonical (lowest-ordinal) occurrence of each. Feeds the draft
   * privilege log's "Withheld" rows; a withheld duplicate group's
   * non-canonical members appear only in `duplicateGroups`, never as their
   * own log row. */
  withheldLogSources: readonly ScannedSource[];
}

/**
 * Planning pass. Each source is read, hashed, counted, and CLOSED before the
 * next one is touched, so the whole plan is scalars: no bytes and no open
 * handles survive it. Bates validation still runs across the complete plan
 * before any output exists, exactly as before.
 *
 * The tradeoff is one extra read per source (planning reads it, the output pass
 * reads it again) in exchange for peak memory that no longer grows with the
 * number of documents in the production.
 *
 * Duplicate sources (matching `sourceSha256`) are detected here, from the
 * SAME hash every source already computes for the planning pass -- no extra
 * read. In `"produce-once"` mode, every occurrence but the first (input
 * order) within a group is excluded from `plans` before Bates numbers are
 * assigned, so an omitted duplicate consumes no Bates number and never
 * reaches `stampPlannedSource` -- it is never re-read, so the #335 drift
 * guard (`readPlannedSourceBytes`) never runs against it either.
 */
async function prepareProductionSourcePlans(
  options: NormalizedInput,
  engine: PdfEngine,
): Promise<ProductionSourcePlanningResult> {
  const scanned: ScannedSource[] = [];

  for (const [index, source] of options.sources.entries()) {
    const sourcePath = path.resolve(source.path);
    const sourceFilename = path.basename(sourcePath);
    const sourceBytes = await fs.readFile(sourcePath);
    const original = await engine.open(sourceBytes);
    let pages: number;

    try {
      pages = await engine.pageCount(original);
    } finally {
      await engine.close(original).catch(() => undefined);
    }

    const designation = normalizeDesignation(source.designation);
    const designationPageIndexes = resolveDesignationPageIndexes(
      designation,
      source.designationPages,
      pages,
      sourceFilename,
    );
    const status = normalizeProductionStatus(source.status, sourceFilename);
    // Privilege text has no meaning for a produced document, and it is
    // sensitive attorney work product: a value left over from a reverted
    // Withhold choice must never reach the package manifest.
    const privilegeAsserted =
      status === "produce" ? "" : normalizePrivilegeText(source.privilegeAsserted);
    const basis = status === "produce" ? "" : normalizePrivilegeText(source.basis);
    if (status === "withhold" && privilegeAsserted === "") {
      throw new Error(
        `"${sourceFilename}": withholding a document requires a privilege basis ("Privilege asserted").`,
      );
    }

    scanned.push({
      sourcePath,
      sourceFilename,
      sourceSha256: sha256Hex(sourceBytes),
      sourceBytes: sourceBytes.byteLength,
      sourceOrdinal: index + 1,
      pages,
      // Read directly via pdf-lib rather than through `engine` -- the
      // opaque `PdfDocumentHandle` has no page-geometry accessor on
      // `PdfEngine`, and this is only needed for the pre-output fit check
      // below, not for the actual stamp (which still goes through `engine`
      // in `stampPlannedSource`). Same bytes already in memory; no extra I/O.
      pageGeometry: await readPageGeometry(sourceBytes),
      designation,
      designationPageIndexes,
      designationPagesSpec: designation === ""
        ? null
        : formatPartialDesignationPagesSpec(designationPageIndexes, pages),
      custodian: normalizeCustodian(source.custodian),
      status,
      privilegeAsserted,
      basis,
      isSlipSheet: false,
    });
  }

  const { groups, excludedSourceOrdinals } = groupDuplicateSources(scanned, options.duplicateHandling);
  // Two occurrences of the identical document can't be given different
  // production statuses -- checked BEFORE anything downstream (Bates
  // assignment, withhold filtering) treats the group as consistent.
  assertNoConflictingDuplicateStatuses(groups);
  // Under `withheldHandling: "omit"` (or when nothing is withheld), a
  // withheld source is excluded the same way a produce-once-omitted
  // duplicate is -- filtered out before Bates numbers are assigned, so
  // numbering stays contiguous and it never reaches `stampPlannedSource`.
  // Under `"slip-sheet"`, only a withheld duplicate group's NON-CANONICAL
  // occurrences are excluded this way -- the canonical occurrence instead
  // becomes a slip-sheet plan below, regardless of `duplicateHandling`
  // (mirroring the single-privilege-log-row rule for withheld duplicates).
  const withheldSources = scanned.filter((source) => source.status === "withhold");
  const withheldNonCanonicalOrdinals = new Set<number>();
  if (options.withheldHandling === "slip-sheet") {
    const seenWithheldSha256 = new Set<string>();
    for (const source of withheldSources) {
      if (seenWithheldSha256.has(source.sourceSha256)) {
        withheldNonCanonicalOrdinals.add(source.sourceOrdinal);
      } else {
        seenWithheldSha256.add(source.sourceSha256);
      }
    }
  }
  const withheldExcludedOrdinals = options.withheldHandling === "slip-sheet"
    ? withheldNonCanonicalOrdinals
    : new Set(withheldSources.map((source) => source.sourceOrdinal));
  const included = scanned
    .filter((source) =>
      !excludedSourceOrdinals.has(source.sourceOrdinal) && !withheldExcludedOrdinals.has(source.sourceOrdinal)
    )
    .map((source) => {
      if (options.withheldHandling !== "slip-sheet" || source.status !== "withhold") {
        return source;
      }
      // The slip sheet is a GENERATED one-page placeholder -- it consumes
      // exactly one Bates number regardless of the withheld document's real
      // page count (still recorded, informationally, on `scanned` for the
      // privilege log's Pages column), and it is never confidentiality
      // designated (see `WithheldHandling`'s doc comment and
      // `docs/PRODUCTION-SETS.md`).
      return {
        ...source,
        pages: 1,
        pageGeometry: [SLIP_SHEET_PAGE_GEOMETRY],
        designation: "",
        designationPageIndexes: "all" as PdfPageSelection,
        designationPagesSpec: null,
        isSlipSheet: true,
      };
    });

  const totalPages = included.reduce((sum, source) => sum + source.pages, 0);
  assertBatesFits(options.digits, options.start + totalPages - 1);

  let running = options.start;
  const plans: ProductionSourcePlan[] = included.map((source) => {
    const firstNumber = running;
    const lastNumber = firstNumber + source.pages - 1;
    running = lastNumber + 1;

    return {
      ...source,
      firstNumber,
      lastNumber,
      batesStart: formatBates(options.prefix, firstNumber, options.digits),
      batesEnd: formatBates(options.prefix, lastNumber, options.digits),
    };
  });

  await assertStampsFitAtMinimumSize(plans, options);

  const producedByOrdinal = new Map(plans.map((plan) => [plan.sourceOrdinal, plan]));
  let duplicateCount = 0;
  const duplicateGroups: ProductionDuplicateGroup[] = groups.map((group) => {
    duplicateCount += group.members.length - 1;
    return {
      sourceSha256: group.sourceSha256,
      canonicalOccurrenceOrdinal: group.members[0]!.sourceOrdinal,
      occurrences: group.members.map((member) => {
        const plan = producedByOrdinal.get(member.sourceOrdinal);
        return {
          sourceFilename: member.sourceFilename,
          sourceOrdinal: member.sourceOrdinal,
          action: plan === undefined ? "omitted" : "produced",
          batesRange: plan === undefined ? null : `${plan.batesStart}-${plan.batesEnd}`,
        };
      }),
    };
  });

  return { plans, duplicateGroups, duplicateCount, withheldLogSources: selectCanonicalWithheldSources(scanned) };
}

/**
 * Rejects, before any output exists, a duplicate group (byte-identical
 * sources) whose members don't all share the same `status`. Two copies of
 * the same document can't be simultaneously produced and withheld -- that
 * would mean the production hands over a document the privilege log claims
 * was never produced. Identically-statused duplicates proceed to the normal
 * `duplicateHandling` (and, for a uniformly-withheld group, the
 * single-canonical-row privilege log collapse in
 * `selectCanonicalWithheldSources`) unaffected.
 */
function assertNoConflictingDuplicateStatuses(groups: readonly ScannedSourceGroup[]): void {
  for (const group of groups) {
    const statuses = new Set(group.members.map((member) => member.status));
    if (statuses.size > 1) {
      const names = group.members.map((member) => `"${member.sourceFilename}"`).join(", ");
      throw new Error(
        `${names} are identical documents with conflicting production statuses -- resolve before building.`,
      );
    }
  }
}

/**
 * Picks one canonical `ScannedSource` per distinct content hash among
 * withheld sources, in `scanned` (source) order -- the first occurrence of
 * each hash wins. A withheld duplicate group produces exactly one draft
 * privilege log row (the group's canonical occurrence); its non-canonical
 * members are recorded only in the `duplicateGroups` manifest
 * cross-reference, same as any other duplicate group's excluded members.
 */
function selectCanonicalWithheldSources(scanned: readonly ScannedSource[]): ScannedSource[] {
  const seenSha256 = new Set<string>();
  const canonical: ScannedSource[] = [];
  for (const source of scanned) {
    if (source.status !== "withhold" || seenSha256.has(source.sourceSha256)) {
      continue;
    }
    seenSha256.add(source.sourceSha256);
    canonical.push(source);
  }
  return canonical;
}

interface ScannedSourceGroup {
  sourceSha256: string;
  /** In input (`sources`) order -- the first entry is the group's canonical
   * occurrence. */
  members: ScannedSource[];
}

/**
 * Groups `scanned` sources by `sourceSha256`, keeping only groups with two
 * or more members (a lone hash isn't a duplicate of anything). In
 * `"produce-once"` mode, every member but the first (source order) is
 * marked excluded -- the caller drops those before Bates numbers are
 * assigned, so numbering stays contiguous and an excluded duplicate never
 * reaches output.
 */
function groupDuplicateSources(
  scanned: readonly ScannedSource[],
  duplicateHandling: ProductionDuplicateHandling,
): { groups: ScannedSourceGroup[]; excludedSourceOrdinals: ReadonlySet<number> } {
  const bySha = new Map<string, ScannedSource[]>();
  for (const source of scanned) {
    const members = bySha.get(source.sourceSha256);
    if (members === undefined) {
      bySha.set(source.sourceSha256, [source]);
    } else {
      members.push(source);
    }
  }

  const groups: ScannedSourceGroup[] = [];
  const excludedSourceOrdinals = new Set<number>();

  // Map iteration order already reflects first-seen order (insertion order),
  // which is source order here -- sorting explicitly keeps that guarantee
  // even if a future refactor changes how `bySha` is built.
  for (const [sourceSha256, members] of bySha) {
    if (members.length < 2) {
      continue;
    }
    groups.push({ sourceSha256, members });
    if (duplicateHandling === "produce-once") {
      for (const member of members.slice(1)) {
        excludedSourceOrdinals.add(member.sourceOrdinal);
      }
    }
  }
  groups.sort((left, right) => left.members[0]!.sourceOrdinal - right.members[0]!.sourceOrdinal);

  return { groups, excludedSourceOrdinals };
}

/** The `duplicate-sources` check detail string -- shared by every
 * `duplicateHandling` mode so the manifest always records that duplicate
 * detection ran, not just when it found something. */
function formatDuplicateCheckDetail(
  duplicateHandling: ProductionDuplicateHandling,
  duplicateGroups: readonly ProductionDuplicateGroup[],
  duplicateCount: number,
): string {
  if (duplicateGroups.length === 0) {
    return "No duplicate sources detected.";
  }

  const totalOccurrences = duplicateGroups.reduce((sum, group) => sum + group.occurrences.length, 0);
  const groupWord = duplicateGroups.length === 1 ? "group" : "groups";
  const base = `${totalOccurrences} duplicate sources in ${duplicateGroups.length} ${groupWord}`;
  return duplicateHandling === "produce-all"
    ? `${base}; produced all`
    : `${base}; produced once, ${duplicateCount} omitted`;
}

/** A draft privilege log row, in production order (assigned after the full
 * withheld + produce-redacted row set is sorted by source ordinal) -- see
 * where `privilegeLogRows` is built in `buildProductionSet`. Carries the
 * source's absolute path and hash for the `privilegeLog` manifest detail;
 * `formatPrivilegeLogCsv` (the CSV surface) uses only the
 * `ProductionPrivilegeLogRow` subset of these fields. */
interface ProductionPrivilegeLogRowPlan {
  rowId: string;
  status: "Withheld" | "Produced with redactions";
  /** `"${batesStart}-${batesEnd}"` when this row's document was actually
   * produced and consumed a Bates range -- always true for "Produced with
   * redactions"; true for "Withheld" ONLY under `withheldHandling:
   * "slip-sheet"` (the slip sheet's own range). `""` for a "Withheld" row
   * under `"omit"`, which consumed no Bates number at all. */
  bates: string;
  privilegeAsserted: string;
  basis: string;
  filename: string;
  pages: number;
  sourceOrdinal: number;
  sourceFilename: string;
  sourcePath: string;
  sourceSha256: string;
}

/** Zero-padded to 3 digits (e.g. `"P-001"`), widening naturally past 999
 * rows -- never truncated or capped. Assigned by production order (source
 * ordinal), so a rebuild of the identical input reproduces identical row
 * ids -- see `ProductionSetResult` / the package README's "stable across
 * two builds" requirement for `draft-privilege-log.csv`. */
function formatPrivilegeLogRowId(sequence: number): string {
  return `P-${String(sequence).padStart(3, "0")}`;
}

/** The `privilege-log-draft` check detail string -- only ever recorded when
 * at least one row exists (see the `privilegeLogRows.length > 0` gate in
 * `buildProductionSet`), so this never needs a "none found" branch the way
 * `formatDuplicateCheckDetail` does. */
function formatPrivilegeLogCheckDetail(withheldCount: number, redactedCount: number): string {
  const parts: string[] = [];
  if (withheldCount > 0) {
    parts.push(`${withheldCount} withheld`);
  }
  if (redactedCount > 0) {
    parts.push(`${redactedCount} produced with redactions`);
  }
  return `${parts.join(", ")} -- draft privilege log; not ready to serve, review and complete it before any use.`;
}

/**
 * Resolves a source's designation page restriction against its actual page
 * count. Requires `designationPages` to be empty when there's no
 * designation to restrict (nothing to stamp, so a page range would be
 * meaningless), and wraps any `PageRangeError` with the source's filename so
 * a multi-file production's error names which file is at fault.
 */
function resolveDesignationPageIndexes(
  designation: string,
  designationPages: string | undefined,
  pageCount: number,
  sourceFilename: string,
): PdfPageSelection {
  if (designation === "") {
    if (designationPages !== undefined && designationPages.trim() !== "") {
      throw new Error(
        `"${sourceFilename}": a page range was set ("${designationPages}") but no confidentiality ` +
          "designation was chosen for this file -- choose a designation, or clear the page range.",
      );
    }
    return "all";
  }

  try {
    return parsePageRanges(designationPages, pageCount);
  } catch (error) {
    if (error instanceof PageRangeError) {
      throw new Error(`"${sourceFilename}": ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/** Only records a spec when it's a genuine restriction to fewer than every
 * page -- an explicit spec that happens to name every page is functionally
 * identical to the (unrecorded) whole-document default. */
function formatPartialDesignationPagesSpec(
  pageIndexes: PdfPageSelection,
  pageCount: number,
): string | null {
  if (pageIndexes === "all" || pageIndexes === "first" || pageIndexes.length >= pageCount) {
    return null;
  }
  return formatPageRangeSpec(pageIndexes);
}

async function readPageGeometry(bytes: Uint8Array): Promise<readonly PlannedPageGeometry[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPages().map((page) => ({
    widthPt: page.getWidth(),
    heightPt: page.getHeight(),
    rotationDegrees: page.getRotation().angle,
  }));
}

/** `true` when the page's visual (as-viewed) orientation swaps width and
 * height -- mirrors `engine-local`'s own `isSidewaysRotation`, rounded to
 * the nearest 90-degree increment since that's the only rotation PDF page
 * dictionaries support. */
function isPlannedPageSideways(rotationDegrees: number): boolean {
  const normalized = ((Math.round(rotationDegrees / 90) * 90) % 360 + 360) % 360;
  return normalized === 90 || normalized === 270;
}

interface StampFitProbe {
  label: "Bates numbers" | "confidentiality designation";
  text: string;
  sourceFilename: string;
  /** 1-based, for the error message. */
  pageNumber: number;
  geometry: PlannedPageGeometry;
}

/**
 * Pre-output check that every stamp this build will apply still renders at
 * or above `MIN_STAMP_FONT_SIZE_PT` once the engine's own width-fitting
 * (`fitFontSizeToWidth` in `engine-local`, mirrored here) shrinks it to fit
 * the narrowest page it lands on. Runs BEFORE any output exists, same as
 * `assertBatesFits` above -- a build that would silently produce
 * illegibly-small stamps fails here instead, naming the exact offending
 * text and page.
 *
 * This re-implements the engine's own fit math (same Helvetica metrics, same
 * default 0.5in margin) rather than calling the engine, because `PdfEngine`
 * has no "measure without stamping" operation and `stampText`/`batesStamp`
 * only report the stamped bytes, not the rendered size they landed on.
 * `buildProductionSet` is only ever invoked against the local (pdf-lib)
 * engine in this codebase (see `handleProductionSet` in
 * `apps/mcp/src/tools/legal.ts`), so this mirrors the exact algorithm that
 * will actually run, not an approximation of a different backend.
 */
async function assertStampsFitAtMinimumSize(
  plans: readonly ProductionSourcePlan[],
  options: NormalizedInput,
): Promise<void> {
  const probes = buildStampFitProbes(plans, options);
  if (probes.length === 0) {
    return;
  }

  const measuringDoc = await PDFDocument.create();
  const font = await measuringDoc.embedFont(StandardFonts.Helvetica);
  const marginPt = STAMP_MARGIN_IN * POINTS_PER_INCH;

  let worst: { probe: StampFitProbe; renderedSize: number; visualWidth: number } | null = null;

  for (const probe of probes) {
    const visualWidth = isPlannedPageSideways(probe.geometry.rotationDegrees)
      ? probe.geometry.heightPt
      : probe.geometry.widthPt;
    const maxTextWidth = visualWidth - 2 * marginPt;
    const textWidth = font.widthOfTextAtSize(probe.text, options.stampFontSizePt);
    const renderedSize = maxTextWidth <= 0
      ? 0
      : Math.min(options.stampFontSizePt, options.stampFontSizePt * (maxTextWidth / textWidth));

    if (worst === null || renderedSize < worst.renderedSize) {
      worst = { probe, renderedSize, visualWidth };
    }
  }

  if (worst !== null && worst.renderedSize < MIN_STAMP_FONT_SIZE_PT) {
    throw new Error(
      `The ${worst.probe.label} "${worst.probe.text}" would shrink to ${worst.renderedSize.toFixed(1)}pt ` +
        `on page ${worst.probe.pageNumber} of "${worst.probe.sourceFilename}" (that page is ` +
        `${worst.visualWidth.toFixed(0)}pt wide) -- below the ${MIN_STAMP_FONT_SIZE_PT}pt minimum. Use a ` +
        "smaller font size, shorter text, or a different placement.",
    );
  }
}

/**
 * Normalizes a `PdfPageSelection` (as stored on a plan) to concrete
 * zero-based page indexes. `designationPageIndexes` on a plan is only ever
 * `"all"` or an explicit array in practice (see `resolveDesignationPageIndexes`
 * above -- `parsePageRanges` never returns `"first"`), but the shared
 * `PdfPageSelection` type is broader, so `"first"` is handled defensively
 * rather than assumed away.
 */
function resolveConcreteDesignationPages(
  selection: PdfPageSelection,
  pageCount: number,
): readonly number[] {
  if (selection === "all") {
    return Array.from({ length: pageCount }, (_, index) => index);
  }
  if (selection === "first") {
    return pageCount > 0 ? [0] : [];
  }
  return selection;
}

function buildStampFitProbes(
  plans: readonly ProductionSourcePlan[],
  options: NormalizedInput,
): StampFitProbe[] {
  const probes: StampFitProbe[] = [];

  for (const plan of plans) {
    for (let pageIndex = 0; pageIndex < plan.pages; pageIndex += 1) {
      const geometry = plan.pageGeometry[pageIndex];
      if (geometry === undefined) {
        continue;
      }
      probes.push({
        label: "Bates numbers",
        text: formatBates(options.prefix, plan.firstNumber + pageIndex, options.digits),
        sourceFilename: plan.sourceFilename,
        pageNumber: pageIndex + 1,
        geometry,
      });
    }

    if (plan.designation === "") {
      continue;
    }

    for (const pageIndex of resolveConcreteDesignationPages(plan.designationPageIndexes, plan.pages)) {
      const geometry = plan.pageGeometry[pageIndex];
      if (geometry === undefined) {
        continue;
      }
      probes.push({
        label: "confidentiality designation",
        text: plan.designation,
        sourceFilename: plan.sourceFilename,
        pageNumber: pageIndex + 1,
        geometry,
      });
    }
  }

  return probes;
}

/**
 * Reopens one planned source and applies its stamps, closing each intermediate
 * document as soon as the next one exists. Returns the final stamped document;
 * the caller owns closing it.
 */
async function stampPlannedSource(
  plan: ProductionSourcePlan,
  options: NormalizedInput,
  engine: PdfEngine,
): Promise<PdfDocumentHandle> {
  const sourceBytes = await resolvePlannedSourceBytes(plan);
  const original = await engine.open(sourceBytes);
  let produced: PdfDocumentHandle;

  try {
    produced = await engine.batesStamp(original, {
      prefix: options.prefix,
      start: plan.firstNumber,
      digits: options.digits,
      placement: options.batesPlacement,
      fontSizePt: options.stampFontSizePt,
    });
  } finally {
    await engine.close(original).catch(() => undefined);
  }

  if (plan.designation === "") {
    return produced;
  }

  try {
    return await engine.stampText(produced, {
      text: plan.designation,
      pageIndexes: plan.designationPageIndexes,
      placement: options.designationPlacement,
      fontSizePt: options.stampFontSizePt,
    });
  } finally {
    await engine.close(produced).catch(() => undefined);
  }
}

/**
 * Rereads a planned source and refuses it if it no longer matches the bytes the
 * plan was built from. Planning and output are two separate reads now, so a file
 * edited in between would otherwise be produced under a page range and a source
 * hash that describe the older document.
 */
async function readPlannedSourceBytes(plan: ProductionSourcePlan): Promise<Uint8Array> {
  const bytes = await fs.readFile(plan.sourcePath);

  if (bytes.byteLength !== plan.sourceBytes || sha256Hex(bytes) !== plan.sourceSha256) {
    throw new Error(
      `"${plan.sourceFilename}" changed on disk during the production build. Start the production again.`,
    );
  }

  return bytes;
}

/**
 * Resolves the bytes `stampPlannedSource` actually opens for a plan.
 *
 * For an ordinary plan, this is just `readPlannedSourceBytes` -- the
 * source's own (re-verified, drift-checked) bytes. For a slip-sheet
 * placeholder (`plan.isSlipSheet`), the withheld source's FILE is still
 * never read for its content -- `readPlannedSourceBytes` runs anyway,
 * purely as a drift guard (same #335 fix family as an ordinary produced
 * source: the planning hash must still match what's on disk right before
 * output, so the privilege log and manifest are never attested against a
 * stale fingerprint), and its return value is discarded. The actual output
 * bytes come from `createSlipSheetPageBytes`, a generated page carrying the
 * privilege asserted and basis, never the withheld document's bytes.
 */
async function resolvePlannedSourceBytes(plan: ProductionSourcePlan): Promise<Uint8Array> {
  if (!plan.isSlipSheet) {
    return readPlannedSourceBytes(plan);
  }

  await readPlannedSourceBytes(plan);
  return createSlipSheetPageBytes({
    privilegeAsserted: plan.privilegeAsserted,
    basis: plan.basis,
  });
}

function normalizeInput(input: BuildProductionSetInput): NormalizedInput {
  const prefix = input.prefix.trim();
  const start = input.start ?? DEFAULT_START;
  const digits = input.digits ?? DEFAULT_DIGITS;

  if (input.sources.length === 0) {
    throw new Error("Production set requires at least one source PDF.");
  }
  if (prefix.length === 0) {
    throw new Error("Production prefix is required.");
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new Error("Production start must be a non-negative integer.");
  }
  if (!Number.isInteger(digits) || digits < 1) {
    throw new Error("Production digits must be a positive integer.");
  }
  if (input.volumeSizeMb !== undefined && (!Number.isFinite(input.volumeSizeMb) || input.volumeSizeMb <= 0)) {
    throw new Error("Volume size cap must be a positive number of MB.");
  }
  if (input.continuationOverride !== undefined && input.continueFrom === undefined) {
    throw new Error("Adjusting the Bates continuation start or digit width requires continuing from a prior production.");
  }
  if (input.continuationOverride !== undefined && input.continuationOverride.reason.trim().length === 0) {
    throw new Error("A reason is required to adjust the Bates continuation start or digit width.");
  }
  const duplicateHandling = input.duplicateHandling ?? DEFAULT_DUPLICATE_HANDLING;
  if (duplicateHandling !== "produce-all" && duplicateHandling !== "produce-once") {
    throw new Error('Duplicate handling must be "produce-all" or "produce-once".');
  }
  const withheldHandling = input.withheldHandling ?? DEFAULT_WITHHELD_HANDLING;
  if (withheldHandling !== "slip-sheet" && withheldHandling !== "omit") {
    throw new Error('Withheld handling must be "slip-sheet" or "omit".');
  }
  // Refused before anything is written, so the user still has the choice of
  // running the same production without the combined PDF.
  if ((input.combinedPdf ?? false) && input.sources.length > MAX_COMBINED_PRODUCTION_SOURCES) {
    throw new Error(
      `A combined production PDF is limited to ${MAX_COMBINED_PRODUCTION_SOURCES} documents ` +
        `(${input.sources.length} selected) because every document must be held open to merge them. ` +
        "Turn off the combined PDF to produce this set; the Bates-stamped documents are not limited.",
    );
  }

  const stampFontSizePt = input.stampFontSizePt ?? DEFAULT_STAMP_FONT_SIZE_PT;
  if (
    !Number.isFinite(stampFontSizePt) ||
    stampFontSizePt < MIN_STAMP_FONT_SIZE_PT ||
    stampFontSizePt > MAX_STAMP_FONT_SIZE_PT
  ) {
    throw new Error(
      `Stamp font size must be between ${MIN_STAMP_FONT_SIZE_PT} and ${MAX_STAMP_FONT_SIZE_PT} points.`,
    );
  }

  const batesPlacement = input.batesPlacement ?? DEFAULT_BATES_PLACEMENT;
  const designationPlacement = input.designationPlacement ?? DEFAULT_DESIGNATION_PLACEMENT;
  assertPlacementsDoNotShareEdge(batesPlacement, designationPlacement);

  return {
    sources: input.sources,
    outputDir: input.outputDir,
    prefix,
    start,
    digits,
    includeFilenameInIndex: input.includeFilenameInIndex ?? true,
    includeIndex: input.includeIndex ?? true,
    combinedPdf: input.combinedPdf ?? false,
    appVersion: input.appVersion ?? DEFAULT_APP_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    volumeBytes: input.volumeSizeMb === undefined ? null : Math.floor(input.volumeSizeMb * 1024 * 1024),
    continueFrom: input.continueFrom ?? null,
    continuationOverride: input.continuationOverride ?? null,
    batesPlacement,
    designationPlacement,
    stampFontSizePt,
    duplicateHandling,
    includeLoadFiles: input.includeLoadFiles ?? false,
    includeFilenameInPrivilegeLog: input.includeFilenameInPrivilegeLog ?? true,
    withheldHandling,
  };
}

/**
 * Collision guard (v1): Bates numbers and the confidentiality designation
 * may not share a page edge, regardless of alignment.
 *
 * The task this guards against is real -- a long designation centered in the
 * header can run into a right-aligned Bates number also in the header -- but
 * measuring whether any two ACTUAL strings would overlap at build time is
 * disproportionate to implement correctly: it would need per-page text-width
 * measurement (already added for the min-size check below, but that check is
 * single-stamp; overlap is pairwise) crossed against every rotation, and it
 * would still be a moving target every time a filename-derived Bates string
 * or a custom designation changes length between pages. Prohibiting the
 * same edge outright is unambiguous, cheap, always correct (two placements
 * on different edges can never collide), and easy to reason about: put Bates
 * in the footer and the designation in the header (the defaults), or vice
 * versa. A future version could relax this with real pairwise measurement if
 * the blanket rule proves too restrictive in practice.
 */
function assertPlacementsDoNotShareEdge(
  batesPlacement: PdfStampPlacement,
  designationPlacement: PdfStampPlacement,
): void {
  if (batesPlacement.edge === designationPlacement.edge) {
    throw new Error(
      `Bates numbers and the confidentiality designation can't both be placed in the ` +
        `${batesPlacement.edge} -- put one in the header and the other in the footer.`,
    );
  }
}

function formatBates(prefix: string, value: number, digits: number): string {
  return `${prefix}${String(value).padStart(digits, "0")}`;
}

function assertBatesFits(digits: number, lastNumber: number): void {
  if (lastNumber >= 10 ** digits) {
    throw new Error("Bates numbers exceed the configured digit width.");
  }
}

function normalizeDesignation(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** Same shape as `normalizeDesignation` -- trim, default to `""` -- kept as
 * its own function since it normalizes a semantically distinct field
 * (`ProductionSourceInput.custodian`, not the confidentiality designation). */
function normalizeCustodian(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** Same shape again -- trim, default to `""` -- for `privilegeAsserted` and
 * `basis`, which share identical normalization but are semantically
 * distinct fields (see `ProductionSourceInput`). */
function normalizePrivilegeText(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Validates and defaults a source's `status`. Defensive at the type level
 * (not just documentation): `input.sources` crosses a JSON boundary from the
 * MCP tool and the Rust one-shot input, either of which could hand this an
 * arbitrary string, same reasoning as `duplicateHandling`'s validation in
 * `normalizeInput`. Named in the error so a multi-file production's error
 * points at the offending source, matching `resolveDesignationPageIndexes`.
 */
function normalizeProductionStatus(value: unknown, sourceFilename: string): ProductionSourceStatus {
  if (value === undefined) {
    return DEFAULT_PRODUCTION_STATUS;
  }
  if (value === "produce" || value === "produce-redacted" || value === "withhold") {
    return value;
  }
  throw new Error(
    `"${sourceFilename}": status must be "produce", "produce-redacted", or "withhold".`,
  );
}

function safePdfName(value: string): string {
  const base = [...value]
    .map((character) => (isUnsafeFileNameCharacter(character) ? "_" : character))
    .join("")
    .trim() || "document.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function isUnsafeFileNameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  // 0x14 and þ (0xFE) are the DAT load file's structural bytes: a produced
  // filename containing them could never round-trip through the DAT LINK
  // field, so they are normalized out of physical names to keep the two
  // identical. ® is substituted in DAT values too, so it is excluded as well.
  return (
    code < 0x20 ||
    code === 0x7f ||
    code === 0xfe ||
    code === 0xae ||
    "\\/:*?\"<>|".includes(character)
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createVolume(index: number): VolumeState {
  return { index, bytes: 0, files: [], oversizedFiles: [] };
}

function volumeLabel(index: number): string {
  return `VOL${String(index).padStart(3, "0")}`;
}

function assignVolume(
  current: VolumeState | null,
  outputName: string,
  bytes: number,
  cap: number | null,
): string | null {
  if (cap === null || current === null) {
    return null;
  }

  if (current.files.length > 0 && current.bytes + bytes > cap) {
    current.index += 1;
    current.bytes = 0;
    current.files = [];
    current.oversizedFiles = [];
  }

  current.files.push(outputName);
  current.bytes += bytes;
  if (bytes > cap) {
    current.oversizedFiles.push(outputName);
  }

  return volumeLabel(current.index);
}

function collectVolumes(
  files: readonly VolumeUploadArtifact[],
  cap: number | null,
): ProductionVolumeResult[] {
  if (cap === null) {
    return [];
  }

  const byName = new Map<string, ProductionVolumeResult & { files: string[]; oversizedFiles: string[] }>();
  for (const file of files) {
    if (file.volume === null) {
      continue;
    }
    const entry = byName.get(file.volume) ?? {
      name: file.volume,
      files: [],
      bytes: 0,
      oversizedFiles: [],
    };
    entry.files.push(file.outputName);
    entry.bytes += file.bytes;
    if (file.bytes > cap) {
      entry.oversizedFiles.push(file.outputName);
    }
    byName.set(file.volume, entry);
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export interface ProductionIndexRow {
  batesStart: string;
  batesEnd: string;
  filename: string;
  pages: number;
  designation: string;
  /** Normalized 1-based page-range spec (e.g. "1-3,7") when the designation
   * is restricted to part of the document; `null` for whole-document
   * coverage (including no designation at all). */
  designationPages: string | null;
  sha256: string;
}

function toIndexRow(file: ProductionSetFileResult): ProductionIndexRow {
  return {
    batesStart: file.batesStart,
    batesEnd: file.batesEnd,
    filename: file.outputName,
    pages: file.pages,
    designation: file.designation,
    designationPages: file.designationPages,
    sha256: file.sha256,
  };
}

/** `LINK` is written backslash-separated by `formatProductionDat` itself --
 * this only needs to hand over the forward-slash `packageRelativePath` the
 * package writer already produced. */
function toDatRow(file: ProductionSetFileResult): ProductionDatRow {
  return {
    begBates: file.batesStart,
    endBates: file.batesEnd,
    pageCount: file.pages,
    confidentiality: file.designation,
    custodian: file.custodian,
    filename: file.outputName,
    link: file.packageRelativePath,
    sha256: file.sha256,
  };
}

export function formatProductionCsv(
  rows: readonly ProductionIndexRow[],
  includeFilename: boolean,
): string {
  const headers = [
    "Bates Start",
    "Bates End",
    ...(includeFilename ? ["Filename"] : []),
    "Pages",
    "Designation",
    "Designation Pages",
    "SHA-256",
  ];
  const lines = rows.map((row) => [
    row.batesStart,
    row.batesEnd,
    ...(includeFilename ? [row.filename] : []),
    String(row.pages),
    row.designation,
    row.designationPages ?? "",
    row.sha256,
  ]);
  return `${[headers, ...lines].map((line) => line.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

/**
 * One `draft-privilege-log.csv` row's CSV-facing fields -- the subset of
 * `ProductionPrivilegeLogRowPlan` that `formatPrivilegeLogCsv` actually
 * writes; the plan's extra source-path/hash/ordinal fields stay in the
 * `privilegeLog` manifest detail only.
 */
export interface ProductionPrivilegeLogRow {
  /** Stable, e.g. `"P-001"` -- see `formatPrivilegeLogRowId`. */
  rowId: string;
  status: "Withheld" | "Produced with redactions";
  /** `"${batesStart}-${batesEnd}"` when the row's document consumed a Bates
   * range (always for "Produced with redactions"; a "Withheld" row only
   * under `withheldHandling: "slip-sheet"`), `""` otherwise -- a "Withheld"
   * row under `"omit"` consumed no Bates number at all. */
  bates: string;
  privilegeAsserted: string;
  /** The `Description` column. */
  basis: string;
  filename: string;
  pages: number;
}

/**
 * Formats the draft privilege log -- see `BuildProductionSetInput`'s doc
 * comments and `docs/PRODUCTION-SETS.md` for the design. `Date`, `DocType`,
 * `Author`, and `Recipients` are always blank: manual columns a human fills
 * in, never guessed by RaioPDF -- a wrong autopopulated privilege log is
 * worse than a sparse one. Unlike `formatProductionCsv`'s filename column
 * (entirely omitted when off), `includeFilename` here only blanks the
 * `Filename` VALUES; the column and its header always exist, matching
 * `formatProductionDat`'s `FILENAME` behavior. `Bates` is never blanked by
 * `includeFilename` -- it's independent of the filename option, and blank
 * only when the row's document genuinely never consumed a Bates number.
 */
export function formatPrivilegeLogCsv(
  rows: readonly ProductionPrivilegeLogRow[],
  includeFilename: boolean,
): string {
  const headers = [
    "RowId",
    "Status",
    "Bates",
    "PrivilegeAsserted",
    "Description",
    "Filename",
    "Pages",
    "Date",
    "DocType",
    "Author",
    "Recipients",
  ];
  const lines = rows.map((row) => [
    row.rowId,
    row.status,
    row.bates,
    row.privilegeAsserted,
    row.basis,
    includeFilename ? row.filename : "",
    String(row.pages),
    "", // Date -- always blank; manual column.
    "", // DocType -- always blank; manual column.
    "", // Author -- always blank; manual column.
    "", // Recipients -- always blank; manual column.
  ]);
  return `${[headers, ...lines].map((line) => line.map(csvCell).join(",")).join("\n")}\n`;
}

async function createProductionIndexPdf(
  rows: readonly ProductionIndexRow[],
  includeFilename: boolean,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 42;
  const rowHeight = 15;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const draw = (text: string, x: number, font = regular, size = 8): void => {
    page.drawText(text, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
  };
  const nextPageIfNeeded = (): void => {
    if (y >= margin + rowHeight) {
      return;
    }
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
    drawHeader();
  };
  const drawHeader = (): void => {
    page.drawText("Production Index", {
      x: margin,
      y,
      size: 13,
      font: bold,
      color: rgb(0.06, 0.06, 0.06),
    });
    y -= 24;
    draw("Bates Start", margin, bold);
    draw("Bates End", margin + 92, bold);
    if (includeFilename) {
      draw("Filename", margin + 184, bold);
      draw("Pages", margin + 390, bold);
      draw("Designation", margin + 430, bold);
    } else {
      draw("Pages", margin + 184, bold);
      draw("Designation", margin + 230, bold);
    }
    y -= rowHeight;
  };

  drawHeader();
  for (const row of rows) {
    nextPageIfNeeded();
    draw(row.batesStart, margin);
    draw(row.batesEnd, margin + 92);
    const designationDisplay = row.designationPages === null
      ? row.designation
      : `${row.designation} (pp. ${row.designationPages})`;
    if (includeFilename) {
      draw(truncate(row.filename, 44), margin + 184);
      draw(String(row.pages), margin + 390);
      draw(truncate(designationDisplay, 31), margin + 430);
    } else {
      draw(String(row.pages), margin + 184);
      draw(truncate(designationDisplay, 56), margin + 230);
    }
    y -= rowHeight;
  }

  return pdf.save();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
