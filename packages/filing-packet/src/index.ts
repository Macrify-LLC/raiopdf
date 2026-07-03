import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PdfDocumentHandle, PdfEngine } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { createPackage, readPackageManifest, type JsonValue, type PackageManifest } from "@raiopdf/package-writer";
import {
  buildDocumentFacts,
  getPack,
  preflight,
  resolvePrepPlan,
  shouldConvertToPdfA,
  type BuildDocumentFactsOptions,
  type DocumentFacts,
  type JurisdictionPack,
  type JurisdictionPackId,
  type PreflightCheck,
  type PreflightReport,
  type PrepPlanStep,
  type PrepPlanStepId,
  type SelectionFacts,
} from "@raiopdf/rules";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type FilingPacketLayoutMode = "separate-files" | "combined-pdf";
export type FilingPacketStepStatus = "run" | "skipped" | "overridden" | "unsupported";

export interface FilingPacketSourceInput {
  path: string;
  displayName?: string | undefined;
  facts?: DocumentFacts | undefined;
}

export interface FilingPacketChecklistOverrides {
  selectedStepIds?: readonly PrepPlanStepId[] | undefined;
  skippedStepIds?: readonly PrepPlanStepId[] | undefined;
  splitSizeMb?: number | undefined;
  convertToPdfA?: boolean | undefined;
}

export interface FilingPacketCourtProfileValues {
  maxFileBytes?: number | undefined;
  maxEnvelopeBytes?: number | undefined;
}

export interface BuildFilingPacketInput {
  sources: readonly FilingPacketSourceInput[];
  outputDir: string;
  packId?: JurisdictionPackId | undefined;
  layoutMode?: FilingPacketLayoutMode | undefined;
  prefixFilenames?: boolean | undefined;
  courtProfile?: FilingPacketCourtProfileValues | undefined;
  checklist?: FilingPacketChecklistOverrides | undefined;
  appVersion?: string | undefined;
  createdAt?: string | undefined;
  factsOptions?: BuildDocumentFactsOptions | undefined;
}

export interface FilingPacketEngines {
  local?: PdfEngine | undefined;
  sidecar?: FilingPacketSidecarEngine | undefined;
}

export type FilingPacketSidecarEngine = PdfEngine & {
  ocr(
    document: PdfDocumentHandle,
    options?: { languages?: readonly string[]; ocrType?: "force-ocr" | "skip-text" },
  ): Promise<PdfDocumentHandle>;
};

export interface FilingPacketOutputFile {
  sourceFilename: string;
  outputName: string;
  packageRelativePath: string;
  pages: number;
  bytes: number;
  sha256: string;
  pageIndexes: readonly number[];
  oversized: boolean;
  sourceOrder: number;
}

export interface FilingPacketStepRecord {
  stepId: PrepPlanStepId;
  label: string;
  status: FilingPacketStepStatus;
  detail: string;
}

export interface FilingPacketDocumentResult {
  sourceFilename: string;
  sourceSha256: string;
  order: number;
  outputs: readonly FilingPacketOutputFile[];
  checks: readonly PreflightCheck[];
  stepStatus: readonly FilingPacketStepRecord[];
}

export interface FilingPacketResult {
  packageRoot: string;
  layoutMode: FilingPacketLayoutMode;
  files: readonly FilingPacketOutputFile[];
  documents: readonly FilingPacketDocumentResult[];
  manifestPdf: string;
  packetJson: string;
  combinedPdf: string | null;
  selectionChecks: readonly PreflightCheck[];
  manifest: PackageManifest;
}

interface NormalizedInput {
  sources: readonly FilingPacketSourceInput[];
  outputDir: string;
  pack: JurisdictionPack;
  layoutMode: FilingPacketLayoutMode;
  prefixFilenames: boolean;
  appVersion: string;
  createdAt: string;
  factsOptions: BuildDocumentFactsOptions;
  checklist: FilingPacketChecklistOverrides;
}

interface OpenedHandle {
  handle: PdfDocumentHandle;
  engine: PdfEngine;
}

interface PreparedDocument {
  sourceFilename: string;
  sourceSha256: string;
  order: number;
  outputs: Omit<FilingPacketOutputFile, "packageRelativePath" | "bytes" | "sha256">[];
  outputBytes: readonly Uint8Array[];
  checks: readonly PreflightCheck[];
  stepStatus: readonly FilingPacketStepRecord[];
  handlesForCombined: readonly PdfDocumentHandle[];
}

const DEFAULT_APP_VERSION = "0.0.0";
const MANIFEST_PDF_NAME = "filing-packet-manifest.pdf";
const PACKET_JSON_NAME = "filing-packet.json";

export async function buildFilingPacket(
  input: BuildFilingPacketInput,
  engines: FilingPacketEngines = {},
): Promise<FilingPacketResult> {
  const options = normalizeInput(input);
  const localEngine = engines.local ?? createLocalPdfEngine();
  const sidecarEngine = engines.sidecar;
  const session = createPackage(options.outputDir, {
    appVersion: options.appVersion,
    createdAt: options.createdAt,
    packId: options.pack.id,
    packVersion: options.pack.packVersion,
    lastVerified: packLastVerified(options.pack),
    confirmCurrentRequirements:
      `Confirm current ${options.pack.name} filing requirements before upload; local packs update only with app releases.`,
  });
  const opened: OpenedHandle[] = [];
  const preparedDocuments: PreparedDocument[] = [];
  const documents: FilingPacketDocumentResult[] = [];
  const allOutputFiles: FilingPacketOutputFile[] = [];
  const combinedHandles: PdfDocumentHandle[] = [];

  try {
    for (let index = 0; index < options.sources.length; index += 1) {
      const source = options.sources[index];
      if (!source) {
        continue;
      }

      const prepared = await prepareDocument({
        source,
        order: index + 1,
        options,
        localEngine,
        sidecarEngine,
        opened,
      });

      preparedDocuments.push(prepared);
      combinedHandles.push(...prepared.handlesForCombined);
    }

    let combinedPdf: string | null = null;
    if (options.layoutMode === "separate-files") {
      for (const prepared of preparedDocuments) {
        const documentFiles: FilingPacketOutputFile[] = [];
        for (let outputIndex = 0; outputIndex < prepared.outputs.length; outputIndex += 1) {
          const output = prepared.outputs[outputIndex];
          const bytes = prepared.outputBytes[outputIndex];
          if (!output || !bytes) {
            continue;
          }
          const entry = await session.addUploadFile(bytes, output.outputName, {
            pages: output.pages,
            sourceFilename: output.sourceFilename,
            sourceSha256: prepared.sourceSha256,
            pageIndexes: [...output.pageIndexes],
            oversized: output.oversized,
            sourceOrder: output.sourceOrder,
          });
          const file: FilingPacketOutputFile = {
            ...output,
            packageRelativePath: entry.relativePath,
            bytes: entry.bytes,
            sha256: entry.sha256,
          };
          documentFiles.push(file);
          allOutputFiles.push(file);
        }
        documents.push(toDocumentResult(prepared, documentFiles));
      }
    } else {
      const combined = await localEngine.merge(combinedHandles);
      opened.push({ handle: combined, engine: localEngine });
      const combinedBytes = await localEngine.saveToBytes(combined);
      const combinedPageCount = preparedDocuments.reduce(
        (sum, document) => sum + document.outputs.reduce((documentSum, output) => documentSum + output.pages, 0),
        0,
      );
      const entry = await session.addUploadFile(combinedBytes, "filing-packet.pdf", {
        pages: combinedPageCount,
        sourceFilename: "filing-packet.pdf",
        combinedPacket: true,
      });
      combinedPdf = entry.relativePath;
      const combinedFile: FilingPacketOutputFile = {
        sourceFilename: "filing-packet.pdf",
        outputName: "filing-packet.pdf",
        packageRelativePath: entry.relativePath,
        pages: combinedPageCount,
        bytes: entry.bytes,
        sha256: entry.sha256,
        pageIndexes: [],
        oversized: false,
        sourceOrder: 0,
      };
      allOutputFiles.push(combinedFile);
      documents.push(...preparedDocuments.map((prepared) => toDocumentResult(prepared, [combinedFile])));
    }

    const selectionChecks = packetSelectionChecks(allOutputFiles, options.pack);
    const packetJson = toPacketJson(options, documents, allOutputFiles, selectionChecks, combinedPdf);
    const packetJsonEntry = await session.addManifestJson(PACKET_JSON_NAME, packetJson);
    const manifestPdfEntry = await session.addRootDocument(
      MANIFEST_PDF_NAME,
      await createFilingPacketManifestPdf(options, documents, allOutputFiles, selectionChecks, combinedPdf),
    );

    for (const document of documents) {
      for (const check of document.checks) {
        session.recordCheck({
          sourceFilename: document.sourceFilename,
          checkId: check.checkId,
          label: check.label,
          status: check.status,
          detail: check.detail,
        });
      }
      for (const step of document.stepStatus) {
        if (step.status === "overridden") {
          session.recordOverride({
            sourceFilename: document.sourceFilename,
            type: "filing-checklist-step",
            stepId: step.stepId,
            detail: step.detail,
          });
        }
      }
    }
    for (const check of selectionChecks) {
      session.recordCheck({
        scope: "packet",
        checkId: check.checkId,
        label: check.label,
        status: check.status,
        detail: check.detail,
      });
    }
    if (options.checklist.splitSizeMb !== undefined) {
      session.recordOverride({
        type: "filing-packet-split-size",
        valueMb: options.checklist.splitSizeMb,
      });
    }
    if (input.layoutMode !== undefined) {
      session.recordOverride({
        type: "filing-packet-layout",
        value: options.layoutMode,
      });
    }
    if (input.prefixFilenames !== undefined) {
      session.recordOverride({
        type: "filing-packet-prefix-filenames",
        value: options.prefixFilenames,
      });
    }
    session.recordDetail("filingPacket", packetJson);

    await session.finalize();
    const manifest = await readPackageManifest(options.outputDir);

    return {
      packageRoot: path.resolve(options.outputDir),
      layoutMode: options.layoutMode,
      files: allOutputFiles,
      documents,
      manifestPdf: manifestPdfEntry.relativePath,
      packetJson: packetJsonEntry.relativePath,
      combinedPdf,
      selectionChecks,
      manifest,
    };
  } finally {
    for (const item of opened.reverse()) {
      await item.engine.close(item.handle).catch(() => undefined);
    }
  }
}

async function prepareDocument({
  source,
  order,
  options,
  localEngine,
  sidecarEngine,
  opened,
}: {
  source: FilingPacketSourceInput;
  order: number;
  options: NormalizedInput;
  localEngine: PdfEngine;
  sidecarEngine: FilingPacketSidecarEngine | undefined;
  opened: OpenedHandle[];
}): Promise<PreparedDocument> {
  const sourcePath = path.resolve(source.path);
  const sourceBytes = await fs.readFile(sourcePath);
  const sourceFilename = source.displayName ?? path.basename(sourcePath);
  const sourceSha256 = sha256Hex(sourceBytes);
  const facts = withFilename(
    source.facts ?? await buildDocumentFacts(sourceBytes, options.factsOptions),
    sourceFilename,
    sourceBytes.byteLength,
  );
  const plan = resolvePrepPlan(options.pack, facts);
  const selectedSteps = selectedStepIds(plan, options.checklist);
  const stepStatus: FilingPacketStepRecord[] = [];
  let workingEngine: PdfEngine = localEngine;
  let working = await localEngine.open(sourceBytes);
  opened.push({ handle: working, engine: localEngine });

  const replaceWorking = (next: PdfDocumentHandle, engine: PdfEngine): void => {
    working = next;
    workingEngine = engine;
    opened.push({ handle: next, engine });
  };
  const record = (step: PrepPlanStep, status: FilingPacketStepStatus, detail: string): void => {
    stepStatus.push({ stepId: step.id, label: step.label, status, detail });
  };

  for (const step of plan) {
    if (!selectedSteps.has(step.id)) {
      record(step, wasDefaultChecked(step) ? "overridden" : "skipped", "Step was not selected for this packet run.");
      continue;
    }
    if (step.disabledReason) {
      record(step, "skipped", step.disabledReason);
      continue;
    }
    if (step.id === "split-by-size") {
      continue;
    }
    if (step.id === "convert-pdfa") {
      continue;
    }

    try {
      if (step.id === "remove-encryption") {
        record(step, "skipped", "No packet password workflow is available; encrypted inputs are reported by preflight.");
      } else if (step.id === "normalize-pages") {
        replaceWorking(await workingEngine.normalizePages(working, {
          targetSize: options.pack.pageSize,
          orientation: "portrait",
        }), workingEngine);
        record(step, "run", "Pages normalized to the pack page size and orientation.");
      } else if (step.id === "sanitize-content") {
        if (!sidecarEngine) {
          record(step, "unsupported", "Sanitize requires the desktop sidecar engine.");
          continue;
        }
        const sidecarDocument = await reopenInEngine(workingEngine, sidecarEngine, working);
        opened.push({ handle: sidecarDocument, engine: sidecarEngine });
        const sanitized = await sidecarEngine.sanitize(sidecarDocument, {
          removeJavaScript: true,
          removeEmbeddedFiles: true,
          removeLinks: true,
        });
        replaceWorking(sanitized.document, sidecarEngine);
        record(step, "run", `Sanitized content; removed ${sanitized.removed.length} item type(s).`);
      } else if (step.id === "scrub-metadata") {
        replaceWorking(await workingEngine.scrubMetadata(working), workingEngine);
        record(step, "run", "Metadata scrubbed where supported by the local engine.");
      } else if (step.id === "make-searchable") {
        if (!sidecarEngine) {
          record(step, "unsupported", "Make Searchable requires the desktop sidecar engine.");
          continue;
        }
        const sidecarDocument = await reopenInEngine(workingEngine, sidecarEngine, working);
        opened.push({ handle: sidecarDocument, engine: sidecarEngine });
        replaceWorking(await sidecarEngine.ocr(sidecarDocument, { ocrType: "skip-text" }), sidecarEngine);
        record(step, "run", "OCR ran with skip-text mode.");
      } else if (step.id === "flatten-forms") {
        replaceWorking(await workingEngine.flattenForm(working), workingEngine);
        record(step, "run", "Interactive form fields flattened.");
      }
    } catch (error) {
      record(step, "unsupported", errorMessage(error));
    }
  }

  const splitStepSelected = selectedSteps.has("split-by-size");
  const splitBytes = splitTargetBytes(options);
  const splitResult = splitStepSelected
    ? await workingEngine.splitByMaxBytes(working, splitBytes)
    : await singlePart(workingEngine, working);
  if (splitStepSelected) {
    const splitStep = plan.find((step) => step.id === "split-by-size");
    if (splitStep) {
      record(splitStep, options.checklist.splitSizeMb === undefined ? "run" : "overridden", `Split into ${splitResult.parts.length} upload part(s).`);
    }
  }

  const convertStep = plan.find((step) => step.id === "convert-pdfa");
  const convertOutput = convertStep !== undefined &&
    selectedSteps.has("convert-pdfa") &&
    shouldConvertToPdfA(options.pack) &&
    options.checklist.convertToPdfA !== false;
  if (convertStep && selectedSteps.has("convert-pdfa") && options.checklist.convertToPdfA === false) {
    record(convertStep, "overridden", "PDF/A conversion was explicitly disabled for this packet run.");
  }

  const outputs: PreparedDocument["outputs"] = [];
  const outputBytes: Uint8Array[] = [];
  const handlesForCombined: PdfDocumentHandle[] = [];
  const baseName = stripPdfExtension(sourceFilename);

  for (let index = 0; index < splitResult.parts.length; index += 1) {
    const part = splitResult.parts[index];
    if (!part) {
      continue;
    }
    opened.push({ handle: part.document, engine: workingEngine });
    let outputHandle = part.document;
    let outputEngine = workingEngine;

    if (convertOutput) {
      if (!sidecarEngine) {
        if (convertStep) {
          record(convertStep, "unsupported", "PDF/A conversion requires the desktop sidecar engine.");
        }
      } else {
        const sidecarDocument = await reopenInEngine(outputEngine, sidecarEngine, outputHandle);
        opened.push({ handle: sidecarDocument, engine: sidecarEngine });
        outputHandle = await sidecarEngine.convertToPdfA(sidecarDocument, { flavor: options.pack.pdfa.flavor });
        outputEngine = sidecarEngine;
        opened.push({ handle: outputHandle, engine: outputEngine });
        if (convertStep && index === 0) {
          record(convertStep, "run", `Converted each upload part to ${options.pack.pdfa.flavor}.`);
        }
      }
    }

    const bytes = await outputEngine.saveToBytes(outputHandle);
    const pageCount = await outputEngine.pageCount(outputHandle);
    outputBytes.push(bytes);
    const combinedHandle = await localEngine.open(bytes);
    opened.push({ handle: combinedHandle, engine: localEngine });
    handlesForCombined.push(combinedHandle);
    outputs.push({
      sourceFilename,
      outputName: outputNameFor({
        sourceFilename,
        baseName,
        order,
        partNumber: index + 1,
        totalParts: splitResult.parts.length,
        prefix: options.prefixFilenames,
      }),
      pages: pageCount,
      pageIndexes: part.pageIndexes,
      oversized: part.oversized || (splitStepSelected && bytes.byteLength > splitBytes),
      sourceOrder: order,
    });
  }

  const outputReports = await Promise.all(outputBytes.map(async (bytes, index) => {
    const output = outputs[index];
    return preflight(
      withFilename(await buildDocumentFacts(bytes, options.factsOptions), output?.outputName ?? sourceFilename, bytes.byteLength),
      options.pack,
    );
  }));

  return {
    sourceFilename,
    sourceSha256,
    order,
    outputs,
    outputBytes,
    checks: aggregateChecks(outputReports),
    stepStatus,
    handlesForCombined,
  };
}

function normalizeInput(input: BuildFilingPacketInput): NormalizedInput {
  if (input.sources.length === 0) {
    throw new Error("Filing packet requires at least one source PDF.");
  }
  if (input.checklist?.splitSizeMb !== undefined && (
    !Number.isFinite(input.checklist.splitSizeMb) ||
    input.checklist.splitSizeMb <= 0
  )) {
    throw new Error("Packet split size override must be a positive MB value.");
  }
  if (
    input.courtProfile?.maxFileBytes !== undefined &&
    (!Number.isInteger(input.courtProfile.maxFileBytes) || input.courtProfile.maxFileBytes <= 0)
  ) {
    throw new Error("Court profile maxFileBytes must be a positive integer.");
  }
  if (
    input.courtProfile?.maxEnvelopeBytes !== undefined &&
    (!Number.isInteger(input.courtProfile.maxEnvelopeBytes) || input.courtProfile.maxEnvelopeBytes <= 0)
  ) {
    throw new Error("Court profile maxEnvelopeBytes must be a positive integer.");
  }

  return {
    sources: input.sources,
    outputDir: input.outputDir,
    pack: applyCourtProfile(getPack(input.packId), input.courtProfile),
    layoutMode: input.layoutMode ?? "separate-files",
    prefixFilenames: input.prefixFilenames ?? true,
    appVersion: input.appVersion ?? DEFAULT_APP_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    factsOptions: input.factsOptions ?? {},
    checklist: input.checklist ?? {},
  };
}

function applyCourtProfile(
  pack: JurisdictionPack,
  profile: FilingPacketCourtProfileValues | undefined,
): JurisdictionPack {
  if (!profile) {
    return pack;
  }

  return {
    ...pack,
    ...(profile.maxFileBytes === undefined ? {} : { maxFileBytes: profile.maxFileBytes }),
    ...(profile.maxEnvelopeBytes === undefined ? {} : { maxEnvelopeBytes: profile.maxEnvelopeBytes }),
  };
}

function toDocumentResult(
  prepared: PreparedDocument,
  outputs: readonly FilingPacketOutputFile[],
): FilingPacketDocumentResult {
  return {
    sourceFilename: prepared.sourceFilename,
    sourceSha256: prepared.sourceSha256,
    order: prepared.order,
    outputs,
    checks: prepared.checks,
    stepStatus: prepared.stepStatus,
  };
}

function selectedStepIds(
  plan: readonly PrepPlanStep[],
  checklist: FilingPacketChecklistOverrides,
): Set<PrepPlanStepId> {
  const selected = new Set<PrepPlanStepId>(
    checklist.selectedStepIds ?? plan.filter((step) => step.defaultChecked).map((step) => step.id),
  );

  for (const stepId of checklist.skippedStepIds ?? []) {
    selected.delete(stepId);
  }
  if (checklist.convertToPdfA === false) {
    selected.delete("convert-pdfa");
  }

  return selected;
}

function wasDefaultChecked(step: PrepPlanStep): boolean {
  return step.defaultChecked && !step.disabledReason;
}

async function reopenInEngine(
  fromEngine: PdfEngine,
  toEngine: PdfEngine,
  document: PdfDocumentHandle,
): Promise<PdfDocumentHandle> {
  return await toEngine.open(await fromEngine.saveToBytes(document));
}

async function singlePart(
  engine: PdfEngine,
  document: PdfDocumentHandle,
): Promise<{ parts: readonly { document: PdfDocumentHandle; pageIndexes: readonly number[]; oversized: boolean }[] }> {
  const pages = await engine.pageCount(document);
  return {
    parts: [{
      document,
      pageIndexes: Array.from({ length: pages }, (_value, index) => index),
      oversized: false,
    }],
  };
}

function splitTargetBytes(options: NormalizedInput): number {
  return Math.floor(
    (options.checklist.splitSizeMb === undefined
      ? undefined
      : options.checklist.splitSizeMb * 1024 * 1024) ??
    options.pack.recommendedMaxFileBytes ??
    options.pack.maxFileBytes ??
    Number.MAX_SAFE_INTEGER,
  );
}

function outputNameFor(input: {
  sourceFilename: string;
  baseName: string;
  order: number;
  partNumber: number;
  totalParts: number;
  prefix: boolean;
}): string {
  const stem = input.totalParts === 1
    ? input.baseName
    : `${input.baseName} - Part ${input.partNumber} of ${input.totalParts}`;
  const name = `${safePdfName(stem)}.pdf`;
  return input.prefix ? `${String(input.order).padStart(2, "0")} - ${name}` : name;
}

function safePdfName(value: string): string {
  return [...stripPdfExtension(value)]
    .map((character) => (isUnsafeFileNameCharacter(character) ? "_" : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim() || "document";
}

function stripPdfExtension(value: string): string {
  return value.replace(/\.pdf$/i, "");
}

function isUnsafeFileNameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f || "\\/:*?\"<>|".includes(character);
}

function withFilename(facts: DocumentFacts, filename: string, fileBytes: number): DocumentFacts {
  return {
    ...facts,
    filename,
    fileBytes,
  };
}

function aggregateChecks(reports: readonly PreflightReport[]): readonly PreflightCheck[] {
  const [first] = reports;
  if (!first) {
    return [];
  }

  return first.checks.map((check) => {
    const matches = reports
      .map((report) => report.checks.find((candidate) => candidate.checkId === check.checkId))
      .filter((candidate): candidate is PreflightCheck => candidate !== undefined);
    const nonPass = matches
      .map((candidate, index) => ({ candidate, partNumber: index + 1 }))
      .filter((match) => match.candidate.status !== "pass");

    return {
      ...check,
      status: aggregateStatus(matches),
      detail: nonPass.length === 0
        ? `All ${reports.length} output part(s) pass.`
        : nonPass.map((match) => `Part ${match.partNumber}: ${match.candidate.detail}`).join(" "),
    };
  });
}

function aggregateStatus(checks: readonly PreflightCheck[]): PreflightCheck["status"] {
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  if (checks.some((check) => check.status === "unknown")) {
    return "unknown";
  }
  return "pass";
}

function packetSelectionChecks(
  files: readonly FilingPacketOutputFile[],
  pack: JurisdictionPack,
): readonly PreflightCheck[] {
  const selection: SelectionFacts = {
    envelopeBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.map((file) => ({
      filename: file.outputName,
      fileBytes: file.bytes,
    })),
  };

  return preflight({ pages: [] }, pack, selection).selectionChecks ?? [];
}

function toPacketJson(
  options: NormalizedInput,
  documents: readonly FilingPacketDocumentResult[],
  files: readonly FilingPacketOutputFile[],
  selectionChecks: readonly PreflightCheck[],
  combinedPdf: string | null,
): JsonValue {
  return {
    packetVersion: 1,
    createdAt: options.createdAt,
    pack: {
      id: options.pack.id,
      packVersion: options.pack.packVersion,
      lastVerified: packLastVerified(options.pack),
    },
    layoutMode: options.layoutMode,
    prefixFilenames: options.prefixFilenames,
    combinedPdf,
    sourceToOutput: documents.map((document) => ({
      sourceFilename: document.sourceFilename,
      outputs: document.outputs.map((output) => output.outputName),
    })),
    files: files.map((file) => ({
      outputName: file.outputName,
      sourceFilename: file.sourceFilename,
      pages: file.pages,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    checks: {
      summary: checkSummary([
        ...documents.flatMap((document) => document.checks),
        ...selectionChecks,
      ]),
      selection: selectionChecks.map(checkToJson),
      documents: documents.map((document) => ({
        sourceFilename: document.sourceFilename,
        checks: document.checks.map(checkToJson),
        stepStatus: document.stepStatus.map((step) => ({
          stepId: step.stepId,
          label: step.label,
          status: step.status,
          detail: step.detail,
        })),
      })),
    },
    confirmCurrentRequirements:
      `Confirm current ${options.pack.name} filing requirements before upload; local packs update only with app releases.`,
  };
}

function checkToJson(check: PreflightCheck) {
  return {
    checkId: check.checkId,
    label: check.label,
    authority: check.authority,
    kind: check.kind,
    status: check.status,
    detail: check.detail,
  };
}

function checkSummary(checks: readonly PreflightCheck[]): { pass: number; warn: number; unknown: number } {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    unknown: checks.filter((check) => check.status === "unknown").length,
  };
}

async function createFilingPacketManifestPdf(
  options: NormalizedInput,
  documents: readonly FilingPacketDocumentResult[],
  files: readonly FilingPacketOutputFile[],
  selectionChecks: readonly PreflightCheck[],
  combinedPdf: string | null,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 42;
  const lineHeight = 13;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const draw = (text: string, x = margin, font = regular, size = 8): void => {
    page.drawText(truncate(text, 118), { x, y, size, font, color: rgb(0.08, 0.08, 0.08) });
    y -= lineHeight;
  };
  const heading = (text: string): void => {
    ensureSpace(28);
    y -= 4;
    draw(text, margin, bold, 11);
  };
  const ensureSpace = (height: number): void => {
    if (y >= margin + height) {
      return;
    }
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };

  page.drawText("Filing Packet Manifest", {
    x: margin,
    y,
    size: 15,
    font: bold,
    color: rgb(0.04, 0.04, 0.04),
  });
  y -= 24;
  draw(`Pack: ${options.pack.name} (${options.pack.id}) ${options.pack.packVersion}`);
  draw(`Last verified: ${Object.values(packLastVerified(options.pack)).sort().at(-1) ?? "unknown"}`);
  draw(`Created: ${options.createdAt}`);
  draw(`Layout: ${options.layoutMode}${combinedPdf ? ` (${path.basename(combinedPdf)})` : ""}`);
  draw(`Reminder: Confirm current ${options.pack.name} filing requirements before upload.`);

  heading("Source to Output");
  for (const document of documents) {
    ensureSpace(36);
    draw(`${document.order}. ${document.sourceFilename}`, margin, bold);
    for (const output of document.outputs) {
      draw(`- ${output.outputName} | ${output.pages} page(s) | ${formatBytes(output.bytes)}`, margin + 12);
    }
  }

  heading("Checks Summary");
  const summary = checkSummary([
    ...documents.flatMap((document) => document.checks),
    ...selectionChecks,
  ]);
  draw(`Pass: ${summary.pass} | Warnings: ${summary.warn} | Unknown: ${summary.unknown}`);
  for (const check of selectionChecks) {
    draw(`${check.status.toUpperCase()} packet ${check.label}: ${check.detail}`);
  }

  heading("Per-File Steps");
  for (const document of documents) {
    ensureSpace(32);
    draw(document.sourceFilename, margin, bold);
    for (const step of document.stepStatus) {
      draw(`${step.status.toUpperCase()} ${step.label}: ${step.detail}`, margin + 12);
    }
  }

  return await pdf.save();
}

function packLastVerified(pack: JurisdictionPack): Record<string, string> {
  return Object.fromEntries(pack.constraints.map((constraint) => [constraint.id, constraint.lastVerified]));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
