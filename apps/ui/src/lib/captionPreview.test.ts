import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { generateCaptionPdf } from "./captionPreview";

describe("generateCaptionPdf", () => {
  it("renders a valid one-page letter PDF with the shared caption renderer", async () => {
    const bytes = await generateCaptionPdf({
      styleId: "classic-boxed",
      caption: {
        courtName: "Circuit Court",
        county: "Orange County, Florida",
        parties: [
          { role: "Plaintiff", names: ["Jane Smith"] },
          { role: "Defendant", names: ["Acme Corp."], etAl: true },
        ],
        caseNumber: "2026-CA-1234",
        documentTitle: "Motion to Compel",
        signatureBlockLines: ["Respectfully submitted,", "Jane Smith"],
      },
    });
    const pdf = await PDFDocument.load(bytes);
    const page = pdf.getPage(0);

    expect(pdf.getPageCount()).toBe(1);
    expect([page.getWidth(), page.getHeight()]).toEqual([612, 792]);
  });
});
