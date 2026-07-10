import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../src/engine.js";
import { extractPageText } from "../src/pdfjs-node.js";
import {
  handleApplyEditsOneShot,
  handleBates,
  handleBatesFolder,
  handleBinder,
  handleBuildCoverPage,
  handleBuildBinderOneShot,
  handleExtract,
  handlePageNumbers,
  handleProductionSet,
  handleSplit,
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
});
