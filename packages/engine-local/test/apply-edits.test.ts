import { PdfEngineError, type PdfEdit } from "@raiopdf/engine-api";
import { wrapTextBoxLines } from "@raiopdf/engine-api";
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
  StandardFonts,
} from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createLocalPdfEngine } from "../src/index";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type LocalEngine = ReturnType<typeof createLocalPdfEngine>;
type ApplyEditsArgs = Parameters<LocalEngine["applyEdits"]>;

function applyBakedEdits(
  engine: LocalEngine,
  document: ApplyEditsArgs[0],
  edits: ApplyEditsArgs[1],
  options: ApplyEditsArgs[2] = {},
) {
  return engine.applyEdits(document, edits, { markupMode: "baked", ...options });
}

describe("LocalPdfEngine.applyEdits", () => {
  it("bakes highlight edits as translucent rectangles at the given rects", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
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

  it("draws underline edits as one baseline line per rect", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "underline",
        pageIndex: 0,
        rects: [
          { x: 40, y: 100, w: 120, h: 14 },
          { x: 40, y: 84, w: 90, h: 14 },
        ],
        color: { r: 0.7, g: 0.1, b: 0.2 },
        thicknessPt: 2,
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);

    expect(content).toMatch(/\b2 w\b/);
    expectSomeOperandsWithin(readOperandPairs(content, "RG"), [0.7, 0.1, 0.2]);
    expectSomePointWithin1Pt(
      readOperandPairs(content, "m").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 40, y: 100 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 160, y: 100 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "m").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 40, y: 84 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 130, y: 84 },
    );
  });

  it("draws strikethrough edits through each rect midpoint", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "strikethrough",
        pageIndex: 0,
        rects: [
          { x: 40, y: 100, w: 120, h: 14 },
          { x: 40, y: 84, w: 90, h: 10 },
        ],
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);

    expect(content).toMatch(/\b1 w\b/);
    expectSomePointWithin1Pt(
      readOperandPairs(content, "m").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 40, y: 107 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 160, y: 107 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "m").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 40, y: 89 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 130, y: 89 },
    );
  });

  it("draws text box edits with the first baseline below the rect's top edge", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
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

  it("draws text box background fills before the text", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 72, y: 700, w: 200, h: 40 },
        text: "Filled box",
        fontSizePt: 12,
        backgroundColor: { r: 1, g: 0.9, b: 0.3 },
        backgroundOpacity: 0.45,
      },
    ]);
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);
    const graphicsStateIndex = content.search(/\/GS\S* gs/);
    const textIndex = content.indexOf(encodeTextAsHex("Filled box"));

    expect(content).toMatch(/\/GS\S* gs/);
    expect(textIndex).toBeGreaterThan(graphicsStateIndex);
  });

  it("rejects invalid text box background colors", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "textBox",
          pageIndex: 0,
          rect: { x: 72, y: 700, w: 200, h: 40 },
          text: "Bad fill",
          fontSizePt: 12,
          backgroundColor: { r: Number.NaN, g: 0.9, b: 0.3 },
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("preserves authored whitespace for text box lines that do not need wrapping", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 200]]));
    const text = "  Alpha   beta  gamma";

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 40, y: 120, w: 220, h: 40 },
        text,
        fontSizePt: 12,
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const content = await readDecodedPageContent(bytes, 0);

    expect(readTextDraws(content)).toEqual([text]);
    expect(content).toContain(encodeTextAsHex(text));
  });

  it("renders all standard text box font faces as page font resources", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));
    const faces = [
      ["helvetica", false, false, "Helvetica"],
      ["helvetica", true, false, "Helvetica-Bold"],
      ["helvetica", false, true, "Helvetica-Oblique"],
      ["helvetica", true, true, "Helvetica-BoldOblique"],
      ["times", false, false, "Times-Roman"],
      ["times", true, false, "Times-Bold"],
      ["times", false, true, "Times-Italic"],
      ["times", true, true, "Times-BoldItalic"],
      ["courier", false, false, "Courier"],
      ["courier", true, false, "Courier-Bold"],
      ["courier", false, true, "Courier-Oblique"],
      ["courier", true, true, "Courier-BoldOblique"],
    ] as const;

    const edited = await applyBakedEdits(
      engine,
      document,
      faces.map(([fontFamily, bold, italic], index) => ({
        type: "textBox",
        pageIndex: 0,
        rect: { x: 40, y: 720 - index * 20, w: 220, h: 18 },
        text: `Face ${index}`,
        fontSizePt: 10,
        fontFamily,
        bold,
        italic,
      })),
    );
    const bytes = await engine.saveToBytes(edited);
    const pdf = await PDFDocument.load(bytes);
    const content = await readDecodedPageContent(bytes, 0);
    const baseFonts = readPageBaseFonts(pdf, 0);

    for (const [, , , baseFont] of faces) {
      expect(baseFonts).toContain(baseFont);
    }
    expect(content.match(/\/\S+ 10 Tf/g) ?? []).toHaveLength(faces.length);
  });

  it("offsets each text box line for left, center, and right alignment", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 200]]));
    const measurePdf = await PDFDocument.create();
    const font = await measurePdf.embedFont(StandardFonts.Helvetica);
    const text = "Align";
    const fontSizePt = 10;
    const rect = { x: 20, y: 120, w: 100, h: 20 };
    const lineWidth = font.widthOfTextAtSize(text, fontSizePt);

    const edited = await applyBakedEdits(engine, document, [
      { type: "textBox", pageIndex: 0, rect, text, fontSizePt, align: "left" },
      {
        type: "textBox",
        pageIndex: 0,
        rect: { ...rect, y: 90 },
        text,
        fontSizePt,
        align: "center",
      },
      {
        type: "textBox",
        pageIndex: 0,
        rect: { ...rect, y: 60 },
        text,
        fontSizePt,
        align: "right",
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const matrices = readOperandPairs(await readDecodedPageContent(bytes, 0), "Tm");

    expectWithin1Pt(matrices[0]![4]!, rect.x);
    expectWithin1Pt(matrices[1]![4]!, rect.x + (rect.w - lineWidth) / 2);
    expectWithin1Pt(matrices[2]![4]!, rect.x + rect.w - lineWidth);
  });

  it("applies text alignment offsets through the existing rotated-page mapping", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));
    const rotated = await engine.rotatePages(document, [0], 90);
    const measurePdf = await PDFDocument.create();
    const font = await measurePdf.embedFont(StandardFonts.Helvetica);
    const text = "Rot";
    const fontSizePt = 12;
    const visualWidth = 80;
    const lineWidth = font.widthOfTextAtSize(text, fontSizePt);

    const edited = await applyBakedEdits(engine, rotated, [
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 120, y: 50, w: 30, h: 80 },
        text,
        fontSizePt,
        align: "right",
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const [matrix] = readOperandPairs(await readDecodedPageContent(bytes, 0), "Tm");

    if (!matrix) {
      throw new Error("Expected the rotated page to contain a text matrix.");
    }

    expectWithin1Pt(matrix[0]!, 0);
    expectWithin1Pt(matrix[1]!, 1);
    expectWithin1Pt(matrix[2]!, -1);
    expectWithin1Pt(matrix[3]!, 0);
    expectWithin1Pt(matrix[4]!, 132);
    expectWithin1Pt(matrix[5]!, 50 + visualWidth - lineWidth);
  });

  it("wraps text boxes with pdf-lib font metrics, including long words", async () => {
    const measurePdf = await PDFDocument.create();
    const font = await measurePdf.embedFont(StandardFonts.Helvetica);
    const lines = wrapTextBoxLines({
      text: "Alpha beta extraordinarilylongword",
      boxWidthPt: 60,
      fontSizePt: 12,
      font,
    });

    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toBe("Alpha beta");
    expect(lines.some((line) => line.length < "extraordinarilylongword".length)).toBe(true);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 12)).toBeLessThanOrEqual(60);
    }
  });

  it("bakes wrapped lines with the selected font metrics", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[240, 240]]));
    const text = "Preview wraps these words\nand splits supercalifragilistic";
    const expectedLines = [
      "Preview wraps ",
      "these words",
      "and splits ",
      "supercalifragilist",
      "ic",
    ];

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 24, y: 100, w: 86, h: 100 },
        text,
        fontSizePt: 12,
        fontFamily: "times",
        bold: true,
        italic: true,
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const bakedLines = readTextDraws(await readDecodedPageContent(bytes, 0));

    expect(bakedLines).toEqual(expectedLines);
  });

  it("draws callouts as a box-edge leader, arrowhead, box, and wrapped text", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 240]]));
    const measurePdf = await PDFDocument.create();
    const font = await measurePdf.embedFont(StandardFonts.CourierBold);
    const rect = { x: 40, y: 120, w: 80, h: 50 };
    const tip = { x: 180, y: 145 };
    const text = "Alpha beta gamma";
    const fontSizePt = 12;
    const expectedLines = wrapTextBoxLines({
      text,
      boxWidthPt: rect.w,
      fontSizePt,
      font,
    });

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "callout",
        pageIndex: 0,
        rect,
        tip,
        text,
        fontSizePt,
        fontFamily: "courier",
        bold: true,
        align: "center",
        color: { r: 0.8, g: 0.1, b: 0.2 },
        strokeColor: { r: 0.1, g: 0.2, b: 0.9 },
        strokeWidthPt: 3,
        boxFill: { r: 1, g: 0.95, b: 0.65 },
      },
    ]);
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);
    const moves = readOperandPairs(content, "m").map((values) => ({
      x: values[0]!,
      y: values[1]!,
    }));
    const lines = readOperandPairs(content, "l").map((values) => ({
      x: values[0]!,
      y: values[1]!,
    }));
    const matrices = readOperandPairs(content, "Tm");
    const firstLineWidth = font.widthOfTextAtSize(expectedLines[0]!, fontSizePt);

    expect(content).toMatch(/\b3 w\b/);
    expectSomeOperandsWithin(readOperandPairs(content, "RG"), [0.1, 0.2, 0.9]);
    expectSomeOperandsWithin(readOperandPairs(content, "rg"), [1, 0.95, 0.65]);
    expectSomeOperandsWithin(readOperandPairs(content, "rg"), [0.8, 0.1, 0.2]);
    expectSomePointWithin1Pt(moves, { x: 120, y: 145 });
    expectSomePointWithin1Pt(lines, tip);
    expectSomePointWithin1Pt(moves, tip);
    expect(readTextDraws(content)).toEqual(expectedLines);
    expectWithin1Pt(matrices[0]![4]!, rect.x + (rect.w - firstLineWidth) / 2);
    expectWithin1Pt(matrices[0]![5]!, rect.y + rect.h - fontSizePt);
  });

  it("anchors callout leaders at the nearest box boundary point", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 240]]));
    const rect = { x: 40, y: 120, w: 80, h: 50 };
    const cases = [
      {
        tip: { x: 180, y: 150 },
        expectedAnchor: { x: 120, y: 150 },
      },
      {
        tip: { x: 180, y: 200 },
        expectedAnchor: { x: 120, y: 170 },
      },
      {
        tip: { x: 60, y: 135 },
        expectedAnchor: { x: 60, y: 120 },
      },
    ];

    const edited = await applyBakedEdits(
      engine,
      document,
      cases.map(({ tip }) => ({
        type: "callout" as const,
        pageIndex: 0,
        rect,
        tip,
        text: "X",
        arrowhead: false,
        boxBorder: false,
      })),
    );
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);
    const moves = readOperandPairs(content, "m").map((values) => ({
      x: values[0]!,
      y: values[1]!,
    }));
    const lines = readOperandPairs(content, "l").map((values) => ({
      x: values[0]!,
      y: values[1]!,
    }));

    for (const { tip, expectedAnchor } of cases) {
      expectSomePointWithin1Pt(moves, expectedAnchor);
      expectSomePointWithin1Pt(lines, tip);
    }
  });

  it("draws image edits scaled into the target rect", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
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

    const edited = await applyBakedEdits(engine, document, [
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

    const edited = await applyBakedEdits(engine, document, [
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

  it("draws rectangle shape edits with stroke, fill, and custom width", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "shape",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 80, y: 120, w: 140, h: 60 },
        strokeWidthPt: 3,
        strokeColor: { r: 0.1, g: 0.2, b: 0.3 },
        fillColor: { r: 0.8, g: 0.7, b: 0.2 },
      },
    ]);
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);

    expect(content).toMatch(/\b3 w\b/);
    expectSomeOperandsWithin(readOperandPairs(content, "RG"), [0.1, 0.2, 0.3]);
    expectSomeOperandsWithin(readOperandPairs(content, "rg"), [0.8, 0.7, 0.2]);
    expectSomePointWithin1Pt(
      readOperandPairs(content, "cm").map((values) => ({ x: values[4]!, y: values[5]! })),
      { x: 80, y: 120 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 140, y: 0 },
    );
  });

  it("draws ellipse shape edits from the rect center and radii", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "shape",
        pageIndex: 0,
        shape: "ellipse",
        rect: { x: 100, y: 150, w: 80, h: 40 },
        fillColor: { r: 0.2, g: 0.8, b: 0.4 },
      },
    ]);
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);
    expectSomePointWithin1Pt(
      readOperandPairs(content, "m").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 100, y: 170 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "c").flatMap((values) => [
        { x: values[0]!, y: values[1]! },
        { x: values[2]!, y: values[3]! },
        { x: values[4]!, y: values[5]! },
      ]),
      { x: 140, y: 150 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "c").flatMap((values) => [
        { x: values[0]!, y: values[1]! },
        { x: values[2]!, y: values[3]! },
        { x: values[4]!, y: values[5]! },
      ]),
      { x: 180, y: 170 },
    );
    expectSomeOperandsWithin(readOperandPairs(content, "rg"), [0.2, 0.8, 0.4]);
  });

  it("draws line shape edits verbatim in user space", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "shape",
        pageIndex: 0,
        shape: "line",
        from: { x: 30, y: 40 },
        to: { x: 200, y: 220 },
        strokeColor: { r: 0.9, g: 0.1, b: 0.1 },
      },
    ]);
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);

    expect(content).toMatch(/\b1\.5 w\b/);
    expectSomeOperandsWithin(readOperandPairs(content, "RG"), [0.9, 0.1, 0.1]);
    expectSomePointWithin1Pt(
      readOperandPairs(content, "m").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 30, y: 40 },
    );
    expectSomePointWithin1Pt(
      readOperandPairs(content, "l").map((values) => ({ x: values[0]!, y: values[1]! })),
      { x: 200, y: 220 },
    );
  });

  it("draws arrow shape edits as a line plus oriented filled triangle", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "shape",
        pageIndex: 0,
        shape: "arrow",
        from: { x: 40, y: 40 },
        to: { x: 140, y: 40 },
        strokeWidthPt: 2,
      },
      {
        type: "shape",
        pageIndex: 0,
        shape: "arrow",
        from: { x: 200, y: 80 },
        to: { x: 200, y: 180 },
        strokeWidthPt: 2,
      },
    ]);
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);
    const moves = readOperandPairs(content, "m").map((values) => ({
      x: values[0]!,
      y: values[1]!,
    }));
    const lines = readOperandPairs(content, "l").map((values) => ({
      x: values[0]!,
      y: values[1]!,
    }));

    expectSomePointWithin1Pt(moves, { x: 40, y: 40 });
    expectSomePointWithin1Pt(lines, { x: 140, y: 40 });
    expectSomePointWithin1Pt(moves, { x: 200, y: 80 });
    expectSomePointWithin1Pt(lines, { x: 200, y: 180 });
    expectSomePointWithin1Pt(moves, { x: 140, y: 40 });
    expectSomePointWithin1Pt(lines, { x: 126, y: 46.3 });
    expectSomePointWithin1Pt(moves, { x: 200, y: 180 });
    expectSomePointWithin1Pt(lines, { x: 193.7, y: 166 });
    expect(content).toContain("f");
  });

  it("draws stroke-only shapes without a fill color", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "shape",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 40, y: 40, w: 50, h: 30 },
      },
    ]);
    const content = await readDecodedPageContent(await engine.saveToBytes(edited), 0);

    expect(content).toMatch(/\bS\b/);
    expect(content).not.toMatch(/\bB\b/);
  });

  it("renders custom highlight, text, and ink styles into page content", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[612, 792]]));

    const edited = await applyBakedEdits(engine, document, [
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

    const edited = await applyBakedEdits(engine, document, [
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

    const edited = await applyBakedEdits(engine, rotated, [
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

    const edited = await applyBakedEdits(engine, document, [
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

  it("creates a reusable text form field in a fieldless PDF", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 400]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "formField",
        fieldType: "text",
        name: "client.name",
        pageIndex: 0,
        rect: { x: 40, y: 300, w: 200, h: 24 },
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const reopened = await PDFDocument.load(bytes);
    const field = reopened.getForm().getTextField("client.name");
    const [widget] = field.acroField.getWidgets();

    expect(field.getText()).toBeUndefined();
    expect(widget?.getRectangle()).toEqual({ x: 40, y: 300, width: 200, height: 24 });
  });

  it("creates a reusable checkbox form field in a fieldless PDF", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 400]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "formField",
        fieldType: "checkbox",
        name: "terms.accepted",
        pageIndex: 0,
        rect: { x: 40, y: 300, w: 18, h: 18 },
        initialValue: true,
        required: true,
        readOnly: true,
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const reopened = await PDFDocument.load(bytes);
    const field = reopened.getForm().getCheckBox("terms.accepted");
    const [widget] = field.acroField.getWidgets();

    expect(field.isChecked()).toBe(true);
    expect(field.isRequired()).toBe(true);
    expect(field.isReadOnly()).toBe(true);
    expect(widget?.getRectangle()).toEqual({ x: 40, y: 300, width: 18, height: 18 });
  });

  it("creates a text field with its initial value and authoring properties", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 400]]));

    const edited = await applyBakedEdits(engine, document, [
      {
        type: "formField",
        fieldType: "text",
        name: "client.notes",
        pageIndex: 0,
        rect: { x: 40, y: 250, w: 200, h: 48 },
        initialValue: "Ready for review",
        required: true,
        readOnly: true,
        multiline: true,
        fontSizePt: 13,
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const reopened = await PDFDocument.load(bytes);
    const field = reopened.getForm().getTextField("client.notes");

    expect(field.getText()).toBe("Ready for review");
    expect(field.isRequired()).toBe(true);
    expect(field.isReadOnly()).toBe(true);
    expect(field.isMultiline()).toBe(true);
    expect(field.acroField.getDefaultAppearance()).toMatch(/13 Tf/);
  });

  it("creates fields before writing values in the same atomic edit transaction", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 400]]));

    const edited = await applyBakedEdits(engine, document, [
      { type: "formValues", values: { "client.name": "Jane Doe" } },
      {
        type: "formField",
        fieldType: "text",
        name: "client.name",
        pageIndex: 0,
        rect: { x: 40, y: 300, w: 200, h: 24 },
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const reopened = await PDFDocument.load(bytes);

    expect(reopened.getForm().getTextField("client.name").getText()).toBe("Jane Doe");
  });

  it("rejects duplicate authored field names without changing the source document", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 400]]));

    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "formField",
          fieldType: "text",
          name: "client.name",
          pageIndex: 0,
          rect: { x: 40, y: 300, w: 200, h: 24 },
        },
        {
          type: "formField",
          fieldType: "checkbox",
          name: "client.name",
          pageIndex: 0,
          rect: { x: 40, y: 260, w: 18, h: 18 },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: 'Form field "client.name" already exists.',
    });

    const sourceBytes = await engine.saveToBytes(document);
    const reopenedSource = await PDFDocument.load(sourceBytes);
    expect(reopenedSource.getForm().getFields()).toHaveLength(0);
  });

  it("refuses to author fields in a signed document", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    const signatureValue = pdf.context.register(
      pdf.context.obj({ Type: "Sig", Filter: "Adobe.PPKLite" }),
    );
    const signatureField = pdf.context.register(
      pdf.context.obj({
        FT: "Sig",
        T: PDFString.of("attorney-signature"),
        V: signatureValue,
        Rect: [10, 10, 200, 60],
      }),
    );
    const acroForm = pdf.context.obj({ Fields: [signatureField] }) as PDFDict;
    pdf.catalog.set(PDFName.of("AcroForm"), pdf.context.register(acroForm));

    const engine = createLocalPdfEngine();
    const document = await engine.open(await pdf.save());

    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "formField",
          fieldType: "text",
          name: "client.name",
          pageIndex: 0,
          rect: { x: 40, y: 300, w: 200, h: 24 },
        },
      ]),
    ).rejects.toMatchObject({
      code: "SIGNED_DOCUMENT",
      message: "Form fields cannot be authored in a signed PDF.",
    });
  });

  it("refuses to author fields in an XFA document", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    pdf
      .getForm()
      .acroForm.dict.set(PDFName.of("XFA"), PDFString.of("<template xmlns=\"xfa\" />"));

    const engine = createLocalPdfEngine();
    const document = await engine.open(await pdf.save());

    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "formField",
          fieldType: "text",
          name: "client.name",
          pageIndex: 0,
          rect: { x: 40, y: 300, w: 200, h: 24 },
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Form fields cannot be authored in an XFA PDF.",
    });
  });

  it("rejects unsupported authored field kinds at the runtime boundary", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 400]]));
    const unsupported = {
      type: "formField",
      fieldType: "radio",
      name: "choice",
      pageIndex: 0,
      rect: { x: 40, y: 300, w: 18, h: 18 },
    } as unknown as PdfEdit;

    await expect(applyBakedEdits(engine, document, [unsupported])).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: "Form field type must be text or checkbox.",
    });
  });

  it("rejects non-boolean checkbox defaults at the runtime boundary", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[300, 400]]));
    const invalidDefault = {
      type: "formField",
      fieldType: "checkbox",
      name: "terms.accepted",
      pageIndex: 0,
      rect: { x: 40, y: 300, w: 18, h: 18 },
      initialValue: "true",
    } as unknown as PdfEdit;

    await expect(applyBakedEdits(engine, document, [invalidDefault])).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: "Checkbox initial value must be a boolean.",
    });
  });

  it("rejects form values for unknown fields", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createFormPdf());

    await expect(
      applyBakedEdits(engine, document, [{ type: "formValues", values: { missing: "nope" } }]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("flattens filled forms so values stay visible and fields disappear", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createFormPdf());
    const filled = await applyBakedEdits(engine, document, [
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

    const edited = await applyBakedEdits(engine, document, []);
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
      applyBakedEdits(engine, document, [
        {
          type: "highlight",
          pageIndex: 3,
          rects: [{ x: 10, y: 10, w: 20, h: 10 }],
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_PAGE_INDEX" });
    await expect(
      applyBakedEdits(engine, document, [
        { type: "comment", pageIndex: 0, at: { x: 10, y: 10 }, text: "" },
      ]),
    ).rejects.toBeInstanceOf(PdfEngineError);
  });

  it("rejects invalid text markup edits", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(
      applyBakedEdits(engine, document, [{ type: "underline", pageIndex: 0, rects: [] }]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "strikethrough",
          pageIndex: 0,
          rects: [{ x: 10, y: 10, w: 20, h: 10 }],
          thicknessPt: 0,
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "underline",
          pageIndex: 0,
          rects: [{ x: 10, y: 10, w: 20, h: 10 }],
          color: { r: 1.2, g: 0, b: 0 },
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("rejects invalid shape edits", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(
      applyBakedEdits(engine, document, [
        { type: "shape", pageIndex: 0, shape: "rect", rect: { x: 10, y: 10, w: 0, h: 20 } },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "shape",
          pageIndex: 0,
          shape: "ellipse",
          rect: { x: 10, y: 10, w: 20, h: -1 },
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "shape",
          pageIndex: 0,
          shape: "line",
          from: { x: 20, y: 20 },
          to: { x: 20, y: 20 },
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "shape",
          pageIndex: 0,
          shape: "arrow",
          from: { x: 10, y: 10 },
          to: { x: 30, y: 30 },
          strokeWidthPt: 0,
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "shape",
          pageIndex: 0,
          shape: "rect",
          rect: { x: 10, y: 10, w: 20, h: 20 },
          strokeColor: { r: Number.NaN, g: 0, b: 0 },
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        {
          type: "shape",
          pageIndex: 0,
          shape: "ellipse",
          rect: { x: 10, y: 10, w: 20, h: 20 },
          fillColor: { r: 0, g: 2, b: 0 },
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("rejects invalid callout edits", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));
    const valid = {
      type: "callout" as const,
      pageIndex: 0,
      rect: { x: 10, y: 10, w: 80, h: 40 },
      tip: { x: 140, y: 50 },
      text: "Callout",
    };

    await expect(
      applyBakedEdits(engine, document, [{ ...valid, rect: { x: 10, y: 10, w: 0, h: 40 } }]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(applyBakedEdits(engine, document, [{ ...valid, text: "" }])).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    await expect(
      applyBakedEdits(engine, document, [{ ...valid, tip: { x: Number.NaN, y: 50 } }]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [{ ...valid, strokeWidthPt: 0 }]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [
        { ...valid, strokeColor: { r: 0, g: 0, b: Number.POSITIVE_INFINITY } },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      applyBakedEdits(engine, document, [{ ...valid, boxFill: { r: 0, g: -1, b: 0 } }]),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
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

function readTextDraws(content: string): string[] {
  return [...content.matchAll(/<([0-9A-F]+)> Tj/gi)].map((match) => decodeHexText(match[1]!));
}

function decodeHexText(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  return new TextDecoder().decode(bytes);
}

function readPageBaseFonts(pdf: PDFDocument, pageIndex: number): string[] {
  const resources = pdf.getPage(pageIndex).node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);

  if (!fonts) {
    return [];
  }

  const baseFonts: string[] = [];

  for (const [, entry] of fonts.entries()) {
    const font = entry instanceof PDFRef ? pdf.context.lookup(entry, PDFDict) : entry;

    if (!(font instanceof PDFDict)) {
      continue;
    }

    const baseFont = font.lookupMaybe(PDFName.of("BaseFont"), PDFName);

    if (baseFont) {
      baseFonts.push(baseFont.toString().replace(/^\//, ""));
    }
  }

  return baseFonts;
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
