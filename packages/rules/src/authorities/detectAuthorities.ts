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
      for (const match of page.text.matchAll(resetPattern(pattern.regex))) {
        const canonical = canonicalizeMatch(pattern, match);

        if (canonical === null) {
          continue;
        }

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

function canonicalizeMatch(pattern: CitationPattern, match: RegExpMatchArray): string | null {
  const groups = match.groups;
  if (groups === undefined) {
    return null;
  }

  switch (pattern.name) {
    case "case-reporter":
      return canonicalizeCase(groups);
    case "federal-statute":
      return canonicalizeFederalStatute(groups);
    case "florida-statute":
      return canonicalizeStatute("Fla. Stat.", groups);
    case "georgia-statute":
      return canonicalizeStatute("O.C.G.A.", groups);
    case "indiana-statute":
      return canonicalizeStatute("Ind. Code", groups);
    case "federal-rule":
      return canonicalizeFederalRule(groups);
    case "florida-rule":
      return canonicalizeFloridaRule(groups);
    case "state-rule":
      return canonicalizeStateRule(groups);
    case "federal-constitutional":
      return `U.S. Const. ${canonicalizeConstitutionPart(requiredGroup(groups, "part"))}`;
    case "state-constitutional":
      return `${canonicalizeState(requiredGroup(groups, "state"))} Const. ${canonicalizeConstitutionPart(requiredGroup(groups, "part"))}`;
    default:
      return collapseWhitespace(match[0]);
  }
}

function canonicalizeCase(groups: Record<string, string | undefined>): string | null {
  const volume = requiredGroup(groups, "volume");
  const reporterText = requiredGroup(groups, "reporter");
  const page = requiredGroup(groups, "page");
  const reporter = lookupReporter(reporterText);

  if (reporter === undefined) {
    return null;
  }

  return `${volume} ${reporter.abbreviation} ${page}`;
}

function canonicalizeFederalStatute(groups: Record<string, string | undefined>): string {
  return `${requiredGroup(groups, "title")} U.S.C. § ${canonicalizeSection(requiredGroup(groups, "section"))}`;
}

function canonicalizeStatute(
  code: "Fla. Stat." | "O.C.G.A." | "Ind. Code",
  groups: Record<string, string | undefined>,
): string {
  return `${code} § ${canonicalizeSection(requiredGroup(groups, "section"))}`;
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
  return collapseWhitespace(part)
    .replace(/\barticle\b/giu, "art.")
    .replace(/\bart\b\.?/giu, "art.")
    .replace(/\bamendment\b/giu, "amend.")
    .replace(/\bamend\b\.?/giu, "amend.")
    .replace(/\bsections?\b/giu, "§")
    .replace(/\bsecs?\.?\b/giu, "§")
    .replace(/\s*§+\s*/gu, " § ")
    .replace(/\s*,\s*/gu, ", ")
    .trim();
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
  return collapseWhitespace(section)
    .replace(/[.,;:]+$/u, "")
    .replace(/\s*-\s*/gu, "-")
    .replace(/\s*,\s*/gu, ", ");
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

function resetPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function authorityId(canonical: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `authority-${(hash >>> 0).toString(36)}`;
}
