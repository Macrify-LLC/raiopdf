import {
  decodePDFRawStream,
  degrees as pdfDegrees,
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
  rgb,
} from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfEdit } from "@raiopdf/engine-api";
import {
  createAnnotationAppearanceTarget,
  createLocalPdfEngine,
  createPageDrawTarget,
  hideRaioPdfImportedAnnotationsForDisplay,
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

  it("serializes Slice 1 source metadata into the RaioPDF marker and reads it back", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 220]]));
    const edits = [
      {
        type: "highlight",
        pageIndex: 0,
        rects: [{ x: 20, y: 150, w: 80, h: 12 }],
        color: { r: 1, g: 0.8, b: 0.1 },
        opacity: 0.5,
      },
      {
        type: "underline",
        pageIndex: 0,
        rects: [{ x: 20, y: 125, w: 70, h: 10 }],
        color: { r: 0.2, g: 0.3, b: 0.4 },
        thicknessPt: 2,
      },
      {
        type: "strikethrough",
        pageIndex: 0,
        rects: [{ x: 20, y: 100, w: 90, h: 10 }],
        thicknessPt: 1.5,
      },
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 130, y: 95, w: 100, h: 40 },
        text: "Box text",
        fontSizePt: 13,
        color: { r: 0.1, g: 0.2, b: 0.3 },
        backgroundColor: { r: 0.9, g: 0.9, b: 0.7 },
        backgroundOpacity: 0.6,
        fontFamily: "times",
        bold: true,
        italic: true,
        align: "center",
      },
      {
        type: "comment",
        pageIndex: 0,
        at: { x: 210, y: 160 },
        text: "Comment text",
        author: "Raio",
      },
    ] satisfies PdfEdit[];

    const edited = await engine.applyEdits(document, edits, { markupMode: "annotation" });
    const imports = await engine.readRaioPdfAnnotations(edited);
    const editedPdf = await PDFDocument.load(await engine.saveToBytes(edited));
    const annotations = readPageAnnotations(editedPdf, 0);

    expect(imports.map((entry) => entry.edit.type)).toEqual([
      "highlight",
      "underline",
      "strikethrough",
      "textBox",
      "comment",
    ]);
    expect(new Set(imports.map((entry) => entry.annotId)).size).toBe(5);
    expect(imports.map((entry) => entry.pageIndex)).toEqual([0, 0, 0, 0, 0]);
    expect(imports[0]!.edit).toMatchObject(edits[0]!);
    expect(imports[3]!.edit).toMatchObject(edits[3]!);
    expect(imports[4]!.edit).toMatchObject(edits[4]!);

    for (const annotation of annotations) {
      const marker = annotation.lookup(PDFName.of("RaioPDF"), PDFDict);
      const sourceEdit = JSON.parse(readString(marker, "SourceEdit")) as PdfEdit;
      const markerId = readString(marker, "Id");

      expect(marker.lookup(PDFName.of("Version"), PDFNumber).asNumber()).toBe(2);
      expect(readName(marker, "Kind")).toBe("Markup");
      expect(readString(annotation, "NM")).toBe(markerId);
      expect(sourceEdit.type).toBe(imports.find((entry) => entry.annotId === markerId)?.edit.type);
    }
  });

  it("re-imports moved annotations with the current containing page index", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 220], [310, 220], [320, 220]]));
    const edited = await engine.applyEdits(
      document,
      [
        {
          type: "highlight",
          pageIndex: 1,
          rects: [{ x: 20, y: 150, w: 80, h: 12 }],
          opacity: 0.5,
        },
      ],
      { markupMode: "annotation" },
    );

    const { document: reordered } = await engine.reorderPages(edited, [1, 2, 0]);
    const { document: moved } = await engine.deletePages(reordered, [1]);
    const imports = await engine.readRaioPdfAnnotations(moved);
    const movedPdf = await PDFDocument.load(await engine.saveToBytes(moved));
    const marker = readPageAnnotations(movedPdf, 0)[0]?.lookup(PDFName.of("RaioPDF"), PDFDict);
    const storedSourceEdit = marker
      ? JSON.parse(readString(marker, "SourceEdit")) as PdfEdit
      : null;

    expect(storedSourceEdit).toMatchObject({ type: "highlight", pageIndex: 1 });
    expect(imports).toHaveLength(1);
    expect(imports[0]?.pageIndex).toBe(0);
    expect(imports[0]?.edit).toMatchObject({
      type: "highlight",
      pageIndex: 0,
      rects: [{ x: 20, y: 150, w: 80, h: 12 }],
      opacity: 0.5,
    });
  });

  it("hides only re-importable RaioPDF annotations in viewer display bytes", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 220]]));
    const edited = await engine.applyEdits(
      document,
      [
        {
          type: "highlight",
          pageIndex: 0,
          rects: [{ x: 20, y: 150, w: 80, h: 12 }],
        },
        {
          type: "comment",
          pageIndex: 0,
          at: { x: 210, y: 160 },
          text: "Imported note",
        },
      ],
      { markupMode: "annotation" },
    );
    const sourceBytes = await engine.saveToBytes(edited);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const sourcePage = sourcePdf.getPage(0);
    const foreignAnnotation = sourcePdf.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [40, 40, 60, 60],
      Contents: PDFString.of("Foreign note"),
      F: 0,
    }) as PDFDict;
    const annotations = sourcePage.node.lookup(PDFName.of("Annots"), PDFArray);
    annotations.push(sourcePdf.context.register(foreignAnnotation));
    const withForeignBytes = await sourcePdf.save();

    const displayBytes = await hideRaioPdfImportedAnnotationsForDisplay(withForeignBytes);
    const original = await PDFDocument.load(withForeignBytes);
    const display = await PDFDocument.load(displayBytes);
    const originalAnnotations = readPageAnnotations(original, 0);
    const displayAnnotations = readPageAnnotations(display, 0);

    expect(originalAnnotations.map((annotation) =>
      annotation.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0
    )).toEqual([4, 4, 0]);
    expect(displayAnnotations.map((annotation) =>
      annotation.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0
    )).toEqual([6, 6, 0]);
  });

  it("updates and deletes RaioPDF annotations by id without duplicating them", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 220]]));
    const edited = await engine.applyEdits(
      document,
      [
        {
          type: "highlight",
          pageIndex: 0,
          rects: [{ x: 20, y: 150, w: 80, h: 12 }],
          opacity: 0.4,
        },
        {
          type: "comment",
          pageIndex: 0,
          at: { x: 210, y: 160 },
          text: "Delete me",
        },
      ],
      { markupMode: "annotation" },
    );
    const [highlightImport, commentImport] = await engine.readRaioPdfAnnotations(edited);

    if (!highlightImport || !commentImport) {
      throw new Error("Expected imported highlight and comment annotations.");
    }

    const updated = await engine.updateAnnotationById(edited, highlightImport.annotId, {
      type: "highlight",
      pageIndex: 0,
      annotId: highlightImport.annotId,
      rects: [{ x: 55, y: 130, w: 90, h: 14 }],
      opacity: 0.7,
    });
    const deleted = await engine.deleteAnnotationById(updated, commentImport.annotId);
    const imports = await engine.readRaioPdfAnnotations(deleted);
    const outputPdf = await PDFDocument.load(await engine.saveToBytes(deleted));
    const ids = readPageAnnotations(outputPdf, 0).map((annotation) => readString(annotation, "NM"));

    expect(imports).toHaveLength(1);
    expect(imports[0]?.annotId).toBe(highlightImport.annotId);
    expect(imports[0]?.edit).toMatchObject({
      type: "highlight",
      rects: [{ x: 55, y: 130, w: 90, h: 14 }],
      opacity: 0.7,
    });
    expect(ids).toEqual([highlightImport.annotId]);
    expect(new Set(ids).size).toBe(ids.length);
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

  it("normalizes pages after baking kept RaioPDF markup annotations into content", async () => {
    const engine = createLocalPdfEngine();
    const source = await engine.open(await createPdf([[612, 792]]));
    const edited = await engine.applyEdits(
      source,
      [
        {
          type: "shape",
          pageIndex: 0,
          shape: "rect",
          rect: { x: 80, y: 120, w: 140, h: 60 },
          strokeWidthPt: 3,
          strokeColor: { r: 0.1, g: 0.2, b: 0.3 },
          fillColor: { r: 0.8, g: 0.7, b: 0.2 },
        },
      ],
      { markupMode: "annotation" },
    );
    const editedPdf = await PDFDocument.load(await engine.saveToBytes(edited));

    expect(readRaioPdfMarkupAnnotations(editedPdf.getPage(0))).toHaveLength(1);

    const normalized = await engine.normalizePages(edited, {
      targetSize: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
    });
    const normalizedBytes = await engine.saveToBytes(normalized);
    const normalizedPdf = await PDFDocument.load(normalizedBytes);
    const normalizedContent = await readDecodedPageContent(normalizedBytes, 0);
    const embeddedPageContent = readFlattenedAppearances(normalizedContent)
      .map(({ name }) => readPageXObjectStream(normalizedPdf, 0, name.replace(/^\//, ""), false))
      .filter((stream): stream is PDFStream => Boolean(stream))
      .map((stream) => decodePdfStream(stream))
      .join("\n");

    expect(readRaioPdfMarkupAnnotations(normalizedPdf.getPage(0))).toHaveLength(0);
    expect(readPageAnnotations(normalizedPdf, 0)).toHaveLength(0);
    expect(normalizedContent).toContain(" Do");
    expect(embeddedPageContent).toContain("/RaioPDFAnnot");
  });

  it("flattens newly applied markup on a document with no pre-existing annotations", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 200]]));
    const edited = await engine.applyEdits(
      document,
      [
        {
          type: "shape",
          pageIndex: 0,
          shape: "rect",
          rect: { x: 40, y: 50, w: 80, h: 30 },
          strokeWidthPt: 2,
          strokeColor: { r: 0.1, g: 0.2, b: 0.3 },
        },
      ],
      { markupMode: "annotation" },
    );
    const editedPdf = await PDFDocument.load(await engine.saveToBytes(edited));

    expect(readRaioPdfMarkupAnnotations(editedPdf.getPage(0)).map((entry) => entry.subtype)).toEqual([
      "Square",
    ]);

    const flattened = await engine.flattenMarkupAnnotations(edited);
    const flattenedBytes = await engine.saveToBytes(flattened);
    const flattenedPdf = await PDFDocument.load(flattenedBytes);
    const content = await readDecodedPageContent(flattenedBytes, 0);

    expect(readRaioPdfMarkupAnnotations(flattenedPdf.getPage(0))).toHaveLength(0);
    expect(flattenedPdf.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)).toBeUndefined();
    expect(content).toContain("/RaioPDFAnnot");
    expect(content).toContain(" Do");
  });

  it("emits markup annotations by default and keeps baked mode reachable", async () => {
    const engine = createLocalPdfEngine();
    const defaultSource = await engine.open(await createPdf([[300, 200]]));
    const bakedSource = await engine.open(await createPdf([[300, 200]]));
    const edit: PdfEdit = {
      type: "highlight",
      pageIndex: 0,
      rects: [{ x: 20, y: 30, w: 120, h: 14 }],
    };

    const defaultEdited = await engine.applyEdits(defaultSource, [edit]);
    const defaultPdf = await PDFDocument.load(await engine.saveToBytes(defaultEdited));
    const bakedEdited = await engine.applyEdits(bakedSource, [edit], { markupMode: "baked" });
    const bakedBytes = await engine.saveToBytes(bakedEdited);
    const bakedPdf = await PDFDocument.load(bakedBytes);

    expect(readRaioPdfMarkupAnnotations(defaultPdf.getPage(0)).map((entry) => entry.subtype)).toEqual([
      "Highlight",
    ]);
    expect(readRaioPdfMarkupAnnotations(bakedPdf.getPage(0))).toHaveLength(0);
    expect(await readDecodedPageContent(bakedBytes, 0)).toContain(" rg");
  });

  it("uses the print flag according to printMarkupAnnotations", async () => {
    const engine = createLocalPdfEngine();
    const printableSource = await engine.open(await createPdf([[300, 200]]));
    const nonPrintableSource = await engine.open(await createPdf([[300, 200]]));
    const edit: PdfEdit = {
      type: "shape",
      pageIndex: 0,
      shape: "rect",
      rect: { x: 40, y: 50, w: 80, h: 30 },
    };

    const printable = await engine.applyEdits(printableSource, [edit], {
      printMarkupAnnotations: true,
    });
    const nonPrintable = await engine.applyEdits(nonPrintableSource, [edit], {
      printMarkupAnnotations: false,
    });
    const printablePdf = await PDFDocument.load(await engine.saveToBytes(printable));
    const nonPrintablePdf = await PDFDocument.load(await engine.saveToBytes(nonPrintable));

    expect(
      readRaioPdfMarkupAnnotations(printablePdf.getPage(0))[0]?.dict
        .lookup(PDFName.of("F"), PDFNumber)
        .asNumber(),
    ).toBe(4);
    expect(
      readRaioPdfMarkupAnnotations(nonPrintablePdf.getPage(0))[0]?.dict
        .lookup(PDFName.of("F"), PDFNumber)
        .asNumber(),
    ).toBe(0);
  });

  it("preserves printMarkupAnnotations=false when updating a saved annotation", async () => {
    const engine = createLocalPdfEngine();
    const source = await engine.open(await createPdf([[300, 200]]));
    const edited = await engine.applyEdits(
      source,
      [
        {
          type: "highlight",
          pageIndex: 0,
          rects: [{ x: 40, y: 50, w: 80, h: 12 }],
        },
      ],
      { markupMode: "annotation", printMarkupAnnotations: true },
    );
    const [imported] = await engine.readRaioPdfAnnotations(edited);

    if (!imported || imported.edit.type !== "highlight") {
      throw new Error("Expected imported highlight annotation.");
    }

    const updated = await engine.updateAnnotationById(
      edited,
      imported.annotId,
      {
        ...imported.edit,
        rects: [{ x: 60, y: 70, w: 90, h: 14 }],
      },
      { printMarkupAnnotations: false },
    );
    const updatedPdf = await PDFDocument.load(await engine.saveToBytes(updated));

    expect(
      readRaioPdfMarkupAnnotations(updatedPdf.getPage(0))[0]?.dict
        .lookup(PDFName.of("F"), PDFNumber)
        .asNumber(),
    ).toBe(0);
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
      78.25, 118.25, 221.75, 181.75,
    ]);
    expect(readNumberArray(square!.lookup(PDFName.of("C"), PDFArray))).toEqual([0.1, 0.2, 0.3]);
    expect(readNumberArray(square!.lookup(PDFName.of("IC"), PDFArray))).toEqual([0.8, 0.7, 0.2]);

    expect(readNumberArray(circle!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      99, 149, 181, 191,
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

  it("emits text markup edits as marked printable annotations with quadpoints and appearances", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));
    const edits: readonly PdfEdit[] = [
      {
        type: "highlight",
        pageIndex: 0,
        rects: [
          { x: 40, y: 700, w: 120, h: 14 },
          { x: 40, y: 680, w: 90, h: 14 },
        ],
      },
      {
        type: "underline",
        pageIndex: 0,
        color: { r: 0.2, g: 0.3, b: 0.4 },
        thicknessPt: 1.5,
        rects: [
          { x: 210, y: 640, w: 110, h: 12 },
          { x: 210, y: 622, w: 80, h: 12 },
        ],
      },
      {
        type: "strikethrough",
        pageIndex: 0,
        color: { r: 0.7, g: 0.1, b: 0.2 },
        rects: [{ x: 80, y: 580, w: 130, h: 16 }],
      },
    ];

    const edited = await engine.applyEdits(document, edits, { markupMode: "annotation" });
    const pdf = await PDFDocument.load(await engine.saveToBytes(edited));
    const annotations = readPageAnnotations(pdf, 0);

    expect(readRaioPdfMarkupAnnotations(pdf.getPage(0)).map((entry) => entry.subtype)).toEqual([
      "Highlight",
      "Underline",
      "StrikeOut",
    ]);
    expect(annotations.map((annotation) => readName(annotation, "Subtype"))).toEqual([
      "Highlight",
      "Underline",
      "StrikeOut",
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

    const [highlight, underline, strikeout] = annotations;

    expect(readNumberArray(highlight!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      40, 680, 160, 714,
    ]);
    expect(readNumberArray(highlight!.lookup(PDFName.of("QuadPoints"), PDFArray))).toEqual([
      40, 714, 160, 714, 40, 700, 160, 700,
      40, 694, 130, 694, 40, 680, 130, 680,
    ]);
    expect(readNumberArray(highlight!.lookup(PDFName.of("C"), PDFArray))).toEqual([1, 0.9, 0.3]);

    expect(readNumberArray(underline!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      209, 621, 321, 653,
    ]);
    expect(readNumberArray(underline!.lookup(PDFName.of("QuadPoints"), PDFArray))).toEqual([
      210, 652, 320, 652, 210, 640, 320, 640,
      210, 634, 290, 634, 210, 622, 290, 622,
    ]);
    expect(readNumberArray(underline!.lookup(PDFName.of("C"), PDFArray))).toEqual([
      0.2, 0.3, 0.4,
    ]);

    expect(readNumberArray(strikeout!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      79.25, 579.25, 210.75, 596.75,
    ]);
    expect(readNumberArray(strikeout!.lookup(PDFName.of("QuadPoints"), PDFArray))).toEqual([
      80, 596, 210, 596, 80, 580, 210, 580,
    ]);
    expect(readNumberArray(strikeout!.lookup(PDFName.of("C"), PDFArray))).toEqual([
      0.7, 0.1, 0.2,
    ]);
  });

  it("keeps non-FreeText edit types on their existing paths in annotation mode", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[240, 180]]));
    const edited = await engine.applyEdits(
      document,
      [
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

    expect(readRaioPdfMarkupAnnotations(pdf.getPage(0))).toHaveLength(0);
    expect(readPageAnnotations(pdf, 0).map((annotation) => readName(annotation, "Subtype"))).toEqual([
      "Text",
    ]);
  });

  it.each(markEquivalenceCases)(
    "flattens annotation-mode $name with AP-local drawing equivalent to baked page drawing",
    async ({ edit, expectedRect, expectedQuadPoints }) => {
      const equivalence = await renderBakedAndFlattenedMark(edit, await createPdf([[612, 792]]));

      expect(readNumberArray(equivalence.annotation.lookup(PDFName.of("Rect"), PDFArray))).toEqual(
        expectedRect,
      );
      if (expectedQuadPoints) {
        expect(
          readNumberArray(equivalence.annotation.lookup(PDFName.of("QuadPoints"), PDFArray)),
        ).toEqual(expectedQuadPoints);
      }
      expect(equivalence.apMatrix).toEqual([1, 0, 0, 1, 0, 0]);
      expectTransformedBBoxMatchesAnnotationRect(equivalence);
      expectPaintedPathsInsideBBox(equivalence.apPaths, equivalence.apBBox);
      expectPaintedPathsEquivalent(equivalence.bakedPaths, equivalence.apPaths, equivalence.placementMatrix);
    },
  );

  it("preserves full underline stroke thickness after annotation flattening", async () => {
    const equivalence = await renderBakedAndFlattenedMark(
      {
        type: "underline",
        pageIndex: 0,
        color: { r: 0.2, g: 0.3, b: 0.4 },
        thicknessPt: 2,
        rects: [{ x: 210, y: 622, w: 80, h: 12 }],
      },
      await createPdf([[612, 792]]),
    );
    const [bakedPath] = equivalence.bakedPaths;
    const [apPath] = equivalence.apPaths;

    expect(bakedPath).toBeDefined();
    expect(apPath).toBeDefined();
    expectBoundsClose(
      transformBounds(intersectBounds(paintedPathExtent(apPath!)!, rectToBounds(equivalence.apBBox))!, equivalence.placementMatrix),
      paintedPathExtent(bakedPath!)!,
    );
  });

  it.each([90, 180, 270] as const)(
    "emits and flattens annotation geometry on %i-degree rotated pages",
    async (rotation) => {
      for (const { edit, expectedRect, expectedQuadPoints } of markEquivalenceCases) {
        const equivalence = await renderBakedAndFlattenedMark(edit, await createRotatedPdf(rotation));

        expect(equivalence.annotationPdf.getPage(0).getRotation().angle).toBe(rotation);
        expect(readNumberArray(equivalence.annotation.lookup(PDFName.of("Rect"), PDFArray))).toEqual(
          expectedRect,
        );
        if (expectedQuadPoints) {
          expect(
            readNumberArray(equivalence.annotation.lookup(PDFName.of("QuadPoints"), PDFArray)),
          ).toEqual(expectedQuadPoints);
        }
        expect(equivalence.apMatrix).toEqual([1, 0, 0, 1, 0, 0]);
        expectTransformedBBoxMatchesAnnotationRect(equivalence);
        expectPaintedPathsInsideBBox(equivalence.apPaths, equivalence.apBBox);
        expectPaintedPathsEquivalent(
          equivalence.bakedPaths,
          equivalence.apPaths,
          equivalence.placementMatrix,
        );
      }
    },
  );

  it("emits text boxes as marked printable FreeText annotations with coherent appearance fonts", async () => {
    const engine = createLocalPdfEngine();
    const edit: PdfEdit = {
      type: "textBox",
      pageIndex: 0,
      rect: { x: 40, y: 600, w: 140, h: 60 },
      text: "Alpha beta\nGamma",
      fontSizePt: 14,
      fontFamily: "times",
      bold: true,
      align: "right",
      color: { r: 0.2, g: 0.3, b: 0.4 },
    };
    const document = await engine.open(await createPdf([[612, 792]]));
    const edited = await engine.applyEdits(document, [edit], { markupMode: "annotation" });
    const pdf = await PDFDocument.load(await engine.saveToBytes(edited));
    const [annotation] = readPageAnnotations(pdf, 0);

    expect(annotation).toBeDefined();
    expect(readName(annotation!, "Subtype")).toBe("FreeText");
    expect(readNumberArray(annotation!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      40, 600, 180, 660,
    ]);
    expect(annotation!.lookup(PDFName.of("F"), PDFNumber).asNumber()).toBe(4);
    expect(annotation!.lookupMaybe(PDFName.of("RaioPDF"), PDFDict)).toBeInstanceOf(PDFDict);
    expect(annotation!.get(PDFName.of("T"))).toBeUndefined();
    expect(annotation!.get(PDFName.of("M"))).toBeUndefined();
    expect(annotation!.lookup(PDFName.of("Q"), PDFNumber).asNumber()).toBe(2);
    expect(readString(annotation!, "Contents")).toBe("Alpha beta\nGamma");
    expectFreeTextAppearanceFontCoherence(pdf, annotation!, 14, [0.2, 0.3, 0.4]);
  });

  it("emits callouts as FreeText callout annotations with union Rect, CL, arrowhead, and unclipped BBox", async () => {
    const engine = createLocalPdfEngine();
    const edit: PdfEdit = {
      type: "callout",
      pageIndex: 0,
      rect: { x: 80, y: 120, w: 100, h: 50 },
      tip: { x: 240, y: 145 },
      text: "Callout text",
      fontSizePt: 12,
      strokeWidthPt: 3,
      strokeColor: { r: 0.1, g: 0.2, b: 0.9 },
      boxFill: { r: 1, g: 0.95, b: 0.65 },
    };
    const document = await engine.open(await createPdf([[612, 792]]));
    const edited = await engine.applyEdits(document, [edit], { markupMode: "annotation" });
    const pdf = await PDFDocument.load(await engine.saveToBytes(edited));
    const [annotation] = readPageAnnotations(pdf, 0);
    const appearance = readNormalAppearanceStream(pdf, annotation!);
    const apBBox = readRectArray(appearance.dict.lookup(PDFName.of("BBox"), PDFArray));
    const apPaths = readPaintedPaths(decodePdfStream(appearance), readStreamExtGStates(pdf, appearance));

    expect(annotation).toBeDefined();
    expect(readName(annotation!, "Subtype")).toBe("FreeText");
    expect(readName(annotation!, "IT")).toBe("FreeTextCallout");
    expect(readNumberArray(annotation!.lookup(PDFName.of("Rect"), PDFArray))).toEqual([
      78.25, 118.25, 241.75, 171.75,
    ]);
    expect(readNumberArray(annotation!.lookup(PDFName.of("CL"), PDFArray))).toEqual([
      180, 145, 240, 145,
    ]);
    expect(readName(annotation!, "LE")).toBe("ClosedArrow");
    expect(readNumberArray(annotation!.lookup(PDFName.of("RD"), PDFArray))).toEqual([
      1.75, 1.75, 61.75, 1.75,
    ]);
    expect(readNumberArray(appearance.dict.lookup(PDFName.of("BBox"), PDFArray))).toEqual([
      -1.75, -1.75, 161.75, 51.75,
    ]);
    expect(annotation!.lookup(PDFName.of("F"), PDFNumber).asNumber()).toBe(4);
    expect(annotation!.lookupMaybe(PDFName.of("RaioPDF"), PDFDict)).toBeInstanceOf(PDFDict);
    expect(annotation!.get(PDFName.of("T"))).toBeUndefined();
    expect(annotation!.get(PDFName.of("M"))).toBeUndefined();
    expectPaintedPathsInsideBBox(apPaths, apBBox);
    expectFreeTextAppearanceFontCoherence(pdf, annotation!, 12, [
      EDIT_INK_RGB[0],
      EDIT_INK_RGB[1],
      EDIT_INK_RGB[2],
    ]);
  });

  it.each(freeTextEquivalenceCases)(
    "flattens annotation-mode $name FreeText equivalent to baked page drawing",
    async ({ edit }) => {
      const equivalence = await renderBakedAndFlattenedMark(edit, await createPdf([[612, 792]]));

      expect(readName(equivalence.annotation, "Subtype")).toBe("FreeText");
      expect(equivalence.apMatrix).toEqual([1, 0, 0, 1, 0, 0]);
      expectTransformedBBoxMatchesAnnotationRect(equivalence);
      expectPaintedPathsInsideBBox(equivalence.apPaths, equivalence.apBBox);
      expectPaintedPathsEquivalent(
        equivalence.bakedPaths,
        equivalence.apPaths,
        equivalence.placementMatrix,
      );
      expectTextRunsEquivalent(
        equivalence.bakedTextRuns,
        equivalence.apTextRuns,
        equivalence.placementMatrix,
      );
    },
  );

  it.each(freeTextOverflowCases)(
    "expands $name FreeText bounds for overflowing text and preserves flattened text",
    async ({ edit }) => {
      const equivalence = await renderBakedAndFlattenedMark(edit, await createPdf([[612, 792]]));
      const annotationRect = readRectArray(equivalence.annotation.lookup(PDFName.of("Rect"), PDFArray));
      const apTextBounds = textRunLineBounds(equivalence.apTextRuns);
      const annotationTextBounds = transformBounds(apTextBounds, equivalence.placementMatrix);
      const visibleApRuns = clipTextRunsToBBox(equivalence.apTextRuns, equivalence.apBBox);

      expect(annotationRect.y).toBeLessThan(edit.rect.y);
      expect(annotationRect.h).toBeGreaterThan(edit.rect.h);
      expectBoundsToContain(rectToBounds(equivalence.apBBox), apTextBounds);
      expectBoundsToContain(rectToBounds(annotationRect), annotationTextBounds);
      expectTextRunsEquivalent(
        equivalence.bakedTextRuns,
        visibleApRuns,
        equivalence.placementMatrix,
      );
      expectTextRunsEquivalent(
        equivalence.bakedTextRuns,
        equivalence.apTextRuns,
        equivalence.placementMatrix,
      );
    },
  );

  it.each([90, 180, 270] as const)(
    "flattens FreeText text and callout equivalently on %i-degree rotated pages",
    async (rotation) => {
      for (const edit of rotatedFreeTextEdits) {
        const equivalence = await renderBakedAndFlattenedMark(edit, await createRotatedPdf(rotation));

        expect(equivalence.annotationPdf.getPage(0).getRotation().angle).toBe(rotation);
        expect(readName(equivalence.annotation, "Subtype")).toBe("FreeText");
        expectTransformedBBoxMatchesAnnotationRect(equivalence);
        expectPaintedPathsInsideBBox(equivalence.apPaths, equivalence.apBBox);
        expectPaintedPathsEquivalent(
          equivalence.bakedPaths,
          equivalence.apPaths,
          equivalence.placementMatrix,
        );
        expectTextRunsEquivalent(
          equivalence.bakedTextRuns,
          equivalence.apTextRuns,
          equivalence.placementMatrix,
        );
      }
    },
  );
});

const EDIT_INK_RGB = [0x11 / 0xff, 0x11 / 0xff, 0x11 / 0xff] as const;

const markEquivalenceCases: ReadonlyArray<{
  name: string;
  edit: PdfEdit;
  expectedRect: number[];
  expectedQuadPoints?: number[];
}> = [
  {
    name: "ink",
    edit: {
      type: "ink",
      pageIndex: 0,
      strokeWidthPt: 2,
      color: { r: 0.2, g: 0.3, b: 0.4 },
      strokes: [
        [
          { x: 10, y: 10 },
          { x: 30, y: 40 },
          { x: 60, y: 20 },
        ],
      ],
    },
    expectedRect: [8.75, 8.75, 61.25, 41.25],
  },
  {
    name: "rectangle",
    edit: {
      type: "shape",
      pageIndex: 0,
      shape: "rect",
      rect: { x: 80, y: 120, w: 140, h: 60 },
      strokeWidthPt: 3,
      strokeColor: { r: 0.1, g: 0.2, b: 0.3 },
      fillColor: { r: 0.8, g: 0.7, b: 0.2 },
    },
    expectedRect: [78.25, 118.25, 221.75, 181.75],
  },
  {
    name: "ellipse",
    edit: {
      type: "shape",
      pageIndex: 0,
      shape: "ellipse",
      rect: { x: 100, y: 150, w: 80, h: 40 },
      strokeWidthPt: 2.5,
      strokeColor: { r: 0.3, g: 0.1, b: 0.7 },
      fillColor: { r: 0.2, g: 0.8, b: 0.4 },
    },
    expectedRect: [98.5, 148.5, 181.5, 191.5],
  },
  {
    name: "line",
    edit: {
      type: "shape",
      pageIndex: 0,
      shape: "line",
      from: { x: 30, y: 40 },
      to: { x: 200, y: 220 },
      strokeWidthPt: 4,
      strokeColor: { r: 0.9, g: 0.1, b: 0.1 },
    },
    expectedRect: [27.75, 37.75, 202.25, 222.25],
  },
  {
    name: "arrow",
    edit: {
      type: "shape",
      pageIndex: 0,
      shape: "arrow",
      from: { x: 40, y: 40 },
      to: { x: 140, y: 40 },
      strokeWidthPt: 2,
      strokeColor: { r: 0.15, g: 0.25, b: 0.35 },
    },
    expectedRect: [38.75, 32.45, 141.25, 47.55],
  },
  {
    name: "highlight",
    edit: {
      type: "highlight",
      pageIndex: 0,
      color: { r: 0.95, g: 0.8, b: 0.1 },
      opacity: 0.35,
      rects: [
        { x: 40, y: 700, w: 120, h: 14 },
        { x: 40, y: 680, w: 90, h: 14 },
      ],
    },
    expectedRect: [40, 680, 160, 714],
    expectedQuadPoints: [
      40, 714, 160, 714, 40, 700, 160, 700,
      40, 694, 130, 694, 40, 680, 130, 680,
    ],
  },
  {
    name: "underline",
    edit: {
      type: "underline",
      pageIndex: 0,
      color: { r: 0.2, g: 0.3, b: 0.4 },
      thicknessPt: 1.5,
      rects: [
        { x: 210, y: 640, w: 110, h: 12 },
        { x: 210, y: 622, w: 80, h: 12 },
      ],
    },
    expectedRect: [209, 621, 321, 653],
    expectedQuadPoints: [
      210, 652, 320, 652, 210, 640, 320, 640,
      210, 634, 290, 634, 210, 622, 290, 622,
    ],
  },
  {
    name: "strikethrough",
    edit: {
      type: "strikethrough",
      pageIndex: 0,
      color: { r: 0.7, g: 0.1, b: 0.2 },
      thicknessPt: 2,
      rects: [{ x: 80, y: 580, w: 130, h: 16 }],
    },
    expectedRect: [78.75, 578.75, 211.25, 597.25],
    expectedQuadPoints: [80, 596, 210, 596, 80, 580, 210, 580],
  },
];

const freeTextEquivalenceCases: ReadonlyArray<{ name: string; edit: PdfEdit }> = [
  {
    name: "left-aligned multiline text box",
    edit: {
      type: "textBox",
      pageIndex: 0,
      rect: { x: 40, y: 610, w: 115, h: 80 },
      text: "Alpha beta gamma\nDelta epsilon",
      fontSizePt: 12,
      align: "left",
      color: { r: 0.2, g: 0.3, b: 0.4 },
    },
  },
  {
    name: "center-aligned wrapped text box",
    edit: {
      type: "textBox",
      pageIndex: 0,
      rect: { x: 180, y: 600, w: 100, h: 90 },
      text: "Centered words wrap across lines",
      fontSizePt: 11,
      fontFamily: "courier",
      bold: true,
      align: "center",
      color: { r: 0.5, g: 0.1, b: 0.7 },
    },
  },
  {
    name: "right-aligned wrapped text box",
    edit: {
      type: "textBox",
      pageIndex: 0,
      rect: { x: 300, y: 600, w: 95, h: 90 },
      text: "Right aligned wrapping text",
      fontSizePt: 13,
      fontFamily: "times",
      italic: true,
      align: "right",
    },
  },
  {
    name: "callout with leader arrowhead and centered text",
    edit: {
      type: "callout",
      pageIndex: 0,
      rect: { x: 80, y: 420, w: 105, h: 70 },
      tip: { x: 260, y: 445 },
      text: "Callout wraps text here",
      fontSizePt: 12,
      fontFamily: "courier",
      bold: true,
      align: "center",
      color: { r: 0.8, g: 0.1, b: 0.2 },
      strokeColor: { r: 0.1, g: 0.2, b: 0.9 },
      strokeWidthPt: 3,
      boxFill: { r: 1, g: 0.95, b: 0.65 },
    },
  },
];

const freeTextOverflowCases: ReadonlyArray<{
  name: string;
  edit: Extract<PdfEdit, { type: "textBox" | "callout" }>;
}> = [
  {
    name: "text box",
    edit: {
      type: "textBox",
      pageIndex: 0,
      rect: { x: 40, y: 600, w: 110, h: 24 },
      text: "One\nTwo\nThree\nFour",
      fontSizePt: 12,
    },
  },
  {
    name: "callout",
    edit: {
      type: "callout",
      pageIndex: 0,
      rect: { x: 80, y: 120, w: 100, h: 20 },
      tip: { x: 240, y: 130 },
      text: "One\nTwo\nThree\nFour",
      fontSizePt: 12,
      strokeWidthPt: 3,
    },
  },
];

const rotatedFreeTextEdits: readonly PdfEdit[] = [
  {
    type: "textBox",
    pageIndex: 0,
    rect: { x: 120, y: 50, w: 30, h: 80 },
    text: "Rotated text",
    fontSizePt: 12,
    align: "right",
  },
  {
    type: "callout",
    pageIndex: 0,
    rect: { x: 120, y: 120, w: 45, h: 100 },
    tip: { x: 240, y: 180 },
    text: "Rotated callout",
    fontSizePt: 10,
    align: "center",
    strokeWidthPt: 2,
  },
];

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

function readRectArray(array: PDFArray): Rect {
  const [x1, y1, x2, y2] = readNumberArray(array);

  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    throw new Error("Expected four numeric rectangle values.");
  }

  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
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

type Matrix = readonly [number, number, number, number, number, number];

type Point = {
  x: number;
  y: number;
};

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type GraphicsStateAlpha = {
  fillAlpha: number | undefined;
  strokeAlpha: number | undefined;
};

type PaintState = {
  strokeColor: readonly [number, number, number] | undefined;
  fillColor: readonly [number, number, number] | undefined;
  strokeWidth: number | undefined;
  lineCap: number | undefined;
  fillAlpha: number;
  strokeAlpha: number;
};

type PathSegment =
  | { op: "m" | "l"; point: Point }
  | { op: "c"; points: readonly [Point, Point, Point] }
  | { op: "re"; corners: readonly [Point, Point, Point, Point] }
  | { op: "h" };

type PaintedPath = {
  paint: string;
  state: PaintState;
  segments: readonly PathSegment[];
};

type TextRun = {
  text: string;
  matrix: Matrix;
  font: string | undefined;
  fontSize: number | undefined;
  fillColor: readonly [number, number, number] | undefined;
};

type MarkEquivalence = {
  annotation: PDFDict;
  annotationPdf: PDFDocument;
  apBBox: Rect;
  apMatrix: Matrix;
  apPaths: readonly PaintedPath[];
  apTextRuns: readonly TextRun[];
  bakedPaths: readonly PaintedPath[];
  bakedTextRuns: readonly TextRun[];
  placementMatrix: Matrix;
};

async function renderBakedAndFlattenedMark(
  edit: PdfEdit,
  sourceBytes: Uint8Array,
): Promise<MarkEquivalence> {
  const engine = createLocalPdfEngine();
  const bakedSource = await engine.open(sourceBytes);
  const annotationSource = await engine.open(sourceBytes);
  const baked = await engine.applyEdits(bakedSource, [edit], { markupMode: "baked" });
  const annotationMode = await engine.applyEdits(annotationSource, [edit], { markupMode: "annotation" });
  const bakedBytes = await engine.saveToBytes(baked);
  const annotationBytes = await engine.saveToBytes(annotationMode);
  const annotationPdf = await PDFDocument.load(annotationBytes);
  const annotations = readPageAnnotations(annotationPdf, 0);
  const [annotation] = annotations;

  expect(annotations).toHaveLength(1);
  expect(annotation).toBeDefined();

  const flattened = await engine.flattenMarkupAnnotations(annotationMode);
  const flattenedBytes = await engine.saveToBytes(flattened);
  const flattenedPdf = await PDFDocument.load(flattenedBytes);
  const flattenedContent = await readDecodedPageContent(flattenedBytes, 0);
  const appearancePlacement = readSingleFlattenedAppearance(flattenedPdf, flattenedContent);
  const appearanceStream = readPageXObjectStream(
    flattenedPdf,
    0,
    appearancePlacement.name.replace(/^\//, ""),
  );

  if (!appearanceStream) {
    throw new Error(`Expected flattened appearance ${appearancePlacement.name} to be present.`);
  }

  const apMatrix = readOptionalMatrix(appearanceStream.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray));
  const apBBox = readRectArray(appearanceStream.dict.lookup(PDFName.of("BBox"), PDFArray));

  expect(readRaioPdfMarkupAnnotations(flattenedPdf.getPage(0))).toHaveLength(0);
  expect(flattenedPdf.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)).toBeUndefined();

  return {
    annotation: annotation!,
    annotationPdf,
    apBBox,
    apMatrix,
    apPaths: readPaintedPaths(decodePdfStream(appearanceStream), readStreamExtGStates(flattenedPdf, appearanceStream)),
    apTextRuns: readTextRuns(decodePdfStream(appearanceStream)),
    bakedPaths: readPaintedPaths(
      await readDecodedPageContent(bakedBytes, 0),
      readPageExtGStates(await PDFDocument.load(bakedBytes), 0),
    ),
    bakedTextRuns: readTextRuns(await readDecodedPageContent(bakedBytes, 0)),
    placementMatrix: multiplyMatrices(appearancePlacement.matrix, apMatrix),
  };
}

function readSingleFlattenedAppearance(
  pdf: PDFDocument,
  content: string,
): { name: string; matrix: Matrix } {
  const appearances = readFlattenedAppearances(content).filter(({ name }) =>
    Boolean(readPageXObjectStream(pdf, 0, name.replace(/^\//, ""), false)),
  );

  expect(appearances).toHaveLength(1);

  return appearances[0]!;
}

function readFlattenedAppearances(content: string): Array<{ name: string; matrix: Matrix }> {
  const tokens = tokenizePdfContent(content);
  const stack: Array<number | string> = [];
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = identityMatrix();
  const appearances: Array<{ name: string; matrix: Matrix }> = [];

  for (const token of tokens) {
    if (isNumberToken(token)) {
      stack.push(Number(token));
      continue;
    }

    if (token.startsWith("/")) {
      stack.push(token);
      continue;
    }

    if (token === "q") {
      ctmStack.push(ctm);
      stack.length = 0;
      continue;
    }

    if (token === "Q") {
      ctm = ctmStack.pop() ?? identityMatrix();
      stack.length = 0;
      continue;
    }

    if (token === "cm") {
      ctm = multiplyMatrices(ctm, popMatrix(stack));
      stack.length = 0;
      continue;
    }

    if (token === "Do") {
      const name = popName(stack);
      appearances.push({ name, matrix: ctm });
      stack.length = 0;
      continue;
    }

    if (isPdfOperator(token)) {
      stack.length = 0;
    }
  }

  return appearances;
}

function readPageXObjectStream(
  pdf: PDFDocument,
  pageIndex: number,
  name: string,
  required = true,
): PDFStream | undefined {
  const resources = pdf.getPage(pageIndex).node.Resources();
  const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  const entry = xObjects?.get(PDFName.of(name));
  const stream = entry instanceof PDFRef ? pdf.context.lookup(entry, PDFStream) : entry;

  if (stream instanceof PDFStream) {
    return stream;
  }

  if (required) {
    throw new Error(`Expected page XObject /${name} to be a stream.`);
  }

  return undefined;
}

function readString(dict: PDFDict, key: string): string {
  const value = dict.lookup(PDFName.of(key), PDFString, PDFHexString);

  return value.decodeText();
}

function expectFreeTextAppearanceFontCoherence(
  pdf: PDFDocument,
  annotation: PDFDict,
  fontSize: number,
  color: readonly [number, number, number],
): void {
  const da = readString(annotation, "DA");
  const appearance = readNormalAppearanceStream(pdf, annotation);
  const content = decodePdfStream(appearance);
  const resources = appearance.dict.lookup(PDFName.of("Resources"), PDFDict);
  const fonts = resources.lookup(PDFName.of("Font"), PDFDict);
  const fontNames = [...fonts.entries()].map(([name]) => name.toString());
  const daFont = da.match(/(\/\S+)\s+[-+]?(?:\d+\.?\d*|\.\d+)\s+Tf/)?.[1];

  expect(da).toContain(" Tf ");
  expect(da).toContain(" rg");
  expect(daFont).toBeDefined();
  expect(fontNames).toContain(daFont);
  expect(content).toContain(`${daFont} ${fontSize} Tf`);
  expect(readTextRuns(content).some((run) => colorsClose(run.fillColor, color))).toBe(true);
  expect(decodePdfStream(appearance).length).toBeGreaterThan(0);
}

function readPaintedPaths(
  content: string,
  extGStates: ReadonlyMap<string, GraphicsStateAlpha>,
): PaintedPath[] {
  const tokens = tokenizePdfContent(content);
  const stack: Array<number | string> = [];
  const stateStack: PaintState[] = [];
  const ctmStack: Matrix[] = [];
  let state = defaultPaintState();
  let ctm: Matrix = identityMatrix();
  let path: PathSegment[] = [];
  const paintedPaths: PaintedPath[] = [];

  for (const token of tokens) {
    if (isNumberToken(token)) {
      stack.push(Number(token));
      continue;
    }

    if (token.startsWith("/")) {
      stack.push(token);
      continue;
    }

    switch (token) {
      case "q":
        stateStack.push(clonePaintState(state));
        ctmStack.push(ctm);
        stack.length = 0;
        break;
      case "Q":
        state = stateStack.pop() ?? defaultPaintState();
        ctm = ctmStack.pop() ?? identityMatrix();
        stack.length = 0;
        break;
      case "cm":
        ctm = multiplyMatrices(ctm, popMatrix(stack));
        stack.length = 0;
        break;
      case "w":
        state = { ...state, strokeWidth: popNumber(stack) };
        stack.length = 0;
        break;
      case "J":
        state = { ...state, lineCap: popNumber(stack) };
        stack.length = 0;
        break;
      case "RG":
        state = { ...state, strokeColor: popColor(stack) };
        stack.length = 0;
        break;
      case "rg":
        state = { ...state, fillColor: popColor(stack) };
        stack.length = 0;
        break;
      case "G": {
        const gray = popNumber(stack);
        state = { ...state, strokeColor: [gray, gray, gray] };
        stack.length = 0;
        break;
      }
      case "g": {
        const gray = popNumber(stack);
        state = { ...state, fillColor: [gray, gray, gray] };
        stack.length = 0;
        break;
      }
      case "gs": {
        const graphicsState = extGStates.get(popName(stack).replace(/^\//, ""));
        state = {
          ...state,
          fillAlpha: graphicsState?.fillAlpha ?? state.fillAlpha,
          strokeAlpha: graphicsState?.strokeAlpha ?? state.strokeAlpha,
        };
        stack.length = 0;
        break;
      }
      case "m":
        path.push({ op: "m", point: transformPoint(ctm, popPoint(stack)) });
        stack.length = 0;
        break;
      case "l":
        path.push({ op: "l", point: transformPoint(ctm, popPoint(stack)) });
        stack.length = 0;
        break;
      case "c": {
        const points = popCubicPoints(stack).map((point) => transformPoint(ctm, point)) as [
          Point,
          Point,
          Point,
        ];
        path.push({ op: "c", points });
        stack.length = 0;
        break;
      }
      case "re":
        path.push({ op: "re", corners: transformRectCorners(ctm, popRect(stack)) });
        stack.length = 0;
        break;
      case "h":
        path.push({ op: "h" });
        stack.length = 0;
        break;
      case "n":
        path = [];
        stack.length = 0;
        break;
      case "S":
      case "s":
      case "f":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*":
        paintedPaths.push({ paint: token, state: clonePaintState(state), segments: [...path] });
        path = [];
        stack.length = 0;
        break;
      default:
        if (isPdfOperator(token)) {
          stack.length = 0;
        }
        break;
    }
  }

  return paintedPaths;
}

function readTextRuns(content: string): TextRun[] {
  const tokens = tokenizePdfContent(content);
  const stack: Array<number | string> = [];
  const textMatrixStack: Matrix[] = [];
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = identityMatrix();
  let textMatrix: Matrix = identityMatrix();
  let font: string | undefined;
  let fontSize: number | undefined;
  let fillColor: readonly [number, number, number] | undefined;
  const runs: TextRun[] = [];

  for (const token of tokens) {
    if (isNumberToken(token)) {
      stack.push(Number(token));
      continue;
    }

    if (token.startsWith("/") || isHexTextToken(token)) {
      stack.push(token);
      continue;
    }

    switch (token) {
      case "q":
        ctmStack.push(ctm);
        stack.length = 0;
        break;
      case "Q":
        ctm = ctmStack.pop() ?? identityMatrix();
        stack.length = 0;
        break;
      case "cm":
        ctm = multiplyMatrices(ctm, popMatrix(stack));
        stack.length = 0;
        break;
      case "BT":
        textMatrixStack.push(textMatrix);
        textMatrix = identityMatrix();
        stack.length = 0;
        break;
      case "ET":
        textMatrix = textMatrixStack.pop() ?? identityMatrix();
        stack.length = 0;
        break;
      case "rg":
        fillColor = popColor(stack);
        stack.length = 0;
        break;
      case "Tf":
        fontSize = popNumber(stack);
        font = popName(stack);
        stack.length = 0;
        break;
      case "Tm":
        textMatrix = multiplyMatrices(ctm, popMatrix(stack));
        stack.length = 0;
        break;
      case "Tj":
        runs.push({
          text: popHexText(stack),
          matrix: textMatrix,
          font,
          fontSize,
          fillColor,
        });
        stack.length = 0;
        break;
      default:
        if (isPdfOperator(token)) {
          stack.length = 0;
        }
        break;
    }
  }

  return runs;
}

function readPageExtGStates(
  pdf: PDFDocument,
  pageIndex: number,
): ReadonlyMap<string, GraphicsStateAlpha> {
  return readExtGStates(pdf, pdf.getPage(pageIndex).node.Resources());
}

function readStreamExtGStates(
  pdf: PDFDocument,
  stream: PDFStream,
): ReadonlyMap<string, GraphicsStateAlpha> {
  return readExtGStates(pdf, stream.dict.lookupMaybe(PDFName.of("Resources"), PDFDict));
}

function readExtGStates(
  pdf: PDFDocument,
  resources: PDFDict | undefined,
): ReadonlyMap<string, GraphicsStateAlpha> {
  const extGState = resources?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  const states = new Map<string, GraphicsStateAlpha>();

  if (!extGState) {
    return states;
  }

  for (const [name, entry] of extGState.entries()) {
    const dict = entry instanceof PDFRef ? pdf.context.lookup(entry, PDFDict) : entry;

    if (!(dict instanceof PDFDict)) {
      continue;
    }

    states.set(name.toString().replace(/^\//, ""), {
      fillAlpha: dict.lookupMaybe(PDFName.of("ca"), PDFNumber)?.asNumber(),
      strokeAlpha: dict.lookupMaybe(PDFName.of("CA"), PDFNumber)?.asNumber(),
    });
  }

  return states;
}

function expectPaintedPathsEquivalent(
  bakedPaths: readonly PaintedPath[],
  apPaths: readonly PaintedPath[],
  placementMatrix: Matrix,
): void {
  expect(apPaths).toHaveLength(bakedPaths.length);

  const mappedApPaths = apPaths.map((path) => transformPaintedPath(path, placementMatrix));

  for (let index = 0; index < bakedPaths.length; index += 1) {
    expectPaintedPathClose(mappedApPaths[index]!, bakedPaths[index]!);
  }
}

function expectTextRunsEquivalent(
  bakedRuns: readonly TextRun[],
  apRuns: readonly TextRun[],
  placementMatrix: Matrix,
): void {
  expect(apRuns).toHaveLength(bakedRuns.length);

  const mappedRuns = apRuns.map((run) => transformTextRun(run, placementMatrix));

  for (let index = 0; index < bakedRuns.length; index += 1) {
    expectTextRunClose(mappedRuns[index]!, bakedRuns[index]!);
  }
}

function expectTextRunClose(actual: TextRun, expected: TextRun): void {
  expect(actual.text).toBe(expected.text);
  expectOptionalNumberClose(actual.fontSize, expected.fontSize);
  expectColorClose(actual.fillColor, expected.fillColor);
  expectNumbersClose(actual.matrix, expected.matrix);
}

function expectTransformedBBoxMatchesAnnotationRect(equivalence: MarkEquivalence): void {
  const actual = transformBounds(rectToBounds(equivalence.apBBox), equivalence.placementMatrix);
  const expected = rectToBounds(readRectArray(equivalence.annotation.lookup(PDFName.of("Rect"), PDFArray)));

  expectBoundsClose(actual, expected);
}

function expectPaintedPathsInsideBBox(apPaths: readonly PaintedPath[], bbox: Rect): void {
  const bboxBounds = rectToBounds(bbox);

  for (const path of apPaths) {
    const pathBounds = paintedPathExtent(path);

    if (!pathBounds) {
      continue;
    }

    if (paintsFill(path.paint)) {
      expect(pathBounds.minX).toBeGreaterThanOrEqual(bboxBounds.minX);
      expect(pathBounds.minY).toBeGreaterThanOrEqual(bboxBounds.minY);
      expect(pathBounds.maxX).toBeLessThanOrEqual(bboxBounds.maxX);
      expect(pathBounds.maxY).toBeLessThanOrEqual(bboxBounds.maxY);
    }

    if (paintsStroke(path.paint)) {
      expect(pathBounds.minX).toBeGreaterThan(bboxBounds.minX + 0.001);
      expect(pathBounds.minY).toBeGreaterThan(bboxBounds.minY + 0.001);
      expect(pathBounds.maxX).toBeLessThan(bboxBounds.maxX - 0.001);
      expect(pathBounds.maxY).toBeLessThan(bboxBounds.maxY - 0.001);
    }
  }
}

function expectPaintedPathClose(actual: PaintedPath, expected: PaintedPath): void {
  expect(actual.paint).toBe(expected.paint);
  expect(actual.segments).toHaveLength(expected.segments.length);
  expectPaintStateClose(actual.state, expected.state);

  for (let index = 0; index < expected.segments.length; index += 1) {
    expectPathSegmentClose(actual.segments[index]!, expected.segments[index]!);
  }
}

function expectPaintStateClose(actual: PaintState, expected: PaintState): void {
  expectColorClose(actual.strokeColor, expected.strokeColor);
  expectColorClose(actual.fillColor, expected.fillColor);
  expectOptionalNumberClose(actual.strokeWidth, expected.strokeWidth);
  expectOptionalNumberClose(actual.lineCap, expected.lineCap);
  expectNumbersClose([actual.fillAlpha, actual.strokeAlpha], [expected.fillAlpha, expected.strokeAlpha]);
}

function expectPathSegmentClose(actual: PathSegment, expected: PathSegment): void {
  expect(actual.op).toBe(expected.op);

  switch (expected.op) {
    case "m":
    case "l":
      expectPointClose((actual as Extract<PathSegment, { op: "m" | "l" }>).point, expected.point);
      break;
    case "c": {
      const actualCubic = actual as Extract<PathSegment, { op: "c" }>;
      for (let index = 0; index < expected.points.length; index += 1) {
        expectPointClose(actualCubic.points[index]!, expected.points[index]!);
      }
      break;
    }
    case "re": {
      const actualRect = actual as Extract<PathSegment, { op: "re" }>;
      for (let index = 0; index < expected.corners.length; index += 1) {
        expectPointClose(actualRect.corners[index]!, expected.corners[index]!);
      }
      break;
    }
    case "h":
      break;
  }
}

function expectColorClose(
  actual: readonly [number, number, number] | undefined,
  expected: readonly [number, number, number] | undefined,
): void {
  if (!expected || !actual) {
    expect(actual).toBe(expected);
    return;
  }

  expectNumbersClose(actual, expected);
}

function colorsClose(
  actual: readonly [number, number, number] | undefined,
  expected: readonly [number, number, number],
): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => Math.abs(value - expected[index]!) <= 0.001)
  );
}

function expectOptionalNumberClose(actual: number | undefined, expected: number | undefined): void {
  if (expected === undefined || actual === undefined) {
    expect(actual).toBe(expected);
    return;
  }

  expectNumberClose(actual, expected);
}

function expectPointClose(actual: Point, expected: Point): void {
  expectNumberClose(actual.x, expected.x);
  expectNumberClose(actual.y, expected.y);
}

function expectNumbersClose(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);

  for (let index = 0; index < expected.length; index += 1) {
    expectNumberClose(actual[index]!, expected[index]!);
  }
}

function expectBoundsClose(actual: Bounds, expected: Bounds): void {
  expectNumberClose(actual.minX, expected.minX);
  expectNumberClose(actual.minY, expected.minY);
  expectNumberClose(actual.maxX, expected.maxX);
  expectNumberClose(actual.maxY, expected.maxY);
}

function expectBoundsToContain(actual: Bounds, expected: Bounds): void {
  expect(actual.minX).toBeLessThanOrEqual(expected.minX + 0.001);
  expect(actual.minY).toBeLessThanOrEqual(expected.minY + 0.001);
  expect(actual.maxX).toBeGreaterThanOrEqual(expected.maxX - 0.001);
  expect(actual.maxY).toBeGreaterThanOrEqual(expected.maxY - 0.001);
}

function expectNumberClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.001);
}

function transformPaintedPath(path: PaintedPath, matrix: Matrix): PaintedPath {
  return {
    ...path,
    segments: path.segments.map((segment) => transformPathSegment(segment, matrix)),
  };
}

function transformTextRun(run: TextRun, matrix: Matrix): TextRun {
  return {
    ...run,
    matrix: multiplyMatrices(matrix, run.matrix),
  };
}

function transformPathSegment(segment: PathSegment, matrix: Matrix): PathSegment {
  switch (segment.op) {
    case "m":
    case "l":
      return { ...segment, point: transformPoint(matrix, segment.point) };
    case "c":
      return {
        ...segment,
        points: segment.points.map((point) => transformPoint(matrix, point)) as [Point, Point, Point],
      };
    case "re":
      return {
        ...segment,
        corners: segment.corners.map((point) => transformPoint(matrix, point)) as [
          Point,
          Point,
          Point,
          Point,
        ],
      };
    case "h":
      return segment;
  }
}

function tokenizePdfContent(content: string): string[] {
  return content.match(/\/[^\s[\]<>/()]+|[+-]?(?:\d+\.?\d*|\.\d+)|\S+/g) ?? [];
}

function isNumberToken(token: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token);
}

function isPdfOperator(token: string): boolean {
  return /^[A-Za-z*'"]+$/.test(token);
}

function isHexTextToken(token: string): boolean {
  return /^<[0-9A-Fa-f]*>$/.test(token);
}

function popNumber(stack: Array<number | string>): number {
  const value = stack.pop();

  if (typeof value !== "number") {
    throw new Error(`Expected numeric PDF operand, saw ${String(value)}.`);
  }

  return value;
}

function popName(stack: Array<number | string>): string {
  const value = stack.pop();

  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`Expected PDF name operand, saw ${String(value)}.`);
  }

  return value;
}

function popHexText(stack: Array<number | string>): string {
  const value = stack.pop();

  if (typeof value !== "string" || !isHexTextToken(value)) {
    throw new Error(`Expected hex text PDF operand, saw ${String(value)}.`);
  }

  return decodeHexText(value.slice(1, -1));
}

function popColor(stack: Array<number | string>): [number, number, number] {
  const b = popNumber(stack);
  const g = popNumber(stack);
  const r = popNumber(stack);

  return [r, g, b];
}

function popPoint(stack: Array<number | string>): Point {
  const y = popNumber(stack);
  const x = popNumber(stack);

  return { x, y };
}

function popCubicPoints(stack: Array<number | string>): [Point, Point, Point] {
  const y3 = popNumber(stack);
  const x3 = popNumber(stack);
  const y2 = popNumber(stack);
  const x2 = popNumber(stack);
  const y1 = popNumber(stack);
  const x1 = popNumber(stack);

  return [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
    { x: x3, y: y3 },
  ];
}

function popRect(stack: Array<number | string>): readonly [number, number, number, number] {
  const h = popNumber(stack);
  const w = popNumber(stack);
  const y = popNumber(stack);
  const x = popNumber(stack);

  return [x, y, w, h];
}

function popMatrix(stack: Array<number | string>): Matrix {
  const f = popNumber(stack);
  const e = popNumber(stack);
  const d = popNumber(stack);
  const c = popNumber(stack);
  const b = popNumber(stack);
  const a = popNumber(stack);

  return [a, b, c, d, e, f];
}

function decodeHexText(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  return new TextDecoder().decode(bytes);
}

function readOptionalMatrix(array: PDFArray | undefined): Matrix {
  if (!array) {
    return identityMatrix();
  }

  const values = readNumberArray(array);

  expect(values).toHaveLength(6);

  return values as [number, number, number, number, number, number];
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

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function multiplyMatrices(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;

  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function transformPoint(matrix: Matrix, point: Point): Point {
  const [a, b, c, d, e, f] = matrix;

  return {
    x: a * point.x + c * point.y + e,
    y: b * point.x + d * point.y + f,
  };
}

function transformRectCorners(
  matrix: Matrix,
  [x, y, w, h]: readonly [number, number, number, number],
): [Point, Point, Point, Point] {
  return [
    transformPoint(matrix, { x, y }),
    transformPoint(matrix, { x: x + w, y }),
    transformPoint(matrix, { x: x + w, y: y + h }),
    transformPoint(matrix, { x, y: y + h }),
  ];
}

function rectToBounds(rect: Rect): Bounds {
  return {
    minX: rect.x,
    minY: rect.y,
    maxX: rect.x + rect.w,
    maxY: rect.y + rect.h,
  };
}

function clipTextRunsToBBox(runs: readonly TextRun[], bbox: Rect): TextRun[] {
  const bboxBounds = rectToBounds(bbox);

  return runs.filter((run) => boundsContains(bboxBounds, textRunLineBounds([run])));
}

function textRunLineBounds(runs: readonly TextRun[]): Bounds {
  return boundsForPoints(
    runs.flatMap((run) => {
      const fontSize = run.fontSize ?? 0;

      return [
        transformPoint(run.matrix, { x: 0, y: 0 }),
        transformPoint(run.matrix, { x: 0, y: fontSize }),
      ];
    }),
  );
}

function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX + 0.001 &&
    outer.minY <= inner.minY + 0.001 &&
    outer.maxX >= inner.maxX - 0.001 &&
    outer.maxY >= inner.maxY - 0.001
  );
}

function paintedPathExtent(path: PaintedPath): Bounds | undefined {
  const points = path.segments.flatMap(segmentPoints);

  if (points.length === 0) {
    return undefined;
  }

  const geometricBounds = boundsForPoints(points);

  if (!paintsStroke(path.paint)) {
    return geometricBounds;
  }

  const strokeOutset = (path.state.strokeWidth ?? 1) / 2;

  return outsetBounds(geometricBounds, strokeOutset);
}

function segmentPoints(segment: PathSegment): Point[] {
  switch (segment.op) {
    case "m":
    case "l":
      return [segment.point];
    case "c":
      return [...segment.points];
    case "re":
      return [...segment.corners];
    case "h":
      return [];
  }
}

function boundsForPoints(points: readonly Point[]): Bounds {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function outsetBounds(bounds: Bounds, amount: number): Bounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount,
  };
}

function intersectBounds(a: Bounds, b: Bounds): Bounds | undefined {
  const bounds = {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };

  return bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY ? bounds : undefined;
}

function transformBounds(bounds: Bounds, matrix: Matrix): Bounds {
  return boundsForPoints([
    transformPoint(matrix, { x: bounds.minX, y: bounds.minY }),
    transformPoint(matrix, { x: bounds.maxX, y: bounds.minY }),
    transformPoint(matrix, { x: bounds.maxX, y: bounds.maxY }),
    transformPoint(matrix, { x: bounds.minX, y: bounds.maxY }),
  ]);
}

function paintsStroke(paint: string): boolean {
  return ["S", "s", "B", "B*", "b", "b*"].includes(paint);
}

function paintsFill(paint: string): boolean {
  return ["f", "f*", "B", "B*", "b", "b*"].includes(paint);
}

function defaultPaintState(): PaintState {
  return {
    strokeColor: undefined,
    fillColor: undefined,
    strokeWidth: undefined,
    lineCap: undefined,
    fillAlpha: 1,
    strokeAlpha: 1,
  };
}

function clonePaintState(state: PaintState): PaintState {
  return {
    strokeColor: state.strokeColor ? [...state.strokeColor] : undefined,
    fillColor: state.fillColor ? [...state.fillColor] : undefined,
    strokeWidth: state.strokeWidth,
    lineCap: state.lineCap,
    fillAlpha: state.fillAlpha,
    strokeAlpha: state.strokeAlpha,
  };
}
