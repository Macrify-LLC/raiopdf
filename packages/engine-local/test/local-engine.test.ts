import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createLocalPdfEngine } from "../src/index";

describe("LocalPdfEngine", () => {
  it("reorders pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    const reordered = await engine.reorderPages(document, [2, 0, 1]);
    const bytes = await engine.saveToBytes(reordered);

    await expectPageWidths(bytes, [220, 200, 210]);
  });

  it("rotates selected pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    const rotated = await engine.rotatePages(document, [1], 90);
    const bytes = await engine.saveToBytes(rotated);

    await expectPageRotations(bytes, [0, 90, 0]);
  });

  it("deletes selected pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    const deleted = await engine.deletePages(document, [1]);
    const bytes = await engine.saveToBytes(deleted);

    await expectPageWidths(bytes, [200, 220]);
  });

  it("merges documents in order", async () => {
    const engine = createLocalPdfEngine();
    const first = await engine.open(await createPdf([[200, 300], [210, 300]]));
    const second = await engine.open(await createPdf([[300, 400]]));

    const merged = await engine.merge([first, second]);
    const bytes = await engine.saveToBytes(merged);

    await expectPageWidths(bytes, [200, 210, 300]);
  });

  it("inserts another document at a page position", async () => {
    const engine = createLocalPdfEngine();
    const target = await engine.open(await createPdf([[200, 300], [220, 300]]));
    const inserted = await engine.open(await createPdf([[210, 300]]));

    const combined = await engine.insertPages(target, 1, inserted);
    const bytes = await engine.saveToBytes(combined);

    await expectPageWidths(bytes, [200, 210, 220]);
  });
});

async function createPdf(pageSizes: ReadonlyArray<readonly [number, number]>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const pageSize of pageSizes) {
    pdf.addPage([pageSize[0], pageSize[1]]);
  }

  return pdf.save();
}

async function expectPageWidths(bytes: Uint8Array, expectedWidths: readonly number[]): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const widths = pdf.getPages().map((page) => page.getWidth());

  expect(widths).toEqual(expectedWidths);
}

async function expectPageRotations(
  bytes: Uint8Array,
  expectedRotations: readonly number[],
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const rotations = pdf.getPages().map((page) => page.getRotation().angle);

  expect(rotations).toEqual(expectedRotations);
}
