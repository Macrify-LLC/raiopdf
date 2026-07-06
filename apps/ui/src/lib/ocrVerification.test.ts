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

  it("reports garbled output as a failed verification for normal OCR so callers keep the original", () => {
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

  it("returns a warning for force OCR residual garbled pages so callers still apply the output", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0, 1],
      garbledPages: [{
        pageIndex: 1,
        confidence: 0.91,
        reason: "low_alpha_entropy",
        puaRatio: 0,
        replacementRatio: 0,
        alphaRatio: 0.01,
      }],
    }), "force-ocr");

    expect(result).toMatchObject({
      status: "warning",
      pageCount: 2,
      rebuiltPages: 2,
      garbledPages: 1,
      imageOnlyPages: 0,
    });
    expect(result.message).toContain("Warning: 1 page may still have imperfect text");

    const replaceDocument = vi.fn();
    if (result.status !== "failed") {
      replaceDocument();
    }

    expect(replaceDocument).toHaveBeenCalledTimes(1);
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

  it("fails normal OCR when a mostly scanned page kept only a trivial text layer", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [],
      mixedPages: [0],
      textPages: [1, 2],
      garbledPages: [],
      trivialTextImagePages: [{
        pageIndex: 0,
        textCharacterCount: 8,
        imageCoverageRatio: 0.96,
      }],
    }), "skip-text");

    expect(result).toMatchObject({
      status: "failed",
      garbledPages: 0,
      imageOnlyPages: 0,
      trivialTextImagePages: 1,
    });
    expect(result.message).toContain("Normal OCR may have skipped page 1");
    expect(result.message).toContain("tiny text layer over a scanned page image");
    expect(result.message).toContain("Run Force OCR");
    expect(result.message).toContain("The original was kept unchanged");
  });

  it("keeps force OCR output with a warning when a mostly scanned page is still imperfect", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [],
      mixedPages: [0],
      textPages: [1],
      garbledPages: [],
      trivialTextImagePages: [{
        pageIndex: 0,
        textCharacterCount: 8,
        imageCoverageRatio: 0.96,
      }],
    }), "force-ocr");

    expect(result).toMatchObject({
      status: "warning",
      pageCount: 2,
      rebuiltPages: 2,
      garbledPages: 0,
      imageOnlyPages: 0,
      trivialTextImagePages: 1,
    });
    expect(result.message).toContain("Warning: 1 page may still have imperfect text");
  });
});

function coverage(overrides: TextLayerCoverage): TextLayerCoverage {
  return {
    ...overrides,
  };
}
