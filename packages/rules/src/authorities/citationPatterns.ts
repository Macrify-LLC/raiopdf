import type { AuthorityKind } from "./types.js";
import type { ReporterTable } from "./reporters.js";

export type CitationPatternName =
  | "case-reporter"
  | "federal-statute"
  | "florida-statute"
  | "georgia-statute"
  | "indiana-statute"
  | "federal-rule"
  | "florida-rule"
  | "state-rule"
  | "federal-constitutional"
  | "state-constitutional";

export type CitationPattern = {
  name: CitationPatternName;
  kind: AuthorityKind;
  regex: RegExp;
};

const CITATION_PREFIX = String.raw`(?<![A-Za-z0-9$])`;
const CITATION_SUFFIX = String.raw`(?![A-Za-z0-9])`;
const SECTION_MARKER = String.raw`(?:§{1,2}|sections?|secs?\.?)`;
const SECTION_MARKER_PLURAL = String.raw`(?:§§|sections|secs\.?)`;
const SECTION_MARKER_SINGULAR = String.raw`(?:§|section|sec\.?)`;
const SECTION_VALUE = String.raw`[A-Za-z0-9][A-Za-z0-9().:-]*`;
// Continuation segments after a comma in a §§ list are deliberately narrow so
// prose ("1331, and the court held") and adjacent citations are never
// swallowed: only parenthetical chains ("(5)", "(1)(a)") or short
// digit-leading section numbers qualify.
const SECTION_PARENTHETICAL = String.raw`\([A-Za-z0-9]{1,10}\)`;
const SECTION_LIST_CONTINUATION = String.raw`(?:${SECTION_PARENTHETICAL}(?:${SECTION_PARENTHETICAL})*|\d[A-Za-z0-9().:-]{0,24})`;
const SECTION_LIST = String.raw`${SECTION_VALUE}(?:,\s*${SECTION_LIST_CONTINUATION})*`;
// Plural markers (§§ / sections / secs.) accept a bounded comma-separated
// list captured as `sectionList`; singular markers capture a single
// `section`. Keeping list capture behind the plural marker prevents a
// singular cite followed by other citation text from over-capturing.
const SECTION_CLAUSE = String.raw`(?:${SECTION_MARKER_PLURAL}\s*(?<sectionList>${SECTION_LIST})|${SECTION_MARKER_SINGULAR}\s*(?<section>${SECTION_VALUE}))`;
const RULE_NUMBER = String.raw`\d+[A-Za-z]?(?:\.\d+)*(?:\([a-zA-Z0-9]+\))*`;
const CONSTITUTION_SECTION_SEPARATOR = String.raw`(?:\s+,\s*|,\s*|\s+)`;
const CONSTITUTION_PART = String.raw`(?:art\.?|article|amend\.?|amendment)\s+[A-Za-z0-9IVXLCDMivxlcdm]+(?:${CONSTITUTION_SECTION_SEPARATOR}${SECTION_MARKER}\s*[A-Za-z0-9IVXLCDMivxlcdm]+(?:\([a-zA-Z0-9]+\))*)?`;

// Example: 410 U.S. 113; 550 F.3d 1214; 123 So. 3d 456.
export function buildCaseReporterCitationPattern(reporters: ReporterTable): CitationPattern {
  const reporterAlternation = reporterAlternatives(reporters).join("|");

  return {
    name: "case-reporter",
    kind: "case",
    regex: new RegExp(
      String.raw`${CITATION_PREFIX}(?<volume>\d{1,4})\s+(?<reporter>${reporterAlternation})\s+(?<page>\d{1,6})(?!\d)`,
      "giu",
    ),
  };
}

// Example: 42 U.S.C. § 1983; 11 USC section 362; 28 U.S.C. §§ 1331, 1332.
export const federalStatutePattern: CitationPattern = {
  name: "federal-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?<title>\d+)\s+U\.?\s*S\.?\s*C\.?\s*(?:A\.?\s*)?${SECTION_CLAUSE}${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Fla. Stat. § 768.28(5); Florida Statutes section 90.702;
// Fla. Stat. §§ 768.28(1), (5).
export const floridaStatutePattern: CitationPattern = {
  name: "florida-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?<code>Fla\.?|Florida)\s+Stat(?:\.|utes)?(?:\s+Ann\.?)?\s*${SECTION_CLAUSE}${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: O.C.G.A. § 9-11-56; OCGA section 50-18-70.
export const georgiaStatutePattern: CitationPattern = {
  name: "georgia-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}O\.?\s*C\.?\s*G\.?\s*A\.?\s*${SECTION_CLAUSE}${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Ind. Code § 34-13-3-5; Indiana Code sec. 35-42-2-1.
export const indianaStatutePattern: CitationPattern = {
  name: "indiana-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?:Ind\.?|Indiana)\s+Code\s*${SECTION_CLAUSE}${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Fed. R. Civ. P. 56; Federal Rule of Evidence 702;
// Federal Rules of Civil Procedure 56.
export const federalRulePattern: CitationPattern = {
  name: "federal-rule",
  kind: "rule",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?:Fed\.?|Federal)\s+(?:R\.?|Rules?)\s+(?:of\s+)?(?<body>Civ\.?|Civil|Evid\.?|Evidence|App\.?|Appellate|Crim\.?|Criminal|Bankr\.?|Bankruptcy)(?:\s+(?:P\.?|Proc\.?|Procedure))?\s*(?<rule>${RULE_NUMBER})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Fla. R. Civ. P. 1.510; Florida Rule of Appellate Procedure 9.130;
// Fla. R. Gen. Prac. & Jud. Admin. 2.425.
export const floridaRulePattern: CitationPattern = {
  name: "florida-rule",
  kind: "rule",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?:Fla\.?|Florida)\s+(?:R\.?|Rules?)\s+(?:of\s+)?(?<body>Civ\.?|Civil|App\.?|Appellate|Crim\.?|Criminal|Gen\.?\s*Prac\.?\s*&\s*Jud\.?\s*Admin\.?|General\s+Practice\s+and\s+Judicial\s+Administration|Jud\.?\s*Admin\.?|Judicial\s+Administration|Fam\.?\s*L\.?|Family\s+Law)(?:\s+(?:P\.?|Proc\.?|Procedure))?\s*(?<rule>${RULE_NUMBER})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Ind. Trial Rule 56; Ga. Unif. Super. Ct. R. 6.3.
export const stateRulePattern: CitationPattern = {
  name: "state-rule",
  kind: "rule",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?:(?<indiana>(?:Ind\.?|Indiana)\s+(?:Trial|Appellate|Evidence)\s+Rule)|(?<georgia>Ga\.?\s+Unif\.?\s+Super\.?\s+Ct\.?\s+R\.?))\s*(?<rule>${RULE_NUMBER})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: U.S. Const. art. III, § 2; U.S. Const. amend. XIV.
export const federalConstitutionalPattern: CitationPattern = {
  name: "federal-constitutional",
  kind: "constitutional",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}U\.?\s*S\.?\s+Const\.?\s+(?<part>${CONSTITUTION_PART})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Fla. Const. art. V, § 3; Ga. Const. art. I, § I.
export const stateConstitutionalPattern: CitationPattern = {
  name: "state-constitutional",
  kind: "constitutional",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?<state>Fla\.?|Florida|Ga\.?|Georgia|Ind\.?|Indiana)\s+Const\.?\s+(?<part>${CONSTITUTION_PART})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Building the case-reporter pattern compiles a large alternation (the whole
// reporter table), so the pattern set is memoized per reporter table. The
// compiled regexes are safe to share across calls: detection uses
// `String.prototype.matchAll`, which iterates over an internal copy and never
// mutates the shared pattern's `lastIndex`.
const citationPatternsCache = new WeakMap<ReporterTable, readonly CitationPattern[]>();

export function buildCitationPatterns(reporters: ReporterTable): readonly CitationPattern[] {
  const cached = citationPatternsCache.get(reporters);

  if (cached !== undefined) {
    return cached;
  }

  const patterns: readonly CitationPattern[] = [
    buildCaseReporterCitationPattern(reporters),
    federalStatutePattern,
    floridaStatutePattern,
    georgiaStatutePattern,
    indianaStatutePattern,
    federalRulePattern,
    floridaRulePattern,
    stateRulePattern,
    federalConstitutionalPattern,
    stateConstitutionalPattern,
  ];

  citationPatternsCache.set(reporters, patterns);

  return patterns;
}

function reporterAlternatives(reporters: ReporterTable): string[] {
  const alternatives = new Set<string>();

  for (const [lookupKey, entry] of Object.entries(reporters)) {
    alternatives.add(lookupKey);
    alternatives.add(entry.abbreviation);

    for (const edition of entry.editions ?? []) {
      alternatives.add(edition);
    }
  }

  return [...alternatives]
    .map((alternative) => alternative.trim())
    .filter((alternative) => /[A-Za-z]/u.test(alternative))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((alternative) => escapeReporterAlternative(alternative));
}

function escapeReporterAlternative(alternative: string): string {
  return alternative
    .replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")
    .replace(/\s+/gu, String.raw`\s+`);
}
