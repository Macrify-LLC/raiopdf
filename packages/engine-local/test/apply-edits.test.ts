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
  PDFStream,
  PDFString,
} from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createLocalPdfEngine } from "../src/index";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("LocalPdfEngine.applyEdits", () => {
  it("bakes highlight edits as translucent rectangles at the given rects", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await engine.applyEdits(document, [
      {
        type: "highlight",
        pageIndex: 0,
        rects: [
          { x: 40, y: 100, w: 120, h: 14 },
          { x: 40, y: 84, w: 90, h: 14 },
        ],
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);
    const translates = readOperandPairs(content, "cm").filter(
      (pair) => pair.length === 6,
    );

    expectSomePointWithin1Pt(
      translates.map((values) => ({ x: values[4]!, y: values[5]! })),
      { x: 40, y: 100 },
    );
    expectSomePointWithin1Pt(
      translates.map((values) => ({ x: values[4]!, y: values[5]! })),
      { x: 40, y: 84 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 120, y: 14 },
    );
    // Translucency comes from an ExtGState, not an annotation.
    expect(content).toMatch(/\/GS\S* gs/);
    expect(content).toContain("f");
  });

  it("draws text box edits with the first baseline below the rect's top edge", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await engine.applyEdits(document, [
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 72, y: 700, w: 200, h: 40 },
        text: "Hello box",
        fontSizePt: 12,
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);
    const [matrix] = readOperandPairs(content, "Tm");

    expect(content).toContain(encodeTextAsHex("Hello box"));

    if (!matrix) {
      throw new Error("Expected the edited page to contain a text matrix.");
    }

    expectWithin1Pt(matrix[0]!, 1);
    expectWithin1Pt(matrix[3]!, 1);
    expectWithin1Pt(matrix[4]!, 72);
    expectWithin1Pt(matrix[5]!, 700 + 40 - 12);
  });

  it("draws image edits scaled into the target rect", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await engine.applyEdits(document, [
      {
        type: "image",
        pageIndex: 0,
        rect: { x: 50, y: 60, w: 80, h: 40 },
        bytes: pngBytes(),
        format: "png",
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);
    const matrices = readOperandPairs(content, "cm");

    expect(content).toMatch(/\/\S+ Do/);
    expectSomePointWithin1Pt(
      matrices.map((values) => ({ x: values[4]!, y: values[5]! })),
      { x: 50, y: 60 },
    );
    expectSomePointWithin1Pt(
      matrices.map((values) => ({ x: values[0]!, y: values[3]! })),
      { x: 80, y: 40 },
    );
  });

  it("draws signature edits exactly like image edits", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await engine.applyEdits(document, [
      {
        type: "signature",
        pageIndex: 0,
        rect: { x: 300, y: 120, w: 140, h: 50 },
        bytes: pngBytes(),
        format: "png",
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);
    const matrices = readOperandPairs(content, "cm");

    expect(content).toMatch(/\/\S+ Do/);
    expectSomePointWithin1Pt(
      matrices.map((values) => ({ x: values[4]!, y: values[5]! })),
      { x: 300, y: 120 },
    );
    expectSomePointWithin1Pt(
      matrices.map((values) => ({ x: values[0]!, y: values[3]! })),
      { x: 140, y: 50 },
    );
  });

  it("draws ink edits as stroked polylines with the default 1.5pt width", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await engine.applyEdits(document, [
      {
        type: "ink",
        pageIndex: 0,
        strokes: [
          [
            { x: 10, y: 10 },
            { x: 30, y: 40 },
            { x: 60, y: 20 },
          ],
        ],
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);

    expect(content).toMatch(/\b1\.5 w\b/);
    expectSomePointWithin1Pt(
      readOperandPairs(content, "m").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 10, y: 10 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 30, y: 40 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 60, y: 20 },
    );
  });

  it("renders custom highlight, text, and ink styles into page content", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await engine.applyEdits(document, [
      {
        type: "highlight",
        pageIndex: 0,
        rects: [{ x: 40, y: 100, w: 120, h: 14 }],
        color: { r: 0.2, g: 0.7, b: 0.1 },
        opacity: 0.65,
      },
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 72, y: 700, w: 200, h: 40 },
        text: "Custom text",
        color: { r: 0.8, g: 0.1, b: 0.2 },
      },
      {
        type: "ink",
        pageIndex: 0,
        strokes: [
          [
            { x: 10, y: 10 },
            { x: 30, y: 40 },
          ],
        ],
        strokeWidthPt: 5,
        color: { r: 0.1, g: 0.2, b: 0.9 },
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const pdf = await PDFDocument.load(bytes);
    const content = await readDecodedPageContent(bytes, 0);

    expectSomeOperandsWithin(readOperandPairs(content, "rg"), [0.2, 0.7, 0.1]);
    expectSomeOperandsWithin(readOperandPairs(content, "rg"), [0.8, 0.1, 0.2]);
    expectSomeOperandsWithin(readOperandPairs(content, "RG"), [0.1, 0.2, 0.9]);
    expect(readExtGStateFillAlphaValues(pdf, 0)).toContain(0.65);
    expect(content).toMatch(/\b5 w\b/);
  });

  it("stores comment edits as real /Text annotations in /Annots", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792], [612, 792]]));

    const edited = await engine.applyEdits(document, [
      {
        type: "comment",
        pageIndex: 1,
        at: { x: 100, y: 150 },
        text: "Please review",
        author: "Jacob",
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const pdf = await PDFDocument.load(bytes);

    expect(readTextAnnotations(pdf, 0)).toHaveLength(0);

    const [annotation] = readTextAnnotations(pdf, 1);

    if (!annotation) {
      throw new Error("Expected page 1 to contain a /Text annotation.");
    }

    expect(annotation.contents).toBe("Please review");
    expect(annotation.author).toBe("Jacob");
    expectWithin1Pt(annotation.rect[0]!, 100);
    expectWithin1Pt(annotation.rect[1]!, 150);
  });

  it("places text box and image edits upright on a 90-degree-rotated page", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));
    const rotated = await engine.rotatePages(document, [0], 90);

    const edited = await engine.applyEdits(rotated, [
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 120, y: 50, w: 30, h: 80 },
        text: "Rot",
        fontSizePt: 12,
      },
      {
        type: "image",
        pageIndex: 0,
        rect: { x: 20, y: 30, w: 40, h: 100 },
        bytes: pngBytes(),
        format: "png",
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);

    // Text: user rect {120,50,30,80} on a 90-rotated 200x300 page is the
    // visual rect {x:50,y:50,w:80,h:30}; the first baseline anchors at visual
    // (50, 68), which maps back to page point (200-68, 50) = (132, 50), drawn
    // with a 90-degree text matrix so it reads upright.
    const [textMatrix] = readOperandPairs(content, "Tm");

    if (!textMatrix) {
      throw new Error("Expected the rotated page to contain a text matrix.");
    }

    expectWithin1Pt(textMatrix[0]!, 0);
    expectWithin1Pt(textMatrix[1]!, 1);
    expectWithin1Pt(textMatrix[2]!, -1);
    expectWithin1Pt(textMatrix[3]!, 0);
    expectWithin1Pt(textMatrix[4]!, 132);
    expectWithin1Pt(textMatrix[5]!, 50);

    // Image: user rect {20,30,40,100} is the visual rect {x:30,y:140,w:100,h:40};
    // the anchor maps to page point (200-140, 30) = (60, 30), with a 90-degree
    // rotation matrix and a scale of the visual 100x40 extent.
    const matrices = readOperandPairs(content, "cm");

    expect(content).toMatch(/\/\S+ Do/);
    expectSomePointWithin1Pt(
      matrices.map((values) => ({ x: values[4]!, y: values[5]! })),
      { x: 60, y: 30 },
    );
    expectSomePointWithin1Pt(
      matrices.map((values) => ({ x: values[0]!, y: values[3]! })),
      { x: 100, y: 40 },
    );
    expect(
      matrices.some(
        (values) =>
          Math.abs(values[0]!) <= 0.001 &&
          Math.abs(values[1]! - 1) <= 0.001 &&
          Math.abs(values[2]! + 1) <= 0.001 &&
          Math.abs(values[3]!) <= 0.001,
      ),
    ).toBe(true);
  });

  it("writes form values through the AcroForm API", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createFormPdf());

    const edited = await engine.applyEdits(document, [
      {
        type: "formValues",
        values: { name: "Jane Doe", agree: true },
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const pdf = await PDFDocument.load(bytes);
    const form = pdf.getForm();

    expect(form.getTextField("name").getText()).toBe("Jane Doe");
    expect(form.getCheckBox("agree").isChecked()).toBe(true);
  });

  it("rejects form values for unknown fields", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createFormPdf());

    await expect(
      engine.applyEdits(document, [{ type: "formValues", values: { missing: "nope" } }]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("flattens filled forms so values stay visible and fields disappear", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createFormPdf());
    const filled = await engine.applyEdits(document, [
      { type: "formValues", values: { name: "Jane Doe", agree: true } },
    ]);

    const flattened = await engine.flattenForm(filled);
    const bytes = await engine.saveToBytes(flattened);
    const pdf = await PDFDocument.load(bytes);

    expect(pdf.getForm().getFields()).toHaveLength(0);
    expect(await documentStreamsContain(pdf, encodeTextAsHex("Jane Doe"))).toBe(true);
  });

  it("flattens documents without form fields as a content no-op", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    const flattened = await engine.flattenForm(document);
    const bytes = await engine.saveToBytes(flattened);
    const pdf = await PDFDocument.load(bytes);

    expect(flattened).not.toBe(document);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("returns a new handle with unchanged content for empty edit lists", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 310]]));

    const edited = await engine.applyEdits(document, []);
    const bytes = await engine.saveToBytes(edited);
    const pdf = await PDFDocument.load(bytes);

    expect(edited).not.toBe(document);
    expect(pdf.getPages().map((page) => [page.getWidth(), page.getHeight()])).toEqual([
      [200, 300],
      [210, 310],
    ]);
  });

  it("rejects edits targeting pages outside the document", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(
      engine.applyEdits(document, [
        {
          type: "highlight",
          pageIndex: 3,
          rects: [{ x: 10, y: 10, w: 20, h: 10 }],
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_PAGE_INDEX" });
    await expect(
      engine.applyEdits(document, [
        { type: "comment", pageIndex: 0, at: { x: 10, y: 10 }, text: "" },
      ]),
    ).rejects.toBeInstanceOf(PdfEngineError);
  });
});

async function createPdf(
  pageSizes: ReadonlyArray<readonly [number, number]>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const pageSize of pageSizes) {
    pdf.addPage([pageSize[0], pageSize[1]]);
  }

  return pdf.save();
}

async function createFormPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const form = pdf.getForm();

  const nameField = form.createTextField("name");
  nameField.addToPage(page, { x: 40, y: 300, width: 200, height: 24 });

  const agreeField = form.createCheckBox("agree");
  agreeField.addToPage(page, { x: 40, y: 250, width: 18, height: 18 });

  return pdf.save();
}

function pngBytes(): Uint8Array {
  return Uint8Array.from(atob(ONE_BY_ONE_PNG_BASE64), (char) => char.charCodeAt(0));
}

async function readDecodedPageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPage(pageIndex).node.Contents();
  const contentObjects =
    contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

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

/**
 * Extracts the numeric operands of every occurrence of a content-stream
 * operator, e.g. `readOperandPairs(content, "cm")` returns each `cm` matrix.
 */
function readOperandPairs(content: string, operator: string): number[][] {
  const numberPattern = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  const operandsPattern = new RegExp(
    `((?:${numberPattern} )+)${operator.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?=\\s|$)`,
    "gm",
  );

  return [...content.matchAll(operandsPattern)].map((match) =>
    match[1]!.trim().split(" ").map((value) => Number(value)),
  );
}

function encodeTextAsHex(text: string): string {
  return `<${[...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("")}>`;
}

function expectWithin1Pt(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

function expectSomePointWithin1Pt(
  points: ReadonlyArray<{ x: number; y: number }>,
  expected: { x: number; y: number },
): void {
  const found = points.some(
    (point) => Math.abs(point.x - expected.x) <= 1 && Math.abs(point.y - expected.y) <= 1,
  );

  if (!found) {
    throw new Error(
      `Expected a point within 1pt of (${expected.x}, ${expected.y}); saw ${JSON.stringify(points)}`,
    );
  }
}

function expectSomeOperandsWithin(
  operands: ReadonlyArray<readonly number[]>,
  expected: readonly number[],
  tolerance = 0.001,
): void {
  const found = operands.some(
    (actual) =>
      actual.length === expected.length &&
      actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance),
  );

  if (!found) {
    throw new Error(
      `Expected operands within ${tolerance} of ${JSON.stringify(expected)}; saw ${JSON.stringify(operands)}`,
    );
  }
}

function readExtGStateFillAlphaValues(pdf: PDFDocument, pageIndex: number): number[] {
  const resources = pdf.getPage(pageIndex).node.Resources();
  const extGState = resources?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);

  if (!extGState) {
    return [];
  }

  const values: number[] = [];

  for (const [, entry] of extGState.entries()) {
    const dict = entry instanceof PDFRef ? pdf.context.lookup(entry, PDFDict) : entry;

    if (!(dict instanceof PDFDict)) {
      continue;
    }

    const alpha = dict.lookupMaybe(PDFName.of("ca"), PDFNumber)?.asNumber();

    if (alpha !== undefined) {
      values.push(alpha);
    }
  }

  return values;
}

function readTextAnnotations(
  pdf: PDFDocument,
  pageIndex: number,
): Array<{ rect: number[]; contents: string; author: string | undefined }> {
  const page = pdf.getPage(pageIndex);
  const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

  if (!annotations) {
    return [];
  }

  const entries: Array<{ rect: number[]; contents: string; author: string | undefined }> = [];

  for (const element of annotations.asArray()) {
    const annotation =
      element instanceof PDFRef ? pdf.context.lookup(element, PDFDict) : element;

    if (!(annotation instanceof PDFDict)) {
      continue;
    }

    const subtype = annotation.get(PDFName.of("Subtype"));

    if (!(subtype instanceof PDFName) || subtype !== PDFName.of("Text")) {
      continue;
    }

    const rect = annotation
      .lookup(PDFName.of("Rect"), PDFArray)
      .asArray()
      .map((value) => Number(value.toString()));
    const contents = annotation
      .lookup(PDFName.of("Contents"), PDFString, PDFHexString)
      .decodeText();
    const authorObject = annotation.get(PDFName.of("T"));
    const author =
      authorObject instanceof PDFString || authorObject instanceof PDFHexString
        ? authorObject.decodeText()
        : undefined;

    entries.push({ rect, contents, author });
  }

  return entries;
}

async function documentStreamsContain(pdf: PDFDocument, needle: string): Promise<boolean> {
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) {
      continue;
    }

    try {
      if (decodePdfStream(object).includes(needle)) {
        return true;
      }
    } catch {
      // Non-text or unsupported-filter streams are irrelevant to the search.
    }
  }

  return false;
}
