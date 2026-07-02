import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
} from "pdf-lib";

export function scrubPdfMetadataInPlace(pdf: PDFDocument): void {
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
}

export async function scrubPdfMetadataBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  scrubPdfMetadataInPlace(pdf);

  return new Uint8Array(await pdf.save());
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
