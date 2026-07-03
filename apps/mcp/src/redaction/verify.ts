import { extractAllText } from "@raiopdf/rules";

export type RedactionVerification = {
  /** True when none of the redacted terms remain extractable. */
  ok: boolean;
  /** Redacted terms still found in the document's extractable text. */
  survivingTerms: string[];
};

export type VerifyOptions = {
  /** Match whole words only (mirrors the redaction's wholeWord option). */
  wholeWord?: boolean;
};

/**
 * Lowercase and reduce any run of non-letter/non-digit characters to a single
 * space. Uses Unicode classes so CJK / Cyrillic / Greek terms are preserved
 * (an ASCII-only strip would erase them, making them unverifiable forever).
 */
function normalizeSpaced(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The "fail-leaves-no-output" (S4) check for term redaction: after Stirling's
 * rasterizing auto-redact, re-extract all recoverable text (page text +
 * annotations/form fields) and confirm none of the redacted terms survive.
 *
 * Substring mode collapses whitespace so a term split across pdf.js items
 * ("sec" "ret") or hyphenated is still caught. wholeWord mode matches on word
 * boundaries so redacting whole-word "cat" is not falsely flagged by
 * "concatenate". A term that normalizes to empty (all punctuation) is treated as
 * surviving, since it cannot be verified. The bias is toward false positives
 * (failing a clean redaction) over false negatives (passing a leaked one).
 */
export async function verifyTermsRemoved(
  bytes: Uint8Array,
  terms: readonly string[],
  options: VerifyOptions = {},
): Promise<RedactionVerification> {
  const spaced = normalizeSpaced(await extractAllText(bytes));
  const collapsed = spaced.replace(/ /g, "");
  const wholeWord = options.wholeWord ?? false;
  const seen = new Set<string>();
  const survivingTerms: string[] = [];

  for (const term of terms) {
    if (seen.has(term)) {
      continue;
    }
    seen.add(term);

    const termSpaced = normalizeSpaced(term);
    if (termSpaced.length === 0) {
      survivingTerms.push(term);
      continue;
    }

    let present: boolean;
    if (wholeWord) {
      present = new RegExp(`(?:^| )${escapeRegExp(termSpaced)}(?: |$)`, "u").test(spaced);
    } else {
      present = collapsed.includes(termSpaced.replace(/ /g, ""));
    }
    if (present) {
      survivingTerms.push(term);
    }
  }

  return { ok: survivingTerms.length === 0, survivingTerms };
}
