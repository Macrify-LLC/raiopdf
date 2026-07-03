import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { readProductionSetPageCount } from "./ProductionSetWorkspace";

describe("ProductionSetWorkspace", () => {
  it("counts pages from added PDF bytes", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    const bytes = await pdf.save();

    await expect(readProductionSetPageCount(bytes)).resolves.toBe(2);
  });

  it("rejects unreadable bytes instead of returning a zero page count", async () => {
    await expect(readProductionSetPageCount(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
