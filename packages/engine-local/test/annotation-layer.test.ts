import {
  decodePDFRawStream,
  degrees as pdfDegrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  rgb,
} from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfEdit } from "@raiopdf/engine-api";
import {
  createAnnotationAppearanceTarget,
  createLocalPdfEngine,
  createPageDrawTarget,
  readRaioPdfMarkupAnnotations,
  stampRaioPdfAnnotation,
} from "../src/index";

describe("annotation-layer foundation", () => {
  it("reproduces a representative baked rectangle content stream through the page target", async () => {
    const direct = await PDFDocument.create();
    const directPage = direct.addPage([240, 180]);
    const target = await PDFDocument.create();
    const targetPage = target.addPage([240, 180]);
    const rect = { x: 40, y: 50, w: 80, h: 30 };
    const fillColor = rgb(0.8, 0.7, 0.2);
    const strokeColor = rgb(0.1, 0.2, 0.3);

    directPage.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      color: fillColor,
      borderColor: strokeColor,
      borderWidth: 3,
    });
    createPageDrawTarget(targetPage).drawRectangle({
      rect,
      fillColor,
      strokeColor,
      strokeWidthPt: 3,
    });

    expect(await readDecodedPageContent(await target.save(), 0)).toBe(
      await readDecodedPageContent(await direct.save(), 0),
    );
  });

  it("emits a valid annotation appearance form XObject for a rectangle", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([240, 180]);
    const appearanceTarget = createAnnotationAppearanceTarget(pdf, {
      x: 40,
      y: 50,
      w: 80,
      h: 30,
    });

    appearanceTarget.drawRectangle({
      rect: { x: 40, y: 50, w: 80, h: 30 },
      fillColor: rgb(1, 0.9, 0.3),
      strokeColor: rgb(0.1, 0.2, 0.3),
      strokeWidthPt: 2,
      fillAlpha: 0.4,
      strokeAlpha: 0.8,
    });

    const appearance = pdf.context.lookup(appearanceTarget.finish(), PDFStream);
    const bbox = appearance.dict.lookup(PDFName.of("BBox"), PDFArray);
    const matrix = appearance.dict.lookup(PDFName.of("Matrix"), PDFArray);
    const resources = appearance.dict.lookup(PDFName.of("Resources"), PDFDict);
    const extGState = resources.lookup(PDFName.of("ExtGState"), PDFDict);
    const [firstGraphicsState] = extGState.values();

    expect(appearance.dict.lookup(PDFName.of("Type"), PDFName)).toBe(PDFName.of("XObject"));
    expect(appearance.dict.lookup(PDFName.of("Subtype"), PDFName)).toBe(PDFName.of("Form"));
    expect(readNumbers(bbox)).toEqual([0, 0, 80, 30]);
    expect(readNumbers(matrix)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(firstGraphicsState).toBeInstanceOf(PDFDict);
    expect((firstGraphicsState as PDFDict).lookup(PDFName.of("ca"), PDFNumber).asNumber()).toBe(
      0.4,
    );
    expect((firstGraphicsState as PDFDict).lookup(PDFName.of("CA"), PDFNumber).asNumber()).toBe(
      0.8,
    );
  });

  it("stamps and reads only RaioPDF-owned markup annotations", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([240, 180]);
    const square = pdf.context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [40, 50, 120, 80],
    }) as PDFDict;
    const comment = pdf.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [10, 10, 30, 30],
    }) as PDFDict;

    stampRaioPdfAnnotation(square);
    stampRaioPdfAnnotation(comment);
    page.node.addAnnot(pdf.context.register(square));
    page.node.addAnnot(pdf.context.register(comment));

    const [entry] = readRaioPdfMarkupAnnotations(page);

    expect(readRaioPdfMarkupAnnotations(page)).toHaveLength(1);
    expect(entry?.dict).toBe(square);
    expect(entry?.subtype).toBe("Square");
  });

  it("flattens a marked markup annotation appearance into page content and removes it", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([240, 180]);
    const rect = { x: 40, y: 50, w: 80, h: 30 };
    const appearanceTarget = createAnnotationAppearanceTarget(source, rect);

    appearanceTarget.drawRectangle({
      rect,
      fillColor: rgb(1, 0.9, 0.3),
      strokeColor: rgb(0.1, 0.2, 0.3),
      strokeWidthPt: 2,
    });

    const annotation = source.context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
      AP: { N: appearanceTarget.finish() },
    }) as PDFDict;

    stampRaioPdfAnnotation(annotation);
    page.node.addAnnot(source.context.register(annotation));

    const engine = createLocalPdfEngine();
    const document = await engine.open(await source.save());
    const flattened = await engine.flattenMarkupAnnotations(document);
    const flattenedBytes = await engine.saveToBytes(flattened);
    const flattenedPdf = await PDFDocument.load(flattenedBytes);
    const content = await readDecodedPageContent(flattenedBytes, 0);

    expect(readRaioPdfMarkupAnnotations(flattenedPdf.getPage(0))).toHaveLength(0);
    expect(flattenedPdf.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)).toBeUndefined();
    expect(content).toContain("/RaioPDFAnnot");
    expect(content).toContain(" Do");
    expect(readOperandPairs(content, "cm")).toContainEqual([1, 0, 0, 1, 40, 50]);
  });

  it("emits ink and shape edits as marked printable annotations with appearances", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));
    const edits: readonly PdfEdit[] = [
      {
        type: "ink",
        pageIndex: 0,
        strokeWidthPt: 2,
        color: { r: 0.2, g: 0.3, b: 0.4 },
        strokes: [
          [
            { x: 10, y: 10 },
            { x: 30, y: 40 },
          ],
          [
            { x: 30, y: 40 },
            { x: 60, y: 20 },
          ],
        ],
      },
      {
        type: "shape",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 80, y: 120, w: 140, h: 60 },
        strokeWidthPt: 3,
        strokeColor: { r: 0.1, g: 0.2, b: 0.3 },
        fillColor: { r: 0.8, g: 0.7, b: 0.2 },
      },
      {
        type: "shape",
        pageIndex: 0,
        shape: "ellipse",
        rect: { x: 100, y: 150, w: 80, h: 40 },
        fillColor: { r: 0.2, g: 0.8, b: 0.4 },
      },
      {
        type: "shape",
        pageIndex: 0,
        shape: "line",
        from: { x: 30, y: 40 },
        to: { x: 200, y: 220 },
        strokeColor: { r: 0.9, g: 0.1, b: 0.1 },
      },
      {
        type: "shape",
        pageIndex: 0,
        shape: "arrow",
        from: { x: 40, y: 40 },
        to: { x: 140, y: 40 },
        strokeWidthPt: 2,
      },
    ];

    const edited = await engine.applyEdits(document, edits, { markupMode: "annotation" });
    const pdf = await PDFDocument.load(await engine.saveToBytes(edited));
    const annotations = readPageAnnotations(pdf, 0);

    expect(readRaioPdfMarkupAnnotations(pdf.getPage(0)).map((entry) => entry.subtype)).toEqual([
      "Ink",
      "Square",
      "Circle",
      "Line",
      "Line",
    ]);
    expect(annotations.map((annotation) => readName(annotation, "Subtype"))).toEqual([
      "Ink",
      "Square",
      "Circle",
      "Line",
      "Line",
    ]);

    for (const annotation of annotations) {
      expect(annotation.lookup(PDFName.of("F"), PDFNumber).asNumber()).toBe(4);
      expect(annotation.lookupMaybe(PDFName.of("RaioPDF"), PDFDict)).toBeInstanceOf(PDFDict);
      expect(annotation.get(PDFName.of("T"))).toBeUndefined();
      expect(annotation.get(PDFName.of("M"))).toBeUndefined();
      expect(decodePdfStream(readNormalAppearanceStream(pdf, annotation)).length).toBeGreaterThan(
        0,
      );
    }

    const [ink, square, circle, line, arrow] = annotations;

    expect(readNumberArray(ink!.lookup(PDFName.of("InkList"), PDFArray).lookup(0, PDFArray))).toEqual([
      10, 10, 30, 40,
    ]);
    expect(readNumberArray(ink!.lookup(PDFName.of("InkList"), PDFArray).lookup(1, PDFArray))).toEqual([
      30, 40, 60, 20,
    ]);
    expect(readNumberArray(ink!.lookup(PDFName.of("C"), PDFArray))).toEqual([0.2, 0.3, 0.4]);

    expect(readNumberArray(square!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      78.5, 118.5, 221.5, 181.5,
    ]);
    expect(readNumberArray(square!.lookup(PDFName.of("C"), PDFArray))).toEqual([0.1, 0.2, 0.3]);
    expect(readNumberArray(square!.lookup(PDFName.of("IC"), PDFArray))).toEqual([0.8, 0.7, 0.2]);

    expect(readNumberArray(circle!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      99.25, 149.25, 180.75, 190.75,
    ]);
    expect(readNumberArray(line!.lookup(PDFName.of("L"), PDFArray))).toEqual([
      30, 40, 200, 220,
    ]);
    expect(readNumberArray(arrow!.lookup(PDFName.of("L"), PDFArray))).toEqual([
      40, 40, 140, 40,
    ]);
    expect(readNameArray(arrow!.lookup(PDFName.of("LE"), PDFArray))).toEqual([
      "None",
      "ClosedArrow",
    ]);
  });

  it("keeps non-P1 edit types on their existing paths in annotation mode", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[240, 180]]));
    const edited = await engine.applyEdits(
      document,
      [
        {
          type: "highlight",
          pageIndex: 0,
          rects: [{ x: 20, y: 30, w: 70, h: 12 }],
        },
        {
          type: "comment",
          pageIndex: 0,
          at: { x: 100, y: 100 },
          text: "Still a sticky note",
        },
      ],
      { markupMode: "annotation" },
    );
    const bytes = await engine.saveToBytes(edited);
    const pdf = await PDFDocument.load(bytes);

    expect(await readDecodedPageContent(bytes, 0)).toContain("f");
    expect(readRaioPdfMarkupAnnotations(pdf.getPage(0))).toHaveLength(0);
    expect(readPageAnnotations(pdf, 0).map((annotation) => readName(annotation, "Subtype"))).toEqual([
      "Text",
    ]);
  });

  it("flattens annotation-mode ink and shapes back into painted page content", async () => {
    const engine = createLocalPdfEngine();
    const source = await engine.open(await createPdf([[612, 792]]));
    const edits: readonly PdfEdit[] = [
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
      {
        type: "shape",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 80, y: 120, w: 140, h: 60 },
        strokeWidthPt: 3,
        fillColor: { r: 0.8, g: 0.7, b: 0.2 },
      },
      {
        type: "shape",
        pageIndex: 0,
        shape: "arrow",
        from: { x: 40, y: 40 },
        to: { x: 140, y: 40 },
        strokeWidthPt: 2,
      },
    ];

    const baked = await engine.applyEdits(source, edits);
    const annotationMode = await engine.applyEdits(source, edits, { markupMode: "annotation" });
    const flattened = await engine.flattenMarkupAnnotations(annotationMode);
    const bakedBytes = await engine.saveToBytes(baked);
    const flattenedBytes = await engine.saveToBytes(flattened);
    const flattenedPdf = await PDFDocument.load(flattenedBytes);
    const flattenedContent = await readDecodedPageContent(flattenedBytes, 0);

    expect(readRaioPdfMarkupAnnotations(flattenedPdf.getPage(0))).toHaveLength(0);
    expect(flattenedPdf.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)).toBeUndefined();
    expect(flattenedContent).toContain("/RaioPDFAnnot");
    expect(flattenedContent).toContain(" Do");
    await expectFlattenedContentCarriesBakedMarks(bakedBytes, flattenedContent);
  });

  it.each([90, 180, 270] as const)(
    "emits and flattens annotation geometry on %i-degree rotated pages",
    async (rotation) => {
      const engine = createLocalPdfEngine();
      const document = await engine.open(await createRotatedPdf(rotation));
      const edited = await engine.applyEdits(
        document,
        [
          {
            type: "shape",
            pageIndex: 0,
            shape: "rect",
            rect: { x: 80, y: 120, w: 140, h: 60 },
            strokeWidthPt: 3,
          },
          {
            type: "shape",
            pageIndex: 0,
            shape: "line",
            from: { x: 30, y: 40 },
            to: { x: 200, y: 220 },
          },
        ],
        { markupMode: "annotation" },
      );
      const editedBytes = await engine.saveToBytes(edited);
      const pdf = await PDFDocument.load(editedBytes);
      const annotations = readPageAnnotations(pdf, 0);
      const flattened = await engine.flattenMarkupAnnotations(edited);
      const flattenedContent = await readDecodedPageContent(await engine.saveToBytes(flattened), 0);

      expect(pdf.getPage(0).getRotation().angle).toBe(rotation);
      expect(readNumberArray(annotations[0]!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
        78.5, 118.5, 221.5, 181.5,
      ]);
      expect(readNumberArray(annotations[1]!.lookup(PDFName.of("L"), PDFArray))).toEqual([
        30, 40, 200, 220,
      ]);
      expect(
        decodePdfStream(readNormalAppearanceStream(pdf, annotations[0]!)).length,
      ).toBeGreaterThan(0);
      expect(flattenedContent).toContain("/RaioPDFAnnot");
      expect(flattenedContent).toContain(" Do");
    },
  );
});

async function createPdf(pageSizes: ReadonlyArray<readonly [number, number]>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const pageSize of pageSizes) {
    pdf.addPage([pageSize[0], pageSize[1]]);
  }

  return pdf.save();
}

async function createRotatedPdf(rotation: 90 | 180 | 270): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);

  page.setRotation(pdfDegrees(rotation));

  return pdf.save();
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

function readNumbers(array: PDFArray): number[] {
  return readNumberArray(array);
}

function readNumberArray(array: PDFArray): number[] {
  return array.asArray().map((value) => Number(value.toString()));
}

function readName(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFName)?.toString().replace(/^\//, "");
}

function readNameArray(array: PDFArray): string[] {
  return array
    .asArray()
    .map((value) => (value instanceof PDFName ? value.toString().replace(/^\//, "") : ""));
}

function readPageAnnotations(pdf: PDFDocument, pageIndex: number): PDFDict[] {
  const annotations = pdf.getPage(pageIndex).node.lookupMaybe(PDFName.of("Annots"), PDFArray);

  if (!annotations) {
    return [];
  }

  return annotations
    .asArray()
    .map((entry) => (entry instanceof PDFRef ? pdf.context.lookup(entry, PDFDict) : entry))
    .filter((entry): entry is PDFDict => entry instanceof PDFDict);
}

function readNormalAppearanceStream(pdf: PDFDocument, annotation: PDFDict): PDFStream {
  const appearance = annotation.lookup(PDFName.of("AP"), PDFDict);
  const normalAppearance = appearance.get(PDFName.of("N"));

  return normalAppearance instanceof PDFRef
    ? pdf.context.lookup(normalAppearance, PDFStream)
    : (normalAppearance as PDFStream);
}

async function expectFlattenedContentCarriesBakedMarks(
  bakedBytes: Uint8Array,
  flattenedContent: string,
): Promise<void> {
  const bakedContent = await readDecodedPageContent(bakedBytes, 0);

  expect(bakedContent).toMatch(/\b1\.5 w\b/);
  expect(bakedContent).toMatch(/\b2 w\b/);
  expect(bakedContent).toMatch(/\b3 w\b/);
  expect(bakedContent).toContain("f");
  expect(readOperandPairs(flattenedContent, "cm")).toEqual(
    expect.arrayContaining([
      [1, 0, 0, 1, 9.25, 9.25],
      [1, 0, 0, 1, 78.5, 118.5],
      [1, 0, 0, 1, 39, 32.7],
    ]),
  );
}

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
