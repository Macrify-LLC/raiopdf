import { extractAllText } from "../pdfjs-node.js";

export type RedactionVerification = {
  /** True when none of the redacted terms remain extractable. */
  ok: boolean;
  /** Redacted terms still found in the document's extractable text. */
  survivingTerms: string[];
  /**
   * Soft signal, never a refusal: terms whose accent-stripped form still
   * appears even though the exact (NFKC) form does not — e.g. term "résumé"
   * with "resume" left in the text layer. An OCR'd accent-less variant of a
   * redacted name is worth a human look, but blocking an otherwise clean
   * redaction on it would be a false positive.
   */
  accentInsensitiveSurvivors: string[];
};

export type VerifyOptions = {
  /** Match whole words only (mirrors the redaction's wholeWord option). */
  wholeWord?: boolean;
};

/**
 * The hard-gate normalizer (refuses the write on a match). Lowercase and
 * reduce any run of non-letter/non-digit characters to a single space, using
 * Unicode classes so CJK / Cyrillic / Greek terms are preserved (an
 * ASCII-only strip would erase them, making them unverifiable forever).
 *
 * NFKC-normalizes first — canonical composition handles composed vs
 * decomposed spellings (a text layer that extracts "Muñoz" as "Mun" +
 * combining tilde + "oz" still matches the composed needle), and the
 * compatibility mapping folds ligatures and fullwidth forms (a text layer's
 * "ﬁle" still matches the needle "file"). Diacritics are PRESERVED: "résumé"
 * and "resume" stay distinct, so an accent-less near-miss doesn't falsely
 * block a clean redaction — that case is the soft signal below.
 * Exported for direct testing (a decomposed haystack can't be produced with
 * the WinAnsi test fonts).
 */
export function normalizeSpaced(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The soft-signal normalizer: like {@link normalizeSpaced} but additionally
 * strips combining marks (NFKD, drop \p{M}) so "résumé" and "resume"
 * compare equal. A hit here that the hard gate missed is surfaced as a
 * warning, never a refusal.
 */
export function normalizeSpacedMarkless(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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
function termPresent(
  haystackSpaced: string,
  haystackCollapsed: string,
  termSpaced: string,
  wholeWord: boolean,
): boolean {
  if (wholeWord) {
    return new RegExp(`(?:^| )${escapeRegExp(termSpaced)}(?: |$)`, "u").test(haystackSpaced);
  }
  return haystackCollapsed.includes(termSpaced.replace(/ /g, ""));
}

export async function verifyTermsRemoved(
  bytes: Uint8Array,
  terms: readonly string[],
  options: VerifyOptions = {},
): Promise<RedactionVerification> {
  const extracted = await extractAllText(bytes);
  const spaced = normalizeSpaced(extracted);
  const collapsed = spaced.replace(/ /g, "");
  const spacedMarkless = normalizeSpacedMarkless(extracted);
  const collapsedMarkless = spacedMarkless.replace(/ /g, "");
  const wholeWord = options.wholeWord ?? false;
  const seen = new Set<string>();
  const survivingTerms: string[] = [];
  const accentInsensitiveSurvivors: string[] = [];

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

    if (termPresent(spaced, collapsed, termSpaced, wholeWord)) {
      survivingTerms.push(term);
      continue;
    }

    // Hard gate clean — check the accent-stripped shadow match. Runs in both
    // directions: accented term vs unaccented remaining text ("résumé" /
    // "resume") and unaccented term vs accented remaining text.
    const termMarkless = normalizeSpacedMarkless(term);
    if (
      termMarkless.length > 0 &&
      termPresent(spacedMarkless, collapsedMarkless, termMarkless, wholeWord)
    ) {
      accentInsensitiveSurvivors.push(term);
    }
  }

  return {
    ok: survivingTerms.length === 0,
    survivingTerms,
    accentInsensitiveSurvivors,
  };
}
