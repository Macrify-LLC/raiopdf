import { describe, expect, it } from "vitest";
import type { PrepPlanStep, PreflightReport } from "@raiopdf/rules";
import type {
  PathOpsDocumentFacts,
  PathOpsPartPreflight,
  PathOpsStatus,
} from "./pathOps";
import {
  STREAMED_CHECK_NOT_EVALUATED,
  STREAMED_STEP_UNAVAILABLE_REASON,
  annotateStreamedPreflight,
  buildPrepareFilingPlan,
  buildStreamedFilingOutputReport,
  buildStreamedUnavailableSteps,
  mapPathOpsFactsToDocumentFacts,
} from "./streamedFiling";

function prepStep(id: PrepPlanStep["id"]): PrepPlanStep {
  return {
    id,
    label: id,
    stance: "standard",
    actionStance: "standard",
    authority: "test",
    lastVerified: "2026-01-01",
    prepDefault: "on",
    defaultChecked: true,
    destructive: false,
    impact: "none",
  };
}

function statusFixture(): PathOpsStatus {
  return {
    toolchain: { qpdf: true, ghostscript: true, ocrmypdf: false, node: false },
    ops: [
      { name: "normalize_to_letter_portrait", available: true, missingTools: [], filingStep: "normalize-pages", maxInputBytes: null },
      { name: "split_by_max_bytes", available: true, missingTools: [], filingStep: "split-by-size", maxInputBytes: null },
      { name: "scrub_metadata", available: true, missingTools: [], filingStep: "scrub-metadata", maxInputBytes: null },
      { name: "ocr", available: false, missingTools: ["ocrmypdf"], filingStep: "make-searchable", maxInputBytes: null },
    ],
    filingSteps: {
      "remove-encryption": "decrypt",
      "normalize-pages": "normalize_to_letter_portrait",
      "sanitize-content": "sanitize",
      "scrub-metadata": "scrub_metadata",
      "make-searchable": "ocr",
      "flatten-forms": null,
      "convert-pdfa": null,
      "split-by-size": "split_by_max_bytes",
    },
  };
}

describe("mapPathOpsFactsToDocumentFacts", () => {
  const facts: PathOpsDocumentFacts = {
    pageCount: 2,
    sizeBytes: 283_000_000,
    encrypted: false,
    pdfaClaimed: false,
    signatureDetection: {
      standardAcroFormSignatureCount: 1,
      hasByteRangeOrContentsMarkers: true,
      hasCertificationDictionary: false,
    },
    pages: [
      {
        index: 0,
        mediaBox: [0, 0, 612, 792],
        rotate: 0,
        orientation: "portrait",
        letterPortrait: true,
      },
      {
        index: 1,
        mediaBox: [0, 0, 612, 792],
        rotate: 90,
        orientation: "landscape",
        letterPortrait: false,
      },
    ],
  };

  it("maps media boxes to inch sizes, swapping for 90°/270° rotation", () => {
    const mapped = mapPathOpsFactsToDocumentFacts(facts, { filename: "appendix.pdf" });

    expect(mapped.pages[0]).toEqual({
      pageIndex: 0,
      size: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
    });
    expect(mapped.pages[1]).toEqual({
      pageIndex: 1,
      size: { w: 11, h: 8.5, in: true },
      orientation: "landscape",
    });
    expect(mapped.fileBytes).toBe(283_000_000);
    expect(mapped.filename).toBe("appendix.pdf");
    expect(mapped.encryptionState).toBe("none");
    expect(mapped.signatureFieldCount).toBe(1);
    expect(mapped.signatureDetection).toEqual(facts.signatureDetection);
    // Facts qpdf cannot provide stay undefined — unknown, never passed.
    expect(mapped.searchableText).toBeUndefined();
    expect(mapped.pdfaClaimed).toBe(false);
    expect(mapped.pdfaCompliant).toBeUndefined();
  });

  it("maps an encrypted-but-rendered doc to usage_restricted (no open password possible)", () => {
    const mapped = mapPathOpsFactsToDocumentFacts({ ...facts, encrypted: true });
    expect(mapped.encryptionState).toBe("usage_restricted");
  });

  it("carries a streamed PDF/A identification claim into filing facts", () => {
    const mapped = mapPathOpsFactsToDocumentFacts({ ...facts, pdfaClaimed: true });
    expect(mapped.pdfaClaimed).toBe(true);
    expect(mapped.pdfaCompliant).toBeUndefined();
  });
});

describe("annotateStreamedPreflight", () => {
  it("re-details unknown checks and leaves evaluated ones alone", () => {
    const report: PreflightReport = {
      checks: [
        { checkId: "a", label: "A", authority: "x", detail: "fine", kind: "rule", status: "pass" },
        { checkId: "b", label: "B", authority: "x", detail: "???", kind: "rule", status: "unknown" },
      ],
      selectionChecks: [
        { checkId: "c", label: "C", authority: "x", detail: "???", kind: "portal", status: "unknown" },
      ],
    };

    const annotated = annotateStreamedPreflight(report);

    expect(annotated.checks[0]?.detail).toBe("fine");
    expect(annotated.checks[1]?.detail).toBe(STREAMED_CHECK_NOT_EVALUATED);
    expect(annotated.checks[1]?.status).toBe("unknown");
    expect(annotated.selectionChecks?.[0]?.detail).toBe(STREAMED_CHECK_NOT_EVALUATED);
  });
});

describe("buildStreamedUnavailableSteps (closed-form rule wiring [R7-1])", () => {
  const plan = [
    prepStep("remove-encryption"),
    prepStep("normalize-pages"),
    prepStep("make-searchable"),
    prepStep("flatten-forms"),
    prepStep("convert-pdfa"),
    prepStep("split-by-size"),
  ];

  it("disables exactly the steps the rule disables", () => {
    const unavailable = buildStreamedUnavailableSteps(plan, statusFixture());

    // Enabled: registered op + toolchain present.
    expect(unavailable.has("normalize-pages")).toBe(false);
    expect(unavailable.has("split-by-size")).toBe(false);
    // Disabled: no registered op at all.
    expect(unavailable.get("flatten-forms")).toBe(STREAMED_STEP_UNAVAILABLE_REASON);
    expect(unavailable.get("convert-pdfa")).toBe(STREAMED_STEP_UNAVAILABLE_REASON);
    // Disabled: registered op whose toolchain is missing.
    expect(unavailable.get("make-searchable")).toBe(STREAMED_STEP_UNAVAILABLE_REASON);
    // Disabled: mapped op absent from the ops list (decrypt not registered
    // in this fixture) — the rule reads availability, not the mapping alone.
    expect(unavailable.get("remove-encryption")).toBe(STREAMED_STEP_UNAVAILABLE_REASON);
  });

  it("fails closed while the status is still loading (null)", () => {
    const unavailable = buildStreamedUnavailableSteps(plan, null);
    expect(unavailable.size).toBe(plan.length);
  });
});

describe("buildPrepareFilingPlan", () => {
  it("maps the selected step ids onto the engine plan", () => {
    const plan = buildPrepareFilingPlan(
      ["sanitize-content", "normalize-pages", "make-searchable", "scrub-metadata", "split-by-size"],
      { decryptPassword: "hunter2", splitMaxBytes: 25_000_000 },
    );

    expect(plan).toEqual({
      decryptPassword: "hunter2",
      sanitize: true,
      normalize: true,
      ocr: true,
      scrub: true,
      splitMaxBytes: 25_000_000,
    });
  });

  it("omits split and password when not requested", () => {
    const plan = buildPrepareFilingPlan(["scrub-metadata"], {});

    expect(plan).toEqual({
      sanitize: false,
      normalize: false,
      ocr: false,
      scrub: true,
    });
  });

  it("omits split when split-by-size is selected but no cap is known", () => {
    const plan = buildPrepareFilingPlan(["split-by-size"], { splitMaxBytes: null });
    expect(plan.splitMaxBytes).toBeUndefined();
  });
});

describe("buildStreamedFilingOutputReport", () => {
  const part = (overrides: Partial<PathOpsPartPreflight>): PathOpsPartPreflight => ({
    partIndex: 0,
    pageCount: 10,
    sizeBytes: 1000,
    encrypted: false,
    allLetterPortrait: true,
    withinByteCap: true,
    ...overrides,
  });

  it("passes format/encryption/cap checks when every part is clean", () => {
    const report = buildStreamedFilingOutputReport([
      part({ partIndex: 0 }),
      part({ partIndex: 1 }),
    ]);

    const byId = new Map(report.checks.map((check) => [check.checkId, check]));
    expect(byId.get("streamed-page-format")?.status).toBe("pass");
    expect(byId.get("streamed-encryption")?.status).toBe("pass");
    expect(byId.get("streamed-size-cap")?.status).toBe("pass");
    // The catch-all "not evaluated" row is always present — the facts-based
    // report never pretends to be the full preflight.
    expect(byId.get("streamed-other-checks")?.status).toBe("unknown");
    expect(byId.get("streamed-other-checks")?.detail).toBe(STREAMED_CHECK_NOT_EVALUATED);
  });

  it("warns with part numbers when parts fail a computable check", () => {
    const report = buildStreamedFilingOutputReport([
      part({ partIndex: 0, allLetterPortrait: false }),
      part({ partIndex: 1, encrypted: true, withinByteCap: false }),
    ]);

    const byId = new Map(report.checks.map((check) => [check.checkId, check]));
    expect(byId.get("streamed-page-format")?.status).toBe("warn");
    expect(byId.get("streamed-page-format")?.detail).toContain("Part 1");
    expect(byId.get("streamed-encryption")?.status).toBe("warn");
    expect(byId.get("streamed-encryption")?.detail).toContain("Part 2");
    expect(byId.get("streamed-size-cap")?.status).toBe("warn");
  });

  it("reports the cap as unknown when no split cap was requested", () => {
    const report = buildStreamedFilingOutputReport([part({ withinByteCap: null })]);
    const cap = report.checks.find((check) => check.checkId === "streamed-size-cap");
    expect(cap?.status).toBe("unknown");
  });

  it("returns a single not-evaluated row for an empty facts report", () => {
    const report = buildStreamedFilingOutputReport([]);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.status).toBe("unknown");
  });
});
