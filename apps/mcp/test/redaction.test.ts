import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { normalizeSpaced, verifyTermsRemoved } from "../src/redaction/verify.js";

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

  // These two constants look identical but differ at the byte level:
  // COMPOSED uses the single code point U+00F1, DECOMPOSED uses
  // "n" + U+0303 (combining tilde). Guarded by the assertion below so
  // an editor normalization pass can't silently collapse the distinction.
  const COMPOSED_MUNOZ = "Muñoz";
  const DECOMPOSED_MUNOZ = "Muñoz";

  it("keeps the composed/decomposed fixtures genuinely distinct", () => {
    expect(COMPOSED_MUNOZ).not.toBe(DECOMPOSED_MUNOZ);
    expect(COMPOSED_MUNOZ.length).toBe(5);
    expect(DECOMPOSED_MUNOZ.length).toBe(6);
  });

  it("matches a decomposed needle against a composed haystack (Unicode normalization)", async () => {
    // The PDF text layer carries the composed form; the needle arrives
    // decomposed, as another tool might supply it. Before NFKD normalization
    // the combining mark was stripped to a space on the needle side only, so
    // the surviving term verified as removed - a redaction-verification
    // false negative.
    const bytes = await pdfWithText(`Deposition of ${COMPOSED_MUNOZ}, page 3`);
    const result = await verifyTermsRemoved(bytes, [DECOMPOSED_MUNOZ]);
    expect(result.ok).toBe(false);
    expect(result.survivingTerms).toEqual([DECOMPOSED_MUNOZ]);
  });

  it("still passes a decomposed needle once the composed text is gone", async () => {
    const bytes = await pdfWithText("nothing sensitive left");
    const result = await verifyTermsRemoved(bytes, [DECOMPOSED_MUNOZ]);
    expect(result.ok).toBe(true);
    expect(result.survivingTerms).toEqual([]);
  });

  it("normalizes composed and decomposed spellings identically (both directions)", () => {
    // Direct check of the shared helper: a decomposed haystack cannot be
    // drawn with the WinAnsi test fonts, so the haystack side is exercised
    // here rather than through a PDF.
    expect(normalizeSpaced(COMPOSED_MUNOZ)).toBe(normalizeSpaced(DECOMPOSED_MUNOZ));
    expect(normalizeSpaced("Sécret")).toBe(normalizeSpaced("Sécret"));
    // The mark-stripped, lowercased form both spellings collapse to.
    expect(normalizeSpaced(COMPOSED_MUNOZ)).toBe("munoz");
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
