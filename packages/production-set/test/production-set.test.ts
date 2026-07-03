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
import { readPackageManifest } from "@raiopdf/package-writer";
import { buildProductionSet } from "../src/index";

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
    expect(JSON.stringify(manifest.details)).toContain(source);
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
});

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
