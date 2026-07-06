import { describe, expect, it } from "vitest";
import type { TextLayerCoverage } from "@raiopdf/rules";
import {
  TEXT_EDIT_ADVISORY,
  TEXT_EDIT_IMAGE_PAGE_NOTE,
  TEXT_EDIT_SCANNED_GATE_MESSAGE,
  TEXT_EDIT_STREAMED_GATE_MESSAGE,
  buildEngineParityPattern,
  buildTextEditReviewReport,
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
