import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFStream,
} from "pdf-lib";

/**
 * The PDF/A conformance claim carried in a document's XMP metadata (e.g. part "2",
 * conformance "B" for PDF/A-2b).
 *
 * Florida's ePortal runs an informational PDF/A conformity check that fails when a
 * file's identification metadata has been scrubbed (its own FAQ: the "pdfcreator"
 * tag "is required to pass the CONFORMITY test"). More fundamentally, PDF/A
 * conformance itself requires an XMP packet with a pdfaid identification — deleting
 * every metadata stream un-PDF/As the file. So the metadata scrub preserves this
 * identification (and nothing else) by default when the input document claims it.
 */
export type PdfAIdentification = {
  part: string;
  conformance: string | null;
};

export type ScrubPdfMetadataOptions = {
  /**
   * Keep a minimal PDF/A identification (pdfaid part/conformance + a RaioPDF
   * creator-tool tag) so the scrub does not silently un-PDF/A the file. All
   * descriptive metadata (author, title, history, custom fields) is still removed.
   *
   * - true (default): capture the identification from the document being scrubbed.
   * - a PdfAIdentification: restore this identification (captured earlier, e.g. from
   *   input bytes before an engine pass that strips XMP) in the same load/save cycle.
   * - false: maximal scrub that also drops the conformance claim — e.g. after an
   *   edit that invalidates conformance anyway.
   */
  preservePdfAIdentification?: boolean | PdfAIdentification;
};

export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  return pdf.getPageCount();
}

export function readPdfAIdentification(pdf: PDFDocument): PdfAIdentification | null {
  const xmp = readCatalogXmp(pdf);

  if (!xmp) {
    return null;
  }

  const part = matchXmpValue(xmp, "part", /\d+/);

  if (!part) {
    return null;
  }

  return {
    part,
    conformance: matchXmpValue(xmp, "conformance", /[A-Za-z]/),
  };
}

export async function readPdfAIdentificationFromBytes(
  bytes: Uint8Array,
): Promise<PdfAIdentification | null> {
  // Cheap pre-filter before a full parse: PDF/A requires the XMP metadata stream to
  // be uncompressed, so a conformant file necessarily contains the literal "pdfaid"
  // namespace prefix. Most documents are not PDF/A and skip the parse entirely.
  if (!bytesContainAscii(bytes, "pdfaid")) {
    return null;
  }

  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  return readPdfAIdentification(pdf);
}

export function writePdfAIdentificationInPlace(
  pdf: PDFDocument,
  identification: PdfAIdentification,
): void {
  const xmp = buildMinimalPdfAXmp(identification);
  // PDF/A requires the metadata stream to be uncompressed; context.stream creates a
  // raw (unfiltered) stream.
  const stream = pdf.context.stream(xmp, {
    Type: "Metadata",
    Subtype: "XML",
  });

  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
}

export async function writePdfAIdentificationToBytes(
  bytes: Uint8Array,
  identification: PdfAIdentification,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  writePdfAIdentificationInPlace(pdf, identification);

  return new Uint8Array(await pdf.save());
}

export function scrubPdfMetadataInPlace(
  pdf: PDFDocument,
  options: ScrubPdfMetadataOptions = {},
): void {
  const preserve = options.preservePdfAIdentification ?? true;
  const identification = preserve === false
    ? null
    : preserve === true
      ? readPdfAIdentification(pdf)
      : preserve;

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

  if (identification) {
    writePdfAIdentificationInPlace(pdf, identification);
  }
}

export async function scrubPdfMetadataBytes(
  bytes: Uint8Array,
  options: ScrubPdfMetadataOptions = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  scrubPdfMetadataInPlace(pdf, options);

  return new Uint8Array(await pdf.save());
}

/**
 * What a PDF/A conversion would destroy in a document.
 *
 * PDF/A prohibits interactive form fields, most annotations, and encryption, so the
 * converter strips them to reach conformance — silently, because from its point of
 * view removing a prohibited feature IS success. Each count here is a feature the
 * user may be relying on that the conversion would remove or invalidate:
 *
 * - pendingRedactionAnnotations — Acrobat-style "marked for redaction" /Redact
 *   annotations that have NOT been applied. Stripping these silently discards the
 *   user's redaction to-do list and files the content un-redacted.
 * - overlayAnnotations — visible markup (squares, highlights, ink, free text...). A
 *   black box drawn over text is a common bad redaction; dropping it visibly reveals
 *   the text underneath.
 * - formFields — interactive AcroForm fields; conversion flattens or removes them.
 * - signedSignatureFields — digital signatures; any rewrite of the bytes invalidates
 *   them even if the field survives.
 */
export interface PdfAConversionImpact {
  pendingRedactionAnnotations: number;
  overlayAnnotations: number;
  formFields: number;
  signedSignatureFields: number;
}

export function hasPdfAConversionImpact(impact: PdfAConversionImpact): boolean {
  return Object.values(impact).some((count) => count > 0);
}

/** Annotation subtypes that neither carry user content nor survive-or-die visibly. */
const IGNORED_ANNOTATION_SUBTYPES = new Set(["Link", "Popup", "Widget"]);

export function assessPdfAConversionImpact(pdf: PDFDocument): PdfAConversionImpact {
  let pendingRedactionAnnotations = 0;
  let overlayAnnotations = 0;

  for (const page of pdf.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

    if (!annotations) {
      continue;
    }

    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookupMaybe(index, PDFDict);
      const subtype = annotation?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();

      if (!subtype || IGNORED_ANNOTATION_SUBTYPES.has(subtype)) {
        continue;
      }

      if (subtype === "Redact") {
        pendingRedactionAnnotations += 1;
      } else {
        overlayAnnotations += 1;
      }
    }
  }

  let formFields = 0;
  let signedSignatureFields = 0;

  try {
    for (const field of pdf.getForm().getFields()) {
      formFields += 1;

      if (field instanceof PDFSignature && field.acroField.dict.has(PDFName.of("V"))) {
        signedSignatureFields += 1;
      }
    }
  } catch {
    // A malformed AcroForm fails the form count, not the whole assessment.
  }

  return {
    pendingRedactionAnnotations,
    overlayAnnotations,
    formFields,
    signedSignatureFields,
  };
}

export async function assessPdfAConversionImpactFromBytes(
  bytes: Uint8Array,
): Promise<PdfAConversionImpact> {
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  return assessPdfAConversionImpact(pdf);
}

function bytesContainAscii(bytes: Uint8Array, text: string): boolean {
  const first = text.charCodeAt(0);
  const limit = bytes.length - text.length;

  outer: for (let index = 0; index <= limit; index += 1) {
    if (bytes[index] !== first) {
      continue;
    }

    for (let offset = 1; offset < text.length; offset += 1) {
      if (bytes[index + offset] !== text.charCodeAt(offset)) {
        continue outer;
      }
    }

    return true;
  }

  return false;
}

function readCatalogXmp(pdf: PDFDocument): string | null {
  try {
    const stream = pdf.catalog.lookupMaybe(PDFName.of("Metadata"), PDFStream);

    if (!(stream instanceof PDFRawStream)) {
      return null;
    }

    const contents = stream.dict.has(PDFName.of("Filter"))
      ? decodePDFRawStream(stream).decode()
      : stream.contents;

    return new TextDecoder("utf-8", { fatal: false }).decode(contents);
  } catch {
    return null;
  }
}

function matchXmpValue(xmp: string, tag: string, valuePattern: RegExp): string | null {
  // XMP serializes properties as elements (<pdfaid:part>2</pdfaid:part>) or as
  // attributes (pdfaid:part="2"); accept both.
  const element = new RegExp(`<pdfaid:${tag}[^>]*>\\s*(${valuePattern.source})\\s*<`).exec(xmp);

  if (element?.[1]) {
    return element[1];
  }

  const attribute = new RegExp(`pdfaid:${tag}\\s*=\\s*"(${valuePattern.source})"`).exec(xmp);

  return attribute?.[1] ?? null;
}

function buildMinimalPdfAXmp(identification: PdfAIdentification): string {
  const conformance = identification.conformance
    ? `\n    <pdfaid:conformance>${identification.conformance}</pdfaid:conformance>`
    : "";

  return `<?xpacket begin="${"\uFEFF"}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>${identification.part}</pdfaid:part>${conformance}
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>RaioPDF</xmp:CreatorTool>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>RaioPDF</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
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
