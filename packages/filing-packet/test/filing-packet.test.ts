import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import { LocalPdfEngine } from "@raiopdf/engine-local";
import { extractAllText, extractPageTextByPage, extractTextLayerCoverage } from "@raiopdf/rules/node";
import type { DocumentFacts, TextLayerCoverage } from "@raiopdf/rules";
import { buildFilingPacket } from "../src/index";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-filing-packet-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("buildFilingPacket", () => {
  it("builds a separate-file package with split naming, manifests, checks, and overrides", async () => {
    const motion = await writePdf("Motion to Compel.pdf", [
      "MOTION TO COMPEL",
      "I certify that prior to filing this motion, counsel conferred.",
      "motion body",
    ]);
    const exhibit = await writePdf("Exhibit A - Email Chain.pdf", ["email one", "email two"]);
    const notice = await writePdf("Notice of Filing.pdf", ["notice"]);
    const outputDir = path.join(dir, "packet");

    const result = await buildFilingPacket({
      sources: [
        { path: motion },
        { path: exhibit },
        { path: notice },
      ],
      outputDir,
      packId: "florida",
      checklist: {
        selectedStepIds: ["normalize-pages", "scrub-metadata", "split-by-size"],
        skippedStepIds: ["make-searchable"],
        splitSizeMb: 0.001,
      },
      createdAt: "2026-07-03T12:00:00.000Z",
      factsOptions: {
        textExtractor: {
          extractTextLayerCoverage,
          extractPageTextByPage,
        },
      },
    });

    expect(result.packageRoot).toBe(outputDir);
    expect(result.layoutMode).toBe("separate-files");
    expect(await exists(path.join(outputDir, "upload"))).toBe(true);
    expect(await exists(path.join(outputDir, "raio-manifest", "manifest.json"))).toBe(true);
    expect(await exists(path.join(outputDir, result.manifestPdf))).toBe(true);
    expect(result.files.map((file) => file.outputName)).toContain("01 - Motion to Compel - Part 1 of 3.pdf");
    expect(result.files.map((file) => file.outputName)).toContain("02 - Exhibit A - Email Chain - Part 1 of 2.pdf");
    expect(result.selectionChecks.map((check) => check.checkId)).toEqual([
      "envelope-size",
      "selection-filenames",
      "filename-collisions",
    ]);
    expect(result.manifest.rootDocuments.map((document) => document.name)).toContain("filing-packet-manifest.pdf");
    expect(result.manifest.machineReports.map((report) => report.name)).toContain("filing-packet.json");
    expect(result.manifest.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "filing-packet-split-size", valueMb: 0.001 }),
      expect.objectContaining({ type: "filing-checklist-step", stepId: "make-searchable" }),
    ]));

    const manifestText = await extractAllText(await fs.readFile(path.join(outputDir, result.manifestPdf)));
    expect(manifestText).toContain("Motion to Compel.pdf");
    expect(manifestText).toContain("01 - Motion to Compel - Part 1 of 3.pdf");
    expect(manifestText).not.toContain(dir);
  });

  it("builds combined-PDF mode as one upload file", async () => {
    const motion = await writePdf("Motion.pdf", ["Motion", "See Fla. R. Civ. P. 1.202."]);
    const exhibit = await writePdf("Exhibit B.pdf", ["exhibit"]);
    const outputDir = path.join(dir, "combined");

    const result = await buildFilingPacket({
      sources: [{ path: motion }, { path: exhibit }],
      outputDir,
      packId: "florida",
      layoutMode: "combined-pdf",
      prefixFilenames: false,
      checklist: {
        selectedStepIds: ["normalize-pages"],
      },
      factsOptions: {
        textExtractor: {
          extractTextLayerCoverage,
          extractPageTextByPage,
        },
      },
    });

    expect(result.combinedPdf).toBe("upload/filing-packet.pdf");
    expect(result.manifest.uploadFiles).toHaveLength(1);
    expect(result.manifest.uploadFiles[0]).toMatchObject({
      outputName: "filing-packet.pdf",
      relativePath: "upload/filing-packet.pdf",
      pages: 3,
    });
    expect(await exists(path.join(outputDir, "upload", "filing-packet.pdf"))).toBe(true);
  });

  it("reports aggregate output warnings against the original split part number", async () => {
    const motion = await writePdf("Motion to Compel.pdf", ["page one", "page two", "page three"]);
    const outputDir = path.join(dir, "packet-part-numbering");
    const coverageByPart: TextLayerCoverage[] = [
      { imageOnlyPages: [], mixedPages: [], textPages: [0], garbledPages: [] },
      { imageOnlyPages: [], mixedPages: [], textPages: [0], garbledPages: [] },
      { imageOnlyPages: [0], mixedPages: [], textPages: [], garbledPages: [] },
    ];
    const extractTextLayerCoverageForPart = vi.fn(async () => {
      const coverage = coverageByPart.shift();
      if (!coverage) {
        throw new Error("unexpected text-layer extraction call");
      }
      return coverage;
    });

    const result = await buildFilingPacket({
      sources: [{
        path: motion,
        facts: sourceFacts(3),
      }],
      outputDir,
      packId: "florida",
      checklist: {
        selectedStepIds: ["split-by-size"],
        splitSizeMb: 0.001,
      },
      factsOptions: {
        textExtractor: {
          extractTextLayerCoverage: extractTextLayerCoverageForPart,
        },
      },
    });

    const searchableText = result.documents[0]?.checks.find((check) => check.checkId === "searchable-text");

    expect(result.files.map((file) => file.outputName)).toContain("01 - Motion to Compel - Part 3 of 3.pdf");
    expect(searchableText).toMatchObject({
      status: "warn",
      detail: "Part 3: No searchable text was found in this document.",
    });
    expect(searchableText?.detail).not.toContain("Part 1: No searchable text was found in this document.");
    expect(extractTextLayerCoverageForPart).toHaveBeenCalledTimes(3);
  });

  it("runs make-searchable with force OCR for garbled text-layer coverage", async () => {
    const motion = await writePdf("Garbled Motion.pdf", ["abc"]);
    const outputDir = path.join(dir, "packet-force-ocr");
    const engine = new RecordingFilingEngine();

    await buildFilingPacket({
      sources: [{
        path: motion,
        facts: {
          ...sourceFacts(1),
          searchableText: false,
          textLayerCoverage: {
            imageOnlyPages: [],
            mixedPages: [],
            textPages: [0],
            garbledPages: [{
              pageIndex: 0,
              confidence: 0.9,
              reason: "combined",
              puaRatio: 0.2,
              replacementRatio: 0.1,
              alphaRatio: 0.02,
            }],
          },
        },
      }],
      outputDir,
      packId: "florida",
      checklist: {
        selectedStepIds: ["make-searchable"],
      },
    }, { local: engine, sidecar: engine });

    expect(engine.ocrTypes).toEqual(["force-ocr"]);
  });
});

class RecordingFilingEngine extends LocalPdfEngine {
  readonly ocrTypes: Array<"force-ocr" | "skip-text" | undefined> = [];

  async ocr(
    document: PdfDocumentHandle,
    options?: { languages?: readonly string[]; ocrType?: "force-ocr" | "skip-text" },
  ): Promise<PdfDocumentHandle> {
    this.ocrTypes.push(options?.ocrType);
    return this.scrubMetadata(document);
  }
}

function sourceFacts(pageCount: number): DocumentFacts {
  return {
    pages: Array.from({ length: pageCount }, (_value, pageIndex) => ({
      pageIndex,
      size: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
    })),
    fileBytes: 1,
    searchableText: true,
    pdfaCompliant: true,
    encryptionState: "none",
    activeContentSignals: { possiblyPresent: false, signals: [] },
    embeddedFileCount: 0,
    formFields: { count: 0, anyFilled: false },
    annotationCount: 0,
    signatureFieldCount: 0,
    possibleUnappliedRedactions: {
      redactAnnotationCount: 0,
      blackRectangleAnnotationCount: 0,
      possiblyPresent: false,
    },
    clerkStampSpaceBlank: true,
  };
}

async function writePdf(name: string, lines: readonly string[]): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const line of lines) {
    const page = pdf.addPage([612, 792]);
    page.drawText(line, { x: 72, y: 720, size: 12, font });
  }

  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
