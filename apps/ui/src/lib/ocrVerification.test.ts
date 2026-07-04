import { describe, expect, it, vi } from "vitest";
import { verifyOcrTextLayer } from "./ocrVerification";
import type { TextLayerCoverage } from "@raiopdf/rules";

describe("verifyOcrTextLayer", () => {
  it("verifies only when every page has clean searchable text", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0, 1],
      garbledPages: [],
    }));

    expect(result).toMatchObject({
      status: "verified",
      pageCount: 2,
      rebuiltPages: 2,
    });
    expect(result.message).toContain("Verified: all 2 pages now have clean searchable text.");
  });

  it("reports garbled output as a failed verification so callers keep the original", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0, 1],
      garbledPages: [{
        pageIndex: 0,
        confidence: 0.91,
        reason: "low_alpha_entropy",
        puaRatio: 0,
        replacementRatio: 0,
        alphaRatio: 0.01,
      }],
    }));

    expect(result).toMatchObject({
      status: "failed",
      garbledPages: 1,
      imageOnlyPages: 0,
    });
    expect(result.message).toContain("Re-OCR ran, but 1 page still looks garbled");
    expect(result.message).toContain("the original was kept unchanged");

    const replaceDocument = vi.fn();
    if (result.status === "verified") {
      replaceDocument();
    }

    expect(replaceDocument).not.toHaveBeenCalled();
  });

  it("fails verification when OCR produces an empty document", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [],
      garbledPages: [],
    }));

    expect(result).toMatchObject({
      status: "failed",
      garbledPages: 0,
      imageOnlyPages: 0,
    });
  });

  it("fails verification when OCR leaves any image-only pages", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [1],
      mixedPages: [],
      textPages: [0],
      garbledPages: [],
    }));

    expect(result).toMatchObject({
      status: "failed",
      garbledPages: 0,
      imageOnlyPages: 1,
    });
    expect(result.message).toContain("1 page still has no searchable text");
  });
});

function coverage(overrides: TextLayerCoverage): TextLayerCoverage {
  return {
    ...overrides,
  };
}
