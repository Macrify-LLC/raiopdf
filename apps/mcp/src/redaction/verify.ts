import { extractAllText } from "./pdfjs-node.js";

export type RedactionVerification = {
  /** True when none of the redacted terms remain extractable. */
  ok: boolean;
  /** Redacted terms still found in the document's extractable text. */
  survivingTerms: string[];
};

/**
 * Collapse text to lowercase alphanumerics only, so a surviving term is caught
 * even when pdf.js splits it across text items ("sec" "ret"), hyphenates it
 * ("confi-\ndential"), or separates punctuation ("123 -45 -6789"). This biases
 * toward false positives (failing a clean redaction) over false negatives
 * (passing a leaked one) — the safe direction for a redaction guarantee.
 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The "fail-leaves-no-output" (S4) check for term redaction: after Stirling's
 * rasterizing auto-redact, re-extract all recoverable text (page text +
 * annotations/form fields) and confirm none of the redacted terms survive, even
 * split or hyphenated. A term whose normalized form is empty (all punctuation)
 * is treated as surviving, since it cannot be verified.
 */
export async function verifyTermsRemoved(
  bytes: Uint8Array,
  terms: readonly string[],
): Promise<RedactionVerification> {
  const corpus = normalize(await extractAllText(bytes));
  const seen = new Set<string>();
  const survivingTerms: string[] = [];
  for (const term of terms) {
    const needle = normalize(term);
    if (seen.has(term)) {
      continue;
    }
    seen.add(term);
    if (needle.length === 0 || corpus.includes(needle)) {
      survivingTerms.push(term);
    }
  }
  return { ok: survivingTerms.length === 0, survivingTerms };
}
