import reportersGeneratedJson from "./data/reporters.generated.json" with { type: "json" };

export type ReporterKind = "case";

export type ReporterEntry = Readonly<{
  abbreviation: string;
  name: string;
  kind: ReporterKind;
  editions?: readonly string[];
}>;

export type ReporterTable = Readonly<Record<string, ReporterEntry>>;

export const reporterTable = reportersGeneratedJson as ReporterTable;

const compactReporterIndex = new Map<string, ReporterEntry>();
// Case-folded fallback for matches the citation regex accepted
// case-insensitively (e.g. an ALL-CAPS heading citing "123 SO. 2D 456").
// Exact-case lookups always win; this index is only consulted when they miss.
// Case-folding is safe for this table: it introduces no collisions between
// different reporter series beyond the ones the exact-case compact index
// already has (asserted by a test over the whole generated table).
const caseFoldedReporterIndex = new Map<string, ReporterEntry>();

for (const [lookupKey, entry] of Object.entries(reporterTable)) {
  indexReporterAlias(lookupKey, entry);
  indexReporterAlias(entry.abbreviation, entry);
}

export function normalizeReporterAbbreviation(abbreviation: string): string {
  let normalized = "";
  let pendingSpace = false;

  for (const char of abbreviation.trim()) {
    if (isWhitespace(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }

    if (pendingSpace) {
      normalized += " ";
      pendingSpace = false;
    }

    normalized += char;
  }

  return normalized;
}

export function lookupReporter(abbreviation: string): ReporterEntry | undefined {
  const normalized = normalizeReporterAbbreviation(abbreviation);
  const compacted = compactReporterAbbreviation(normalized);

  return (
    reporterTable[normalized]
      ?? compactReporterIndex.get(compacted)
      ?? caseFoldedReporterIndex.get(compacted.toLowerCase())
  );
}

function indexReporterAlias(abbreviation: string, entry: ReporterEntry): void {
  const compacted = compactReporterAbbreviation(normalizeReporterAbbreviation(abbreviation));

  compactReporterIndex.set(compacted, entry);
  caseFoldedReporterIndex.set(compacted.toLowerCase(), entry);
}

function compactReporterAbbreviation(abbreviation: string): string {
  let compacted = "";

  for (const char of abbreviation) {
    if (!isWhitespace(char)) {
      compacted += char;
    }
  }

  return compacted;
}

// Unicode-aware: Bluebook-formatted documents routinely carry non-breaking
// (U+00A0) and narrow non-breaking (U+202F) spaces inside reporter
// abbreviations, and the citation regex already matches them via `\s`.
function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}
