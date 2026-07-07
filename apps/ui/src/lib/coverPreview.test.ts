import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { generateCoverPdf } from "./coverPreview";

async function firstPageSize(bytes: Uint8Array): Promise<[number, number]> {
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(0);
  return [page.getWidth(), page.getHeight()];
}

describe("generateCoverPdf", () => {
  it("defaults generated cover pages to Letter size", async () => {
    const bytes = await generateCoverPdf({ label: "Exhibit A", style: "minimal" });

    expect(await firstPageSize(bytes)).toEqual([612, 792]);
  });

  it("uses the requested page size for generated cover pages", async () => {
    const bytes = await generateCoverPdf({
      label: "Exhibit A",
      style: "labeled",
      pageSize: [612, 1008],
    });

    expect(await firstPageSize(bytes)).toEqual([612, 1008]);
  });
});
