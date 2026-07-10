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

for (const [lookupKey, entry] of Object.entries(reporterTable)) {
  indexReporterAlias(lookupKey, entry);
  indexReporterAlias(entry.abbreviation, entry);
}

export function normalizeReporterAbbreviation(abbreviation: string): string {
  let normalized = "";
  let pendingSpace = false;

  for (const char of abbreviation.trim()) {
    if (isAsciiWhitespace(char)) {
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

  return (
    reporterTable[normalized] ?? compactReporterIndex.get(compactReporterAbbreviation(normalized))
  );
}

function indexReporterAlias(abbreviation: string, entry: ReporterEntry): void {
  compactReporterIndex.set(
    compactReporterAbbreviation(normalizeReporterAbbreviation(abbreviation)),
    entry,
  );
}

function compactReporterAbbreviation(abbreviation: string): string {
  let compacted = "";

  for (const char of abbreviation) {
    if (!isAsciiWhitespace(char)) {
      compacted += char;
    }
  }

  return compacted;
}

function isAsciiWhitespace(char: string): boolean {
  return (
    char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f"
  );
}
