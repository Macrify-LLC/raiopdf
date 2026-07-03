import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  PdfDocumentHandle,
  PdfEngine,
  PdfSanitizeRemovedItem,
  PdfSplitPart,
} from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { createPackage, readPackageManifest, type PackageManifest } from "@raiopdf/package-writer";
import {
  buildDocumentFacts,
  getPack,
  preflight,
  type BuildDocumentFactsOptions,
  type DocumentFacts,
  type JurisdictionPack,
  type JurisdictionPackId,
  type PreflightCheck,
} from "@raiopdf/rules";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type BatchCleanupFileStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type BatchCleanupOcrMode = "auto-image-only" | "skip-text" | "force-ocr" | "off";

export interface BatchCleanupSourceInput {
  path: string;
  facts?: DocumentFacts | undefined;
}

export interface BatchCleanupOperations {
  ocrMode?: BatchCleanupOcrMode | undefined;
  compress?: boolean | undefined;
  sanitize?: boolean | undefined;
  scrubMetadata?: boolean | undefined;
  repair?: boolean | undefined;
  splitBySize?: boolean | undefined;
  splitSizeMb?: number | undefined;
  normalizePages?: boolean | undefined;
  convertToPdfA?: boolean | undefined;
  compressionQuality?: number | undefined;
}

export interface BatchCleanupInput {
  sources: readonly BatchCleanupSourceInput[];
  outputDir: string;
  packId?: JurisdictionPackId | undefined;
  operations?: BatchCleanupOperations | undefined;
  appVersion?: string | undefined;
  createdAt?: string | undefined;
  factsOptions?: BuildDocumentFactsOptions | undefined;
}

export interface BatchCleanupEngines {
  local?: PdfEngine | undefined;
  sidecar?: BatchCleanupSidecarEngine | undefined;
}

export type BatchCleanupSidecarEngine = PdfEngine & {
  ocr(
    document: PdfDocumentHandle,
    options: { languages?: readonly string[]; ocrType?: "force-ocr" | "skip-text" },
  ): Promise<PdfDocumentHandle>;
};

export interface BatchCleanupFileWarning {
  checkId: string;
  label: string;
  status: "warn" | "unknown";
  detail: string;
}

export interface BatchCleanupOutputPart {
  outputName: string;
  packageRelativePath: string;
  pages: number;
  bytes: number;
  sha256: string;
  pageIndexes?: readonly number[] | undefined;
  oversized?: boolean | undefined;
}

export interface BatchCleanupFileResult {
  sourcePath: string;
  sourceFilename: string;
  sourceSha256: string;
  status: BatchCleanupFileStatus;
  reason: string | null;
  operations: readonly string[];
  ocrDecision: string;
  warnings: readonly BatchCleanupFileWarning[];
  facts: BatchCleanupReportFacts;
  outputs: readonly BatchCleanupOutputPart[];
}

export interface BatchCleanupReportFacts {
  pages: number;
  fileBytes: number;
  encryptionState: string;
  imageOnlyPages: number;
  mixedPages: number;
  textPages: number;
  factErrors: readonly string[];
}

export interface BatchCleanupResult {
  packageRoot: string;
  files: readonly BatchCleanupFileResult[];
  reportPdf: string;
  reportJson: string;
  manifest: PackageManifest;
}

interface NormalizedOptions {
  sources: readonly BatchCleanupSourceInput[];
  outputDir: string;
  pack: JurisdictionPack | null;
  operations: NormalizedOperations;
  appVersion: string;
  createdAt: string;
  factsOptions: BuildDocumentFactsOptions;
}

interface NormalizedOperations {
  ocrMode: BatchCleanupOcrMode;
  compress: boolean;
  sanitize: boolean;
  scrubMetadata: boolean;
  repair: boolean;
  splitBySize: boolean;
  splitSizeMb: number;
  normalizePages: boolean;
  convertToPdfA: boolean;
  compressionQuality: number;
}

interface ProducedPdf {
  bytes: Uint8Array;
  pages: number;
  pageIndexes?: readonly number[] | undefined;
  oversized?: boolean | undefined;
}

const DEFAULT_APP_VERSION = "0.0.0";
const DEFAULT_OCR_MODE: BatchCleanupOcrMode = "auto-image-only";
const DEFAULT_COMPRESSION_QUALITY = 5;
const DEFAULT_SPLIT_SIZE_MB = 25;
const SIDE_CAR_OPERATIONS = new Set(["repair", "sanitize", "ocr", "compress", "pdfa"]);

export async function runBatchCleanup(
  input: BatchCleanupInput,
  engines: BatchCleanupEngines = {},
): Promise<BatchCleanupResult> {
  const options = normalizeInput(input);
  const localEngine = engines.local ?? createLocalPdfEngine();
  const sidecarEngine = engines.sidecar ?? (localEngine as BatchCleanupSidecarEngine);
  const session = createPackage(options.outputDir, {
    appVersion: options.appVersion,
    createdAt: options.createdAt,
    ...(options.pack
      ? {
          packId: options.pack.id,
          packVersion: options.pack.packVersion,
          lastVerified: packLastVerified(options.pack),
        }
      : {}),
    confirmCurrentRequirements: options.pack
      ? `Confirm current ${options.pack.name} filing requirements before upload; local packs update only with app releases.`
      : "Confirm current cleanup requirements before sharing or uploading cleaned PDFs.",
  });
  const files: BatchCleanupFileResult[] = [];

  for (const source of options.sources) {
    files.push(await processFile(source, options, localEngine, sidecarEngine, session));
  }

  const reportJson = toMachineReport(options, files);
  const reportJsonEntry = await session.addManifestJson("batch-report.json", reportJson);
  const reportPdfEntry = await session.addRootDocument(
    "batch-report.pdf",
    await createBatchReportPdf(options, files),
  );

  session.recordDetail("batchSources", files.map((file) => ({
    sourcePath: file.sourcePath,
    sourceFilename: file.sourceFilename,
    sourceSha256: file.sourceSha256,
    status: file.status,
    reason: file.reason,
  })));
  session.recordDetail("batchOptions", {
    packId: options.pack?.id ?? null,
    operations: operationsToJson(options.operations),
  });
  if (input.operations?.splitSizeMb !== undefined) {
    session.recordOverride({
      type: "batch-split-size",
      valueMb: input.operations.splitSizeMb,
    });
  }
  session.recordCheck({
    checkId: "batch-serial-execution",
    status: "pass",
    detail: "Batch cleanup runs one file at a time; a file failure does not stop the queue.",
  });

  await session.finalize();
  const manifest = await readPackageManifest(options.outputDir);

  return {
    packageRoot: path.resolve(options.outputDir),
    files,
    reportPdf: reportPdfEntry.relativePath,
    reportJson: reportJsonEntry.relativePath,
    manifest,
  };
}

function normalizeInput(input: BatchCleanupInput): NormalizedOptions {
  if (input.sources.length === 0) {
    throw new Error("Batch cleanup requires at least one source PDF.");
  }
  if (input.operations?.splitSizeMb !== undefined && (
    !Number.isFinite(input.operations.splitSizeMb) ||
    input.operations.splitSizeMb <= 0
  )) {
    throw new Error("Split size cap must be a positive number of MB.");
  }
  if (
    input.operations?.compressionQuality !== undefined &&
    (!Number.isInteger(input.operations.compressionQuality) ||
      input.operations.compressionQuality < 1 ||
      input.operations.compressionQuality > 9)
  ) {
    throw new Error("Compression quality must be an integer from 1 to 9.");
  }

  const pack = input.packId ? getPack(input.packId) : null;
  const operations = input.operations ?? {};
  const normalizedOperations: NormalizedOperations = {
    ocrMode: operations.ocrMode ?? DEFAULT_OCR_MODE,
    compress: operations.compress ?? false,
    sanitize: operations.sanitize ?? defaultSanitize(pack),
    scrubMetadata: operations.scrubMetadata ?? defaultScrubMetadata(pack),
    repair: operations.repair ?? false,
    splitBySize: operations.splitBySize ?? false,
    splitSizeMb: operations.splitSizeMb ?? defaultSplitSizeMb(pack),
    normalizePages: operations.normalizePages ?? false,
    convertToPdfA: operations.convertToPdfA ?? false,
    compressionQuality: operations.compressionQuality ?? DEFAULT_COMPRESSION_QUALITY,
  };

  return {
    sources: input.sources,
    outputDir: input.outputDir,
    pack,
    operations: normalizedOperations,
    appVersion: input.appVersion ?? DEFAULT_APP_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    factsOptions: input.factsOptions ?? {},
  };
}

async function processFile(
  source: BatchCleanupSourceInput,
  options: NormalizedOptions,
  localEngine: PdfEngine,
  sidecarEngine: BatchCleanupSidecarEngine,
  session: ReturnType<typeof createPackage>,
): Promise<BatchCleanupFileResult> {
  const sourcePath = path.resolve(source.path);
  const sourceFilename = path.basename(sourcePath);
  const sourceBytes = await fs.readFile(sourcePath);
  const sourceSha256 = sha256Hex(sourceBytes);
  const facts = source.facts ?? await buildDocumentFacts(sourceBytes, options.factsOptions);
  const warnings = options.pack ? packWarnings(facts, options.pack) : [];
  const reportFacts = summarizeFacts(facts, sourceBytes.byteLength);
  const plan = planFileOperations(facts, options);

  if (facts.encryptionState === "encrypted" || facts.encryptionState === "usage_restricted") {
    return fileResult({
      sourcePath,
      sourceFilename,
      sourceSha256,
      status: "failed",
      reason: "Encrypted input requires a password; no valid password was provided for this batch run.",
      operations: [],
      ocrDecision: plan.ocrDecision,
      warnings,
      facts: reportFacts,
      outputs: [],
    });
  }

  if (plan.operations.length === 0) {
    return fileResult({
      sourcePath,
      sourceFilename,
      sourceSha256,
      status: "skipped",
      reason: plan.skipReason,
      operations: [],
      ocrDecision: plan.ocrDecision,
      warnings,
      facts: reportFacts,
      outputs: [],
    });
  }

  try {
    const produced = await runOperationPipeline(
      sourceBytes,
      facts,
      plan.operations,
      options,
      localEngine,
      sidecarEngine,
    );
    const outputs: BatchCleanupOutputPart[] = [];

    for (let index = 0; index < produced.length; index += 1) {
      const item = produced[index];
      if (!item) {
        continue;
      }
      const outputName = outputNameFor(sourceFilename, produced.length, index);
      const entry = await session.addUploadFile(item.bytes, outputName, {
        pages: item.pages,
        sourceFilename,
        sourceSha256,
        operations: plan.operations,
        ...(item.pageIndexes === undefined ? {} : { pageIndexes: [...item.pageIndexes] }),
        ...(item.oversized === undefined ? {} : { oversized: item.oversized }),
      });
      outputs.push({
        outputName,
        packageRelativePath: entry.relativePath,
        pages: item.pages,
        bytes: entry.bytes,
        sha256: entry.sha256,
        pageIndexes: item.pageIndexes,
        oversized: item.oversized,
      });
    }

    return fileResult({
      sourcePath,
      sourceFilename,
      sourceSha256,
      status: "done",
      reason: null,
      operations: plan.operations,
      ocrDecision: plan.ocrDecision,
      warnings,
      facts: reportFacts,
      outputs,
    });
  } catch (error) {
    return fileResult({
      sourcePath,
      sourceFilename,
      sourceSha256,
      status: "failed",
      reason: errorMessage(error),
      operations: plan.operations,
      ocrDecision: plan.ocrDecision,
      warnings,
      facts: reportFacts,
      outputs: [],
    });
  }
}

function planFileOperations(
  facts: DocumentFacts,
  options: NormalizedOptions,
): { operations: string[]; ocrDecision: string; skipReason: string | null } {
  const operations: string[] = [];
  const add = (enabled: boolean, name: string): void => {
    if (enabled) {
      operations.push(name);
    }
  };
  const pdfaAllowed = options.pack !== null &&
    (options.pack.pdfa.stance === "required" || options.pack.pdfa.stance === "preferred");

  add(options.operations.repair, "repair");
  add(options.operations.normalizePages && options.pack !== null, "normalize-pages");
  add(options.operations.sanitize, "sanitize");
  add(options.operations.scrubMetadata, "scrub-metadata");

  const ocrPlan = ocrPlanFor(facts, options.operations.ocrMode);
  if (ocrPlan.run) {
    operations.push("ocr");
  }

  add(options.operations.compress, "compress");
  add(options.operations.convertToPdfA && pdfaAllowed, "pdfa");
  add(options.operations.splitBySize, "split-by-size");

  return {
    operations,
    ocrDecision: ocrPlan.decision,
    skipReason: operations.length === 0 ? "No selected operation applies to this file." : null,
  };
}

function ocrPlanFor(
  facts: DocumentFacts,
  mode: BatchCleanupOcrMode,
): { run: boolean; decision: string } {
  if (mode === "off") {
    return { run: false, decision: "OCR disabled." };
  }
  if (mode === "force-ocr") {
    return { run: true, decision: "Force OCR selected by user." };
  }
  if (!facts.textLayerCoverage) {
    return { run: false, decision: "Text-layer coverage is unknown; OCR not selected by default." };
  }
  if (isImageOnly(facts)) {
    return { run: true, decision: "All pages are image-only; OCR selected by default." };
  }
  if (mode === "skip-text") {
    return { run: true, decision: "Skip-text OCR selected by user for a mixed or searchable document." };
  }

  return { run: false, decision: "Document has text-layer coverage; default OCR skipped." };
}

function isImageOnly(facts: DocumentFacts): boolean {
  const coverage = facts.textLayerCoverage;
  const pageCount = facts.pages.length || coverage?.imageOnlyPages.length || 0;

  return Boolean(
    coverage &&
    pageCount > 0 &&
    coverage.imageOnlyPages.length === pageCount &&
    coverage.mixedPages.length === 0 &&
    coverage.textPages.length === 0,
  );
}

async function runOperationPipeline(
  sourceBytes: Uint8Array,
  facts: DocumentFacts,
  operations: readonly string[],
  options: NormalizedOptions,
  localEngine: PdfEngine,
  sidecarEngine: PdfEngine,
): Promise<ProducedPdf[]> {
  let bytes = sourceBytes;

  for (const operation of operations) {
    if (operation === "split-by-size") {
      const document = await localEngine.open(bytes);
      let parts: readonly PdfSplitPart[] = [];
      try {
        const split = await localEngine.splitByMaxBytes(
          document,
          Math.floor(options.operations.splitSizeMb * 1024 * 1024),
        );
        parts = split.parts;
        const produced: ProducedPdf[] = [];
        for (const part of split.parts) {
          produced.push({
            bytes: await localEngine.saveToBytes(part.document),
            pages: part.pageIndexes.length,
            pageIndexes: part.pageIndexes,
            oversized: part.oversized,
          });
        }
        return produced;
      } finally {
        for (const part of parts) {
          await localEngine.close(part.document).catch(() => undefined);
        }
        await localEngine.close(document).catch(() => undefined);
      }
    }

    bytes = await runSingleDocumentOperation(
      bytes,
      operation,
      facts,
      options,
      SIDE_CAR_OPERATIONS.has(operation) ? sidecarEngine : localEngine,
    );
  }

  return [{
    bytes,
    pages: facts.pages.length || await countPages(localEngine, bytes),
  }];
}

async function runSingleDocumentOperation(
  bytes: Uint8Array,
  operation: string,
  facts: DocumentFacts,
  options: NormalizedOptions,
  engine: PdfEngine | BatchCleanupSidecarEngine,
): Promise<Uint8Array> {
  const document = await engine.open(bytes);
  let produced: PdfDocumentHandle | null = null;

  try {
    if (operation === "repair") {
      produced = await engine.repair(document);
    } else if (operation === "normalize-pages") {
      if (!options.pack) {
        throw new Error("Page normalization requires a jurisdiction pack.");
      }
      produced = await engine.normalizePages(document, {
        targetSize: options.pack.pageSize,
        orientation: "portrait",
      });
    } else if (operation === "sanitize") {
      const result = await engine.sanitize(document, {
        removeJavaScript: true,
        removeEmbeddedFiles: true,
        removeLinks: true,
      });
      produced = result.document;
    } else if (operation === "scrub-metadata") {
      produced = await engine.scrubMetadata(document);
    } else if (operation === "ocr") {
      produced = await requireOcrEngine(engine).ocr(document, {
        languages: ["eng"],
        ocrType: options.operations.ocrMode === "force-ocr" ? "force-ocr" : "skip-text",
      });
    } else if (operation === "compress") {
      produced = await engine.compress(document, {
        quality: options.operations.compressionQuality,
      });
    } else if (operation === "pdfa") {
      if (!options.pack) {
        throw new Error("PDF/A conversion requires a jurisdiction pack.");
      }
      produced = await engine.convertToPdfA(document, {
        flavor: options.pack.pdfa.flavor,
        strict: false,
      });
    } else {
      throw new Error(`Unsupported batch operation: ${operation}`);
    }

    return await engine.saveToBytes(produced);
  } finally {
    const handleToClose = produced ?? document;
    await engine.close(handleToClose).catch(() => undefined);
    if (produced !== null && produced !== document) {
      await engine.close(document).catch(() => undefined);
    }
  }
}

async function countPages(engine: PdfEngine, bytes: Uint8Array): Promise<number> {
  const document = await engine.open(bytes);
  try {
    return await engine.pageCount(document);
  } finally {
    await engine.close(document).catch(() => undefined);
  }
}

function packWarnings(facts: DocumentFacts, pack: JurisdictionPack): BatchCleanupFileWarning[] {
  return preflight(facts, pack).checks
    .filter((check): check is PreflightCheck & { status: "warn" | "unknown" } => check.status !== "pass")
    .map((check) => ({
      checkId: check.checkId,
      label: check.label,
      status: check.status,
      detail: check.detail,
    }));
}

function toMachineReport(
  options: NormalizedOptions,
  files: readonly BatchCleanupFileResult[],
) {
  return {
    workflow: "batch-cleanup",
    createdAt: options.createdAt,
    pack: options.pack
      ? {
          id: options.pack.id,
          name: options.pack.name,
          packVersion: options.pack.packVersion,
          scopeNote: options.pack.scopeNote,
          guidanceNote: options.pack.guidanceNote,
        }
      : null,
    operations: operationsToJson(options.operations),
    summary: summarizeStatuses(files),
    files: files.map((file) => ({
      sourceFilename: file.sourceFilename,
      status: file.status,
      reason: file.reason,
      operations: [...file.operations],
      ocrDecision: file.ocrDecision,
      warnings: file.warnings.map((warning) => ({ ...warning })),
      facts: {
        ...file.facts,
        factErrors: [...file.facts.factErrors],
      },
      outputs: file.outputs.map((output) => ({
        outputName: output.outputName,
        packageRelativePath: output.packageRelativePath,
        pages: output.pages,
        bytes: output.bytes,
        sha256: output.sha256,
        ...(output.pageIndexes === undefined ? {} : { pageIndexes: [...output.pageIndexes] }),
        ...(output.oversized === undefined ? {} : { oversized: output.oversized }),
      })),
    })),
  };
}

function operationsToJson(operations: NormalizedOperations): Record<string, string | number | boolean> {
  return {
    ocrMode: operations.ocrMode,
    compress: operations.compress,
    sanitize: operations.sanitize,
    scrubMetadata: operations.scrubMetadata,
    repair: operations.repair,
    splitBySize: operations.splitBySize,
    splitSizeMb: operations.splitSizeMb,
    normalizePages: operations.normalizePages,
    convertToPdfA: operations.convertToPdfA,
    compressionQuality: operations.compressionQuality,
  };
}

function requireOcrEngine(engine: PdfEngine | BatchCleanupSidecarEngine): BatchCleanupSidecarEngine {
  if ("ocr" in engine && typeof engine.ocr === "function") {
    return engine;
  }

  throw new Error("OCR requires the desktop sidecar engine.");
}

async function createBatchReportPdf(
  options: NormalizedOptions,
  files: readonly BatchCleanupFileResult[],
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
    page.drawText(truncate(text, 92), { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
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
    page.drawText("Batch Cleanup Report", {
      x: margin,
      y,
      size: 13,
      font: bold,
      color: rgb(0.06, 0.06, 0.06),
    });
    y -= 17;
    draw(options.pack ? `${options.pack.name} (${options.pack.packVersion})` : "No jurisdiction pack", margin);
    y -= 22;
    draw("File", margin, bold);
    draw("Status", margin + 210, bold);
    draw("Operations", margin + 275, bold);
    draw("Warnings", margin + 430, bold);
    y -= rowHeight;
  };

  drawHeader();
  for (const file of files) {
    nextPageIfNeeded();
    draw(file.sourceFilename, margin);
    draw(file.status, margin + 210);
    draw(file.operations.join(", ") || "-", margin + 275);
    draw(String(file.warnings.length), margin + 430);
    y -= rowHeight;
    if (file.reason) {
      nextPageIfNeeded();
      draw(`Reason: ${file.reason}`, margin + 12, regular, 7);
      y -= rowHeight;
    }
  }

  return pdf.save();
}

function fileResult(result: BatchCleanupFileResult): BatchCleanupFileResult {
  return result;
}

function defaultSanitize(pack: JurisdictionPack | null): boolean {
  if (!pack) {
    return true;
  }
  return pack.activeContent.prepDefault === "on" || pack.embeddedFiles.prepDefault === "on";
}

function defaultScrubMetadata(pack: JurisdictionPack | null): boolean {
  return pack ? pack.metadataScrub.prepDefault === "on" : true;
}

function defaultSplitSizeMb(pack: JurisdictionPack | null): number {
  const bytes = pack?.maxFileBytes ?? pack?.recommendedMaxFileBytes;
  return bytes ? bytes / 1024 / 1024 : DEFAULT_SPLIT_SIZE_MB;
}

function summarizeFacts(facts: DocumentFacts, byteLength: number): BatchCleanupReportFacts {
  return {
    pages: facts.pages.length,
    fileBytes: facts.fileBytes ?? byteLength,
    encryptionState: facts.encryptionState ?? "unknown",
    imageOnlyPages: facts.textLayerCoverage?.imageOnlyPages.length ?? 0,
    mixedPages: facts.textLayerCoverage?.mixedPages.length ?? 0,
    textPages: facts.textLayerCoverage?.textPages.length ?? 0,
    factErrors: facts.errors?.map((error) => `${error.fact}: ${error.reason}`) ?? [],
  };
}

function summarizeStatuses(files: readonly BatchCleanupFileResult[]) {
  const summary = {
    total: files.length,
    done: 0,
    failed: 0,
    skipped: 0,
  };

  for (const file of files) {
    if (file.status === "done") {
      summary.done += 1;
    } else if (file.status === "failed") {
      summary.failed += 1;
    } else if (file.status === "skipped") {
      summary.skipped += 1;
    }
  }

  return summary;
}

function packLastVerified(pack: JurisdictionPack): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const constraint of pack.constraints) {
    entries[constraint.id] = constraint.lastVerified;
  }
  return entries;
}

function outputNameFor(sourceFilename: string, total: number, index: number): string {
  const base = sourceFilename.replace(/\.pdf$/i, "").trim() || "document";
  const safeBase = safePdfName(base);
  if (total === 1) {
    return `${safeBase} - cleaned.pdf`;
  }
  return `${safeBase} - cleaned - part ${String(index + 1).padStart(2, "0")}.pdf`;
}

function safePdfName(value: string): string {
  return [...value]
    .map((character) => (isUnsafeFileNameCharacter(character) ? "_" : character))
    .join("")
    .trim() || "document";
}

function isUnsafeFileNameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f || "\\/:*?\"<>|".includes(character);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown batch cleanup error.";
}

export type { PdfSanitizeRemovedItem };
