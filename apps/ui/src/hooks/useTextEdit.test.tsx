// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useTextEdit } from "./useTextEdit";
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
});

function op(): PendingTextReplacement {
  return {
    id: "op",
    find: "Plaintiff",
    replace: "Petitioner",
    wholeWord: false,
    pageIndexes: "all",
  };
}

function page(text: string): ExtractedPageText {
  return {
    pageIndex: 0,
    text,
    spans: [{ start: 0, end: text.length, area: { pageIndex: 0, x: 0, y: 0, w: 100, h: 10 } }],
  };
}
