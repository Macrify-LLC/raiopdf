import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { verifyTermsRemoved } from "../src/redaction/verify.js";

async function pdfWithText(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([400, 200]).drawText(text, { x: 10, y: 100, size: 12, font });
  return pdf.save();
}

describe("redaction term verifier (pdf.js in Node)", () => {
  it("reports surviving terms when the text is still present", async () => {
    const bytes = await pdfWithText("CONFIDENTIAL Smith matter SSN 123-45-6789");
    const result = await verifyTermsRemoved(bytes, ["123-45-6789", "nowhere"]);
    expect(result.ok).toBe(false);
    expect(result.survivingTerms).toContain("123-45-6789");
    expect(result.survivingTerms).not.toContain("nowhere");
  });

  it("passes when none of the terms are extractable", async () => {
    const bytes = await pdfWithText("A perfectly ordinary sentence.");
    const result = await verifyTermsRemoved(bytes, ["CONFIDENTIAL", "123-45-6789"]);
    expect(result.ok).toBe(true);
    expect(result.survivingTerms).toEqual([]);
  });

  it("matches terms case-insensitively", async () => {
    const bytes = await pdfWithText("Marked Confidential across the top.");
    const result = await verifyTermsRemoved(bytes, ["CONFIDENTIAL"]);
    expect(result.ok).toBe(false);
    expect(result.survivingTerms).toEqual(["CONFIDENTIAL"]);
  });

  it("catches a surviving term even when it is split/hyphenated across items", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 200]);
    // Draw the term as separate pieces, as a broken text layer would extract them.
    page.drawText("SEC", { x: 10, y: 120, size: 12, font });
    page.drawText("RET", { x: 60, y: 120, size: 12, font });
    page.drawText("123 - 45 - 6789", { x: 10, y: 90, size: 12, font });
    const bytes = await pdf.save();
    const result = await verifyTermsRemoved(bytes, ["SECRET", "123-45-6789"]);
    expect(result.ok).toBe(false);
    expect(result.survivingTerms).toEqual(expect.arrayContaining(["SECRET", "123-45-6789"]));
  });

  it("treats a punctuation-only term as unverifiable (surviving)", async () => {
    const bytes = await pdfWithText("nothing to see");
    const result = await verifyTermsRemoved(bytes, ["---"]);
    expect(result.ok).toBe(false);
    expect(result.survivingTerms).toEqual(["---"]);
  });

  it("honors whole-word mode (does not flag a substring inside a larger word)", async () => {
    const bytes = await pdfWithText("The word concatenate appears here.");
    const substring = await verifyTermsRemoved(bytes, ["cat"]);
    expect(substring.ok).toBe(false); // default: substring found in "concatenate"
    const wholeWord = await verifyTermsRemoved(bytes, ["cat"], { wholeWord: true });
    expect(wholeWord.ok).toBe(true); // whole-word: "cat" is not a standalone word
  });

  it("does not treat a non-ASCII term as unverifiable-empty", async () => {
    const bytes = await pdfWithText("only plain ascii text here");
    // The Cyrillic term is absent; with Unicode-aware normalization it becomes a
    // real (non-empty) needle and verifies as removed. Before the fix it would
    // strip to an empty needle and be wrongly reported as surviving forever.
    const result = await verifyTermsRemoved(bytes, ["секрет"]);
    expect(result.ok).toBe(true);
    expect(result.survivingTerms).toEqual([]);
  });
});
