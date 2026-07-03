import { describe, expect, it } from "vitest";
import type { TextLayerCoverage } from "@raiopdf/rules";
import { documentSearchWarning } from "./useDocumentSearch";

describe("documentSearchWarning", () => {
  it("warns when the active document has garbled pages", () => {
    expect(documentSearchWarning(coverageWithGarbledPages(2)))
      .toBe("Search may be incomplete - the text layer looks garbled on 2 pages.");
  });

  it("does not warn when the active document has clean text coverage", () => {
    expect(documentSearchWarning({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0],
      garbledPages: [],
    })).toBeNull();
  });
});

function coverageWithGarbledPages(count: number): TextLayerCoverage {
  return {
    imageOnlyPages: [],
    mixedPages: [],
    textPages: Array.from({ length: count }, (_, pageIndex) => pageIndex),
    garbledPages: Array.from({ length: count }, (_, pageIndex) => ({
      pageIndex,
      confidence: 0.9,
      reason: "low_alpha_entropy",
      puaRatio: 0,
      replacementRatio: 0,
      alphaRatio: 0.01,
    })),
  };
}
