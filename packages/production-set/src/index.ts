import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PdfDocumentHandle, PdfEngine, PdfStampPlacement } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { createPackage, readPackageManifest } from "@raiopdf/package-writer";
import type { PackageManifest } from "@raiopdf/package-writer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ProductionSourceInput {
  path: string;
  designation?: string | undefined;
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
  pages: number;
  firstNumber: number;
  lastNumber: number;
  batesStart: string;
  batesEnd: string;
  designation: string;
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
}

const DEFAULT_DIGITS = 6;
const DEFAULT_START = 1;
const DEFAULT_APP_VERSION = "0.1.0";
const BATES_PLACEMENT: PdfStampPlacement = { edge: "footer", align: "right" };
const DESIGNATION_PLACEMENT: PdfStampPlacement = { edge: "header", align: "center" };

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
    const sourcePlans = await prepareProductionSourcePlans(options, engine);
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
    })));
    session.recordDetail("productionOptions", {
      prefix: options.prefix,
      digits: options.digits,
      start: options.start,
      includeFilenameInIndex: options.includeFilenameInIndex,
      combinedPdf: options.combinedPdf,
      volumeSizeMb: input.volumeSizeMb ?? null,
    });
    if (input.volumeSizeMb !== undefined) {
      session.recordOverride({
        type: "production-volume-size",
        valueMb: input.volumeSizeMb,
      });
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
      files: files.map((file) => ({
        sourceFilename: file.sourceFilename,
        outputName: file.outputName,
        packageRelativePath: file.packageRelativePath,
        batesStart: file.batesStart,
        batesEnd: file.batesEnd,
        pages: file.pages,
        designation: file.designation,
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

/**
 * Planning pass. Each source is read, hashed, counted, and CLOSED before the
 * next one is touched, so the whole plan is scalars: no bytes and no open
 * handles survive it. Bates validation still runs across the complete plan
 * before any output exists, exactly as before.
 *
 * The tradeoff is one extra read per source (planning reads it, the output pass
 * reads it again) in exchange for peak memory that no longer grows with the
 * number of documents in the production.
 */
async function prepareProductionSourcePlans(
  options: NormalizedInput,
  engine: PdfEngine,
): Promise<ProductionSourcePlan[]> {
  const scanned: Array<Omit<ProductionSourcePlan, "firstNumber" | "lastNumber" | "batesStart" | "batesEnd">> = [];

  for (const source of options.sources) {
    const sourcePath = path.resolve(source.path);
    const sourceBytes = await fs.readFile(sourcePath);
    const original = await engine.open(sourceBytes);

    try {
      scanned.push({
        sourcePath,
        sourceFilename: path.basename(sourcePath),
        sourceSha256: sha256Hex(sourceBytes),
        sourceBytes: sourceBytes.byteLength,
        pages: await engine.pageCount(original),
        designation: normalizeDesignation(source.designation),
      });
    } finally {
      await engine.close(original).catch(() => undefined);
    }
  }

  const totalPages = scanned.reduce((sum, source) => sum + source.pages, 0);
  assertBatesFits(options.digits, options.start + totalPages - 1);

  let running = options.start;
  return scanned.map((source) => {
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
      placement: BATES_PLACEMENT,
      fontSizePt: 10,
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
      pageIndexes: "all",
      placement: DESIGNATION_PLACEMENT,
      fontSizePt: 10,
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
  // Refused before anything is written, so the user still has the choice of
  // running the same production without the combined PDF.
  if ((input.combinedPdf ?? false) && input.sources.length > MAX_COMBINED_PRODUCTION_SOURCES) {
    throw new Error(
      `A combined production PDF is limited to ${MAX_COMBINED_PRODUCTION_SOURCES} documents ` +
        `(${input.sources.length} selected) because every document must be held open to merge them. ` +
        "Turn off the combined PDF to produce this set; the Bates-stamped documents are not limited.",
    );
  }

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
  };
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
  sha256: string;
}

function toIndexRow(file: ProductionSetFileResult): ProductionIndexRow {
  return {
    batesStart: file.batesStart,
    batesEnd: file.batesEnd,
    filename: file.outputName,
    pages: file.pages,
    designation: file.designation,
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
    "SHA-256",
  ];
  const lines = rows.map((row) => [
    row.batesStart,
    row.batesEnd,
    ...(includeFilename ? [row.filename] : []),
    String(row.pages),
    row.designation,
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
    if (includeFilename) {
      draw(truncate(row.filename, 44), margin + 184);
      draw(String(row.pages), margin + 390);
      draw(truncate(row.designation, 31), margin + 430);
    } else {
      draw(String(row.pages), margin + 184);
      draw(truncate(row.designation, 56), margin + 230);
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
