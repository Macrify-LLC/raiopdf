import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PdfEngineError } from "@raiopdf/engine-api";
import type {
  PdfCompressOptions,
  PdfBytes,
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
  it("defaults to local-only cleanup when no sidecar engine is supplied", async () => {
    const source = await makePdf("source.pdf", 1);
    const outputDir = path.join(dir, "package");
    const engine = new RecordingEngine();

    const result = await runBatchCleanup({
      sources: [{ path: source, facts: imageOnlyFacts(1) }],
      outputDir,
    }, { local: engine });

    expect(result.files[0]!.status).toBe("done");
    expect(result.files[0]!.operations).toEqual(["scrub-metadata"]);
    expect(result.files[0]!.ocrDecision).toBe("OCR disabled.");
    expect(engine.operations).toEqual([]);
    await expect(fs.access(path.join(outputDir, "upload", "source - cleaned.pdf"))).resolves.toBeUndefined();
  });

  it("does not implicitly schedule pack sanitize or OCR without a sidecar engine", async () => {
    const source = await makePdf("scripted-scan.pdf", 1);
    const engine = new RecordingEngine();

    const result = await runBatchCleanup({
      sources: [{
        path: source,
        facts: imageOnlyFacts(1),
      }],
      outputDir: path.join(dir, "package"),
      packId: "federal-cmecf",
    }, { local: engine });

    expect(result.files[0]!.status).toBe("done");
    expect(result.files[0]!.operations).toEqual(["scrub-metadata"]);
    expect(result.files[0]!.ocrDecision).toBe("OCR disabled.");
    expect(engine.operations).toEqual([]);
  });

  it("preserves pack sanitize defaults when a sidecar engine is supplied", async () => {
    const source = await makePdf("scripted.pdf", 1);
    const engine = new RecordingEngine();

    const result = await runBatchCleanup({
      sources: [{ path: source, facts: facts({ pages: 1 }) }],
      outputDir: path.join(dir, "package"),
      packId: "federal-cmecf",
      operations: {
        ocrMode: "off",
      },
    }, { local: engine, sidecar: engine });

    expect(result.files[0]!.status).toBe("done");
    expect(result.files[0]!.operations).toEqual(["sanitize", "scrub-metadata"]);
    expect(engine.operations).toEqual(["sanitize"]);
  });

  it("reports explicit sidecar-only operations clearly when no sidecar engine is supplied", async () => {
    const source = await makePdf("source.pdf", 1);

    const result = await runBatchCleanup({
      sources: [{ path: source, facts: facts({ pages: 1 }) }],
      outputDir: path.join(dir, "package"),
      operations: {
        sanitize: true,
        ocrMode: "off",
        scrubMetadata: false,
      },
    }, { local: new RecordingEngine() });

    expect(result.files[0]!.status).toBe("failed");
    expect(result.files[0]!.reason).toMatch(/sanitize requires the desktop sidecar engine/i);
    expect(result.manifest.uploadFiles).toHaveLength(0);
  });

  it("continues the queue after a failing encrypted file", async () => {
    const first = await makePdf("first.pdf", 1);
    const encrypted = await makePdf("encrypted.pdf", 1);
    const third = await makePdf("third.pdf", 1);
    const outputDir = path.join(dir, "package");
    const engine = new RecordingEngine({ unlockPassword: "open-sesame" });

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

  it("unlocks owner-restricted files without a password and records signature invalidations", async () => {
    const signed = await makeSignedPdf("signed.pdf");
    const outputDir = path.join(dir, "package");
    const engine = new RecordingEngine();

    const result = await runBatchCleanup({
      sources: [
        { path: signed, facts: facts({ pages: 1, encryptionState: "usage_restricted" }) },
      ],
      outputDir,
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
    }, { local: engine, sidecar: engine });

    expect(result.files[0]!).toMatchObject({
      status: "done",
      operations: ["remove-encryption", "scrub-metadata"],
      signatureInvalidated: true,
      signatureDetection: {
        hasByteRangeOrContentsMarkers: true,
      },
    });
    expect(engine.operations).toEqual(["remove-encryption"]);

    const report = JSON.parse(await fs.readFile(path.join(outputDir, result.reportJson), "utf8")) as {
      files: { signatureInvalidated: boolean }[];
      summary: { signatureInvalidatedFiles: string[] };
    };
    expect(report.files[0]!.signatureInvalidated).toBe(true);
    expect(report.summary.signatureInvalidatedFiles).toContain("signed.pdf");
    expect(JSON.stringify(result.manifest)).toContain("\"signatureInvalidated\":true");
  });

  it("reuses the per-run password for encrypted files without writing it to reports", async () => {
    const encrypted = await makePdf("encrypted.pdf", 1);
    const outputDir = path.join(dir, "package");
    const engine = new RecordingEngine({ unlockPassword: "open-sesame" });

    const result = await runBatchCleanup({
      sources: [
        { path: encrypted, facts: facts({ pages: 1, encryptionState: "encrypted" }) },
      ],
      outputDir,
      password: "open-sesame",
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
      createdAt: "2026-07-03T12:00:00.000Z",
    }, { local: engine, sidecar: engine });

    expect(result.files[0]!.status).toBe("done");
    expect(result.files[0]!.operations).toEqual(["remove-encryption", "scrub-metadata"]);
    expect(engine.operations).toEqual(["remove-encryption", "remove-encryption"]);
    expect(result.manifest.uploadFiles).toHaveLength(1);

    const manifestText = JSON.stringify(result.manifest);
    const reportText = await fs.readFile(path.join(outputDir, result.reportJson), "utf8");
    expect(manifestText).not.toContain("open-sesame");
    expect(reportText).not.toContain("open-sesame");
  });

  it("continues the batch when an encrypted file rejects the per-run password", async () => {
    const encrypted = await makePdf("encrypted.pdf", 1);
    const outputDir = path.join(dir, "package");
    const engine = new RecordingEngine({ unlockPassword: "right-password" });

    const result = await runBatchCleanup({
      sources: [
        { path: encrypted, facts: facts({ pages: 1, encryptionState: "encrypted" }) },
      ],
      outputDir,
      password: "wrong-password",
      operations: {
        sanitize: false,
        scrubMetadata: true,
        ocrMode: "off",
      },
    }, { local: engine, sidecar: engine });

    expect(result.files[0]!.status).toBe("failed");
    expect(result.files[0]!.operations).toEqual(["remove-encryption"]);
    expect(result.files[0]!.reason).toMatch(/unlock/i);
    expect(JSON.stringify(result.manifest)).not.toContain("wrong-password");
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
            textLayerCoverage: { imageOnlyPages: [], mixedPages: [], textPages: [0], garbledPages: [] },
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
    expect(engine.ocrTypes).toEqual(["skip-text"]);
  });

  it("forces OCR when default OCR sees a garbled text layer", async () => {
    const source = await makePdf("garbled.pdf", 1);
    const engine = new RecordingEngine();

    const result = await runBatchCleanup({
      sources: [{
        path: source,
        facts: facts({
          pages: 1,
          textLayerCoverage: {
            imageOnlyPages: [],
            mixedPages: [],
            textPages: [0],
            garbledPages: [{
              pageIndex: 0,
              confidence: 0.93,
              reason: "combined",
              puaRatio: 0.2,
              replacementRatio: 0.1,
              alphaRatio: 0.02,
            }],
          },
        }),
      }],
      outputDir: path.join(dir, "package"),
      operations: {
        sanitize: false,
        scrubMetadata: false,
        ocrMode: "auto-image-only",
      },
    }, { local: engine, sidecar: engine });

    expect(result.files[0]!.status).toBe("done");
    expect(result.files[0]!.operations).toEqual(["ocr"]);
    expect(result.files[0]!.ocrDecision).toBe("Garbled text layer detected; force OCR to rebuild it.");
    expect(engine.ocrTypes).toEqual(["force-ocr"]);
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
  readonly ocrTypes: Array<"force-ocr" | "skip-text" | undefined> = [];
  maxActive = 0;
  private active = 0;
  private readonly delayMs: number;
  private readonly unlockPassword: string;

  constructor(options: { delayMs?: number; unlockPassword?: string } = {}) {
    super();
    this.delayMs = options.delayMs ?? 0;
    this.unlockPassword = options.unlockPassword ?? "";
  }

  override async removeEncryption(bytes: PdfBytes, password: string): Promise<Uint8Array> {
    return this.record("remove-encryption", async () => {
      if (password !== this.unlockPassword) {
        if (password === "") {
          throw new PdfEngineError(
            "PASSWORD_REQUIRED",
            "A PDF password is required to remove encryption.",
          );
        }
        throw new Error("The PDF password was not accepted.");
      }
      return new Uint8Array(bytes);
    });
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
    options: { languages?: readonly string[]; ocrType?: "force-ocr" | "skip-text" },
  ): Promise<PdfDocumentHandle> {
    this.ocrTypes.push(options.ocrType);
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

async function makeSignedPdf(name: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([240, 240]);
  page.drawText(`Signed ${name}`, { x: 12, y: 120, size: 10, font });
  pdf.context.register(pdf.context.obj({
    Type: "Sig",
    SubFilter: "adbe.pkcs7.detached",
    ByteRange: [0, 20, 40, 60],
    Contents: "signature-bytes",
  }));
  const filePath = path.join(dir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, await pdf.save({ useObjectStreams: true }));
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
      garbledPages: [],
    },
  });
}
