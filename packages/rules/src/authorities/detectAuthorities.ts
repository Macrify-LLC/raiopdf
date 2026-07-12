import type { PageTextByPage } from "../types.js";
import { buildCitationPatterns, type CitationPattern } from "./citationPatterns.js";
import { lookupReporter, type ReporterTable } from "./reporters.js";
import type { AuthorityKind, DetectedAuthority } from "./types.js";

type AuthorityDraft = {
  kind: AuthorityKind;
  canonical: string;
  pages: Set<number>;
};

export function detectAuthorities(
  pages: PageTextByPage,
  reporters: ReporterTable,
): DetectedAuthority[] {
  const authorities = new Map<string, AuthorityDraft>();
  const patterns = buildCitationPatterns(reporters);

  for (const page of pages) {
    for (const pattern of patterns) {
      // `matchAll` iterates over an internal copy of the pattern and never
      // mutates the shared regex's `lastIndex`, so the memoized patterns are
      // reused as-is instead of being recompiled per page.
      for (const match of page.text.matchAll(pattern.regex)) {
        for (const canonical of canonicalizeMatch(pattern, match)) {
          const existing = authorities.get(canonical);
          if (existing === undefined) {
            authorities.set(canonical, {
              kind: pattern.kind,
              canonical,
              pages: new Set([page.pageIndex]),
            });
            continue;
          }

          existing.pages.add(page.pageIndex);
        }
      }
    }
  }

  return [...authorities.values()]
    .map((authority) => ({
      id: authorityId(authority.canonical),
      kind: authority.kind,
      canonical: authority.canonical,
      hits: [...authority.pages]
        .sort((a, b) => a - b)
        .map((pageIndex) => ({ pageIndex })),
    }))
    .sort((a, b) => a.canonical.localeCompare(b.canonical));
}

// A single regex match can canonicalize to several authorities (a §§ list
// like "28 U.S.C. §§ 1331, 1332" yields one entry per section, so each
// section dedupes against standalone cites of the same section elsewhere in
// the document). An empty array drops the match.
function canonicalizeMatch(pattern: CitationPattern, match: RegExpMatchArray): readonly string[] {
  const groups = match.groups;
  if (groups === undefined) {
    return [];
  }

  switch (pattern.name) {
    case "case-reporter":
      return canonicalizeCase(groups);
    case "federal-statute":
      return statuteSections(groups).map(
        (section) => `${requiredGroup(groups, "title")} U.S.C. § ${canonicalizeSection(section)}`,
      );
    case "florida-statute":
      return canonicalizeStatute("Fla. Stat.", groups);
    case "georgia-statute":
      return canonicalizeStatute("O.C.G.A.", groups);
    case "indiana-statute":
      return canonicalizeStatute("Ind. Code", groups);
    case "federal-rule":
      return [canonicalizeFederalRule(groups)];
    case "florida-rule":
      return [canonicalizeFloridaRule(groups)];
    case "state-rule":
      return [canonicalizeStateRule(groups)];
    case "federal-constitutional":
      return [`U.S. Const. ${canonicalizeConstitutionPart(requiredGroup(groups, "part"))}`];
    case "state-constitutional":
      return [`${canonicalizeState(requiredGroup(groups, "state"))} Const. ${canonicalizeConstitutionPart(requiredGroup(groups, "part"))}`];
    default:
      return [collapseWhitespace(match[0])];
  }
}

function canonicalizeCase(groups: Record<string, string | undefined>): readonly string[] {
  const volume = requiredGroup(groups, "volume");
  const reporterText = requiredGroup(groups, "reporter");
  const page = requiredGroup(groups, "page");
  const reporter = lookupReporter(reporterText);

  if (reporter === undefined) {
    return [];
  }

  return [`${volume} ${reporter.abbreviation} ${page}`];
}

function canonicalizeStatute(
  code: "Fla. Stat." | "O.C.G.A." | "Ind. Code",
  groups: Record<string, string | undefined>,
): readonly string[] {
  return statuteSections(groups).map((section) => `${code} § ${canonicalizeSection(section)}`);
}

// Statute patterns capture either a single `section` (§, section, sec.) or a
// comma-separated `sectionList` (§§, sections, secs.).
function statuteSections(groups: Record<string, string | undefined>): readonly string[] {
  const list = groups["sectionList"];

  if (list === undefined) {
    return [requiredGroup(groups, "section")];
  }

  return expandSectionList(list);
}

// "768.28(1), (5)" → ["768.28(1)", "768.28(5)"]: a bare parenthetical
// continuation inherits the base of the preceding full section. Only the
// final leaf parenthetical is replaced, so "768.28(1)(a), (b)" continues as
// "768.28(1)(b)" — the immediate parent, not the bare statute number.
function expandSectionList(list: string): readonly string[] {
  const sections: string[] = [];
  let base = "";

  for (const rawSegment of list.split(",")) {
    const segment = rawSegment.trim();

    if (segment.length === 0) {
      continue;
    }

    if (segment.startsWith("(") && base.length > 0) {
      sections.push(base + segment);
      continue;
    }

    base = stripTrailingLeafParenthetical(segment);
    sections.push(segment);
  }

  return sections;
}

function stripTrailingLeafParenthetical(section: string): string {
  if (!section.endsWith(")")) {
    return section;
  }

  const open = section.lastIndexOf("(");

  return open > 0 ? section.slice(0, open) : section;
}

function canonicalizeFederalRule(groups: Record<string, string | undefined>): string {
  const body = canonicalizeFederalRuleBody(requiredGroup(groups, "body"));
  return `Fed. R. ${body} ${canonicalizeRuleNumber(requiredGroup(groups, "rule"))}`;
}

function canonicalizeFloridaRule(groups: Record<string, string | undefined>): string {
  const body = canonicalizeFloridaRuleBody(requiredGroup(groups, "body"));
  return `Fla. R. ${body} ${canonicalizeRuleNumber(requiredGroup(groups, "rule"))}`;
}

function canonicalizeStateRule(groups: Record<string, string | undefined>): string {
  const rule = canonicalizeRuleNumber(requiredGroup(groups, "rule"));

  if (groups.indiana !== undefined) {
    return `${canonicalizeIndianaRulePrefix(groups.indiana)} ${rule}`;
  }

  return `Ga. Unif. Super. Ct. R. ${rule}`;
}

function canonicalizeFederalRuleBody(body: string): string {
  const normalized = collapseWhitespace(body).replaceAll(".", "").toLowerCase();

  if (normalized === "civ" || normalized === "civil") {
    return "Civ. P.";
  }
  if (normalized === "evid" || normalized === "evidence") {
    return "Evid.";
  }
  if (normalized === "app" || normalized === "appellate") {
    return "App. P.";
  }
  if (normalized === "crim" || normalized === "criminal") {
    return "Crim. P.";
  }

  return "Bankr. P.";
}

function canonicalizeFloridaRuleBody(body: string): string {
  const normalized = collapseWhitespace(body).replaceAll(".", "").toLowerCase();

  if (normalized === "civ" || normalized === "civil") {
    return "Civ. P.";
  }
  if (normalized === "app" || normalized === "appellate") {
    return "App. P.";
  }
  if (normalized === "crim" || normalized === "criminal") {
    return "Crim. P.";
  }
  if (normalized === "jud admin" || normalized === "judicial administration") {
    return "Jud. Admin.";
  }
  if (
    normalized === "gen prac & jud admin"
    || normalized === "general practice and judicial administration"
  ) {
    return "Gen. Prac. & Jud. Admin.";
  }

  return "Fam. L. R. P.";
}

function canonicalizeIndianaRulePrefix(prefix: string): string {
  const normalized = collapseWhitespace(prefix).replaceAll(".", "").toLowerCase();

  if (normalized.includes("appellate")) {
    return "Ind. Appellate Rule";
  }
  if (normalized.includes("evidence")) {
    return "Ind. Evidence Rule";
  }

  return "Ind. Trial Rule";
}

function canonicalizeConstitutionPart(part: string): string {
  // The section-marker replacements put the trailing-period match *after* the
  // word boundary (`\bsecs?\b\.?`) so "sec. 2" fully collapses to "§ 2"
  // instead of stranding the period as "§ . 2".
  const normalized = collapseWhitespace(part)
    .replace(/\barticle\b/giu, "art.")
    .replace(/\bart\b\.?/giu, "art.")
    .replace(/\bamendment\b/giu, "amend.")
    .replace(/\bamend\b\.?/giu, "amend.")
    .replace(/\bsections?\b\.?/giu, "§")
    .replace(/\bsecs?\b\.?/giu, "§");

  const spaced = normalizeCommaSeparators(normalizeSectionMarkerSpacing(normalized)).trim();

  // Every spelling of the same provision ("art. III, § 2", "art. III § 2",
  // "art. III section 2") must land on one canonical shape — exactly ", § "
  // before the section value — so page hits aggregate onto a single row.
  return spaced.replace(/\s*,?\s*§\s*/u, ", § ").trim();
}

function canonicalizeState(state: string): string {
  const normalized = state.replaceAll(".", "").toLowerCase();

  if (normalized === "florida" || normalized === "fla") {
    return "Fla.";
  }
  if (normalized === "georgia" || normalized === "ga") {
    return "Ga.";
  }

  return "Ind.";
}

function canonicalizeSection(section: string): string {
  // Strip trailing .,;: with a linear scan rather than a `[.,;:]+$` regex,
  // which backtracks polynomially on uncontrolled document text (ReDoS).
  const collapsed = collapseWhitespace(section);
  let end = collapsed.length;
  while (end > 0 && ".,;:".includes(collapsed[end - 1]!)) {
    end -= 1;
  }
  const normalized = collapsed.slice(0, end);

  return normalizeCommaSeparators(normalizeHyphenSeparators(normalized));
}

function canonicalizeRuleNumber(rule: string): string {
  return collapseWhitespace(rule);
}

function requiredGroup(groups: Record<string, string | undefined>, name: string): string {
  const value = groups[name];

  if (value === undefined) {
    throw new Error(`Citation pattern did not capture ${name}.`);
  }

  return value;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeHyphenSeparators(value: string): string {
  return normalizeSingleCharacterSeparators(value, "-", "-");
}

function normalizeCommaSeparators(value: string): string {
  return normalizeSingleCharacterSeparators(value, ",", ", ");
}

function normalizeSingleCharacterSeparators(
  value: string,
  separator: string,
  replacement: string,
): string {
  if (!value.includes(separator)) {
    return value;
  }

  return value
    .split(separator)
    .map((part) => part.trim())
    .join(replacement);
}

function normalizeSectionMarkerSpacing(value: string): string {
  let normalized = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] === " " && value[index + 1] === "§") {
      index = consumeSectionMarker(value, index + 1);
      normalized += " § ";
      continue;
    }

    if (value[index] === "§") {
      index = consumeSectionMarker(value, index);
      normalized += " § ";
      continue;
    }

    normalized += value[index];
    index += 1;
  }

  return normalized;
}

function consumeSectionMarker(value: string, markerIndex: number): number {
  let index = markerIndex;

  while (value[index] === "§") {
    index += 1;
  }

  if (value[index] === " ") {
    index += 1;
  }

  return index;
}

function authorityId(canonical: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `authority-${(hash >>> 0).toString(36)}`;
}
