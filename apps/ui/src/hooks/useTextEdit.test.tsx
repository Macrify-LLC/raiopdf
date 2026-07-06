// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PdfSelectedTextTarget } from "@raiopdf/engine-api";
import {
  selectedTextReviewGateMessage,
  unsafeSelectedTextPageIndexes,
  useTextEdit,
  runTextEditEngineReplacement,
} from "./useTextEdit";
import {
  TEXT_EDIT_ZERO_CHANGE_MESSAGE,
  buildTextEditReviewReport,
  formatReplaceTextResult,
  type PendingTextReplacement,
} from "../lib/textEdit";
import type { ExtractedPageText } from "../lib/pageTextCache";

vi.mock("../lib/pdfjs", () => ({
  loadPdfDocument: async () => ({
    numPages: 1,
    loadingTask: { destroy: async () => undefined },
  }),
}));

describe("useTextEdit contract helpers", () => {
  it("exports the hook used by App and component integrations", () => {
    expect(typeof useTextEdit).toBe("function");
  });

  it("keeps zero-change reviews non-committal", () => {
    const report = buildTextEditReviewReport({
      operations: [op()],
      originalPages: [page("Plaintiff files.")],
      candidatePages: [page("Plaintiff files.")],
    });

    expect(report.zeroChange).toBe(true);
    expect(formatReplaceTextResult(report)).toBe(TEXT_EDIT_ZERO_CHANGE_MESSAGE);
  });

  it("carries source page changes needed for stale apply and scroll targeting", () => {
    const report = buildTextEditReviewReport({
      operations: [op()],
      originalPages: [page("Plaintiff files.")],
      candidatePages: [page("Petitioner files.")],
    });

    expect(report.zeroChange).toBe(false);
    expect(report.changedPageIndexes).toEqual([0]);
  });

  it("dispatches selected operations through replaceSelectedText", async () => {
    const sourceBytes = new Uint8Array([1]);
    const bridge = {
      replaceSelectedText: vi.fn(async () => ({
        bytes: new Uint8Array([2]),
        warnings: [],
      })),
      replaceText: vi.fn(async () => ({
        bytes: new Uint8Array([3]),
        replacedCounts: null,
        warnings: [],
      })),
    };

    const result = await runTextEditEngineReplacement({
      engineBridge: bridge,
      sourceBytes,
      operations: [op({
        id: "selected",
        find: "John Smith",
        replace: "Jane Doe",
        pageIndexes: [0],
        target: selectedTarget(),
      })],
    });

    expect(result).toEqual({
      bytes: new Uint8Array([2]),
      replacedCounts: null,
      warnings: [],
    });
    expect(bridge.replaceSelectedText).toHaveBeenCalledWith(sourceBytes, {
      replacement: "Jane Doe",
      target: expect.objectContaining({ expectedText: "John Smith" }),
    });
    expect(bridge.replaceText).not.toHaveBeenCalled();
  });

  it("dispatches bulk operations through replaceText", async () => {
    const sourceBytes = new Uint8Array([1]);
    const bridge = {
      replaceSelectedText: vi.fn(),
      replaceText: vi.fn(async () => ({
        bytes: new Uint8Array([3]),
        replacedCounts: null,
        warnings: [],
      })),
    };

    await runTextEditEngineReplacement({
      engineBridge: bridge,
      sourceBytes,
      operations: [op()],
      allowSignatureInvalidation: true,
    });

    expect(bridge.replaceText).toHaveBeenCalledWith(sourceBytes, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      wholeWord: false,
      pageIndexes: "all",
      allowSignatureInvalidation: true,
    });
    expect(bridge.replaceSelectedText).not.toHaveBeenCalled();
  });

  it("refuses mixed selected and bulk operations", async () => {
    const bridge = {
      replaceSelectedText: vi.fn(),
      replaceText: vi.fn(),
    };

    await expect(
      runTextEditEngineReplacement({
        engineBridge: bridge,
        sourceBytes: new Uint8Array([1]),
        operations: [
          op({
            id: "selected",
            target: selectedTarget(),
          }),
          op({
            id: "bulk",
            find: "John",
            replace: "Jane",
          }),
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    expect(bridge.replaceSelectedText).not.toHaveBeenCalled();
    expect(bridge.replaceText).not.toHaveBeenCalled();
  });

  it("flags selected-text review on unsafe coverage pages", () => {
    const unsafePages = unsafeSelectedTextPageIndexes({
      imageOnlyPages: [0],
      mixedPages: [],
      textPages: [1, 2],
      garbledPages: [{
        pageIndex: 1,
        confidence: 0.8,
        reason: "low_alpha_entropy",
        puaRatio: 0,
        replacementRatio: 0,
        alphaRatio: 0.01,
      }],
      trivialTextImagePages: [{
        pageIndex: 2,
        textCharacterCount: 8,
        imageCoverageRatio: 0.9,
      }],
    });

    expect([...unsafePages].sort()).toEqual([0, 1, 2]);
    for (const pageIndex of unsafePages) {
      expect(selectedTextReviewGateMessage([
        op({
          target: { ...selectedTarget(), pageIndex },
        }),
      ], unsafePages)).toContain("unreliable text layers");
    }
  });

  it("allows selected-text review only when the latest unsafe-page set permits it", () => {
    const selected = [op({ target: selectedTarget() })];

    expect(selectedTextReviewGateMessage(selected, new Set())).toBeNull();
    expect(selectedTextReviewGateMessage(selected, new Set([0]))).toContain("unreliable text layers");
  });
});

function op(overrides: Partial<PendingTextReplacement> = {}): PendingTextReplacement {
  return {
    id: "op",
    find: "Plaintiff",
    replace: "Petitioner",
    wholeWord: false,
    pageIndexes: "all",
    ...overrides,
  };
}

function page(text: string): ExtractedPageText {
  return {
    pageIndex: 0,
    text,
    spans: [{ start: 0, end: text.length, area: { pageIndex: 0, x: 0, y: 0, w: 100, h: 10 } }],
  };
}

function selectedTarget(): PdfSelectedTextTarget {
  return {
    pageIndex: 0,
    start: 14,
    end: 24,
    expectedText: "John Smith",
    sourceDocumentFingerprint: "document",
    sourceFingerprint: "page",
    firstElementIndex: 2,
    lastElementIndex: 2,
    firstElementOffset: 0,
    lastElementOffset: 10,
  };
}
