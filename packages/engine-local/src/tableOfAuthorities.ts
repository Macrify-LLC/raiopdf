import type {
  PdfAuthorityEntry,
  PdfTableOfAuthoritiesOptions,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { renderStableFrontMatter, type FrontMatterSection, type StableFrontMatterRenderResult } from "./frontMatter";

const DEFAULT_TOA_TITLE = "Table of Authorities";
const DEFAULT_PASSIM_THRESHOLD = 5;

const AUTHORITY_SECTIONS: ReadonlyArray<{
  kind: PdfAuthorityEntry["kind"];
  title: string;
}> = [
  { kind: "case", title: "Cases" },
  { kind: "statute", title: "Statutes" },
  { kind: "rule", title: "Rules" },
  { kind: "constitutional", title: "Constitutional Provisions" },
  { kind: "other", title: "Other" },
];

const AUTHORITY_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

/**
 * Controls how entry page numbers render in the generated table.
 *
 * - `"source"` (default): render the 1-based source-document page numbers
 *   as provided. Use this whenever the table stands alone (Save as PDF,
 *   preview) so the printed numbers keep referencing the source document.
 * - `"physical"`: shift each rendered reference by the table's own page
 *   count. Use this only when the table will be prepended to the document
 *   it indexes, so the printed numbers match physical positions in the
 *   combined document.
 */
export type ToaPageNumberMode = "source" | "physical";

export async function drawToaPages(
  options: PdfTableOfAuthoritiesOptions,
  pageNumberMode: ToaPageNumberMode = "source",
): Promise<StableFrontMatterRenderResult> {
  const passimThreshold = normalizePassimThreshold(options.passimThreshold);

  return renderStableFrontMatter({
    title: options.title ?? DEFAULT_TOA_TITLE,
    sections: ({ frontMatterPageCount }) =>
      buildTableOfAuthoritiesSections(
        options.entries,
        passimThreshold,
        pageNumberMode === "physical" ? frontMatterPageCount : 0,
      ),
  });
}

export function buildTableOfAuthoritiesSections(
  entries: readonly PdfAuthorityEntry[],
  passimThreshold: number = DEFAULT_PASSIM_THRESHOLD,
  pageOffset: number = 0,
): readonly FrontMatterSection[] {
  const grouped = new Map<PdfAuthorityEntry["kind"], PdfAuthorityEntry[]>();

  for (const section of AUTHORITY_SECTIONS) {
    grouped.set(section.kind, []);
  }

  for (const entry of entries) {
    grouped.get(entry.kind)?.push(entry);
  }

  const sections: FrontMatterSection[] = [];
  for (const section of AUTHORITY_SECTIONS) {
    const rows = [...(grouped.get(section.kind) ?? [])]
      .sort(compareAuthorityEntries)
      .map((entry) => ({
        leftText: entry.citation,
        rightText: formatAuthorityPageList(entry.pages, passimThreshold, pageOffset),
      }));

    if (rows.length > 0) {
      sections.push({ title: section.title, rows });
    }
  }

  return sections;
}

export function formatAuthorityPageList(
  pages: readonly number[],
  passimThreshold: number = DEFAULT_PASSIM_THRESHOLD,
  pageOffset: number = 0,
): string {
  const normalizedPassimThreshold = normalizePassimThreshold(passimThreshold);
  const normalizedPages = normalizePageNumbers(pages);

  if (normalizedPages.length === 0) {
    return "";
  }

  if (normalizedPages.length > normalizedPassimThreshold) {
    return "passim";
  }

  const ranges: string[] = [];
  let rangeStart = normalizedPages[0]!;
  let previous = rangeStart;

  for (let index = 1; index < normalizedPages.length; index += 1) {
    const page = normalizedPages[index]!;
    if (page === previous + 1) {
      previous = page;
      continue;
    }

    ranges.push(formatPageRange(rangeStart, previous, pageOffset));
    rangeStart = page;
    previous = page;
  }

  ranges.push(formatPageRange(rangeStart, previous, pageOffset));

  return ranges.join(", ");
}

function compareAuthorityEntries(left: PdfAuthorityEntry, right: PdfAuthorityEntry): number {
  const citationComparison = AUTHORITY_COLLATOR.compare(left.citation, right.citation);

  return citationComparison === 0
    ? left.citation.localeCompare(right.citation)
    : citationComparison;
}

function formatPageRange(start: number, end: number, pageOffset: number): string {
  const adjustedStart = start + pageOffset;
  const adjustedEnd = end + pageOffset;

  return adjustedStart === adjustedEnd
    ? String(adjustedStart)
    : `${adjustedStart}-${adjustedEnd}`;
}

function normalizePassimThreshold(value: number | undefined): number {
  const threshold = value ?? DEFAULT_PASSIM_THRESHOLD;

  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "passimThreshold must be a non-negative integer.");
  }

  return threshold;
}

function normalizePageNumbers(pages: readonly number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];

  for (const page of pages) {
    if (!Number.isInteger(page) || page <= 0 || seen.has(page)) {
      continue;
    }

    seen.add(page);
    normalized.push(page);
  }

  return normalized.sort((left, right) => left - right);
}
