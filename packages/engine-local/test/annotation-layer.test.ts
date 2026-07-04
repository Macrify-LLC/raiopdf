import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  rgb,
} from "pdf-lib";
import { describe, expect, it } from "vitest";
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
});

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
  return array.asArray().map((value) => Number(value.toString()));
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
