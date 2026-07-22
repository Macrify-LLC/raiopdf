import { describe, expect, it } from "vitest";
import type { PdfSelectedTextTarget } from "@raiopdf/engine-api";
import type { TextLayerCoverage } from "@raiopdf/rules";
import {
  TEXT_EDIT_ADVISORY,
  TEXT_EDIT_IMAGE_PAGE_NOTE,
  TEXT_EDIT_RESOURCE_GATE_MESSAGE,
  TEXT_EDIT_SCANNED_GATE_MESSAGE,
  TEXT_EDIT_STREAMED_GATE_MESSAGE,
  buildEngineParityPattern,
  buildTextEditReviewReport,
  canApplyTextEditReview,
  deriveTextEditGate,
  detectsPositionalSpaceRisk,
  findTextMatchesInPages,
  warningCopy,
  type PendingTextReplacement,
} from "./textEdit";
import type { ExtractedPageText } from "./pageTextCache";

describe("textEdit", () => {
  it("uses the engine's exact ASCII whole-word lookaround construction", () => {
    const pattern = buildEngineParityPattern("A+B", true);

    expect(pattern.source).toBe(String.raw`(?<!\w)(?:A\+B)(?!\w)`);
    expect(" A+B ".match(pattern)).toEqual(["A+B"]);
    expect("xA+B".match(pattern)).toBeNull();
    expect("éA+B".match(pattern)).toEqual(["A+B"]);
  });

  it("finds literal case-sensitive matches and excludes image-only pages", () => {
    const operation = op({ find: "Plaintiff", replace: "Petitioner" });

    const matches = findTextMatchesInPages([
      page(0, "Plaintiff and plaintiff"),
      page(1, "Plaintiff"),
    ], operation, { excludedPageIndexes: new Set([1]) });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ pageIndex: 0, excerpt: expect.stringContaining("Plaintiff") });
  });

  it("detects positional-space risk for multi-word finds", () => {
    expect(detectsPositionalSpaceRisk([page(0, "John Smith")], "John Smith")).toBe(false);
    expect(detectsPositionalSpaceRisk([page(0, "JohnSmith")], "John Smith")).toBe(true);
    expect(detectsPositionalSpaceRisk([page(0, "JohnSmith")], "John")).toBe(false);
  });

  it("derives streamed, scanned, mixed, and garbled gates", () => {
    expect(deriveTextEditGate({
      hasDocument: true,
      streamed: true,
      textLayerCoverage: cleanCoverage(),
      engineAvailable: true,
    })).toMatchObject({ blocked: true, message: TEXT_EDIT_STREAMED_GATE_MESSAGE });

    expect(deriveTextEditGate({
      hasDocument: true,
      streamed: false,
      textLayerCoverage: { imageOnlyPages: [0], mixedPages: [], textPages: [], garbledPages: [] },
      engineAvailable: true,
    })).toMatchObject({ blocked: true, message: TEXT_EDIT_SCANNED_GATE_MESSAGE });

    const mixed = deriveTextEditGate({
      hasDocument: true,
      streamed: false,
      textLayerCoverage: { imageOnlyPages: [2], mixedPages: [1], textPages: [0], garbledPages: [garbled(0)] },
      engineAvailable: true,
    });
    expect(mixed.blocked).toBe(false);
    expect(mixed.notes).toContain(TEXT_EDIT_IMAGE_PAGE_NOTE);
    expect(mixed.notes.join(" ")).toContain("garbled");
  });

  it("blocks document-wide rewrites before oversized inputs reach the engine", () => {
    expect(deriveTextEditGate({
      hasDocument: true,
      streamed: false,
      textLayerCoverage: cleanCoverage(),
      engineAvailable: true,
      pageCount: 251,
      fileSizeBytes: 1024,
    })).toMatchObject({ blocked: true, message: TEXT_EDIT_RESOURCE_GATE_MESSAGE });

    expect(deriveTextEditGate({
      hasDocument: true,
      streamed: false,
      textLayerCoverage: cleanCoverage(),
      engineAvailable: true,
      pageCount: 1,
      fileSizeBytes: 64 * 1024 * 1024 + 1,
    })).toMatchObject({ blocked: true, message: TEXT_EDIT_RESOURCE_GATE_MESSAGE });
  });

  it("builds per-operation review reporting from original and candidate text", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({ id: "one", find: "Plaintiff", replace: "Petitioner" }),
        op({ id: "two", find: "Missing", replace: "Found" }),
      ],
      originalPages: [page(0, "Plaintiff files the motion.")],
      candidatePages: [page(0, "Petitioner files the motion.")],
    });

    expect(report.zeroChange).toBe(false);
    expect(report.changedPageIndexes).toEqual([0]);
    expect(report.advisory).toBe(TEXT_EDIT_ADVISORY);
    expect(report.operations).toMatchObject([
      { operationId: "one", foundBefore: [0], foundAfter: [], replacedEstimate: 1, status: "changed" },
      { operationId: "two", foundBefore: [], foundAfter: [], replacedEstimate: 0, status: "not-found" },
    ]);
  });

  it("reports selected-target edits without broad duplicate counting", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John",
          replace: "John Q",
          pageIndexes: [0],
          target: selectedTarget(5, 9),
        }),
      ],
      originalPages: [page(0, "John John")],
      candidatePages: [page(0, "John John Q")],
    });

    expect(report.operations[0]).toMatchObject({
      operationId: "selected",
      selected: true,
      foundBefore: [0],
      foundAfter: [],
      replacedEstimate: 1,
      status: "changed",
    });
    expect(report.zeroChange).toBe(false);
  });

  it("verifies selected-target edits against the separator-free extraction", () => {
    // pdf.js extraction splices inferred separators ("\n" between lines) into
    // `text`, but the target's offsets live in the engine's separator-free
    // model (mirrored by `flatText`). The verification must slice flatText —
    // slicing `text` drifts on any multi-line page and reported every real
    // replacement as "unchanged" (caught by the real-engine canary).
    const originalFlat = "Smith files the motion.Smith replies today.";
    const candidateFlat = "Smith files the motion.Jones replies today.";
    const start = originalFlat.indexOf("Smith", 1);
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "Smith",
          replace: "Jones",
          pageIndexes: [0],
          target: {
            ...selectedTarget(start, start + 5),
            expectedText: "Smith",
            expectedVisibleText: "Smith",
          },
        }),
      ],
      originalPages: [{
        ...page(0, "Smith files the motion.\nSmith replies today."),
        flatText: originalFlat,
      }],
      candidatePages: [{
        ...page(0, "Smith files the motion.\nJones replies today."),
        flatText: candidateFlat,
      }],
    });

    expect(report.operations[0]).toMatchObject({
      selected: true,
      replacedEstimate: 1,
      status: "changed",
    });
    expect(report.zeroChange).toBe(false);
  });

  it("reports unchanged selected-target edits as zero-change", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John",
          replace: "John",
          pageIndexes: [0],
          target: selectedTarget(0, 4),
        }),
      ],
      originalPages: [page(0, "John John")],
      candidatePages: [page(0, "John John")],
    });

    expect(report.operations[0]).toMatchObject({
      selected: true,
      foundBefore: [0],
      foundAfter: [0],
      replacedEstimate: 0,
      status: "unchanged",
    });
    expect(report.zeroChange).toBe(true);
  });

  it("does not report selected-target success for unrelated same-page changes", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John",
          replace: "Jane",
          pageIndexes: [0],
          target: selectedTarget(5, 9),
        }),
      ],
      originalPages: [page(0, "John John")],
      candidatePages: [page(0, "Jane John")],
    });

    expect(report.operations[0]).toMatchObject({
      selected: true,
      foundBefore: [0],
      foundAfter: [0],
      replacedEstimate: 0,
      status: "unchanged",
    });
    expect(report.zeroChange).toBe(false);
  });

  it("does not report selected replacement success when the expected text remains after inserted replacement", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John Smith",
          replace: "Jane Doe",
          pageIndexes: [0],
          target: {
            ...selectedTarget(0, 10),
            expectedText: "John Smith",
            expectedVisibleText: "John Smith",
            lastElementOffset: 10,
          },
        }),
      ],
      originalPages: [page(0, "John Smith filed")],
      candidatePages: [page(0, "Jane DoeJohn Smith filed")],
    });

    expect(report.operations[0]).toMatchObject({
      selected: true,
      replacedEstimate: 0,
      status: "unchanged",
    });
    expect(canApplyTextEditReview(report)).toBe(false);
  });

  it("does not report selected deletion success when an artifact remains at the target offset", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John",
          replace: "",
          pageIndexes: [0],
          target: selectedTarget(0, 4),
        }),
      ],
      originalPages: [page(0, "John John")],
      candidatePages: [page(0, "Jane John")],
    });

    expect(report.operations[0]).toMatchObject({
      selected: true,
      replacedEstimate: 0,
      status: "unchanged",
    });
    expect(canApplyTextEditReview(report)).toBe(false);
  });

  it("reports selected deletion success only when the original suffix shifts left", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John",
          replace: "",
          pageIndexes: [0],
          target: selectedTarget(0, 4),
        }),
      ],
      originalPages: [page(0, "John John")],
      candidatePages: [page(0, " John")],
    });

    expect(report.operations[0]).toMatchObject({
      selected: true,
      replacedEstimate: 1,
      status: "changed",
    });
    expect(canApplyTextEditReview(report)).toBe(true);
  });

  it("anchors a selected review excerpt at document boundaries, including deletion", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected-boundary",
          find: "John",
          replace: "",
          pageIndexes: [0],
          target: selectedTarget(0, 4),
        }),
      ],
      originalPages: [page(0, "John files at the boundary")],
      candidatePages: [page(0, " files at the boundary")],
    });

    expect(report.operations[0]).toMatchObject({ selected: true, status: "changed" });
    expect(report.selectedExcerpt).toEqual({
      pageIndex: 0,
      before: "",
      selected: "John",
      replacement: "",
      after: " files at the boundary",
    });
  });

  it("fails selected verification closed when another page's extracted text changes", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John",
          replace: "Jane",
          pageIndexes: [0],
          target: selectedTarget(0, 4),
        }),
      ],
      originalPages: [page(0, "John files."), page(1, "Untouched page.")],
      candidatePages: [page(0, "Jane files."), page(1, "Unexpected changed page.")],
    });

    expect(report.changedPageIndexes).toEqual([0, 1]);
    expect(report.operations[0]).toMatchObject({
      selected: true,
      replacedEstimate: 0,
      status: "unchanged",
    });
    expect(report.selectedExcerpt).toBeNull();
    expect(canApplyTextEditReview(report)).toBe(false);
  });

  it("only allows applying review reports where every operation changed", () => {
    const changed = buildTextEditReviewReport({
      operations: [op({ find: "Plaintiff", replace: "Petitioner" })],
      originalPages: [page(0, "Plaintiff files.")],
      candidatePages: [page(0, "Petitioner files.")],
    });
    const unverifiedSelected = buildTextEditReviewReport({
      operations: [
        op({
          id: "selected",
          find: "John",
          replace: "Jane",
          pageIndexes: [0],
          target: selectedTarget(5, 9),
        }),
      ],
      originalPages: [page(0, "John John")],
      candidatePages: [page(0, "Jane John")],
    });

    expect(canApplyTextEditReview(changed)).toBe(true);
    expect(canApplyTextEditReview(unverifiedSelected)).toBe(false);
  });

  it("allows applying bulk partial-success reviews", () => {
    const report = buildTextEditReviewReport({
      operations: [
        op({ id: "changed", find: "Plaintiff", replace: "Petitioner" }),
        op({ id: "missing", find: "Respondent", replace: "Defendant" }),
      ],
      originalPages: [page(0, "Plaintiff files.")],
      candidatePages: [page(0, "Petitioner files.")],
    });

    expect(report.operations).toMatchObject([
      { selected: false, status: "changed" },
      { selected: false, status: "not-found" },
    ]);
    expect(canApplyTextEditReview(report)).toBe(true);
  });

  it("maps warning codes to honest copy", () => {
    expect(warningCopy({ code: "COUNTS_UNAVAILABLE", message: "" })).toContain("does not return replacement counts");
    expect(warningCopy({ code: "PDFA_IDENTIFICATION_REMOVED", message: "" })).toContain("PDF/A marking");
  });
});

function op(overrides: Partial<PendingTextReplacement>): PendingTextReplacement {
  return {
    id: "op",
    find: "find",
    replace: "replace",
    wholeWord: false,
    pageIndexes: "all",
    ...overrides,
  };
}

function selectedTarget(start: number, end: number): PdfSelectedTextTarget {
  return {
    pageIndex: 0,
    start,
    end,
    expectedText: "John",
    expectedVisibleText: "John",
    sourceDocumentFingerprint: "document",
    sourceFingerprint: "page",
    firstElementIndex: 0,
    lastElementIndex: 0,
    firstElementOffset: start,
    lastElementOffset: end,
  };
}

function page(pageIndex: number, text: string): ExtractedPageText {
  return {
    pageIndex,
    text,
    spans: text.trim()
      ? [{ start: 0, end: text.length, area: { pageIndex, x: 0, y: 0, w: 100, h: 10 } }]
      : [],
  };
}

function cleanCoverage(): TextLayerCoverage {
  return { imageOnlyPages: [], mixedPages: [], textPages: [0], garbledPages: [] };
}

function garbled(pageIndex: number): TextLayerCoverage["garbledPages"][number] {
  return {
    pageIndex,
    confidence: 0.9,
    reason: "low_alpha_entropy",
    puaRatio: 0,
    replacementRatio: 0,
    alphaRatio: 0.01,
  };
}
