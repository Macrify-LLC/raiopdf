import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodePDFRawStream,
  degrees,
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

    expect(csv).toContain("Bates Start,Bates End,Filename,Pages,Designation,Designation Pages,SHA-256");
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

describe("buildProductionSet stamp placement", () => {
  it("uses the default placements (Bates footer/right, designation header/center) when unset", async () => {
    const source = await makePdf("plain.pdf", 1, [300, 500]);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "DEF",
    });

    const output = await fs.readFile(path.join(outputDir, result.files[0]!.packageRelativePath));
    const [batesMatrix] = await readPageTextMatrices(output, 0, "DEF000001");
    const [designationMatrix] = await readPageTextMatrices(output, 0, "Confidential");

    expect(batesMatrix).toBeDefined();
    expect(designationMatrix).toBeDefined();
    // Footer sits near the bottom of the page (small y); header near the top.
    expect(batesMatrix!.f).toBeLessThan(60);
    expect(designationMatrix!.f).toBeGreaterThan(400);
    // Right-aligned Bates should sit further right than the centered designation.
    expect(batesMatrix!.e).toBeGreaterThan(designationMatrix!.e);
  });

  it("honors custom placements for both Bates numbers and the designation", async () => {
    const source = await makePdf("custom.pdf", 1, [300, 500]);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "AEO" }],
      outputDir,
      prefix: "CUS",
      batesPlacement: { edge: "header", align: "left" },
      designationPlacement: { edge: "footer", align: "right" },
    });

    const output = await fs.readFile(path.join(outputDir, result.files[0]!.packageRelativePath));
    const [batesMatrix] = await readPageTextMatrices(output, 0, "CUS000001");
    const [designationMatrix] = await readPageTextMatrices(output, 0, "AEO");

    expect(batesMatrix).toBeDefined();
    expect(designationMatrix).toBeDefined();
    // Placements were swapped relative to the defaults: Bates is now in the
    // header (large y) and left-aligned (small x); designation is now in
    // the footer (small y) and right-aligned (large x).
    expect(batesMatrix!.f).toBeGreaterThan(400);
    expect(designationMatrix!.f).toBeLessThan(60);
    expect(batesMatrix!.e).toBeLessThan(designationMatrix!.e);
  });

  it("applies a custom shared stamp font size to both stamps", async () => {
    const source = await makePdf("sized.pdf", 1, [300, 500]);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "SIZE",
      stampFontSizePt: 14,
    });

    const output = await fs.readFile(path.join(outputDir, result.files[0]!.packageRelativePath));
    expect(await readPageTextFontSizes(output, 0, "SIZE000001")).toEqual([14]);
    expect(await readPageTextFontSizes(output, 0, "Confidential")).toEqual([14]);
  });

  it("rejects a stamp font size below the 6pt minimum", async () => {
    const source = await makePdf("toosmall.pdf", 1);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "TINY",
      stampFontSizePt: 5,
    })).rejects.toThrow(/between 6 and 24/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stamp font size above the 24pt maximum", async () => {
    const source = await makePdf("toobig.pdf", 1);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "HUGE",
      stampFontSizePt: 25,
    })).rejects.toThrow(/between 6 and 24/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects Bates and designation placements that share a page edge, before writing anything", async () => {
    const source = await makePdf("collide.pdf", 1);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "COL",
      batesPlacement: { edge: "footer", align: "left" },
      designationPlacement: { edge: "footer", align: "right" },
    })).rejects.toThrow(/can't both be placed in the footer/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects same-edge placements even when the designation is disabled by default placement equality", async () => {
    const source = await makePdf("collide-header.pdf", 1);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "COL2",
      batesPlacement: { edge: "header", align: "center" },
      designationPlacement: { edge: "header", align: "center" },
    })).rejects.toThrow(/can't both be placed in the header/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stamp that would shrink below the 6pt minimum on the narrowest page", async () => {
    // A 40pt-wide page leaves only 40 - 2*36 = -32pt of margin-adjusted room
    // at the default 0.5in margin -- nothing fits, let alone a 24pt stamp.
    const source = await makePdf("narrow.pdf", 1, [40, 200]);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "NARROW",
      stampFontSizePt: 24,
    })).rejects.toThrow(/would shrink to .*below the 6pt minimum/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the offending text and page number in the minimum-size error", async () => {
    const wide = await makePdf("wide.pdf", 1, [600, 600]);
    const narrow = await makePdf("narrow2.pdf", 1, [50, 200]);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: wide }, { path: narrow }],
      outputDir,
      prefix: "MIX",
      stampFontSizePt: 20,
    })).rejects.toThrow(/page 1 of "narrow2\.pdf"/);
  });

  it("accounts for page rotation when checking the minimum rendered size", async () => {
    // Unrotated this page is narrow (60pt) and would fail; rotated 90
    // degrees its VISUAL width becomes its unrotated height (400pt), which
    // comfortably fits. The check must use the rotated (visual) width, not
    // the raw page-dictionary width, mirroring engine-local's own
    // rotation-aware stamping (see local-engine.test.ts "stamps rotated
    // pages against the visual page edge").
    const source = await makeRotatedPdf("rotated.pdf", [60, 400], 90);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "ROT",
      stampFontSizePt: 14,
    });

    expect(result.files).toHaveLength(1);
  });

  it("still rejects a rotated page whose VISUAL width is the narrow dimension", async () => {
    // Same page, but rotated 0 degrees so the visual width IS the narrow
    // 60pt dimension -- this must fail even though the raw page height is
    // generously large.
    const source = await makeRotatedPdf("rotated-fail.pdf", [60, 400], 0);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "ROTFAIL",
      stampFontSizePt: 14,
    })).rejects.toThrow(/would shrink to/);
  });
});

describe("buildProductionSet page-range designations", () => {
  it("stamps the designation only on the listed pages, and Bates on every page", async () => {
    const source = await makePdf("ranged.pdf", 5, [300, 500]);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential", designationPages: "1-2,5" }],
      outputDir,
      prefix: "RNG",
    });

    const output = await fs.readFile(path.join(outputDir, result.files[0]!.packageRelativePath));
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      await expectPageContentToContainLabel(output, pageIndex, formatBatesLabel("RNG", pageIndex + 1, 6));
    }
    await expectPageContentToContainLabel(output, 0, "Confidential");
    await expectPageContentToContainLabel(output, 1, "Confidential");
    await expectPageContentNotToContainLabel(output, 2, "Confidential");
    await expectPageContentNotToContainLabel(output, 3, "Confidential");
    await expectPageContentToContainLabel(output, 4, "Confidential");

    expect(result.files[0]!.designationPages).toBe("1-2,5");
  });

  it("treats an undefined or blank designationPages as every page (default, unchanged)", async () => {
    const source = await makePdf("full.pdf", 3);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential" }],
      outputDir,
      prefix: "FULL",
    });

    const output = await fs.readFile(path.join(outputDir, result.files[0]!.packageRelativePath));
    await expectPageContentToContainLabel(output, 0, "Confidential");
    await expectPageContentToContainLabel(output, 1, "Confidential");
    await expectPageContentToContainLabel(output, 2, "Confidential");
    expect(result.files[0]!.designationPages).toBeNull();
  });

  it("does not record designationPages when an explicit spec happens to cover every page", async () => {
    const source = await makePdf("explicit-all.pdf", 2);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential", designationPages: "1-2" }],
      outputDir,
      prefix: "EXPALL",
    });

    expect(result.files[0]!.designationPages).toBeNull();
  });

  it("records designationPages in production.json and the index CSV", async () => {
    const source = await makePdf("recorded.pdf", 4);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential", designationPages: "2-3" }],
      outputDir,
      prefix: "REC",
    });

    const report = JSON.parse(
      await fs.readFile(path.join(outputDir, "raio-manifest", "production.json"), "utf8"),
    ) as { files: Array<{ designationPages: string | null }> };
    expect(report.files[0]!.designationPages).toBe("2-3");

    const csv = await fs.readFile(path.join(outputDir, result.indexCsv!), "utf8");
    expect(csv).toContain("2-3");
  });

  it("rejects an out-of-bounds page range before writing anything", async () => {
    const source = await makePdf("oob.pdf", 3);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source, designation: "Confidential", designationPages: "1-9" }],
      outputDir,
      prefix: "OOB",
    })).rejects.toThrow(/out of range/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects garbage page-range syntax before writing anything, naming the source file", async () => {
    const source = await makePdf("weird-name.pdf", 3);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source, designation: "Confidential", designationPages: "abc" }],
      outputDir,
      prefix: "GARB",
    })).rejects.toThrow(/"weird-name\.pdf".*isn't a page number or range/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a reversed page range before writing anything", async () => {
    const source = await makePdf("reversed.pdf", 5);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source, designation: "Confidential", designationPages: "4-2" }],
      outputDir,
      prefix: "REV",
    })).rejects.toThrow(/ends before it starts/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a page range set without a designation", async () => {
    const source = await makePdf("nodesig.pdf", 3);
    const outputDir = path.join(dir, "package");

    await expect(buildProductionSet({
      sources: [{ path: source, designationPages: "1-2" }],
      outputDir,
      prefix: "NODESIG",
    })).rejects.toThrow(/no confidentiality designation was chosen/);
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tolerates and normalizes overlapping/duplicate range entries", async () => {
    const source = await makePdf("overlap.pdf", 6);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source, designation: "Confidential", designationPages: "3,1-3,2-4" }],
      outputDir,
      prefix: "OVR",
    });

    expect(result.files[0]!.designationPages).toBe("1-4");
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

describe("buildProductionSet duplicate detection", () => {
  it("produces every occurrence of byte-identical sources with its own Bates range in produce-all mode (default)", async () => {
    const first = await makePdf("dup-a.pdf", 2);
    const second = await copyAs(first, "dup-b.pdf");
    const other = await makePdf("other.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }, { path: other }],
      outputDir,
      prefix: "DUP",
    });

    expect(result.files.map((file) => [file.sourceFilename, file.batesStart, file.batesEnd])).toEqual([
      ["dup-a.pdf", "DUP000001", "DUP000002"],
      ["dup-b.pdf", "DUP000003", "DUP000004"],
      ["other.pdf", "DUP000005", "DUP000005"],
    ]);
    expect(result.duplicateCount).toBe(1);
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0]!.occurrences).toEqual([
      { sourceFilename: "dup-a.pdf", sourceOrdinal: 1, action: "produced", batesRange: "DUP000001-DUP000002" },
      { sourceFilename: "dup-b.pdf", sourceOrdinal: 2, action: "produced", batesRange: "DUP000003-DUP000004" },
    ]);
    expect(result.duplicateGroups[0]!.canonicalOccurrenceOrdinal).toBe(1);

    const manifest = await readPackageManifest(outputDir);
    expect(manifest.checks).toContainEqual(
      expect.objectContaining({
        checkId: "duplicate-sources",
        status: "pass",
        detail: "2 duplicate sources in 1 group; produced all",
      }),
    );
    expect(manifest.details.productionDuplicates).toMatchObject({
      duplicateHandling: "produce-all",
      duplicateCount: 1,
    });
  });

  it("omits later duplicate occurrences and keeps Bates numbering contiguous in produce-once mode", async () => {
    const first = await makePdf("dup-a.pdf", 2);
    const second = await copyAs(first, "dup-b.pdf");
    const following = await makePdf("following.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }, { path: following }],
      outputDir,
      prefix: "ONCE",
      duplicateHandling: "produce-once",
    });

    // The omitted occurrence consumes NO Bates number, so the following
    // file's range starts right after the produced duplicate's -- proof
    // that numbering stayed contiguous rather than leaving a gap.
    expect(result.files.map((file) => [file.sourceFilename, file.batesStart, file.batesEnd])).toEqual([
      ["dup-a.pdf", "ONCE000001", "ONCE000002"],
      ["following.pdf", "ONCE000003", "ONCE000003"],
    ]);
    expect(result.nextNumber).toBe(4);
    expect(result.duplicateCount).toBe(1);
    expect(result.duplicateGroups[0]!.occurrences).toEqual([
      { sourceFilename: "dup-a.pdf", sourceOrdinal: 1, action: "produced", batesRange: "ONCE000001-ONCE000002" },
      { sourceFilename: "dup-b.pdf", sourceOrdinal: 2, action: "omitted", batesRange: null },
    ]);

    // The omitted occurrence never reaches upload/ or the index -- the
    // cross-reference lives only in manifest/audit detail.
    expect(result.files.map((file) => file.sourceFilename)).not.toContain("dup-b.pdf");
    const csv = await fs.readFile(path.join(outputDir, result.indexCsv!), "utf8");
    expect(csv).not.toContain("dup-b.pdf");
    expect(csv).not.toMatch(/duplicate/i);

    const manifest = await readPackageManifest(outputDir);
    expect(manifest.uploadFiles).toHaveLength(2);
    expect(manifest.checks).toContainEqual(
      expect.objectContaining({
        checkId: "duplicate-sources",
        status: "pass",
        detail: "2 duplicate sources in 1 group; produced once, 1 omitted",
      }),
    );
    expect(manifest.details.productionDuplicates).toMatchObject({
      duplicateHandling: "produce-once",
      duplicateCount: 1,
      groups: [
        expect.objectContaining({
          occurrences: [
            expect.objectContaining({ sourceFilename: "dup-a.pdf", action: "produced" }),
            expect.objectContaining({ sourceFilename: "dup-b.pdf", action: "omitted", batesRange: null }),
          ],
        }),
      ],
    });
  });

  it("does not group near-miss sources that differ by even a little content", async () => {
    // makePdf bakes the filename into the page content, so two different
    // names are never byte-identical -- this is the near-miss case: close,
    // but not the same hash.
    const first = await makePdf("near-a.pdf", 1);
    const second = await makePdf("near-b.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "NEAR",
      duplicateHandling: "produce-once",
    });

    expect(result.duplicateGroups).toEqual([]);
    expect(result.duplicateCount).toBe(0);
    expect(result.files).toHaveLength(2);

    const manifest = await readPackageManifest(outputDir);
    expect(manifest.checks).toContainEqual(
      expect.objectContaining({
        checkId: "duplicate-sources",
        status: "pass",
        detail: "No duplicate sources detected.",
      }),
    );
  });

  it("records the check even when no duplicates were found, in produce-all mode too", async () => {
    const source = await makePdf("solo.pdf", 1);
    const outputDir = path.join(dir, "package");

    await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "SOLO",
    });

    const manifest = await readPackageManifest(outputDir);
    expect(manifest.checks).toContainEqual(
      expect.objectContaining({ checkId: "duplicate-sources", detail: "No duplicate sources detected." }),
    );
    expect(manifest.details.productionDuplicates).toBeUndefined();
  });

  it("excludes an omitted duplicate from the combined production PDF", async () => {
    const first = await makePdf("dup-a.pdf", 1);
    const second = await copyAs(first, "dup-b.pdf");
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "COMBDUP",
      duplicateHandling: "produce-once",
      combinedPdf: true,
    });

    expect(result.files).toHaveLength(1);
    const combined = await PDFDocument.load(await fs.readFile(path.join(outputDir, result.combinedPdf!)));
    expect(combined.getPageCount()).toBe(1);
  });

  it("includes every occurrence in the combined production PDF in produce-all mode", async () => {
    const first = await makePdf("dup-a.pdf", 1);
    const second = await copyAs(first, "dup-b.pdf");
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "COMBALL",
      combinedPdf: true,
    });

    expect(result.files).toHaveLength(2);
    const combined = await PDFDocument.load(await fs.readFile(path.join(outputDir, result.combinedPdf!)));
    expect(combined.getPageCount()).toBe(2);
  });

  it("excludes an omitted duplicate from volume assignment, keeping later files' volumes correct", async () => {
    const first = await makePdf("dup-a.pdf", 1);
    const second = await copyAs(first, "dup-b.pdf");
    const third = await makePdf("third.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }, { path: third }],
      outputDir,
      prefix: "VOLDUP",
      duplicateHandling: "produce-once",
      volumeSizeMb: 0.0001,
    });

    expect(result.files.map((file) => file.sourceFilename)).toEqual(["dup-a.pdf", "third.pdf"]);
    expect(result.files.map((file) => file.volume)).toEqual(["VOL001", "VOL002"]);
  });

  it("rejects an invalid duplicateHandling value", async () => {
    const source = await makePdf("bad.pdf", 1);
    const outputDir = path.join(dir, "package");
    const invalidInput = {
      sources: [{ path: source }],
      outputDir,
      prefix: "BAD",
      duplicateHandling: "nonsense",
    } as unknown as Parameters<typeof buildProductionSet>[0];

    await expect(buildProductionSet(invalidInput)).rejects.toThrow(
      /must be "produce-all" or "produce-once"/,
    );
    await expect(fs.readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("buildProductionSet load file (DAT)", () => {
  it("keeps the physical filename and the DAT LINK byte-identical for DAT-hostile names", async () => {
    // þ and ® are structural/substituted bytes in the DAT: they must be
    // normalized out of the produced filename itself so the LINK always
    // points at a file that exists.
    const source = await makePdf("thorn þ and ® name.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "SMIþTH",
      includeLoadFiles: true,
    });

    expect(result.loadFileDat).toBe("production.dat");
    const rows = parseDatRows(await fs.readFile(path.join(outputDir, "production.dat")));
    const link = rows[0]!.LINK.replaceAll("\\", "/");

    // The LINK resolves to a real produced file, byte-for-byte.
    await expect(fs.access(path.join(outputDir, link))).resolves.toBeUndefined();
    expect(link.includes("þ")).toBe(false);
    expect(link.includes("®")).toBe(false);
  });

  it("writes no production.dat and reports loadFileDat: null when includeLoadFiles is unset (default false)", async () => {
    const source = await makePdf("no-dat.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "NODAT",
    });

    expect(result.loadFileDat).toBeNull();
    await expect(fs.access(path.join(outputDir, "production.dat"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes production.dat at the package root (not under upload/) with correct rows and backslash LINK paths", async () => {
    const first = await makePdf("alpha.pdf", 2);
    const second = await makePdf("beta.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [
        { path: first, designation: "Confidential" },
        { path: second },
      ],
      outputDir,
      prefix: "DAT",
      includeLoadFiles: true,
    });

    expect(result.loadFileDat).toBe("production.dat");
    // Root document, sibling of upload/ and raio-manifest/ -- never inside upload/.
    const datBytes = await fs.readFile(path.join(outputDir, "production.dat"));
    expect([...datBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const rows = parseDatRows(datBytes);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      BEGBATES: "DAT000001",
      ENDBATES: "DAT000002",
      BEGATTACH: "",
      ENDATTACH: "",
      PAGECOUNT: "2",
      CONFIDENTIALITY: "Confidential",
      CUSTODIAN: "",
      FILENAME: result.files[0]!.outputName,
      SHA256: result.files[0]!.sha256,
    });
    expect(rows[0]!.LINK).toBe(`upload\\${result.files[0]!.outputName}`);
    expect(rows[0]!.LINK).not.toContain("/");
    expect(rows[1]).toMatchObject({
      BEGBATES: "DAT000003",
      ENDBATES: "DAT000003",
      CONFIDENTIALITY: "",
    });

    // Never appended -- the raw designation only, per the module docstring.
    expect(rows[0]!.CONFIDENTIALITY).not.toContain("pages");
  });

  it("resolves LINK backslash-separated across volume splits and plain (non-volume) runs alike", async () => {
    const first = await makePdf("one.pdf", 1);
    const second = await makePdf("two.pdf", 1);
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "DATVOL",
      includeLoadFiles: true,
      volumeSizeMb: 0.0001,
    });

    expect(result.files.map((file) => file.volume)).toEqual(["VOL001", "VOL002"]);
    const datBytes = await fs.readFile(path.join(outputDir, "production.dat"));
    const rows = parseDatRows(datBytes);
    expect(rows[0]!.LINK).toBe(`upload\\VOL001\\${result.files[0]!.outputName}`);
    expect(rows[1]!.LINK).toBe(`upload\\VOL002\\${result.files[1]!.outputName}`);
    for (const row of rows) {
      expect(row.LINK).not.toContain("/");
    }
  });

  it("blanks the FILENAME column (header stays) when includeFilenameInIndex is false", async () => {
    const source = await makePdf("secret-name.pdf", 1);
    const outputDir = path.join(dir, "package");

    await buildProductionSet({
      sources: [{ path: source }],
      outputDir,
      prefix: "NOFN",
      includeLoadFiles: true,
      includeFilenameInIndex: false,
    });

    const datBytes = await fs.readFile(path.join(outputDir, "production.dat"));
    const text = new TextDecoder().decode(datBytes.subarray(3));
    expect(text).toMatch(/þFILENAMEþ/);
    const rows = parseDatRows(datBytes);
    // The FILENAME field itself is blank -- LINK still names the produced
    // file (the physical path is inherently named that way, same as the
    // production index's own includeFilenameInIndex option leaves LINK-
    // equivalent paths alone) -- so this asserts the FILENAME field, not
    // "the filename never appears anywhere in the DAT."
    expect(rows[0]!.FILENAME).toBe("");
    expect(rows[0]!.LINK).toContain("secret-name.pdf");
  });

  it("threads per-source custodian into CUSTODIAN, blank when unset", async () => {
    const withCustodian = await makePdf("custodied.pdf", 1);
    const withoutCustodian = await makePdf("uncustodied.pdf", 1);
    const outputDir = path.join(dir, "package");

    await buildProductionSet({
      sources: [
        { path: withCustodian, custodian: "J. Smith" },
        { path: withoutCustodian },
      ],
      outputDir,
      prefix: "CUST",
      includeLoadFiles: true,
    });

    const datBytes = await fs.readFile(path.join(outputDir, "production.dat"));
    const rows = parseDatRows(datBytes);
    expect(rows[0]!.CUSTODIAN).toBe("J. Smith");
    expect(rows[1]!.CUSTODIAN).toBe("");
  });

  it("omits a produce-once-omitted duplicate's row and any combined production PDF from production.dat", async () => {
    const first = await makePdf("dup-a.pdf", 1);
    const second = await copyAs(first, "dup-b.pdf");
    const outputDir = path.join(dir, "package");

    const result = await buildProductionSet({
      sources: [{ path: first }, { path: second }],
      outputDir,
      prefix: "DATDUP",
      includeLoadFiles: true,
      duplicateHandling: "produce-once",
      combinedPdf: true,
    });

    expect(result.files).toHaveLength(1);
    const datBytes = await fs.readFile(path.join(outputDir, "production.dat"));
    const rows = parseDatRows(datBytes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.FILENAME).toBe(result.files[0]!.outputName);
    const text = new TextDecoder().decode(datBytes.subarray(3));
    expect(text).not.toContain("dup-b.pdf");
    expect(text).not.toContain("combined-production");
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

/** Writes a byte-identical copy of an existing file under a new name in the
 * same temp dir -- the duplicate-detection tests' way of producing two
 * sources that hash identical without hand-building matching PDF bytes. */
async function copyAs(sourcePath: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.copyFile(sourcePath, filePath);
  return filePath;
}

const DAT_ROW_FIELD_DELIMITER = String.fromCharCode(0x14);
const DAT_ROW_TEXT_QUALIFIER = "þ";
const DAT_ROW_FIELD_NAMES = [
  "BEGBATES",
  "ENDBATES",
  "BEGATTACH",
  "ENDATTACH",
  "PAGECOUNT",
  "CONFIDENTIALITY",
  "CUSTODIAN",
  "FILENAME",
  "LINK",
  "SHA256",
] as const;

/** Naive test-side DAT parser -- splits on the bare `0x14` delimiter (as a
 * real importer's first pass would) and strips the `þ` qualifier off each
 * field. Deliberately independent of `formatProductionDat`'s own
 * implementation so these integration tests can't pass by construction. */
function parseDatRows(bytes: Uint8Array): Record<(typeof DAT_ROW_FIELD_NAMES)[number], string>[] {
  const text = new TextDecoder().decode(bytes.subarray(3)); // strip the UTF-8 BOM
  const lines = text.split("\r\n").filter((line) => line.length > 0);
  const [, ...dataLines] = lines;
  return dataLines.map((line) => {
    const fields = line.split(DAT_ROW_FIELD_DELIMITER).map((field) => (
      field.startsWith(DAT_ROW_TEXT_QUALIFIER) && field.endsWith(DAT_ROW_TEXT_QUALIFIER)
        ? field.slice(DAT_ROW_TEXT_QUALIFIER.length, field.length - DAT_ROW_TEXT_QUALIFIER.length)
        : field
    ));
    const row = {} as Record<(typeof DAT_ROW_FIELD_NAMES)[number], string>;
    DAT_ROW_FIELD_NAMES.forEach((name, index) => {
      row[name] = fields[index] ?? "";
    });
    return row;
  });
}

async function makePdf(
  name: string,
  pages: number,
  size: readonly [number, number] = [240, 240],
): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([size[0], size[1]]);
    // Real content is only needed to keep this page distinguishable in
    // logs/diffs; stamping doesn't depend on it. Tiny pages (used for the
    // narrow-page fit checks) can't fit this line, so skip it below the
    // font's own draw floor rather than let pdf-lib throw.
    if (size[0] >= 60 && size[1] >= 20) {
      page.drawText(`Source ${name} page ${index + 1}`, { x: 4, y: Math.max(4, size[1] - 20), size: 6, font });
    }
  }
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

/** Same as `makePdf`, but rotates every page by `rotationDegrees` (a multiple
 * of 90) -- used for the rotation-aware minimum-size checks, where the
 * VISUAL width (post-rotation) has to be used instead of the raw page
 * dictionary width. */
async function makeRotatedPdf(
  name: string,
  size: readonly [number, number],
  rotationDegrees: number,
): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([size[0], size[1]]);
  page.setRotation(degrees(rotationDegrees));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

function formatBatesLabel(prefix: string, value: number, digits: number): string {
  return `${prefix}${String(value).padStart(digits, "0")}`;
}

async function expectPageContentToContainLabel(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<void> {
  expect(await readDecodedPageContent(bytes, pageIndex)).toContain(encodeTextAsHex(label));
}

async function expectPageContentNotToContainLabel(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<void> {
  expect(await readDecodedPageContent(bytes, pageIndex)).not.toContain(encodeTextAsHex(label));
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

interface TextMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface PageTextRun {
  fontSize: number;
  matrix: TextMatrix;
  hex: string;
}

/**
 * Extracts each `Tf`/`Tm`/`Tj` text-show triple from a page's content
 * stream, in source order. Each `page.drawText` call pdf-lib emits produces
 * exactly one `BT ... Tf ... Tm <hex> Tj ... ET` block, so this correlates
 * font size and position with the exact text drawn -- unlike a bare `Tm`
 * scan, it stays correct on a page carrying more than one stamp (Bates AND
 * a designation).
 */
async function readPageTextRuns(bytes: Uint8Array, pageIndex: number): Promise<PageTextRun[]> {
  const content = await readDecodedPageContent(bytes, pageIndex);
  const numberPattern = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  const blockPattern = new RegExp(
    `/[^\\s]+ (${numberPattern}) Tf[\\s\\S]*?` +
      `(${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern}) Tm\\s*` +
      "(<[0-9A-Fa-f]+>) Tj",
    "g",
  );

  const runs: PageTextRun[] = [];
  for (const match of content.matchAll(blockPattern)) {
    const [, fontSizeText, matrixText, hex] = match;
    const values = matrixText!.split(" ").map(Number);
    runs.push({
      fontSize: Number(fontSizeText),
      matrix: { a: values[0]!, b: values[1]!, c: values[2]!, d: values[3]!, e: values[4]!, f: values[5]! },
      hex: hex!,
    });
  }
  return runs;
}

/** Matrices of every text run on the page whose text matches `label` exactly. */
async function readPageTextMatrices(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<TextMatrix[]> {
  const targetHex = encodeTextAsHex(label);
  const runs = await readPageTextRuns(bytes, pageIndex);
  return runs.filter((run) => run.hex === targetHex).map((run) => run.matrix);
}

/** Font sizes of every text run on the page whose text matches `label` exactly. */
async function readPageTextFontSizes(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<number[]> {
  const targetHex = encodeTextAsHex(label);
  const runs = await readPageTextRuns(bytes, pageIndex);
  return runs.filter((run) => run.hex === targetHex).map((run) => run.fontSize);
}
