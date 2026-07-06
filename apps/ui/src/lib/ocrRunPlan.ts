import type { TextLayerCoverage } from "@raiopdf/rules";

export type OcrRunType = "skip-text" | "force-ocr";

export interface OcrRunPlan {
  ocrType: OcrRunType;
  pageIndexes?: readonly number[];
  autoForcePageIndexes: readonly number[];
}

export function planOcrRun(
  requestedOcrType: OcrRunType,
  coverage: TextLayerCoverage | null | undefined,
): OcrRunPlan {
  if (requestedOcrType === "force-ocr") {
    return {
      ocrType: "force-ocr",
      autoForcePageIndexes: [],
    };
  }

  const trivialTextPageIndexes = sortedUniquePageIndexes(
    coverage?.trivialTextImagePages?.map((page) => page.pageIndex) ?? [],
  );
  if (trivialTextPageIndexes.length === 0) {
    return {
      ocrType: "skip-text",
      autoForcePageIndexes: [],
    };
  }

  const pageIndexes = sortedUniquePageIndexes([
    ...(coverage?.imageOnlyPages ?? []),
    ...trivialTextPageIndexes,
  ]);

  return {
    ocrType: "force-ocr",
    pageIndexes,
    autoForcePageIndexes: trivialTextPageIndexes,
  };
}

function sortedUniquePageIndexes(pageIndexes: readonly number[]): number[] {
  return [...new Set(pageIndexes.filter(isValidPageIndex))].sort((a, b) => a - b);
}

function isValidPageIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
