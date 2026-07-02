export interface PageRangeParseResult {
  pageIndexes: number[];
  groups: number[][];
  error: string | null;
}

export function parsePageRanges(
  input: string,
  pageCount: number,
): PageRangeParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return emptyResult("Enter one or more pages.");
  }

  if (pageCount <= 0) {
    return emptyResult("Open a PDF before choosing pages.");
  }

  const groups: number[][] = [];
  const pageIndexes: number[] = [];
  const seen = new Set<number>();
  const tokens = trimmed.split(",").map((token) => token.trim());

  for (const token of tokens) {
    if (!token) {
      return emptyResult("Remove the empty range.");
    }

    const group = parseRangeToken(token, pageCount);

    if (typeof group === "string") {
      return emptyResult(group);
    }

    groups.push(group);

    for (const pageIndex of group) {
      if (!seen.has(pageIndex)) {
        seen.add(pageIndex);
        pageIndexes.push(pageIndex);
      }
    }
  }

  return {
    pageIndexes,
    groups,
    error: null,
  };
}

export function formatDefaultRange(pageCount: number): string {
  if (pageCount <= 1) {
    return "1";
  }

  return `1-${pageCount}`;
}

function parseRangeToken(token: string, pageCount: number): number[] | string {
  const match = token.match(/^(\d+)(?:-(\d+))?$/);

  if (!match) {
    return "Use page numbers like 1,3-5.";
  }

  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);

  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return "Use whole page numbers.";
  }

  if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
    return `Pages must be between 1 and ${pageCount}.`;
  }

  if (end < start) {
    return "Put the lower page number first.";
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index - 1);
}

function emptyResult(error: string): PageRangeParseResult {
  return {
    pageIndexes: [],
    groups: [],
    error,
  };
}
