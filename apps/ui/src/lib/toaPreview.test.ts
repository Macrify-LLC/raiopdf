import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { generateToaPdf } from "./toaPreview";

describe("generateToaPdf", () => {
  it("renders a valid Table of Authorities PDF with grouped authorities", async () => {
    const bytes = await generateToaPdf({
      entries: [
        { kind: "case", citation: "123 So. 3d 456", pages: [1, 3, 4] },
        { kind: "statute", citation: "Fla. Stat. § 95.11", pages: [2] },
      ],
      passimThreshold: 5,
    });
    const pdf = await PDFDocument.load(bytes);
    const page = pdf.getPage(0);

    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect([page.getWidth(), page.getHeight()]).toEqual([612, 792]);
  });
});
