import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PdfDocumentHandle, PdfEngine, PdfPageSelection, PdfStampPlacement } from "@raiopdf/engine-api";
import { formatPageRangeSpec, parsePageRanges, PageRangeError } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { createPackage, readPackageManifest } from "@raiopdf/package-writer";
import type { PackageManifest } from "@raiopdf/package-writer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

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
}

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
}

const DEFAULT_DIGITS = 6;
const DEFAULT_START = 1;
const DEFAULT_APP_VERSION = "0.1.0";
const DEFAULT_BATES_PLACEMENT: PdfStampPlacement = { edge: "footer", align: "right" };
const DEFAULT_DESIGNATION_PLACEMENT: PdfStampPlacement = { edge: "header", align: "center" };
const DEFAULT_STAMP_FONT_SIZE_PT = 10;
/** Silently dropping a document from a discovery production is the
 * dangerous default; producing every occurrence (with its own Bates range,
 * cross-referenced) is the safe one. */
const DEFAULT_DUPLICATE_HANDLING: ProductionDuplicateHandling = "produce-all";
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

    const { plans: sourcePlans, duplicateGroups, duplicateCount } = await prepareProductionSourcePlans(
      options,
      engine,
    );
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
        const outputName = `${plan.batesStart} - ${plan.batesEnd} - ${safePdfName(plan.sourceFilename)}`;
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

    let combinedPdf: string | null = null;
    if (options.combinedPdf) {
      const merged = await engine.merge(stampedForCombined, {
        labels: files.map((file) => file.sourceFilename),
      });
      const combined = merged.document;
      combinedHandle = combined;
      const combinedBytes = await engine.saveToBytes(combined);
      const combinedName = `${formatBates(options.prefix, options.start, options.digits)} - ${formatBates(
        options.prefix,
        running - 1,
        options.digits,
      )} - combined-production.pdf`;
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
    if (options.combinedPdf) {
      // The per-document path holds one document at a time; the combined PDF
      // cannot, so record the bound it ran under next to the output it applies to.
      session.recordCheck({
        checkId: "production-combined-memory-bound",
        status: "pass",
        detail: `Combined production PDF held ${files.length} stamped documents open at once (cap ${MAX_COMBINED_PRODUCTION_SOURCES}); the per-document outputs hold one at a time.`,
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
      files: files.map((file) => ({
        sourceFilename: file.sourceFilename,
        outputName: file.outputName,
        packageRelativePath: file.packageRelativePath,
        batesStart: file.batesStart,
        batesEnd: file.batesEnd,
        pages: file.pages,
        designation: file.designation,
        designationPages: file.designationPages,
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
      manifest,
      continuation: continuation === null
        ? null
        : { mode: continuation.mode, priorLastBates: continuation.summary.lastBates },
      duplicateGroups,
      duplicateCount,
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
    });
  }

  const { groups, excludedSourceOrdinals } = groupDuplicateSources(scanned, options.duplicateHandling);
  const included = scanned.filter((source) => !excludedSourceOrdinals.has(source.sourceOrdinal));

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

  return { plans, duplicateGroups, duplicateCount };
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
  const sourceBytes = await readPlannedSourceBytes(plan);
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

function safePdfName(value: string): string {
  const base = [...value]
    .map((character) => (isUnsafeFileNameCharacter(character) ? "_" : character))
    .join("")
    .trim() || "document.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function isUnsafeFileNameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f || "\\/:*?\"<>|".includes(character);
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
