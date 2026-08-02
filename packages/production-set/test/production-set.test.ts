import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PDFStream,
  StandardFonts,
} from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PdfDocumentHandle, PdfEngine } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { readPackageManifest } from "@raiopdf/package-writer";
import {
  buildProductionSet,
  MAX_COMBINED_PRODUCTION_SOURCES,
  ProductionContinuationError,
  readProductionContinuation,
} from "../src/index";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-production-set-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("buildProductionSet", () => {
  it("numbers continuously across files and zero-pads Bates ranges", async () => {
    const first = await makePdf("alpha.pdf", 2);
    const second = await makePdf("beta.pdf", 3);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "SMITH",
      start: 7,
      digits: 4,
      createdAt: "2026-07-03T12:00:00.000Z",
    });

    expect(result.files.map((file) => [file.batesStart, file.batesEnd])).toEqual([
      ["SMITH0007", "SMITH0008"],
      ["SMITH0009", "SMITH0011"],
    ]);
    expect(result.nextNumber).toBe(12);

    const firstOutput = await fs.readFile(path.join(outputDir, result.files[0]!.packageRelativePath));
    await expectPageContentToContainLabel(firstOutput, 0, "SMITH0007");
    await expectPageContentToContainLabel(firstOutput, 1, "SMITH0008");
  });

  it("validates the full Bates range before creating output", async () => {
    const first = await makePdf("first.pdf", 1);
    const second = await makePdf("second.pdf", 2);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "RANGE",
      start: 98,
      digits: 2,
    })).rejects.toThrow(/Bates numbers exceed/);

    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(dir)).resolves.toEqual(["first.pdf", "second.pdf"]);
  });

  it("stamps whole-document confidentiality designations", async () => {
    const source = await makePdf("secret.pdf", 2);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "C",
    });

    const output = await fs.readFile(path.join(outputDir, result.files[0]!.packageRelativePath));
    await expectPageContentToContainLabel(output, 0, "Confidential");
    await expectPageContentToContainLabel(output, 1, "Confidential");
  });

  it("writes index PDF and CSV without absolute source paths", async () => {
    const source = await makePdf("client notes.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "IDX",
      start: 42,
    });

    const csv = await fs.readFile(path.join(outputDir, result.indexCsv!), "utf8");
    const pdf = await fs.readFile(path.join(outputDir, result.indexPdf!));
    const pdfContent = await readAllDecodedPageContent(pdf);

    expect(csv).toContain("Bates Start,Bates End,Filename,Pages,Designation,SHA-256");
    expect(csv).toContain("IDX000042");
    expect(csv).toContain("client notes.pdf");
    expect(csv).not.toContain(dir);
    expect(pdfContent).toContain(encodeTextAsHex("Production Index"));
    expect(pdfContent).not.toContain(encodeTextAsHex(dir));
  });

  it("places upload files into volume folders when a cap is set", async () => {
    const first = await makePdf("one.pdf", 1);
    const second = await makePdf("two.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "VOL",
      volumeSizeMb: 0.0001,
    });

    expect(result.files.map((file) => file.volume)).toEqual(["VOL001", "VOL002"]);
    expect(result.files.map((file) => file.packageRelativePath)).toEqual([
      expect.stringMatching(/^upload\/VOL001\//),
      expect.stringMatching(/^upload\/VOL002\//),
    ]);
  });

  it("round-trips package manifest detail and keeps source paths out of production.json", async () => {
    const source = await makePdf("manifest-source.pdf", 1);
    const outputDir = path.join(dir, "package");

    await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "MAN",
    });

    const manifest = await readPackageManifest(outputDir);
    const productionReport = await fs.readFile(
      path.join(outputDir, "raio-manifest", "production.json"),
      "utf8",
    );

    expect(manifest.uploadFiles).toHaveLength(1);
    expect(manifest.details).toMatchObject({
      productionSources: [expect.objectContaining({ sourcePath: source })],
    });
    expect(productionReport).not.toContain(source);
    expect(await fs.access(path.join(outputDir, "raio-manifest", "checksums.txt"))).toBeUndefined();
  });

  it("can include an optional combined production PDF", async () => {
    const first = await makePdf("first.pdf", 2);
    const second = await makePdf("second.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "COMB",
      combinedPdf: true,
    });

    expect(result.combinedPdf).toMatch(/^upload\/COMB000001 - COMB000003 - combined-production\.pdf$/);
    const combined = await PDFDocument.load(await fs.readFile(path.join(outputDir, result.combinedPdf!)));
    expect(combined.getPageCount()).toBe(3);
  });

  it("includes combined production PDFs in volume summaries", async () => {
    const first = await makePdf("first.pdf", 1);
    const second = await makePdf("second.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "CVOL",
      combinedPdf: true,
      volumeSizeMb: 0.0001,
    });

    expect(result.combinedPdf).toMatch(/^upload\/VOL003\//);
    expect(result.volumes.map((volume) => volume.name)).toEqual(["VOL001", "VOL002", "VOL003"]);
    expect(result.volumes[2]!.files).toEqual(["CVOL000001 - CVOL000002 - combined-production.pdf"]);
    expect(result.volumes[2]!.oversizedFiles).toEqual([
      "CVOL000001 - CVOL000002 - combined-production.pdf",
    ]);

    const productionReport = JSON.parse(
      await fs.readFile(path.join(outputDir, "raio-manifest", "production.json"), "utf8"),
    ) as { volumes: Array<{ name: string; files: string[]; oversizedFiles: string[] }> };

    expect(productionReport.volumes.map((volume) => volume.name)).toEqual([
      "VOL001",
      "VOL002",
      "VOL003",
    ]);
    expect(productionReport.volumes[2]!.files).toEqual([
      "CVOL000001 - CVOL000002 - combined-production.pdf",
    ]);
  });

  it("holds a constant number of documents open across a large production", async () => {
    const fileCount = 300;
    const sources: Array<{ path: string; designation?: string }> = [];
    for (let index = 0; index < fileCount; index += 1) {
      sources.push({
        path: await makePdf(`doc-${String(index).padStart(3, "0")}.pdf`, 1),
        // Every third document takes the second stamping pass, which is the
        // branch that opens the most documents at once.
        ...(index % 3 === 0 ? { designation: "Confidential" } : {}),
      });
    }
    const outputDir = path.join(dir, "package");
    const engine = countingEngine();

    const result = await buildProductionSet({
      sources,
      outputDir,
      prefix: "BIG",
    }, engine.engine);

    expect(result.files).toHaveLength(fileCount);
    expect(result.files[0]!.batesStart).toBe("BIG000001");
    expect(result.files.at(-1)!.batesEnd).toBe(`BIG${String(fileCount).padStart(6, "0")}`);
    expect(result.nextNumber).toBe(fileCount + 1);
    // Bates numbers stay continuous and in picker order across the whole run.
    expect(result.files.map((file) => file.firstNumber)).toEqual(
      Array.from({ length: fileCount }, (_, index) => index + 1),
    );

    const last = result.files.at(-1)!;
    const lastOutput = await fs.readFile(path.join(outputDir, last.packageRelativePath));
    await expectPageContentToContainLabel(lastOutput, 0, last.batesStart);

    const manifest = await readPackageManifest(outputDir);
    expect(manifest.uploadFiles).toHaveLength(fileCount);

    // The whole point of the refactor: peak open documents does not grow with
    // the number of sources (open source + its stamped output is the maximum),
    // and nothing is left open at the end.
    expect(engine.peakOpen).toBeLessThanOrEqual(3);
    expect(engine.liveOpen).toBe(0);
  }, 120_000);

  it("closes every document a combined production opens", async () => {
    const sources = [
      { path: await makePdf("combined-one.pdf", 1) },
      { path: await makePdf("combined-two.pdf", 1) },
      { path: await makePdf("combined-three.pdf", 1) },
    ];
    const outputDir = path.join(dir, "package");
    const engine = countingEngine();

    const result = await buildProductionSet({
      sources,
      outputDir,
      prefix: "CMB",
      combinedPdf: true,
    }, engine.engine);

    expect(result.combinedPdf).not.toBeNull();
    expect(engine.liveOpen).toBe(0);
    // The combined path is the documented exception: `PdfEngine.merge` needs
    // every stamped document open at once, so peak scales with the file count.
    expect(engine.peakOpen).toBeGreaterThanOrEqual(sources.length);

    const manifest = await readPackageManifest(outputDir);
    expect(manifest.checks).toContainEqual(
      expect.objectContaining({ checkId: "production-combined-memory-bound", status: "pass" }),
    );
  });

  it("refuses a combined production PDF beyond the documented cap", async () => {
    const outputDir = path.join(dir, "package");
    const sources = Array.from(
      { length: MAX_COMBINED_PRODUCTION_SOURCES + 1 },
      (_, index) => ({ path: path.join(dir, `over-cap-${index}.pdf`) }),
    );

    await expect(buildProductionSet({
      sources,
      outputDir,
      prefix: "CAP",
      combinedPdf: true,
    })).rejects.toThrow(/combined production PDF is limited to 200 documents/);

    // The same set without the combined PDF is not capped, so nothing is
    // written and the user still has a way to produce it.
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to produce a source that changed between planning and output", async () => {
    const source = await makePdf("drifting.pdf", 1);
    const replacement = await makePdf("replacement.pdf", 2);
    const outputDir = path.join(dir, "package");
    const base = createLocalPdfEngine();
    let swapped = false;
    // Planning hashes the file and then counts its pages; swapping the file
    // during the count is the deterministic stand-in for a user editing it
    // while the production runs.
    const engine: PdfEngine = Object.assign(Object.create(base) as PdfEngine, {
      pageCount: async (document: PdfDocumentHandle) => {
        const pages = await base.pageCount(document);
        if (!swapped) {
          swapped = true;
          await fs.copyFile(replacement, source);
        }
        return pages;
      },
    });

    await expect(buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "DRIFT",
    }, engine)).rejects.toThrow(/changed on disk during the production build/);

    // The aborted session leaves no half-written package behind.
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("readProductionContinuation", () => {
  it("reads where the next production in the series should start", async () => {
    const source = await makePdf("first.pdf", 3);
    const outputDir = path.join(dir, "package");

    const built = await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "SMITH",
      start: 1,
      digits: 6,
      createdAt: "2026-07-14T10:00:00.000Z",
    });
    expect(built.continuation).toBeNull();

    const continuation = await readProductionContinuation(outputDir);
    expect(continuation).toEqual({
      prefix: "SMITH",
      digits: 6,
      nextNumber: 4,
      lastBates: "SMITH000003",
      createdAt: "2026-07-14T10:00:00.000Z",
      fileCount: 1,
    });
  });

  it("rejects a folder that isn't a RaioPDF production package", async () => {
    const notAPackage = path.join(dir, "not-a-package");
    await fs.mkdir(notAPackage, { recursive: true });

    await expect(readProductionContinuation(notAPackage)).rejects.toMatchObject({
      code: "not-a-production-package",
    });
    await expect(readProductionContinuation(notAPackage)).rejects.toBeInstanceOf(ProductionContinuationError);
  });

  it("rejects a package whose Bates report was edited after it was produced", async () => {
    const source = await makePdf("tamper.pdf", 1);
    const outputDir = path.join(dir, "package");

    await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "TAMP",
    });

    const reportPath = path.join(outputDir, "raio-manifest", "production.json");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as { nextNumber: number };
    report.nextNumber = 999;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

    await expect(readProductionContinuation(outputDir)).rejects.toMatchObject({ code: "tampered" });
  });

  it("rejects overlapping Bates ranges as inconsistent", async () => {
    const source = await makePdf("overlap.pdf", 1);
    const outputDir = path.join(dir, "package");

    await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "OVLP",
      digits: 6,
    });

    // Rewrite production.json (still hash-matched below) with a second file
    // row whose range overlaps the first, then re-point manifest.json's
    // machine-report hash at the edited bytes so only the numbering
    // invariant -- not the hash check -- is under test here.
    const reportPath = path.join(outputDir, "raio-manifest", "production.json");
    const parsed = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
      lastNumber: number;
      nextNumber: number;
      files: Array<{ batesStart: string; batesEnd: string }>;
    };
    parsed.files.push({ batesStart: "OVLP000001", batesEnd: "OVLP000001" });
    parsed.lastNumber = 1;
    parsed.nextNumber = 2;
    await rewriteReportAndManifestHash(outputDir, parsed);

    await expect(readProductionContinuation(outputDir)).rejects.toMatchObject({ code: "inconsistent" });
  });

  it("rejects a lastNumber/nextNumber mismatch as inconsistent", async () => {
    const source = await makePdf("mismatch.pdf", 1);
    const outputDir = path.join(dir, "package");

    await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "MISM",
    });

    const reportPath = path.join(outputDir, "raio-manifest", "production.json");
    const parsed = JSON.parse(await fs.readFile(reportPath, "utf8")) as { nextNumber: number };
    parsed.nextNumber = parsed.nextNumber + 5;
    await rewriteReportAndManifestHash(outputDir, parsed);

    await expect(readProductionContinuation(outputDir)).rejects.toMatchObject({ code: "inconsistent" });
  });
});

describe("buildProductionSet Bates continuation", () => {
  it("continues numbering from a prior production in strict mode", async () => {
    const first = await makePdf("a.pdf", 2);
    const priorDir = path.join(dir, "prior");
    const prior = await buildProductionSet({
      sources: [{ path: first }],
      outputDir: priorDir,
      prefix: "SMITH",
      start: 1,
      digits: 6,
    });
    expect(prior.nextNumber).toBe(3);

    const second = await makePdf("b.pdf", 1);
    const nextDir = path.join(dir, "next");
    const result = await buildProductionSet({
      sources: [{ path: second }],
      outputDir: nextDir,
      prefix: "SMITH",
      start: prior.nextNumber,
      digits: 6,
      continueFrom: priorDir,
    });

    expect(result.firstNumber).toBe(3);
    expect(result.files[0]!.batesStart).toBe("SMITH000003");
    expect(result.continuation).toEqual({ mode: "strict", priorLastBates: "SMITH000002" });

    const manifest = await readPackageManifest(nextDir);
    expect(manifest.checks).toContainEqual(
      expect.objectContaining({
        checkId: "bates-continuation",
        status: "pass",
        detail: expect.objectContaining({ mode: "strict", priorLastBates: "SMITH000002" }),
      }),
    );
    expect(manifest.details.productionContinuationSource).toMatchObject({
      priorPackageRoot: path.resolve(priorDir),
      mode: "strict",
    });
  });

  it("rejects a case-drifted prefix even in strict mode", async () => {
    const first = await makePdf("a.pdf", 1);
    const priorDir = path.join(dir, "prior");
    await buildProductionSet({ sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH" });

    const second = await makePdf("b.pdf", 1);
    await expect(buildProductionSet({
      sources: [{ path: second }],
      outputDir: path.join(dir, "next"),
      prefix: "smith",
      start: 2,
      continueFrom: priorDir,
    })).rejects.toThrow(/prefix mismatch/i);
  });

  it("rejects a digit-width mismatch without an override", async () => {
    const first = await makePdf("a.pdf", 1);
    const priorDir = path.join(dir, "prior");
    await buildProductionSet({ sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH", digits: 6 });

    const second = await makePdf("b.pdf", 1);
    await expect(buildProductionSet({
      sources: [{ path: second }],
      outputDir: path.join(dir, "next"),
      prefix: "SMITH",
      start: 2,
      digits: 4,
      continueFrom: priorDir,
    })).rejects.toThrow(/digit-width mismatch/i);
  });

  it("rejects a start mismatch without an override", async () => {
    const first = await makePdf("a.pdf", 1);
    const priorDir = path.join(dir, "prior");
    await buildProductionSet({ sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH" });

    const second = await makePdf("b.pdf", 1);
    await expect(buildProductionSet({
      sources: [{ path: second }],
      outputDir: path.join(dir, "next"),
      prefix: "SMITH",
      start: 1,
      continueFrom: priorDir,
    })).rejects.toThrow(/start mismatch/i);
  });

  it("allows a gap-start override with a reason and records it", async () => {
    const first = await makePdf("a.pdf", 1);
    const priorDir = path.join(dir, "prior");
    await buildProductionSet({ sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH" });

    const second = await makePdf("b.pdf", 1);
    const nextDir = path.join(dir, "next");
    const result = await buildProductionSet({
      sources: [{ path: second }],
      outputDir: nextDir,
      prefix: "SMITH",
      start: 500,
      digits: 6,
      continueFrom: priorDir,
      continuationOverride: { reason: "Reserving 000002-000499 for a supplemental production." },
    });

    expect(result.firstNumber).toBe(500);
    expect(result.continuation).toEqual({ mode: "override", priorLastBates: "SMITH000001" });

    const manifest = await readPackageManifest(nextDir);
    expect(manifest.overrides).toContainEqual(
      expect.objectContaining({
        type: "production-bates-continuation",
        reason: "Reserving 000002-000499 for a supplemental production.",
      }),
    );
  });

  it("requires a reason to use continuationOverride", async () => {
    const first = await makePdf("a.pdf", 1);
    const priorDir = path.join(dir, "prior");
    await buildProductionSet({ sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH" });

    const second = await makePdf("b.pdf", 1);
    await expect(buildProductionSet({
      sources: [{ path: second }],
      outputDir: path.join(dir, "next"),
      prefix: "SMITH",
      start: 500,
      continueFrom: priorDir,
      continuationOverride: { reason: "   " },
    })).rejects.toThrow(/reason is required/i);
  });

  it("rejects a tampered prior production before writing anything", async () => {
    const first = await makePdf("a.pdf", 1);
    const priorDir = path.join(dir, "prior");
    await buildProductionSet({ sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH" });

    const reportPath = path.join(priorDir, "raio-manifest", "production.json");
    const parsed = JSON.parse(await fs.readFile(reportPath, "utf8")) as { nextNumber: number };
    parsed.nextNumber = 999;
    await fs.writeFile(reportPath, JSON.stringify(parsed, null, 2));

    const second = await makePdf("b.pdf", 1);
    const nextDir = path.join(dir, "next");
    await expect(buildProductionSet({
      sources: [{ path: second }],
      outputDir: nextDir,
      prefix: "SMITH",
      start: 2,
      continueFrom: priorDir,
    })).rejects.toMatchObject({ code: "tampered" });

    await expect(fs.readdir(nextDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * Counting wrapper around the local engine. The engine interface exposes no
 * handle census, so the test observes open/close directly for every call that
 * mints or releases a document.
 */
function countingEngine(): { engine: PdfEngine; liveOpen: number; peakOpen: number } {
  const base = createLocalPdfEngine();
  const state = { engine: undefined as unknown as PdfEngine, liveOpen: 0, peakOpen: 0 };

  const opened = <T extends PdfDocumentHandle>(handle: T): T => {
    state.liveOpen += 1;
    state.peakOpen = Math.max(state.peakOpen, state.liveOpen);
    return handle;
  };

  state.engine = Object.assign(Object.create(base) as PdfEngine, {
    open: async (bytes: Parameters<PdfEngine["open"]>[0]) => opened(await base.open(bytes)),
    batesStamp: async (...args: Parameters<PdfEngine["batesStamp"]>) =>
      opened(await base.batesStamp(...args)),
    stampText: async (...args: Parameters<PdfEngine["stampText"]>) =>
      opened(await base.stampText(...args)),
    merge: async (...args: Parameters<PdfEngine["merge"]>) => {
      const result = await base.merge(...args);
      opened(result.document);
      return result;
    },
    close: async (document: PdfDocumentHandle) => {
      state.liveOpen -= 1;
      await base.close(document);
    },
  });

  return state;
}

/**
 * Rewrites `raio-manifest/production.json` with `content` and re-points
 * `manifest.json`'s machine-report hash for it at the new bytes -- isolates a
 * test to the SEMANTIC (numbering) check by keeping the hash check passing.
 */
async function rewriteReportAndManifestHash(outputDir: string, content: unknown): Promise<void> {
  const reportPath = path.join(outputDir, "raio-manifest", "production.json");
  const manifestPath = path.join(outputDir, "raio-manifest", "manifest.json");
  const bytes = `${JSON.stringify(content, null, 2)}\n`;
  await fs.writeFile(reportPath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    machineReports: Array<{ name: string; sha256: string }>;
  };
  const entry = manifest.machineReports.find((report) => report.name === "production.json");
  if (!entry) {
    throw new Error("test setup: production.json machine report entry not found");
  }
  entry.sha256 = sha256;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function makePdf(name: string, pages: number): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([240, 240]);
    page.drawText(`Source ${name} page ${index + 1}`, { x: 12, y: 120, size: 10, font });
  }
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

async function expectPageContentToContainLabel(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<void> {
  expect(await readDecodedPageContent(bytes, pageIndex)).toContain(encodeTextAsHex(label));
}

async function readAllDecodedPageContent(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages();
  const chunks = await Promise.all(pages.map((_, index) => readDecodedPageContent(bytes, index)));

  return chunks.join("\n");
}

async function readDecodedPageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPage(pageIndex).node.Contents();
  const contentObjects = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

  return contentObjects
    .map((object) => (object instanceof PDFStream ? object : pdf.context.lookup(object)))
    .filter((object): object is PDFStream => object instanceof PDFStream)
    .map((stream) => decodePdfStream(stream))
    .join("\n");
}

function decodePdfStream(stream: PDFStream): string {
  if (stream instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }

  return new TextDecoder().decode(stream.getContents());
}

function encodeTextAsHex(text: string): string {
  return `<${[...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("")}>`;
}
