import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PdfCompressOptions,
  PdfDocumentHandle,
  PdfSanitizeOptions,
  PdfSanitizeResult,
  PdfAConversionOptions,
} from "@raiopdf/engine-api";
import { LocalPdfEngine } from "@raiopdf/engine-local";
import { readPackageManifest } from "@raiopdf/package-writer";
import type { DocumentFacts } from "@raiopdf/rules";
import { runBatchCleanup, type BatchCleanupSidecarEngine } from "../src/index";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-batch-cleanup-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runBatchCleanup", () => {
  it("continues the queue after a failing encrypted file", async () => {
    const first = await makePdf("first.pdf", 1);
    const encrypted = await makePdf("encrypted.pdf", 1);
    const third = await makePdf("third.pdf", 1);
    const outputDir = path.join(dir, "package");
    const engine = new RecordingEngine();

    const result = await runBatchCleanup({
      sources: [
        { path: first, facts: facts({ pages: 1 }) },
        { path: encrypted, facts: facts({ pages: 1, encryptionState: "encrypted" }) },
        { path: third, facts: facts({ pages: 1 }) },
      ],
      outputDir,
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
      createdAt: "2026-07-03T12:00:00.000Z",
    }, { local: engine, sidecar: engine });

    expect(result.files.map((file) => file.status)).toEqual(["done", "failed", "done"]);
    expect(result.files[1]!.reason).toMatch(/password/i);
    expect(result.manifest.uploadFiles).toHaveLength(2);
  });

  it("runs engine work serially", async () => {
    const first = await makePdf("first.pdf", 1);
    const second = await makePdf("second.pdf", 1);
    const engine = new RecordingEngine({ delayMs: 15 });

    await runBatchCleanup({
      sources: [
        { path: first, facts: imageOnlyFacts(1) },
        { path: second, facts: imageOnlyFacts(1) },
      ],
      outputDir: path.join(dir, "package"),
      operations: {
        sanitize: false,
        scrubMetadata: false,
        ocrMode: "auto-image-only",
      },
    }, { local: engine, sidecar: engine });

    expect(engine.maxActive).toBe(1);
    expect(engine.operations).toEqual(["ocr", "ocr"]);
  });

  it("gates default OCR on image-only text-layer facts", async () => {
    const imageOnly = await makePdf("scan.pdf", 1);
    const searchable = await makePdf("searchable.pdf", 1);
    const engine = new RecordingEngine();

    const result = await runBatchCleanup({
      sources: [
        { path: imageOnly, facts: imageOnlyFacts(1) },
        {
          path: searchable,
          facts: facts({
            pages: 1,
            textLayerCoverage: { imageOnlyPages: [], mixedPages: [], textPages: [0] },
          }),
        },
      ],
      outputDir: path.join(dir, "package"),
      operations: {
        sanitize: false,
        scrubMetadata: false,
        ocrMode: "auto-image-only",
      },
    }, { local: engine, sidecar: engine });

    expect(result.files.map((file) => file.status)).toEqual(["done", "skipped"]);
    expect(result.files[0]!.operations).toEqual(["ocr"]);
    expect(result.files[1]!.ocrDecision).toMatch(/skipped/i);
    expect(engine.operations).toEqual(["ocr"]);
  });

  it("refuses to create a package in a non-empty output folder", async () => {
    const source = await makePdf("source.pdf", 1);
    const outputDir = path.join(dir, "package");
    await fs.mkdir(outputDir);
    await fs.writeFile(path.join(outputDir, "existing.pdf"), "already here");

    await expect(runBatchCleanup({
      sources: [{ path: source, facts: facts({ pages: 1 }) }],
      outputDir,
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
    }, { local: new RecordingEngine() })).rejects.toThrow(/non-empty directory/);
  });

  it("writes package reports, checksums, and upload files through package-writer", async () => {
    const source = await makePdf("source.pdf", 2);
    const outputDir = path.join(dir, "package");

    const result = await runBatchCleanup({
      sources: [{ path: source, facts: facts({ pages: 2 }) }],
      outputDir,
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
    }, { local: new RecordingEngine() });

    expect(result.reportPdf).toBe("batch-report.pdf");
    expect(result.reportJson).toBe("raio-manifest/batch-report.json");
    expect(await fs.access(path.join(outputDir, "upload", "source - cleaned.pdf"))).toBeUndefined();
    expect(await fs.access(path.join(outputDir, "raio-manifest", "checksums.txt"))).toBeUndefined();
    expect((await readPackageManifest(outputDir)).rootDocuments.map((entry) => entry.name)).toContain(
      "batch-report.pdf",
    );
  });

  it("disambiguates duplicate source basenames and records the output mapping", async () => {
    const first = await makePdf("alpha/motion.pdf", 1);
    const second = await makePdf("beta/motion.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await runBatchCleanup({
      sources: [
        { path: first, facts: facts({ pages: 1 }) },
        { path: second, facts: facts({ pages: 1 }) },
      ],
      outputDir,
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
    }, { local: new RecordingEngine() });

    expect(result.files.map((file) => file.status)).toEqual(["done", "done"]);
    expect(result.files.flatMap((file) => file.outputs.map((output) => output.outputName))).toEqual([
      "motion - cleaned.pdf",
      "motion - cleaned (2).pdf",
    ]);
    expect(result.manifest.uploadFiles.map((file) => file.outputName)).toEqual([
      "motion - cleaned.pdf",
      "motion - cleaned (2).pdf",
    ]);
    expect(JSON.stringify(result.manifest.details.batchSources)).toContain("motion - cleaned (2).pdf");
    await expect(fs.access(path.join(outputDir, "upload", "motion - cleaned.pdf"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(outputDir, "upload", "motion - cleaned (2).pdf"))).resolves.toBeUndefined();
  });

  it("propagates pack-aware warnings into the report without source paths", async () => {
    const source = await makePdf("scripted.pdf", 1);
    const outputDir = path.join(dir, "package");

    await runBatchCleanup({
      sources: [{
        path: source,
        facts: facts({
          pages: 1,
          activeContentSignals: { possiblyPresent: true, signals: ["javascriptAction"] },
        }),
      }],
      outputDir,
      packId: "federal-cmecf",
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
    }, { local: new RecordingEngine() });

    const report = await fs.readFile(path.join(outputDir, "raio-manifest", "batch-report.json"), "utf8");
    expect(report).toContain("active-content");
    expect(report).toContain("scripted.pdf");
    expect(report).not.toContain(source);
  });

  it("records split-size overrides and part outputs", async () => {
    const source = await makePdf("big.pdf", 2);
    const outputDir = path.join(dir, "package");

    const result = await runBatchCleanup({
      sources: [{ path: source, facts: facts({ pages: 2 }) }],
      outputDir,
      operations: {
        sanitize: false,
        scrubMetadata: false,
        ocrMode: "off",
        splitBySize: true,
        splitSizeMb: 0.0001,
      },
    }, { local: new RecordingEngine() });

    expect(result.files[0]!.outputs.map((output) => output.outputName)).toEqual([
      "big - cleaned - part 01.pdf",
      "big - cleaned - part 02.pdf",
    ]);
    expect(result.manifest.overrides).toContainEqual({
      type: "batch-split-size",
      valueMb: 0.0001,
    });
  });
});

class RecordingEngine extends LocalPdfEngine implements BatchCleanupSidecarEngine {
  readonly operations: string[] = [];
  maxActive = 0;
  private active = 0;
  private readonly delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    super();
    this.delayMs = options.delayMs ?? 0;
  }

  override async repair(document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    return this.record("repair", async () => this.scrubMetadata(document));
  }

  override async sanitize(
    document: PdfDocumentHandle,
    _options: PdfSanitizeOptions = {},
  ): Promise<PdfSanitizeResult> {
    return this.record("sanitize", async () => ({
      document: await this.scrubMetadata(document),
      removed: ["javascript"],
    }));
  }

  override async compress(
    document: PdfDocumentHandle,
    _options: PdfCompressOptions,
  ): Promise<PdfDocumentHandle> {
    return this.record("compress", async () => this.scrubMetadata(document));
  }

  override async convertToPdfA(
    document: PdfDocumentHandle,
    _options: PdfAConversionOptions,
  ): Promise<PdfDocumentHandle> {
    return this.record("pdfa", async () => this.scrubMetadata(document));
  }

  async ocr(
    document: PdfDocumentHandle,
    _options: { languages?: readonly string[]; ocrType?: "force-ocr" | "skip-text" },
  ): Promise<PdfDocumentHandle> {
    return this.record("ocr", async () => this.scrubMetadata(document));
  }

  private async record<T>(operation: string, run: () => Promise<T>): Promise<T> {
    this.operations.push(operation);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      return await run();
    } finally {
      this.active -= 1;
    }
  }
}

async function makePdf(name: string, pages: number): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([240, 240]);
    page.drawText(`Source ${name} page ${index + 1}`, { x: 12, y: 120, size: 10, font });
  }
  const filePath = path.join(dir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

function facts(overrides: {
  pages: number;
  encryptionState?: DocumentFacts["encryptionState"] | undefined;
  textLayerCoverage?: DocumentFacts["textLayerCoverage"] | undefined;
  activeContentSignals?: DocumentFacts["activeContentSignals"] | undefined;
}): DocumentFacts {
  return {
    pages: Array.from({ length: overrides.pages }, (_, pageIndex) => ({
      pageIndex,
      size: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
    })),
    fileBytes: 1000,
    encryptionState: overrides.encryptionState ?? "none",
    activeContentSignals: overrides.activeContentSignals ?? { possiblyPresent: false, signals: [] },
    embeddedFileCount: 0,
    formFields: { count: 0, anyFilled: false },
    annotationCount: 0,
    signatureFieldCount: 0,
    possibleUnappliedRedactions: {
      redactAnnotationCount: 0,
      blackRectangleAnnotationCount: 0,
      possiblyPresent: false,
    },
    ...(overrides.textLayerCoverage === undefined
      ? {}
      : { textLayerCoverage: overrides.textLayerCoverage }),
  };
}

function imageOnlyFacts(pages: number): DocumentFacts {
  return facts({
    pages,
    textLayerCoverage: {
      imageOnlyPages: Array.from({ length: pages }, (_, index) => index),
      mixedPages: [],
      textPages: [],
    },
  });
}
