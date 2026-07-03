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

interface OpenedHandle {
  handle: PdfDocumentHandle;
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
const DEFAULT_APP_VERSION = "0.0.0";
const BATES_PLACEMENT: PdfStampPlacement = { edge: "footer", align: "right" };
const DESIGNATION_PLACEMENT: PdfStampPlacement = { edge: "header", align: "center" };

export async function buildProductionSet(
  input: BuildProductionSetInput,
  engine: PdfEngine = createLocalPdfEngine(),
): Promise<ProductionSetResult> {
  const options = normalizeInput(input);
  const session = createPackage(options.outputDir, {
    appVersion: options.appVersion,
    createdAt: options.createdAt,
    confirmCurrentRequirements:
      "Confirm current production protocol, protective order, and delivery format before service.",
  });
  const opened: OpenedHandle[] = [];
  const stampedForCombined: PdfDocumentHandle[] = [];
  const files: ProductionSetFileResult[] = [];
  const volumeArtifacts: VolumeUploadArtifact[] = [];
  let running = options.start;
  const volume: VolumeState | null = options.volumeBytes === null ? null : createVolume(1);

  try {
    for (const source of options.sources) {
      const sourcePath = path.resolve(source.path);
      const sourceBytes = await fs.readFile(sourcePath);
      const sourceSha256 = sha256Hex(sourceBytes);
      const sourceFilename = path.basename(sourcePath);
      const original = await engine.open(sourceBytes);
      opened.push({ handle: original });
      const pages = await engine.pageCount(original);
      const firstNumber = running;
      const lastNumber = running + pages - 1;
      assertBatesFits(options.digits, lastNumber);

      let produced = await engine.batesStamp(original, {
        prefix: options.prefix,
        start: firstNumber,
        digits: options.digits,
        placement: BATES_PLACEMENT,
        fontSizePt: 10,
      });
      opened.push({ handle: produced });

      const designation = normalizeDesignation(source.designation);
      if (designation !== "") {
        produced = await engine.stampText(produced, {
          text: designation,
          pageIndexes: "all",
          placement: DESIGNATION_PLACEMENT,
          fontSizePt: 10,
        });
        opened.push({ handle: produced });
      }

      const outputBytes = await engine.saveToBytes(produced);
      const batesStart = formatBates(options.prefix, firstNumber, options.digits);
      const batesEnd = formatBates(options.prefix, lastNumber, options.digits);
      const outputName = `${batesStart} - ${batesEnd} - ${safePdfName(sourceFilename)}`;
      const volumeName = assignVolume(volume, outputName, outputBytes.byteLength, options.volumeBytes);
      const packageName = volumeName === null ? outputName : `${volumeName}/${outputName}`;
      const entry = await session.addUploadFile(outputBytes, packageName, {
        pages,
        sourceFilename,
        sourceSha256,
        batesStart,
        batesEnd,
        designation,
      });
      volumeArtifacts.push({
        outputName,
        bytes: entry.bytes,
        volume: volumeName,
      });

      files.push({
        sourcePath,
        sourceFilename,
        sourceSha256,
        outputName,
        packageRelativePath: entry.relativePath,
        batesStart,
        batesEnd,
        firstNumber,
        lastNumber,
        pages,
        designation,
        sha256: entry.sha256,
        bytes: entry.bytes,
        volume: volumeName,
      });
      stampedForCombined.push(produced);
      running = lastNumber + 1;
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
      const combined = await engine.merge(stampedForCombined);
      opened.push({ handle: combined });
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
    for (const { handle } of opened.reverse()) {
      await engine.close(handle).catch(() => undefined);
    }
  }
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
