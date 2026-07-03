import { describe, expect, it, vi } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import type { PDFDocumentProxy } from "./pdfjs";
import {
  collectRedactionAreaTexts,
  findTextRedactionAreas,
  scanSensitivePatterns,
  verifyRedactionAreasClear,
} from "./legalTools";

const pdfjsMock = vi.hoisted(() => ({
  document: null as PDFDocumentProxy | null,
}));

vi.mock("./pdfjs", () => ({
  loadPdfDocument: async () => {
    if (!pdfjsMock.document) {
      throw new Error("No mocked PDF document configured.");
    }

    return pdfjsMock.document;
  },
}));

describe("legalTools", () => {
  it("finds SSNs split across pdf.js text items with space separators", async () => {
    const pdf = mockPdf([
      textItem("Client SSN ", 10, 50),
      textItem("123", 70, 18),
      textItem(" ", 88, 4),
      textItem("45", 92, 12),
      textItem(" ", 104, 4),
      textItem("6789", 108, 24),
    ]);

    const hits = await scanSensitivePatterns(pdf);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      category: "SSN",
      confidence: "high",
      excerpt: expect.stringContaining("6789"),
      pageIndex: 0,
    });
    expect(hits[0]?.area.x).toBeLessThanOrEqual(68);
    expect(hits[0]?.area.w).toBeGreaterThan(55);
  });

  it("flags bare 9-digit SSNs as lower confidence", async () => {
    const pdf = mockPdf([
      textItem("Possible SSN 123456789", 10, 120),
    ]);

    const hits = await scanSensitivePatterns(pdf);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      category: "SSN",
      confidence: "lower",
    });
  });

  it("maps text redaction search matches that cross item boundaries", async () => {
    const pdf = mockPdf([
      textItem("Privileged ", 10, 58),
      textItem("matter", 68, 32),
    ]);

    const areas = await findTextRedactionAreas(pdf, "privileged matter");

    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ pageIndex: 0 });
    expect(areas[0]?.x).toBeLessThanOrEqual(8);
    expect(areas[0]?.w).toBeGreaterThan(90);
  });

  it("finds two-word search matches split across text items without literal spaces", async () => {
    const pdf = mockPdf([
      textItem("two", 10, 18),
      textItem("word", 40, 24),
    ]);

    const areas = await findTextRedactionAreas(pdf, "two word");

    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ pageIndex: 0 });
    expect(areas[0]?.x).toBeLessThanOrEqual(8);
    expect(areas[0]?.w).toBeGreaterThan(55);
  });

  it("fails verification when a redacted-page annotation still contains the term", async () => {
    const term = "Privileged Codename";
    await createRedactionFixturePdf({
      annotationText: term,
      visibleText: term,
    });
    const sourcePdf = mockPdf([
      textItem(term, 36, 140),
    ]);

    const areas = await findTextRedactionAreas(sourcePdf, term);
    const redactedTerms = await collectRedactionAreaTexts(sourcePdf, areas);

    const outputBytes = await createRedactionFixturePdf({
      annotationText: term,
      visibleText: "",
    });
    pdfjsMock.document = mockPdf([]);
    const result = await verifyRedactionAreasClear(outputBytes, areas, redactedTerms);

    expect(redactedTerms).toContain(term);
    expect(result.ok).toBe(false);
    expect(result.annotations.status).toBe("fail");
    expect(result.annotations.detail).toContain("Annotations remain");
  });

  it("passes verification when text, content operators, annotations, and metadata are clean", async () => {
    const term = "Privileged Codename";
    await createRedactionFixturePdf({
      annotationText: term,
      visibleText: term,
    });
    const sourcePdf = mockPdf([
      textItem(term, 36, 140),
    ]);

    const areas = await findTextRedactionAreas(sourcePdf, term);
    const redactedTerms = await collectRedactionAreaTexts(sourcePdf, areas);

    const outputBytes = await createRedactionFixturePdf({
      annotationText: "",
      visibleText: "",
    });
    pdfjsMock.document = mockPdf([]);
    const result = await verifyRedactionAreasClear(outputBytes, areas, redactedTerms);

    expect(result).toMatchObject({
      ok: true,
      textLayer: { status: "pass" },
      rasterizedPages: { status: "pass" },
      annotations: { status: "pass" },
      metadata: { status: "pass" },
    });
  });

  it("fails verification when a redacted page keeps text operators in a Form XObject", async () => {
    const term = "Privileged Codename";
    const sourcePdf = mockPdf([
      textItem(term, 36, 140),
    ]);

    const areas = await findTextRedactionAreas(sourcePdf, term);
    const redactedTerms = await collectRedactionAreaTexts(sourcePdf, areas);

    const outputBytes = await addTextFormXObject(
      await createRedactionFixturePdf({
        annotationText: "",
        visibleText: "",
      }),
    );
    pdfjsMock.document = mockPdf([]);
    const result = await verifyRedactionAreasClear(outputBytes, areas, redactedTerms);

    expect(result.ok).toBe(false);
    expect(result.rasterizedPages.status).toBe("fail");
    expect(result.rasterizedPages.detail).toContain("text operators");
  });
});

function mockPdf(items: unknown[]): PDFDocumentProxy {
  return {
    numPages: 1,
    getPage: async () => ({
      getTextContent: async () => ({ items }),
    }),
    loadingTask: {
      destroy: async () => {},
    },
  } as unknown as PDFDocumentProxy;
}

function textItem(str: string, x: number, width: number) {
  return {
    str,
    transform: [1, 0, 0, 10, x, 100],
    width,
    height: 10,
  };
}

async function createRedactionFixturePdf({
  annotationText,
  visibleText,
}: {
  annotationText: string;
  visibleText: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);

  if (visibleText) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText(visibleText, {
      x: 36,
      y: 220,
      size: 14,
      font,
    });
  }

  if (annotationText) {
    const annotation = pdf.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [36, 180, 56, 200],
      Contents: PDFString.of(annotationText),
      Name: "Comment",
      F: 4,
      Open: false,
    });
    const annotationRef = pdf.context.register(annotation);
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

    if (annotations) {
      annotations.push(annotationRef);
    } else {
      page.node.set(PDFName.of("Annots"), pdf.context.obj([annotationRef]));
    }
  }

  return scrubFixtureMetadata(new Uint8Array(await pdf.save({ updateFieldAppearances: false })));
}

async function scrubFixtureMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const infoRef = pdf.context.trailerInfo.Info;

  if (isPdfRef(infoRef)) {
    pdf.context.delete(infoRef);
  }
  delete pdf.context.trailerInfo.Info;

  const metadataName = PDFName.of("Metadata");
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) {
      continue;
    }

    const metadataRef = object.get(metadataName);
    if (isPdfRef(metadataRef)) {
      pdf.context.delete(metadataRef);
    }

    if (object.has(metadataName)) {
      object.delete(metadataName);
      pdf.context.assign(ref, object);
    }
  }

  return new Uint8Array(await pdf.save());
}

async function addTextFormXObject(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = pdf.getPage(0);
  const resources = page.node.Resources() ?? pdf.context.obj({});
  const xObjects = resources.lookupMaybe(PDFName.XObject, PDFDict) ?? pdf.context.obj({});
  const formStream = pdf.context.flateStream(
    "BT /F1 12 Tf 1 0 0 1 12 12 Tm ET",
    {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 50, 50],
      Resources: {},
    },
  );
  const formRef = pdf.context.register(formStream);
  const contentRef = pdf.context.register(pdf.context.flateStream("q /Fm1 Do Q"));

  xObjects.set(PDFName.of("Fm1"), formRef);
  resources.set(PDFName.XObject, xObjects);
  page.node.set(PDFName.Resources, resources);
  page.node.set(PDFName.Contents, contentRef);

  return scrubFixtureMetadata(new Uint8Array(await pdf.save({ updateFieldAppearances: false })));
}

function isPdfRef(value: unknown): value is PDFRef {
  return (
    value instanceof PDFRef ||
    (
      typeof value === "object" &&
      value !== null &&
      "objectNumber" in value &&
      "generationNumber" in value
    )
  );
}
