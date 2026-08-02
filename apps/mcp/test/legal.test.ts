import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { EngineHandle } from "../src/engine.js";
import { extractPageText, extractPageTextByPage } from "../src/pdfjs-node.js";
import {
  handleApplyEditsOneShot,
  handleBates,
  handleBatesFolder,
  buildBinderOneShotInputSchema,
  handleBinder,
  handleBuildCoverPage,
  handleBuildBinderOneShot,
  handleDetectAuthorities,
  handleExtract,
  handlePageNumbers,
  handleProductionSet,
  handleSplit,
  productionSetInputSchema,
} from "../src/tools/legal.js";

// The local (pdf-lib) tools ignore the engine handle; they use the in-process engine.
const engine = {} as EngineHandle;

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-legal-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Byte-identical copy under a new name -- `makePdf` here draws no
 * filename-dependent content, but relying on two separate `makePdf` calls
 * happening to produce identical bytes would be fragile; copy explicitly. */
async function copyAs(sourcePath: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.copyFile(sourcePath, filePath);
  return filePath;
}

async function makePdf(name: string, pages: number): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([200, 200]);
    // Draw text so each page has real content (blank pdf-lib pages are too small
    // to exercise byte-cap splitting deterministically).
    page.drawText(`Page ${index} ${"content ".repeat(40)}`, { x: 5, y: 100, size: 6, font });
  }
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

async function makeTextPdf(name: string, pageTexts: readonly string[]): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [index, text] of pageTexts.entries()) {
    const page = pdf.addPage([612, 792]);
    page.drawText(text, { x: 40, y: 720 - index * 20, size: 10, font });
  }
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

async function pageCount(filePath: string): Promise<number> {
  const pdf = await PDFDocument.load(await fs.readFile(filePath));
  return pdf.getPageCount();
}

function structured(result: { structuredContent: Record<string, unknown> }): Record<string, unknown> {
  return result.structuredContent;
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lb9hKwAAAABJRU5ErkJggg==",
  "base64",
);

describe("legal tools (local pdf-lib engine)", () => {
  it("extract_pages keeps only the selected pages, in order", async () => {
    const input = await makePdf("in.pdf", 4);
    const output = path.join(dir, "out.pdf");
    const result = await handleExtract({ input, output, pages: [0, 2] }, engine);
    expect(structured(result)).toMatchObject({ ok: true });
    expect(await pageCount(output)).toBe(2);
  });

  it("extract_pages rejects an out-of-range page and writes no output", async () => {
    const input = await makePdf("in.pdf", 2);
    const output = path.join(dir, "out.pdf");
    await expect(handleExtract({ input, output, pages: [5] }, engine)).rejects.toThrow(/out of range/);
    await expect(fs.access(output)).rejects.toBeTruthy();
  });

  it("bates_stamp writes a same-length stamped copy", async () => {
    const input = await makePdf("in.pdf", 3);
    const output = path.join(dir, "out.pdf");
    await handleBates({ input, output, prefix: "ABC", start: 1, digits: 6 }, engine);
    expect(await pageCount(output)).toBe(3);
  });

  it("page_numbers writes an output of the same length", async () => {
    const input = await makePdf("in.pdf", 2);
    const output = path.join(dir, "out.pdf");
    await handlePageNumbers({ input, output }, engine);
    expect(await pageCount(output)).toBe(2);
  });

  it("build_exhibit_binder combines the main document and exhibits", async () => {
    const main = await makePdf("main.pdf", 1);
    const exhibit = await makePdf("ex1.pdf", 2);
    const output = path.join(dir, "binder.pdf");
    await handleBinder(
      {
        main,
        exhibits: [{ path: exhibit, label: "Exhibit A" }],
        descriptions: ["Custom exhibit description"],
        index: { includeSourceFileName: true },
        output,
        slipSheets: false,
      },
      engine,
    );
    expect(await pageCount(output)).toBe(4);
  });

  it("keeps exhibit stamp designs off the build_binder surface", () => {
    // Stamp designs are an in-app concept; the MCP schema must not quietly
    // start accepting them just because the engine option exists.
    const parsed = z.object(buildBinderOneShotInputSchema).parse({
      mainPath: path.join(dir, "main.pdf"),
      exhibits: [{ path: path.join(dir, "ex1.pdf"), label: "Exhibit A" }],
      options: {
        slipSheets: false,
        stampDesign: { widthPt: 115.2, heightPt: 72 },
      },
      outputPath: path.join(dir, "binder.pdf"),
      maxInputBytes: 1024,
    });

    expect(parsed.options).not.toHaveProperty("stampDesign");
  });

  it("build_cover_page writes a caption PDF and returns the output path", async () => {
    const output = path.join(dir, "caption.pdf");
    const result = await handleBuildCoverPage(
      {
        courtName: "Superior Court of Fulton County",
        county: "Fulton",
        parties: [
          { role: "Plaintiff", names: ["Jane Doe"] },
          { role: "Defendant", names: ["Acme LLC"], etAl: true },
        ],
        caseNumber: "2026-CV-1000",
        division: "Civil Division",
        judge: "Hon. Ada Lovelace",
        documentTitle: "Motion for Summary Judgment",
        signatureBlockLines: ["Respectfully submitted,", "Jane Doe"],
        styleId: "classic-boxed",
        output,
      },
      engine,
    );

    expect(structured(result)).toMatchObject({ ok: true, output });
    expect(await pageCount(output)).toBe(1);
    const text = await extractPageText(await fs.readFile(output));
    expect(text).toContain("Superior Court of Fulton County");
    expect(text).toContain("v.");
    expect(text).toContain("Case No. 2026-CV-1000");
    expect(text).toContain("Motion for Summary Judgment");
  });

  it("build_cover_page rejects a relative output path", async () => {
    await expect(
      handleBuildCoverPage(
        {
          courtName: "Superior Court of Fulton County",
          parties: [{ role: "Plaintiff", names: ["Jane Doe"] }],
          documentTitle: "Complaint",
          output: "caption.pdf",
        },
        engine,
      ),
    ).rejects.toThrow(/Output path must be absolute/);
  });

  it("build_cover_page refuses to overwrite an existing file", async () => {
    const output = path.join(dir, "caption.pdf");
    await fs.writeFile(output, "existing");

    await expect(
      handleBuildCoverPage(
        {
          courtName: "Superior Court of Fulton County",
          parties: [{ role: "Plaintiff", names: ["Jane Doe"] }],
          documentTitle: "Complaint",
          output,
        },
        engine,
      ),
    ).rejects.toThrow(/already exists/);
    expect(await fs.readFile(output, "utf8")).toBe("existing");
  });

  it("build_cover_page rejects an overflowing caption with a typed error and writes no output", async () => {
    const output = path.join(dir, "caption-overflow.pdf");
    const parties = Array.from({ length: 12 }, (_, partyIndex) => ({
      role: partyIndex % 2 === 0 ? "Plaintiff" : "Defendant",
      names: Array.from({ length: 20 }, (_, nameIndex) =>
        `Party ${partyIndex + 1} Name ${nameIndex + 1} With A Long Descriptive Suffix`),
    }));

    await expect(
      handleBuildCoverPage(
        {
          courtName: "Superior Court of Fulton County",
          parties,
          documentTitle: "Complaint",
          output,
        },
        engine,
      ),
    ).rejects.toMatchObject({
      name: "PdfEngineError",
      code: "CONTENT_OVERFLOW",
      message: expect.stringContaining("does not fit on one page"),
    });
    await expect(fs.access(output)).rejects.toBeTruthy();
  });

  it("detect_authorities returns structured authorities with one-based page hits and writes no output", async () => {
    const input = await makeTextPdf("authorities.pdf", [
      [
        "The motion cites Roe v. Wade, 410 U.S. 113, 42 USC section 1983,",
        "Fla. R. Civ. P. 1.510, and U.S. Const. amend. XIV.",
      ].join(" "),
      [
        "The same case appears again as 410 U. S. 113.",
        "Additional authorities include Fla. Stat. sec. 90.702 and Fed. R. Evid. 702.",
      ].join(" "),
    ]);
    const wouldBeOutput = path.join(dir, "authorities-output.pdf");

    const result = await handleDetectAuthorities({ input }, engine);

    expect(structured(result)).toMatchObject({
      ok: true,
      skipped: false,
      summary: {
        total: 6,
        pageCount: 2,
        byKind: {
          case: 1,
          statute: 2,
          rule: 2,
          constitutional: 1,
          other: 0,
        },
      },
    });
    expect(structured(result).output).toBeUndefined();
    expect(structured(result).authorities).toEqual([
      { kind: "case", canonical: "410 U.S. 113", pages: [1, 2] },
      { kind: "statute", canonical: "42 U.S.C. § 1983", pages: [1] },
      { kind: "rule", canonical: "Fed. R. Evid. 702", pages: [2] },
      { kind: "rule", canonical: "Fla. R. Civ. P. 1.510", pages: [1] },
      { kind: "statute", canonical: "Fla. Stat. § 90.702", pages: [2] },
      { kind: "constitutional", canonical: "U.S. Const. amend. XIV", pages: [1] },
    ]);
    await expect(fs.access(wouldBeOutput)).rejects.toBeTruthy();
  });

  it("detect_authorities skips garbled text layers with Make Searchable guidance", async () => {
    const input = await makeTextPdf("garbled-authorities.pdf", [
      "xqz!@#$ brt%^&* crw+=? plk[]{} mnn<>/ ".repeat(4),
    ]);

    const result = await handleDetectAuthorities({ input }, engine);

    expect(structured(result)).toMatchObject({
      ok: true,
      skipped: true,
      guidance: expect.stringContaining("running Make Searchable again is recommended"),
      garbledPages: [1],
      summary: {
        total: 0,
        pageCount: 1,
      },
      authorities: [],
    });
  });

  it("one-shot build_binder rejects a main PDF over its passed-in ceiling", async () => {
    const main = await makePdf("main.pdf", 1);
    const exhibit = await makePdf("ex1.pdf", 1);
    const output = path.join(dir, "binder.pdf");
    const result = await handleBuildBinderOneShot({
      mainPath: main,
      exhibits: [{ path: exhibit, label: "Exhibit A" }],
      options: { slipSheets: false },
      outputPath: output,
      maxInputBytes: 1,
    });

    expect(structured(result)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    await expect(fs.access(output)).rejects.toBeTruthy();
  });

  it("one-shot build_binder rejects combined main and exhibit bytes over its ceiling", async () => {
    const main = await makePdf("main.pdf", 1);
    const exhibit = await makePdf("ex1.pdf", 1);
    const output = path.join(dir, "binder.pdf");
    const mainSize = (await fs.stat(main)).size;

    const result = await handleBuildBinderOneShot({
      mainPath: main,
      exhibits: [{ path: exhibit, label: "Exhibit A" }],
      options: { slipSheets: false },
      outputPath: output,
      maxInputBytes: mainSize + 1,
    });

    expect(structured(result)).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("combined"),
      },
    });
    await expect(fs.access(output)).rejects.toBeTruthy();
  });

  it("one-shot build_binder writes a binder file with optional options omitted", async () => {
    const main = await makePdf("main.pdf", 1);
    const exhibit = await makePdf("ex1.pdf", 1);
    const output = path.join(dir, "binder-one-shot.pdf");
    const result = await handleBuildBinderOneShot({
      mainPath: main,
      exhibits: [{ path: exhibit, label: "Exhibit A", sourceFileName: "ex1.pdf" }],
      options: { slipSheets: false },
      outputPath: output,
      maxInputBytes: 10_000_000,
    });

    expect(structured(result)).toMatchObject({ ok: true, output });
    expect(await pageCount(output)).toBe(3);
  });

  it("one-shot apply_edits rejects a main PDF over its passed-in ceiling", async () => {
    const main = await makePdf("main.pdf", 1);
    const output = path.join(dir, "edited.pdf");
    const result = await handleApplyEditsOneShot({
      mainPath: main,
      edits: [{ type: "comment", pageIndex: 0, at: { x: 20, y: 20 }, text: "review" }],
      applyOptions: { markupMode: "annotation" },
      outputPath: output,
      maxInputBytes: 1,
    });

    expect(structured(result)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    await expect(fs.access(output)).rejects.toBeTruthy();
  });

  it("one-shot apply_edits materializes temp-file image edits", async () => {
    const main = await makePdf("main.pdf", 1);
    const imagePath = path.join(dir, "stamp.png");
    const output = path.join(dir, "edited-image.pdf");
    await fs.writeFile(imagePath, ONE_PIXEL_PNG);

    const result = await handleApplyEditsOneShot({
      mainPath: main,
      edits: [
        {
          type: "image",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 24, h: 24 },
          bytes: { tempPath: imagePath },
          format: "png",
        },
      ],
      applyOptions: { markupMode: "annotation" },
      outputPath: output,
      maxInputBytes: 10_000_000,
    });

    expect(structured(result)).toMatchObject({ ok: true, output });
    expect(await pageCount(output)).toBe(1);
  });

  it("one-shot apply_edits fills and optionally flattens AcroForm values", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([300, 200]);
    const field = source.getForm().createTextField("client.name");
    field.addToPage(page, { x: 30, y: 100, width: 180, height: 24 });
    const main = path.join(dir, "fillable.pdf");
    const output = path.join(dir, "filled-flat.pdf");
    await fs.writeFile(main, await source.save());

    const result = await handleApplyEditsOneShot({
      mainPath: main,
      edits: [{ type: "formValues", values: { "client.name": "Ada Lovelace" } }],
      flatten: true,
      outputPath: output,
      maxInputBytes: 10_000_000,
    });

    expect(structured(result)).toMatchObject({ ok: true, output });
    const written = await PDFDocument.load(await fs.readFile(output));
    expect(written.getForm().getFields()).toHaveLength(0);
    expect(await extractPageText(await fs.readFile(output))).toContain("Ada Lovelace");
  });

  it("split_pdf writes multiple parts that cover every page", async () => {
    const input = await makePdf("in.pdf", 10);
    const result = await handleSplit({ input, outputDir: dir, maxBytes: 1500 }, engine);
    const outputs = structured(result).outputs as string[];
    expect(outputs.length).toBeGreaterThan(1);
    let total = 0;
    for (const output of outputs) {
      total += await pageCount(output);
    }
    expect(total).toBe(10);
  });

  it("split_pdf aborts every part when one target already exists (no clobber)", async () => {
    const input = await makePdf("doc.pdf", 8);
    const clash = path.join(dir, "doc-part-01.pdf");
    await fs.writeFile(clash, "existing");
    await expect(handleSplit({ input, outputDir: dir, maxBytes: 500 }, engine)).rejects.toBeTruthy();
    expect(await fs.readFile(clash, "utf8")).toBe("existing");
    const leftovers = (await fs.readdir(dir)).filter((entry) => /doc-part-0[2-9]/.test(entry));
    expect(leftovers).toEqual([]);
  });

  it("bates_stamp_folder numbers continuously across the set", async () => {
    const first = await makePdf("a.pdf", 2);
    const second = await makePdf("b.pdf", 3);
    const outputDir = path.join(dir, "out");
    await fs.mkdir(outputDir);
    const result = await handleBatesFolder(
      { inputs: [first, second], outputDir, prefix: "X", start: 1, digits: 4 },
      engine,
    );
    const content = structured(result);
    expect(content.outputs).toHaveLength(2);
    expect(content.nextNumber).toBe(6);
  });

  it("build_production_set writes a package with indexed upload files", async () => {
    const first = await makePdf("prod-a.pdf", 2);
    const second = await makePdf("prod-b.pdf", 1);
    const outputDir = path.join(dir, "production-package");

    const result = await handleProductionSet(
      {
        sources: [
          { path: first, designation: "Confidential" },
          { path: second },
        ],
        outputDir,
        prefix: "PROD",
        start: 10,
        digits: 5,
      },
      engine,
    );

    const content = structured(result);
    expect(content).toMatchObject({
      ok: true,
      packageRoot: outputDir,
      nextNumber: 13,
      indexPdf: "production-index.pdf",
      indexCsv: "production-index.csv",
    });
    expect(content.outputs).toEqual([
      "upload/PROD00010 - PROD00011 - prod-a.pdf",
      "upload/PROD00012 - PROD00012 - prod-b.pdf",
    ]);
    await expect(fs.access(path.join(outputDir, "raio-manifest", "manifest.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(outputDir, "raio-manifest", "checksums.txt"))).resolves.toBeUndefined();
  });

  it("build_production_set accepts an existing empty package directory", async () => {
    const source = await makePdf("prod-a.pdf", 1);
    const outputDir = path.join(dir, "production-package");
    await fs.mkdir(outputDir);

    const result = await handleProductionSet(
      {
        sources: [{ path: source }],
        outputDir,
        prefix: "PROD",
      },
      engine,
    );

    expect(structured(result)).toMatchObject({
      ok: true,
      packageRoot: outputDir,
    });
    await expect(fs.access(path.join(outputDir, "raio-manifest", "manifest.json"))).resolves.toBeUndefined();
  });

  it("build_production_set rejects relative source paths before writing output", async () => {
    const outputDir = path.join(dir, "production-package");

    await expect(
      handleProductionSet(
        {
          sources: [{ path: "relative.pdf" }],
          outputDir,
          prefix: "PROD",
        },
        engine,
      ),
    ).rejects.toThrow(/Input path must be absolute/);

    await expect(fs.access(outputDir)).rejects.toBeTruthy();
  });

  it("build_production_set rejects source symlink components before writing output", async () => {
    const source = await makePdf("source.pdf", 1);
    const linkDir = path.join(dir, "linked");
    await fs.symlink(dir, linkDir);
    const outputDir = path.join(dir, "production-package");

    await expect(
      handleProductionSet(
        {
          sources: [{ path: path.join(linkDir, path.basename(source)) }],
          outputDir,
          prefix: "PROD",
        },
        engine,
      ),
    ).rejects.toThrow(/Path contains a symlink component/);

    await expect(fs.access(outputDir)).rejects.toBeTruthy();
  });

  it("build_production_set rejects output symlink components before writing output", async () => {
    const source = await makePdf("source.pdf", 1);
    const linkDir = path.join(dir, "linked-output");
    await fs.symlink(dir, linkDir);
    const outputDir = path.join(linkDir, "production-package");

    await expect(
      handleProductionSet(
        {
          sources: [{ path: source }],
          outputDir,
          prefix: "PROD",
        },
        engine,
      ),
    ).rejects.toThrow(/Path contains a symlink component/);

    await expect(fs.access(path.join(dir, "production-package"))).rejects.toBeTruthy();
  });

  it("build_production_set continues Bates numbering from a prior production package", async () => {
    const first = await makePdf("prior-a.pdf", 2);
    const priorDir = path.join(dir, "prior-package");
    const prior = await handleProductionSet(
      { sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH", start: 1, digits: 6 },
      engine,
    );
    expect(structured(prior).nextNumber).toBe(3);

    const second = await makePdf("next-a.pdf", 1);
    const nextDir = path.join(dir, "next-package");
    const result = await handleProductionSet(
      {
        sources: [{ path: second }],
        outputDir: nextDir,
        prefix: "SMITH",
        start: 3,
        digits: 6,
        continueFrom: priorDir,
      },
      engine,
    );

    expect(structured(result)).toMatchObject({
      ok: true,
      nextNumber: 4,
      continuation: { mode: "strict", priorLastBates: "SMITH000002" },
    });
  });

  it("build_production_set rejects a Bates start mismatch against the prior production", async () => {
    const first = await makePdf("prior-a.pdf", 1);
    const priorDir = path.join(dir, "prior-package");
    await handleProductionSet(
      { sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH" },
      engine,
    );

    const second = await makePdf("next-a.pdf", 1);
    const nextDir = path.join(dir, "next-package");
    await expect(
      handleProductionSet(
        { sources: [{ path: second }], outputDir: nextDir, prefix: "SMITH", start: 1, continueFrom: priorDir },
        engine,
      ),
    ).rejects.toThrow(/start mismatch/i);
  });

  it("build_production_set allows a continuation override with a reason", async () => {
    const first = await makePdf("prior-a.pdf", 1);
    const priorDir = path.join(dir, "prior-package");
    await handleProductionSet(
      { sources: [{ path: first }], outputDir: priorDir, prefix: "SMITH" },
      engine,
    );

    const second = await makePdf("next-a.pdf", 1);
    const nextDir = path.join(dir, "next-package");
    const result = await handleProductionSet(
      {
        sources: [{ path: second }],
        outputDir: nextDir,
        prefix: "SMITH",
        start: 500,
        continueFrom: priorDir,
        continuationOverride: { reason: "Reserving a supplemental range." },
      },
      engine,
    );

    expect(structured(result)).toMatchObject({
      ok: true,
      continuation: { mode: "override", priorLastBates: "SMITH000001" },
    });
  });

  it("build_production_set threads custom placement, font size, and per-source page ranges through to the engine", async () => {
    const source = await makePdf("ranged.pdf", 3);
    const outputDir = path.join(dir, "production-package");

    const result = await handleProductionSet(
      {
        sources: [{ path: source, designation: "Confidential", designationPages: "1-2" }],
        outputDir,
        prefix: "THREAD",
        batesPlacement: { edge: "header", align: "left" },
        designationPlacement: { edge: "footer", align: "center" },
        stampFontSizePt: 12,
      },
      engine,
    );

    const content = structured(result);
    expect(content.ok).toBe(true);
    const outputPath = path.join(outputDir, (content.outputs as string[])[0]!);
    const pages = await extractPageTextByPage(await fs.readFile(outputPath));
    expect(pages[0]!.text).toContain("Confidential");
    expect(pages[1]!.text).toContain("Confidential");
    expect(pages[2]!.text).not.toContain("Confidential");
  });

  it("build_production_set rejects a designation page range with no designation set", async () => {
    const source = await makePdf("nodesig.pdf", 2);
    const outputDir = path.join(dir, "production-package");

    await expect(
      handleProductionSet(
        { sources: [{ path: source, designationPages: "1" }], outputDir, prefix: "NODESIG" },
        engine,
      ),
    ).rejects.toThrow(/no confidentiality designation was chosen/);
  });

  it("build_production_set rejects Bates/designation placements sharing an edge", async () => {
    const source = await makePdf("collide.pdf", 1);
    const outputDir = path.join(dir, "production-package");

    await expect(
      handleProductionSet(
        {
          sources: [{ path: source, designation: "Confidential" }],
          outputDir,
          prefix: "COL",
          batesPlacement: { edge: "footer", align: "left" },
          designationPlacement: { edge: "footer", align: "right" },
        },
        engine,
      ),
    ).rejects.toThrow(/can't both be placed in the footer/);
  });

  it("build_production_set threads duplicateHandling through and returns duplicateCount/duplicateGroups", async () => {
    const first = await makePdf("dup-a.pdf", 1);
    const second = await copyAs(first, "dup-b.pdf");
    const outputDir = path.join(dir, "production-package");

    const result = await handleProductionSet(
      {
        sources: [{ path: first }, { path: second }],
        outputDir,
        prefix: "MCPDUP",
        duplicateHandling: "produce-once",
      },
      engine,
    );

    const content = structured(result);
    expect(content.duplicateCount).toBe(1);
    expect(content.duplicateGroupsTruncated).toBe(false);
    expect(content.duplicateGroups).toEqual([
      expect.objectContaining({
        occurrences: [
          expect.objectContaining({ sourceFilename: "dup-a.pdf", action: "produced" }),
          expect.objectContaining({ sourceFilename: "dup-b.pdf", action: "omitted", batesRange: null }),
        ],
      }),
    ]);
    // Only the first occurrence was produced.
    expect(content.outputs).toHaveLength(1);
  });

  it("defaults to produce-all, producing every occurrence, when duplicateHandling is omitted", async () => {
    const first = await makePdf("dup-a.pdf", 1);
    const second = await copyAs(first, "dup-b.pdf");
    const outputDir = path.join(dir, "production-package");

    const result = await handleProductionSet(
      { sources: [{ path: first }, { path: second }], outputDir, prefix: "MCPDUPALL" },
      engine,
    );

    const content = structured(result);
    expect(content.duplicateCount).toBe(1);
    expect(content.outputs).toHaveLength(2);
  });

  describe("productionSetInputSchema (round trip)", () => {
    const schema = z.object(productionSetInputSchema);

    it("accepts batesPlacement, designationPlacement, stampFontSizePt, and per-source designationPages", () => {
      const parsed = schema.parse({
        sources: [{ path: "/abs/a.pdf", designation: "Confidential", designationPages: "1-3,7" }],
        outputDir: "/abs/out",
        prefix: "SMITH",
        batesPlacement: { edge: "header", align: "left" },
        designationPlacement: { edge: "footer", align: "right" },
        stampFontSizePt: 14,
      });

      expect(parsed.sources[0]).toMatchObject({ designationPages: "1-3,7" });
      expect(parsed.batesPlacement).toEqual({ edge: "header", align: "left" });
      expect(parsed.designationPlacement).toEqual({ edge: "footer", align: "right" });
      expect(parsed.stampFontSizePt).toBe(14);
    });

    it("omits the new fields entirely without error (backward compatible)", () => {
      const parsed = schema.parse({
        sources: [{ path: "/abs/a.pdf" }],
        outputDir: "/abs/out",
        prefix: "SMITH",
      });

      expect(parsed.batesPlacement).toBeUndefined();
      expect(parsed.designationPlacement).toBeUndefined();
      expect(parsed.stampFontSizePt).toBeUndefined();
      expect(parsed.sources[0]!.designationPages).toBeUndefined();
    });

    it("rejects a stampFontSizePt below 6 or above 24 at the schema layer", () => {
      const base = { sources: [{ path: "/abs/a.pdf" }], outputDir: "/abs/out", prefix: "SMITH" };
      expect(() => schema.parse({ ...base, stampFontSizePt: 5 })).toThrow();
      expect(() => schema.parse({ ...base, stampFontSizePt: 25 })).toThrow();
      expect(() => schema.parse({ ...base, stampFontSizePt: 10 })).not.toThrow();
    });

    it("rejects an invalid edge/align value at the schema layer", () => {
      const base = { sources: [{ path: "/abs/a.pdf" }], outputDir: "/abs/out", prefix: "SMITH" };
      expect(() => schema.parse({ ...base, batesPlacement: { edge: "middle", align: "right" } })).toThrow();
      expect(() => schema.parse({ ...base, designationPlacement: { edge: "header", align: "up" } })).toThrow();
    });

    it("accepts duplicateHandling and rejects an out-of-enum value", () => {
      const base = { sources: [{ path: "/abs/a.pdf" }], outputDir: "/abs/out", prefix: "SMITH" };
      expect(schema.parse({ ...base, duplicateHandling: "produce-once" }).duplicateHandling).toBe("produce-once");
      expect(schema.parse({ ...base, duplicateHandling: "produce-all" }).duplicateHandling).toBe("produce-all");
      expect(() => schema.parse({ ...base, duplicateHandling: "keep-first" })).toThrow();
    });

    it("omits duplicateHandling entirely without error (backward compatible)", () => {
      const parsed = schema.parse({ sources: [{ path: "/abs/a.pdf" }], outputDir: "/abs/out", prefix: "SMITH" });
      expect(parsed.duplicateHandling).toBeUndefined();
    });
  });
});
