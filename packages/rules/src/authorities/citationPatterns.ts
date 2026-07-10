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
const SECTION_VALUE = String.raw`[A-Za-z0-9][A-Za-z0-9().:-]*`;
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

// Example: 42 U.S.C. § 1983; 11 USC section 362.
export const federalStatutePattern: CitationPattern = {
  name: "federal-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?<title>\d+)\s+U\.?\s*S\.?\s*C\.?\s*(?:A\.?\s*)?${SECTION_MARKER}\s*(?<section>${SECTION_VALUE})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Fla. Stat. § 768.28(5); Florida Statutes section 90.702.
export const floridaStatutePattern: CitationPattern = {
  name: "florida-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?<code>Fla\.?|Florida)\s+Stat(?:\.|utes)?(?:\s+Ann\.?)?\s*${SECTION_MARKER}\s*(?<section>${SECTION_VALUE})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: O.C.G.A. § 9-11-56; OCGA section 50-18-70.
export const georgiaStatutePattern: CitationPattern = {
  name: "georgia-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}O\.?\s*C\.?\s*G\.?\s*A\.?\s*${SECTION_MARKER}\s*(?<section>${SECTION_VALUE})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Ind. Code § 34-13-3-5; Indiana Code sec. 35-42-2-1.
export const indianaStatutePattern: CitationPattern = {
  name: "indiana-statute",
  kind: "statute",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?:Ind\.?|Indiana)\s+Code\s*${SECTION_MARKER}\s*(?<section>${SECTION_VALUE})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Fed. R. Civ. P. 56; Federal Rule of Evidence 702.
export const federalRulePattern: CitationPattern = {
  name: "federal-rule",
  kind: "rule",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?:Fed\.?|Federal)\s+(?:R\.?|Rule)\s+(?<body>Civ\.?|Civil|Evid\.?|Evidence|App\.?|Appellate|Crim\.?|Criminal|Bankr\.?|Bankruptcy)(?:\s+(?:P\.?|Proc\.?|Procedure))?\s*(?<rule>${RULE_NUMBER})${CITATION_SUFFIX}`,
    "giu",
  ),
};

// Example: Fla. R. Civ. P. 1.510; Florida Rule of Appellate Procedure 9.130.
export const floridaRulePattern: CitationPattern = {
  name: "florida-rule",
  kind: "rule",
  regex: new RegExp(
    String.raw`${CITATION_PREFIX}(?:Fla\.?|Florida)\s+(?:R\.?|Rule)\s+(?<body>Civ\.?|Civil|App\.?|Appellate|Crim\.?|Criminal|Jud\.?\s*Admin\.?|Judicial\s+Administration|Fam\.?\s*L\.?|Family\s+Law)(?:\s+(?:P\.?|Proc\.?|Procedure))?\s*(?<rule>${RULE_NUMBER})${CITATION_SUFFIX}`,
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

export function buildCitationPatterns(reporters: ReporterTable): readonly CitationPattern[] {
  return [
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
