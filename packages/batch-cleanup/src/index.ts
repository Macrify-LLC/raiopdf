import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  PdfDocumentHandle,
  PdfEngine,
  PdfSanitizeRemovedItem,
  PdfSplitPart,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { createPackage, readPackageManifest, type PackageManifest } from "@raiopdf/package-writer";
import {
  buildDocumentFacts,
  detectSignatureFacts,
  getPack,
  hasEmbeddedSignatureMarkers,
  preflight,
  type BuildDocumentFactsOptions,
  type DocumentFacts,
  type JurisdictionPack,
  type JurisdictionPackId,
  type PreflightCheck,
  type SignatureDetectionFacts,
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
  /** Optional per-run PDF open password reused for encrypted inputs. Never persisted. */
  password?: string | undefined;
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
  signatureInvalidated: boolean;
  signatureDetection: SignatureDetectionFacts | null;
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
  password?: string | undefined;
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

type BatchCleanupOcrType = "skip-text" | "force-ocr";

interface BatchUnlockResult {
  bytes: Uint8Array;
  signatureDetection: SignatureDetectionFacts | null;
}

type BatchCleanupFileResultInput =
  Omit<BatchCleanupFileResult, "signatureInvalidated" | "signatureDetection"> &
  Partial<Pick<BatchCleanupFileResult, "signatureInvalidated" | "signatureDetection">>;

const DEFAULT_APP_VERSION = "0.1.0";
const DEFAULT_OCR_MODE: BatchCleanupOcrMode = "auto-image-only";
const DEFAULT_COMPRESSION_QUALITY = 5;
const DEFAULT_SPLIT_SIZE_MB = 25;
const SIDE_CAR_OPERATIONS = new Set(["remove-encryption", "repair", "sanitize", "ocr", "compress", "pdfa"]);

class BatchPackageWriteError extends Error {
  constructor(readonly originalError: unknown) {
    super("Batch package write failed.");
  }
}

export async function runBatchCleanup(
  input: BatchCleanupInput,
  engines: BatchCleanupEngines = {},
): Promise<BatchCleanupResult> {
  const hasSidecar = engines.sidecar !== undefined;
  const options = normalizeInput(input, { hasSidecar });
  const localEngine = engines.local ?? createLocalPdfEngine();
  const sidecarEngine = engines.sidecar;
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
  const outputNames = new Set<string>();
  let finalized = false;

  try {
    for (const source of options.sources) {
      files.push(await processFile(source, options, localEngine, sidecarEngine, session, outputNames));
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
      signatureInvalidated: file.signatureInvalidated,
      signatureDetection: file.signatureDetection,
      outputs: file.outputs.map((output) => ({
        outputName: output.outputName,
        packageRelativePath: output.packageRelativePath,
        pages: output.pages,
        bytes: output.bytes,
        sha256: output.sha256,
      })),
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
    finalized = true;
    const manifest = await readPackageManifest(options.outputDir);

    return {
      packageRoot: path.resolve(options.outputDir),
      files,
      reportPdf: reportPdfEntry.relativePath,
      reportJson: reportJsonEntry.relativePath,
      manifest,
    };
  } finally {
    if (!finalized) {
      await session.abort().catch(() => undefined);
    }
  }
}

function normalizeInput(
  input: BatchCleanupInput,
  runtime: { hasSidecar: boolean },
): NormalizedOptions {
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
    ocrMode: operations.ocrMode ?? (runtime.hasSidecar ? DEFAULT_OCR_MODE : "off"),
    compress: operations.compress ?? false,
    sanitize: operations.sanitize ?? (runtime.hasSidecar ? defaultSanitize(pack) : false),
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
    ...(input.password === undefined ? {} : { password: input.password }),
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
  sidecarEngine: BatchCleanupSidecarEngine | undefined,
  session: ReturnType<typeof createPackage>,
  outputNames: Set<string>,
): Promise<BatchCleanupFileResult> {
  const sourcePath = path.resolve(source.path);
  const sourceFilename = path.basename(sourcePath);
  const sourceBytes = await fs.readFile(sourcePath);
  let workingSourceBytes: Uint8Array = sourceBytes;
  const sourceSha256 = sha256Hex(sourceBytes);
  const facts = source.facts ?? await buildDocumentFacts(sourceBytes, options.factsOptions);
  let workingFacts = facts;
  let signatureDetection: SignatureDetectionFacts | null = facts.signatureDetection ?? null;
  let signatureInvalidated = false;

  if (isEncrypted(facts)) {
    const encryptedPlan = planFileOperations(facts, options);
    const encryptedWarnings = options.pack ? packWarnings(facts, options.pack) : [];
    const encryptedReportFacts = summarizeFacts(facts, sourceBytes.byteLength);
    if (!sidecarEngine) {
      return fileResult({
        sourcePath,
        sourceFilename,
        sourceSha256,
        status: "failed",
        reason: "Encrypted input requires the desktop sidecar engine to remove encryption.",
        operations: ["remove-encryption"],
        ocrDecision: encryptedPlan.ocrDecision,
        warnings: encryptedWarnings,
        facts: encryptedReportFacts,
        outputs: [],
      });
    }
    try {
      const unlock = await unlockProtectedPdfForBatch(sourceBytes, sidecarEngine, options.password);
      workingSourceBytes = unlock.bytes;
      signatureDetection = unlock.signatureDetection;
      signatureInvalidated = signatureDetection ? hasEmbeddedSignatureMarkers(signatureDetection) : false;
      workingFacts = await buildDocumentFacts(workingSourceBytes, options.factsOptions);
      signatureDetection = workingFacts.signatureDetection ?? signatureDetection;
      signatureInvalidated = signatureDetection ? hasEmbeddedSignatureMarkers(signatureDetection) : signatureInvalidated;
    } catch (error) {
      return fileResult({
        sourcePath,
        sourceFilename,
        sourceSha256,
        status: "failed",
        reason: batchUnlockFailureReason(error),
        operations: ["remove-encryption"],
        ocrDecision: encryptedPlan.ocrDecision,
        warnings: encryptedWarnings,
        facts: encryptedReportFacts,
        outputs: [],
      });
    }
  }

  const warnings = options.pack ? packWarnings(workingFacts, options.pack) : [];
  const reportFacts = summarizeFacts(workingFacts, workingSourceBytes.byteLength);
  const plan = planFileOperations(workingFacts, options, isEncrypted(facts));

  if (isEncrypted(workingFacts)) {
    return fileResult({
      sourcePath,
      sourceFilename,
      sourceSha256,
      status: "failed",
      reason: "Encrypted input could not be converted to an unencrypted filing copy.",
      operations: ["remove-encryption"],
      ocrDecision: plan.ocrDecision,
      signatureInvalidated,
      signatureDetection,
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
    validateSidecarAvailability(plan.operations, sidecarEngine);
    const produced = await runOperationPipeline(
      workingSourceBytes,
      workingFacts,
      plan.operations,
      plan.ocrType,
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
      const outputName = reserveOutputName(outputNameFor(sourceFilename, produced.length, index), outputNames);
      const entry = await addBatchUploadFile(session, item, outputName, {
        sourceFilename,
        sourceSha256,
        operations: plan.operations,
        signatureInvalidated,
        signatureDetection,
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
      signatureInvalidated,
      signatureDetection,
      warnings,
      facts: reportFacts,
      outputs,
    });
  } catch (error) {
    if (error instanceof BatchPackageWriteError) {
      throw error.originalError;
    }

    return fileResult({
      sourcePath,
      sourceFilename,
      sourceSha256,
      status: "failed",
      reason: errorMessage(error),
      operations: plan.operations,
      ocrDecision: plan.ocrDecision,
      signatureInvalidated,
      signatureDetection,
      warnings,
      facts: reportFacts,
      outputs: [],
    });
  }
}

async function addBatchUploadFile(
  session: ReturnType<typeof createPackage>,
  item: ProducedPdf,
  outputName: string,
  info: {
    sourceFilename: string;
    sourceSha256: string;
    operations: readonly string[];
    signatureInvalidated: boolean;
    signatureDetection: SignatureDetectionFacts | null;
  },
) {
  try {
    return await session.addUploadFile(item.bytes, outputName, {
      pages: item.pages,
      sourceFilename: info.sourceFilename,
      sourceSha256: info.sourceSha256,
      operations: [...info.operations],
      signatureInvalidated: info.signatureInvalidated,
      signatureDetection: info.signatureDetection,
      ...(item.pageIndexes === undefined ? {} : { pageIndexes: [...item.pageIndexes] }),
      ...(item.oversized === undefined ? {} : { oversized: item.oversized }),
    });
  } catch (error) {
    throw new BatchPackageWriteError(error);
  }
}

function planFileOperations(
  facts: DocumentFacts,
  options: NormalizedOptions,
  removedEncryption = false,
): {
  operations: string[];
  ocrDecision: string;
  ocrType: BatchCleanupOcrType;
  skipReason: string | null;
} {
  const operations: string[] = [];
  const add = (enabled: boolean, name: string): void => {
    if (enabled) {
      operations.push(name);
    }
  };
  const pdfaAllowed = options.pack !== null &&
    (options.pack.pdfa.stance === "required" || options.pack.pdfa.stance === "preferred");

  add(removedEncryption, "remove-encryption");
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
    ocrType: ocrPlan.ocrType,
    skipReason: operations.length === 0 ? "No selected operation applies to this file." : null,
  };
}

function ocrPlanFor(
  facts: DocumentFacts,
  mode: BatchCleanupOcrMode,
): { run: boolean; ocrType: BatchCleanupOcrType; decision: string } {
  if (mode === "off") {
    return { run: false, ocrType: "skip-text", decision: "OCR disabled." };
  }
  if (mode === "force-ocr") {
    return { run: true, ocrType: "force-ocr", decision: "Force OCR selected by user." };
  }
  if (!facts.textLayerCoverage) {
    return { run: false, ocrType: "skip-text", decision: "Text-layer coverage is unknown; OCR not selected by default." };
  }
  if (facts.textLayerCoverage.garbledPages.length > 0) {
    return { run: true, ocrType: "force-ocr", decision: "Garbled text layer detected; force OCR to rebuild it." };
  }
  if (isImageOnly(facts)) {
    return { run: true, ocrType: "skip-text", decision: "All pages are image-only; OCR selected by default." };
  }
  if (mode === "skip-text") {
    return { run: true, ocrType: "skip-text", decision: "Skip-text OCR selected by user for a mixed or searchable document." };
  }

  return { run: false, ocrType: "skip-text", decision: "Document has text-layer coverage; default OCR skipped." };
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

function isEncrypted(facts: DocumentFacts): boolean {
  return facts.encryptionState === "encrypted" || facts.encryptionState === "usage_restricted";
}

async function unlockProtectedPdfForBatch(
  bytes: Uint8Array,
  sidecarEngine: BatchCleanupSidecarEngine,
  password: string | undefined,
): Promise<BatchUnlockResult> {
  try {
    return await unlockWithPassword(bytes, sidecarEngine, "");
  } catch (emptyPasswordError) {
    if (!isPasswordRequiredError(emptyPasswordError)) {
      throw new Error(
        `Encrypted input could not be unlocked: ${errorMessage(emptyPasswordError)}`,
        { cause: emptyPasswordError },
      );
    }

    if (!password) {
      throw new PdfEngineError(
        "PASSWORD_REQUIRED",
        "Encrypted input requires a password; no valid password was provided for this batch run.",
      );
    }
  }

  try {
    return await unlockWithPassword(bytes, sidecarEngine, password);
  } catch (passwordError) {
    throw new Error(
      `Encrypted input could not be unlocked: ${errorMessage(passwordError)}`,
      { cause: passwordError },
    );
  }
}

async function unlockWithPassword(
  bytes: Uint8Array,
  sidecarEngine: BatchCleanupSidecarEngine,
  password: string,
): Promise<BatchUnlockResult> {
  const unlockedBytes = await sidecarEngine.removeEncryption(bytes, password);

  return {
    bytes: unlockedBytes,
    signatureDetection: await detectSignatureFactsOrNull(unlockedBytes),
  };
}

async function detectSignatureFactsOrNull(
  bytes: Uint8Array,
): Promise<SignatureDetectionFacts | null> {
  try {
    return await detectSignatureFacts(bytes);
  } catch {
    return null;
  }
}

function isPasswordRequiredError(error: unknown): boolean {
  return error instanceof PdfEngineError &&
    (error.code === "PASSWORD_REQUIRED" || error.code === "ENCRYPTED_DOCUMENT");
}

function batchUnlockFailureReason(error: unknown): string {
  if (error instanceof PdfEngineError && error.code === "PASSWORD_REQUIRED") {
    return error.message;
  }

  const message = errorMessage(error);
  return message.startsWith("Encrypted input") ? message : `Encrypted input could not be unlocked: ${message}`;
}

async function runOperationPipeline(
  sourceBytes: Uint8Array,
  facts: DocumentFacts,
  operations: readonly string[],
  ocrType: BatchCleanupOcrType,
  options: NormalizedOptions,
  localEngine: PdfEngine,
  sidecarEngine: PdfEngine | undefined,
): Promise<ProducedPdf[]> {
  let bytes = sourceBytes;

  for (const operation of operations) {
    if (operation === "remove-encryption") {
      continue;
    }

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
      ocrType,
      options,
      selectEngineForOperation(operation, localEngine, sidecarEngine),
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
  ocrType: BatchCleanupOcrType,
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
        ocrType,
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
      signatureInvalidated: file.signatureInvalidated,
      signatureDetection: file.signatureDetection,
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

function selectEngineForOperation(
  operation: string,
  localEngine: PdfEngine,
  sidecarEngine: PdfEngine | undefined,
): PdfEngine {
  if (!SIDE_CAR_OPERATIONS.has(operation)) {
    return localEngine;
  }

  if (!sidecarEngine) {
    throw new Error(`${operationLabel(operation)} requires the desktop sidecar engine.`);
  }

  return sidecarEngine;
}

function validateSidecarAvailability(
  operations: readonly string[],
  sidecarEngine: BatchCleanupSidecarEngine | undefined,
): void {
  if (sidecarEngine) {
    return;
  }

  const sidecarOperation = operations.find((operation) => SIDE_CAR_OPERATIONS.has(operation));
  if (sidecarOperation) {
    throw new Error(`${operationLabel(sidecarOperation)} requires the desktop sidecar engine.`);
  }
}

function operationLabel(operation: string): string {
  switch (operation) {
    case "pdfa":
      return "PDF/A conversion";
    case "ocr":
      return "OCR";
    case "remove-encryption":
      return "Remove encryption";
    case "scrub-metadata":
      return "Metadata scrubbing";
    case "split-by-size":
      return "Split by size";
    default:
      return operation;
  }
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
    draw("Warnings", margin + 405, bold);
    draw("Signatures", margin + 470, bold);
    y -= rowHeight;
  };

  drawHeader();
  const signatureFiles = files.filter((file) => file.signatureInvalidated);
  if (signatureFiles.length > 0) {
    draw(
      `${signatureFiles.length} unlocked file${signatureFiles.length === 1 ? "" : "s"} had digital signatures invalidated: ${
        signatureFiles.map((file) => file.sourceFilename).join(", ")
      }`,
      margin,
      regular,
      7,
    );
    y -= rowHeight;
  }
  for (const file of files) {
    nextPageIfNeeded();
    draw(file.sourceFilename, margin);
    draw(file.status, margin + 210);
    draw(file.operations.join(", ") || "-", margin + 275);
    draw(String(file.warnings.length), margin + 405);
    draw(file.signatureInvalidated ? "Invalidated" : "-", margin + 470);
    y -= rowHeight;
    if (file.reason) {
      nextPageIfNeeded();
      draw(`Reason: ${file.reason}`, margin + 12, regular, 7);
      y -= rowHeight;
    }
  }

  return pdf.save();
}

function fileResult(result: BatchCleanupFileResultInput): BatchCleanupFileResult {
  return {
    signatureInvalidated: false,
    signatureDetection: null,
    ...result,
  };
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
    signatureInvalidated: 0,
    signatureInvalidatedFiles: [] as string[],
  };

  for (const file of files) {
    if (file.status === "done") {
      summary.done += 1;
    } else if (file.status === "failed") {
      summary.failed += 1;
    } else if (file.status === "skipped") {
      summary.skipped += 1;
    }

    if (file.signatureInvalidated) {
      summary.signatureInvalidated += 1;
      summary.signatureInvalidatedFiles.push(file.sourceFilename);
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

function reserveOutputName(outputName: string, outputNames: Set<string>): string {
  if (!outputNames.has(outputName)) {
    outputNames.add(outputName);
    return outputName;
  }

  const extension = path.extname(outputName);
  const stem = extension ? outputName.slice(0, -extension.length) : outputName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`;
    if (!outputNames.has(candidate)) {
      outputNames.add(candidate);
      return candidate;
    }
  }
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
