import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import {
  readPdfAIdentification,
  readPdfAIdentificationFromBytes,
  scrubPdfMetadataBytes,
  scrubPdfMetadataInPlace,
  writePdfAIdentificationToBytes,
} from "../src/index";

const ELEMENT_FORM_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:creator><rdf:Seq><rdf:li>Confidential Author</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const ATTRIBUTE_FORM_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
   pdfaid:part="1" pdfaid:conformance="b"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

async function createPdfWithXmp(xmp: string | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.setAuthor("Confidential Author");
  pdf.setTitle("Confidential Title");

  if (xmp !== null) {
    const stream = pdf.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
    pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
  }

  return new Uint8Array(await pdf.save({ updateFieldAppearances: false }));
}

describe("PDF/A identification", () => {
  it("reads element-form pdfaid identification", async () => {
    const bytes = await createPdfWithXmp(ELEMENT_FORM_XMP);

    expect(await readPdfAIdentificationFromBytes(bytes)).toEqual({
      part: "2",
      conformance: "B",
    });
  });

  it("reads attribute-form pdfaid identification", async () => {
    const bytes = await createPdfWithXmp(ATTRIBUTE_FORM_XMP);

    expect(await readPdfAIdentificationFromBytes(bytes)).toEqual({
      part: "1",
      conformance: "b",
    });
  });

  it("returns null for documents without a PDF/A claim", async () => {
    const bytes = await createPdfWithXmp(null);

    expect(await readPdfAIdentificationFromBytes(bytes)).toBeNull();
  });
});

describe("scrubPdfMetadata with a PDF/A input", () => {
  it("keeps the conformance claim and creator tool while removing descriptive metadata", async () => {
    const bytes = await createPdfWithXmp(ELEMENT_FORM_XMP);
    const scrubbed = await scrubPdfMetadataBytes(bytes);
    const pdf = await PDFDocument.load(scrubbed, { updateMetadata: false });
    // The rebuilt XMP stream is uncompressed, so its text is visible in the raw bytes.
    const scrubbedText = new TextDecoder("utf-8", { fatal: false }).decode(scrubbed);

    expect(readPdfAIdentification(pdf)).toEqual({ part: "2", conformance: "B" });
    expect(scrubbedText).toContain("<xmp:CreatorTool>RaioPDF</xmp:CreatorTool>");
    expect(scrubbedText).not.toContain("Confidential Author");
    expect(scrubbedText).not.toContain("Confidential Title");
    expect(pdf.context.trailerInfo.Info).toBeUndefined();
  });

  it("drops the conformance claim on a maximal scrub", async () => {
    const bytes = await createPdfWithXmp(ELEMENT_FORM_XMP);
    const scrubbed = await scrubPdfMetadataBytes(bytes, {
      preservePdfAIdentification: false,
    });
    const pdf = await PDFDocument.load(scrubbed, { updateMetadata: false });

    expect(readPdfAIdentification(pdf)).toBeNull();
    expect(pdf.catalog.get(PDFName.of("Metadata"))).toBeUndefined();
  });

  it("scrubs everything from documents without a PDF/A claim", async () => {
    const bytes = await createPdfWithXmp(null);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });

    scrubPdfMetadataInPlace(pdf);

    expect(pdf.catalog.get(PDFName.of("Metadata"))).toBeUndefined();
    expect(pdf.context.trailerInfo.Info).toBeUndefined();
  });

  it("restores an identification onto scrubbed bytes", async () => {
    const bytes = await createPdfWithXmp(null);
    const scrubbed = await scrubPdfMetadataBytes(bytes, {
      preservePdfAIdentification: false,
    });
    const restored = await writePdfAIdentificationToBytes(scrubbed, {
      part: "2",
      conformance: "B",
    });

    expect(await readPdfAIdentificationFromBytes(restored)).toEqual({
      part: "2",
      conformance: "B",
    });
  });
});
