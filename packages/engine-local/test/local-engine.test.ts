import { PdfEngineError } from "@raiopdf/engine-api";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFStream,
} from "pdf-lib";
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

  it("rejects deleting every page", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300]]));

    const result = engine.deletePages(document, [0, 1]);

    await expect(result).rejects.toBeInstanceOf(PdfEngineError);
    await expect(result).rejects.toMatchObject({
      code: "EMPTY_RESULT",
    });
  });

  it("maps encrypted documents to ENCRYPTED_DOCUMENT", async () => {
    const engine = createLocalPdfEngine();

    await expect(engine.open(encryptedPdfBytes())).rejects.toMatchObject({
      code: "ENCRYPTED_DOCUMENT",
    });
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

  it("stamps selected pages with text", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300]]));

    const stamped = await engine.stampText(document, {
      text: "Filed 2026",
      pageIndexes: "first",
      placement: { edge: "header", align: "center" },
    });
    const bytes = await engine.saveToBytes(stamped);

    await expectPageContentToContainLabel(bytes, 0, "Filed 2026");
    await expectPageContentNotToContainLabel(bytes, 1, "Filed 2026");
  });

  it("builds a slip-sheet exhibit binder with stamped labels and outline entries", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[200, 300], [210, 300]]));
    const exhibitA = await engine.open(await createPdf([[300, 400], [310, 400]]));
    const exhibitB = await engine.open(await createPdf([[400, 500]]));

    const binder = await engine.buildBinder(
      main,
      [
        { doc: exhibitA, label: "Exhibit A" },
        { doc: exhibitB, label: "Exhibit B" },
      ],
      { slipSheets: true },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageWidths(bytes, [200, 210, 200, 300, 310, 200, 400]);
    await expectPageContentToContainLabel(bytes, 2, "Exhibit A");
    await expectPageContentToContainLabel(bytes, 3, "Exhibit A");
    await expectPageContentToContainLabel(bytes, 4, "Exhibit A");
    await expectPageContentToContainLabel(bytes, 5, "Exhibit B");
    await expectPageContentToContainLabel(bytes, 6, "Exhibit B");
    await expectOutlineEntries(bytes, [
      { title: "Main document", pageIndex: 0 },
      { title: "Exhibit A", pageIndex: 2 },
      { title: "Exhibit B", pageIndex: 5 },
    ]);
  });

  it("builds an exhibit binder without slip sheets", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[200, 300], [210, 300]]));
    const exhibitA = await engine.open(await createPdf([[300, 400], [310, 400]]));
    const exhibitB = await engine.open(await createPdf([[400, 500]]));

    const binder = await engine.buildBinder(
      main,
      [
        { doc: exhibitA, label: "Exhibit A" },
        { doc: exhibitB, label: "Exhibit B" },
      ],
      { slipSheets: false },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageWidths(bytes, [200, 210, 300, 310, 400]);
    await expectOutlineEntries(bytes, [
      { title: "Main document", pageIndex: 0 },
      { title: "Exhibit A", pageIndex: 2 },
      { title: "Exhibit B", pageIndex: 4 },
    ]);
  });

  it("closes document handles and ignores unknown handles", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(engine.close(document)).resolves.toBeUndefined();
    await expect(engine.close("local-pdf:missing" as never)).resolves.toBeUndefined();
    await expect(engine.saveToBytes(document)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });
});

async function createPdf(pageSizes: ReadonlyArray<readonly [number, number]>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const pageSize of pageSizes) {
    pdf.addPage([pageSize[0], pageSize[1]]);
  }

  return pdf.save();
}

function encryptedPdfBytes(): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 0 /Kids [] >>
endobj
3 0 obj
<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>
endobj
trailer
<< /Root 1 0 R /Encrypt 3 0 R >>
%%EOF`);
}

async function expectPageWidths(bytes: Uint8Array, expectedWidths: readonly number[]): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const widths = pdf.getPages().map((page) => page.getWidth());

  expect(widths).toEqual(expectedWidths);
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

async function expectOutlineEntries(
  bytes: Uint8Array,
  expectedEntries: ReadonlyArray<{ title: string; pageIndex: number }>,
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const outlinesObject = pdf.catalog.get(PDFName.of("Outlines"));
  const outlines = outlinesObject instanceof PDFRef
    ? pdf.context.lookup(outlinesObject, PDFDict)
    : outlinesObject;

  if (!(outlines instanceof PDFDict)) {
    throw new Error("Expected PDF outlines dictionary.");
  }

  const count = outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber();

  expect(count).toBe(expectedEntries.length);
  expect(readOutlineEntries(pdf, outlines)).toEqual(expectedEntries);
}

function readOutlineEntries(
  pdf: PDFDocument,
  outlines: PDFDict,
): Array<{ title: string; pageIndex: number }> {
  const entries: Array<{ title: string; pageIndex: number }> = [];
  let itemRef = outlines.get(PDFName.of("First"));

  while (itemRef) {
    if (!(itemRef instanceof PDFRef)) {
      throw new Error("Expected PDF outline item reference.");
    }

    const item = pdf.context.lookup(itemRef, PDFDict);
    const title = item.lookup(PDFName.of("Title"), PDFString, PDFHexString).decodeText();
    const dest = item.lookup(PDFName.of("Dest"), PDFArray);
    const destPageRef = dest.get(0);
    if (!(destPageRef instanceof PDFRef)) {
      throw new Error("Expected PDF outline destination page reference.");
    }

    const pageIndex = pdf.getPages().findIndex((page) => page.ref.toString() === destPageRef.toString());

    entries.push({ title, pageIndex });
    itemRef = item.get(PDFName.of("Next"));
  }

  return entries;
}

async function expectPageRotations(
  bytes: Uint8Array,
  expectedRotations: readonly number[],
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const rotations = pdf.getPages().map((page) => page.getRotation().angle);

  expect(rotations).toEqual(expectedRotations);
}
