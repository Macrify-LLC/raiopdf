import type { PdfAuthorityEntry, PdfTableOfAuthoritiesOptions } from "@raiopdf/engine-api";
import type { AuthorityKind } from "@raiopdf/rules";
import { filePort, type SavedFile } from "./filePort";
import { generateToaPdf } from "./toaPreview";

export interface ReviewedAuthorityEntry {
  kind: AuthorityKind;
  citation: string;
  pageIndexes: readonly number[];
  excluded?: boolean | undefined;
}

export function buildTableOfAuthoritiesOptions(
  entries: readonly ReviewedAuthorityEntry[],
  passimThreshold: number,
): PdfTableOfAuthoritiesOptions {
  return {
    entries: entries
      .filter((entry) => !entry.excluded)
      .map(toPdfAuthorityEntry)
      .filter((entry) => entry.citation.length > 0 && entry.pages.length > 0),
    passimThreshold,
  };
}

export async function saveToaPdf(
  entries: readonly ReviewedAuthorityEntry[],
  passimThreshold: number,
  suggestedName: string,
): Promise<SavedFile | null> {
  const bytes = await generateToaPdf(buildTableOfAuthoritiesOptions(entries, passimThreshold));
  return filePort.saveFile(bytes, suggestedName, null);
}

function toPdfAuthorityEntry(entry: ReviewedAuthorityEntry): PdfAuthorityEntry {
  return {
    kind: entry.kind,
    citation: entry.citation.trim(),
    pages: normalizePageIndexes(entry.pageIndexes).map((pageIndex) => pageIndex + 1),
  };
}

function normalizePageIndexes(pageIndexes: readonly number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];

  for (const pageIndex of pageIndexes) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || seen.has(pageIndex)) {
      continue;
    }

    seen.add(pageIndex);
    normalized.push(pageIndex);
  }

  return normalized.sort((left, right) => left - right);
}
