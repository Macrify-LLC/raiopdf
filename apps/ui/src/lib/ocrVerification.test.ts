import { describe, expect, it, vi } from "vitest";
import {
  filingOcrVerificationFailureMessage,
  verifyFilingOcrOutputParts,
  verifyOcrTextLayer,
} from "./ocrVerification";
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

  it("lets filing workflows continue only after verified OCR output", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0, 1],
      garbledPages: [],
    }));

    expect(filingOcrVerificationFailureMessage(result)).toBeNull();
  });

  it("formats filing OCR failures without promising an output was saved", () => {
    const result = verifyOcrTextLayer(coverage({
      imageOnlyPages: [1],
      mixedPages: [],
      textPages: [0],
      garbledPages: [],
    }));

    expect(filingOcrVerificationFailureMessage(result)).toBe(
      "OCR ran, but the filing copy is still not fully searchable. 1 page still has no searchable text. The filing copy was not saved.",
    );
  });

  it("treats force OCR warnings as unverified for filing output", () => {
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

    expect(filingOcrVerificationFailureMessage(result)).toBe(
      "OCR finished, but the filing copy still has imperfect searchable text. 1 page still has garbled text. The filing copy was not saved.",
    );
  });

  it("verifies each final filing output part before saving", async () => {
    const firstPartBytes = new Uint8Array([1]);
    const secondPartBytes = new Uint8Array([2]);
    const inspectPartTextLayer = vi.fn()
      .mockResolvedValueOnce(coverage({
        imageOnlyPages: [],
        mixedPages: [],
        textPages: [0],
        garbledPages: [],
      }))
      .mockResolvedValueOnce(coverage({
        imageOnlyPages: [],
        mixedPages: [],
        textPages: [0, 1],
        garbledPages: [],
      }));

    await expect(verifyFilingOcrOutputParts([
      { bytes: firstPartBytes, fileName: "part-1.pdf" },
      { bytes: secondPartBytes, fileName: "part-2.pdf" },
    ], "skip-text", inspectPartTextLayer)).resolves.toBeUndefined();

    expect(inspectPartTextLayer).toHaveBeenNthCalledWith(1, firstPartBytes);
    expect(inspectPartTextLayer).toHaveBeenNthCalledWith(2, secondPartBytes);
  });

  it("rejects a final filing output part with failed searchable text verification", async () => {
    const inspectPartTextLayer = vi.fn().mockResolvedValue(coverage({
      imageOnlyPages: [0],
      mixedPages: [],
      textPages: [1],
      garbledPages: [],
    }));

    await expect(verifyFilingOcrOutputParts([
      { bytes: new Uint8Array([1]), fileName: "part-1.pdf" },
    ], "skip-text", inspectPartTextLayer)).rejects.toThrow(
      "part-1.pdf: OCR ran, but the filing copy is still not fully searchable. 1 page still has no searchable text. The filing copy was not saved.",
    );
  });

  it("rejects final force OCR output warnings for filing output", async () => {
    const inspectPartTextLayer = vi.fn().mockResolvedValue(coverage({
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
    }));

    await expect(verifyFilingOcrOutputParts([
      { bytes: new Uint8Array([1]), fileName: "part-2.pdf" },
    ], "force-ocr", inspectPartTextLayer)).rejects.toThrow(
      "part-2.pdf: OCR finished, but the filing copy still has imperfect searchable text. 1 page still has garbled text. The filing copy was not saved.",
    );
  });

  it("blocks filing output when final text-layer inspection fails", async () => {
    const inspectPartTextLayer = vi.fn().mockRejectedValue(new Error("parse failed"));

    await expect(verifyFilingOcrOutputParts([
      { bytes: new Uint8Array([1]), fileName: "part-1.pdf" },
    ], "skip-text", inspectPartTextLayer)).rejects.toThrow(
      "part-1.pdf: The filing copy text layer could not be verified. The filing copy was not saved.",
    );
  });
});

function coverage(overrides: TextLayerCoverage): TextLayerCoverage {
  return {
    ...overrides,
  };
}
