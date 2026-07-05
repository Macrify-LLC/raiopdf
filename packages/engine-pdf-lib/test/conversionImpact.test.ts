import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from "pdf-lib";
import {
  assessPdfAConversionImpactFromBytes,
  countEmbeddedFiles,
  countSignedSignatureFields,
  hasPdfAConversionImpact,
  restoreEmbeddedFiles,
} from "../src/index";

async function createPdf(): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);

  return pdf;
}

async function saveBytes(pdf: PDFDocument): Promise<Uint8Array> {
  return new Uint8Array(await pdf.save());
}

function addAnnotation(pdf: PDFDocument, subtype: string, extra: Record<string, unknown> = {}): void {
  const page = pdf.getPages()[0]!;
  const annotation = pdf.context.obj({
    Type: "Annot",
    Subtype: subtype,
    Rect: [10, 10, 100, 40],
    ...extra,
  }) as PDFDict;
  const annotationRef = pdf.context.register(annotation);
  const existing = page.node.get(PDFName.of("Annots"));
  const annotations = existing instanceof PDFArray ? existing : pdf.context.obj([]) as PDFArray;

  annotations.push(annotationRef);
  page.node.set(PDFName.of("Annots"), annotations);
}

describe("assessPdfAConversionImpact", () => {
  it("reports no impact for a clean document", async () => {
    const impact = await assessPdfAConversionImpactFromBytes(await saveBytes(await createPdf()));

    expect(impact).toEqual({
      pendingRedactionAnnotations: 0,
      overlayAnnotations: 0,
      formFields: 0,
      signedSignatureFields: 0,
    });
    expect(hasPdfAConversionImpact(impact)).toBe(false);
  });

  it("counts unapplied redaction marks separately from other annotations", async () => {
    const pdf = await createPdf();
    addAnnotation(pdf, "Redact");
    addAnnotation(pdf, "Redact");
    addAnnotation(pdf, "Square");
    addAnnotation(pdf, "Highlight");

    const impact = await assessPdfAConversionImpactFromBytes(await saveBytes(pdf));

    expect(impact.pendingRedactionAnnotations).toBe(2);
    expect(impact.overlayAnnotations).toBe(2);
    expect(hasPdfAConversionImpact(impact)).toBe(true);
  });

  it("ignores links, popups, and widget appearances", async () => {
    const pdf = await createPdf();
    addAnnotation(pdf, "Link");
    addAnnotation(pdf, "Popup");
    addAnnotation(pdf, "Widget");

    const impact = await assessPdfAConversionImpactFromBytes(await saveBytes(pdf));

    expect(hasPdfAConversionImpact(impact)).toBe(false);
  });

  it("counts interactive form fields", async () => {
    const pdf = await createPdf();
    const form = pdf.getForm();
    const field = form.createTextField("case.number");
    field.addToPage(pdf.getPages()[0]!, { x: 50, y: 700, width: 200, height: 20 });

    const impact = await assessPdfAConversionImpactFromBytes(await saveBytes(pdf));

    expect(impact.formFields).toBe(1);
    expect(impact.signedSignatureFields).toBe(0);
  });

  it("counts signed signature fields", async () => {
    const pdf = await createPdf();
    const signatureValue = pdf.context.register(pdf.context.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
    }));
    const signatureField = pdf.context.register(pdf.context.obj({
      FT: "Sig",
      T: "attorney-signature",
      V: signatureValue,
      Rect: [10, 10, 200, 60],
    }));
    const acroForm = pdf.context.obj({
      Fields: [signatureField],
    }) as PDFDict;
    pdf.catalog.set(PDFName.of("AcroForm"), pdf.context.register(acroForm));

    const impact = await assessPdfAConversionImpactFromBytes(await saveBytes(pdf));

    expect(impact.formFields).toBe(1);
    expect(impact.signedSignatureFields).toBe(1);
    await expect(countSignedSignatureFields(await saveBytes(pdf))).resolves.toBe(1);
  });
});

describe("restoreEmbeddedFiles", () => {
  it("restores embedded file name trees onto regenerated output bytes", async () => {
    const source = await createPdf();
    addEmbeddedFile(source, "native-exhibit.txt", new Uint8Array([1, 2, 3]));
    const output = await createPdf();
    const result = await restoreEmbeddedFiles(await saveBytes(source), await saveBytes(output));

    expect(result.sourceEmbeddedFileCount).toBe(1);
    expect(result.restoredEmbeddedFileCount).toBe(1);
    await expect(countEmbeddedFiles(result.bytes)).resolves.toBe(1);
  });

  it("leaves output unchanged when the source has no embedded files", async () => {
    const source = await createPdf();
    const outputBytes = await saveBytes(await createPdf());
    const result = await restoreEmbeddedFiles(await saveBytes(source), outputBytes);

    expect(result).toEqual({
      bytes: outputBytes,
      sourceEmbeddedFileCount: 0,
      restoredEmbeddedFileCount: 0,
    });
  });
});

function addEmbeddedFile(pdf: PDFDocument, fileName: string, contents: Uint8Array): void {
  const embeddedStreamRef = pdf.context.register(pdf.context.stream(contents, {
    Type: "EmbeddedFile",
    Subtype: "text/plain",
  }));
  const fileSpecRef = pdf.context.register(pdf.context.obj({
    Type: "Filespec",
    F: PDFString.of(fileName),
    UF: PDFHexString.fromText(fileName),
    EF: pdf.context.obj({
      F: embeddedStreamRef,
      UF: embeddedStreamRef,
    }),
  }));
  const namesRoot = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)
    ?? pdf.context.obj({}) as PDFDict;
  namesRoot.set(PDFName.of("EmbeddedFiles"), pdf.context.obj({
    Names: [PDFString.of(fileName), fileSpecRef],
  }));
  pdf.catalog.set(PDFName.of("Names"), namesRoot);
}
