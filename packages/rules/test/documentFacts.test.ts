import { describe, expect, it } from "vitest";
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import {
  buildDocumentFacts,
  detectEncryptionState,
  deriveTextLayerQuality,
} from "../src/index";
import {
  extractPageTextByPage,
  extractTextLayerCoverage,
} from "../src/node";

const ONE_BY_ONE_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
));

describe("document fact extractors", () => {
  it("extracts active content, embedded files, forms, annotations, signatures, and redaction signals", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    pdf.addJavaScript("open-alert", "app.alert('hi')");
    await pdf.attach(Uint8Array.from([1, 2, 3]), "note.txt", {
      mimeType: "text/plain",
      description: "attachment",
      creationDate: new Date("2026-07-03T00:00:00Z"),
      modificationDate: new Date("2026-07-03T00:00:00Z"),
    });

    const form = pdf.getForm();
    const field = form.createTextField("client.name");
    field.setText("Ada");
    field.addToPage(page, { x: 72, y: 700, width: 180, height: 24 });

    const redactAnnotation = pdf.context.obj({
      Type: "Annot",
      Subtype: "Redact",
      Rect: [72, 620, 180, 660],
    });
    const blackSquare = pdf.context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [72, 560, 180, 600],
      IC: [0, 0, 0],
      CA: 1,
    });
    const fileAttachment = pdf.context.obj({
      Type: "Annot",
      Subtype: "FileAttachment",
      Rect: [72, 520, 96, 544],
    });
    const signatureField = pdf.context.obj({
      FT: "Sig",
      T: PDFString.of("signature"),
    });
    const signatureFieldRef = pdf.context.register(signatureField);
    const acroForm = pdf.catalog.getOrCreateAcroForm();
    acroForm.addField(signatureFieldRef);
    page.node.set(PDFName.of("Annots"), pdf.context.obj([redactAnnotation, blackSquare, fileAttachment]));

    const facts = await buildDocumentFacts(await pdf.save({ useObjectStreams: false }), {
      textExtractor: {
        extractTextLayerCoverage: async () => ({
          imageOnlyPages: [],
          mixedPages: [],
          textPages: [0],
          garbledPages: [],
        }),
      },
    });

    expect(facts.encryptionState).toBe("none");
    expect(facts.activeContentSignals).toMatchObject({ possiblyPresent: true });
    expect(facts.activeContentSignals?.signals).toContain("javascriptNameTree");
    expect(facts.embeddedFileCount).toBe(2);
    expect(facts.formFields).toEqual({ count: 2, anyFilled: true });
    expect(facts.signatureFieldCount).toBe(1);
    expect(facts.annotationCount).toBe(3);
    expect(facts.possibleUnappliedRedactions).toEqual({
      redactAnnotationCount: 1,
      blackRectangleAnnotationCount: 1,
      possiblyPresent: true,
    });
    expect(facts.textLayerCoverage).toEqual({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0],
      garbledPages: [],
    });
    expect(facts.searchableText).toBe(true);
    expect(facts.errors).toBeUndefined();
  });

  it("classifies text-layer coverage per page", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const image = await pdf.embedPng(ONE_BY_ONE_PNG);

    const textPage = pdf.addPage([612, 792]);
    textPage.drawText("searchable text", { x: 72, y: 720, font, size: 12 });

    const imagePage = pdf.addPage([612, 792]);
    imagePage.drawImage(image, { x: 72, y: 720, width: 72, height: 72 });

    const mixedPage = pdf.addPage([612, 792]);
    mixedPage.drawText("text and image", { x: 72, y: 720, font, size: 12 });
    mixedPage.drawImage(image, { x: 72, y: 620, width: 72, height: 72 });

    const facts = await buildDocumentFacts(await pdf.save({ useObjectStreams: false }), {
      textExtractor: {
        extractTextLayerCoverage,
        extractPageTextByPage,
      },
    });

    // One image-only page must not make the whole document look searchable.
    expect(facts.searchableText).toBe(false);
    expect(facts.textLayerCoverage).toEqual({
      textPages: [0],
      imageOnlyPages: [1],
      mixedPages: [2],
      garbledPages: [],
    });
    expect(facts.pageTextByPage?.map((page) => page.text.trim())).toEqual([
      "searchable text",
      "",
      "text and image",
    ]);
  });

  it("marks a document searchable only when every page has a text layer", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const first = pdf.addPage([612, 792]);
    first.drawText("page one", { x: 72, y: 720, font, size: 12 });
    const second = pdf.addPage([612, 792]);
    second.drawText("page two", { x: 72, y: 720, font, size: 12 });

    const facts = await buildDocumentFacts(await pdf.save({ useObjectStreams: false }), {
      textExtractor: {
        extractTextLayerCoverage,
        extractPageTextByPage,
      },
    });

    expect(facts.searchableText).toBe(true);
    expect(facts.textLayerCoverage).toEqual({
      textPages: [0, 1],
      imageOnlyPages: [],
      mixedPages: [],
      garbledPages: [],
    });
  });

  it("does not mark a document searchable when the text layer is garbled", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);

    const garbledPage = {
      pageIndex: 0,
      confidence: 0.91,
      reason: "low_alpha_entropy" as const,
      puaRatio: 0,
      replacementRatio: 0,
      alphaRatio: 0.01,
    };
    const facts = await buildDocumentFacts(await pdf.save({ useObjectStreams: false }), {
      textExtractor: {
        extractTextLayerCoverage: async () => ({
          textPages: [0],
          imageOnlyPages: [],
          mixedPages: [],
          garbledPages: [garbledPage],
        }),
      },
    });

    expect(facts.searchableText).toBe(false);
    expect(deriveTextLayerQuality(facts.textLayerCoverage!)).toMatchObject({
      garbledPages: 1,
      totalPages: 1,
      verdict: "garbled",
    });
  });

  it("detects encrypted trailers without requiring PDF parsing", async () => {
    const encrypted = syntheticPdfWithEncrypt("5 0 R", "<< /Filter /Standard /V 1 /R 2 /O <> /U <> /P -4 >>");
    const usageRestricted = syntheticPdfWithEncrypt("<< /P -4 >>");

    expect(detectEncryptionState(encrypted)).toBe("encrypted");
    expect(detectEncryptionState(usageRestricted)).toBe("usage_restricted");

    const facts = await buildDocumentFacts(encrypted);
    expect(facts.encryptionState).toBe("encrypted");
    expect(facts.pages).toEqual([]);
    expect(facts.errors?.map((error) => error.fact)).toContain("textLayerCoverage");
  });
});

function syntheticPdfWithEncrypt(encryptValue: string, encryptObject = ""): Uint8Array {
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    encryptObject ? `5 0 obj ${encryptObject} endobj` : "",
  ].filter(Boolean);
  const body = objects.join("\n");
  const pdf = `%PDF-1.4\n${body}\ntrailer << /Root 1 0 R /Size 6 /Encrypt ${encryptValue} >>\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
