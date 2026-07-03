import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../src/engine.js";
import {
  handleBates,
  handleBatesFolder,
  handleBinder,
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
});
