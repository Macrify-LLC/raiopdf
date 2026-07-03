import { describe, expect, it } from "vitest";
import {
  getPack,
  resolvePrepPlan,
  type DocumentFacts,
  type PrepPlanStep,
} from "../src/index";

const baseFacts: DocumentFacts = {
  filename: "motion.pdf",
  fileBytes: 2 * 1024 * 1024,
  searchableText: false,
  pdfaCompliant: false,
  pages: [
    {
      pageIndex: 0,
      size: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
    },
  ],
};

describe("resolvePrepPlan", () => {
  it("resolves Florida defaults, destructive PDF/A impact, and prohibited flattening", () => {
    const plan = resolvePrepPlan(getPack("florida"), {
      ...baseFacts,
      annotationCount: 3,
      formFields: { count: 2, anyFilled: true },
      signatureFieldCount: 1,
      possibleUnappliedRedactions: {
        redactAnnotationCount: 1,
        blackRectangleAnnotationCount: 0,
        possiblyPresent: true,
      },
    });

    expect(plan.map((step) => step.id)).toEqual([
      "remove-encryption",
      "normalize-pages",
      "sanitize-content",
      "scrub-metadata",
      "make-searchable",
      "flatten-forms",
      "convert-pdfa",
      "split-by-size",
    ]);
    expect(byId(plan, "convert-pdfa")).toMatchObject({
      stance: "preferred",
      prepDefault: "on",
      defaultChecked: true,
      destructive: true,
    });
    expect(byId(plan, "convert-pdfa").impact).toContain(
      "3 annotations, 2 form fields, 1 signature field, 1 possible unapplied redaction detected",
    );
    expect(byId(plan, "flatten-forms")).toMatchObject({
      stance: "prohibited",
      defaultChecked: false,
      disabledReason: "This pack marks this output property as prohibited.",
    });
  });

  it("keeps eFileGA PDF/A and OCR off by default while still showing the policy row", () => {
    const plan = resolvePrepPlan(getPack("georgia-efilega"), baseFacts);

    expect(byId(plan, "convert-pdfa")).toMatchObject({
      stance: "accepted",
      prepDefault: "off",
      defaultChecked: false,
    });
    expect(byId(plan, "convert-pdfa").disabledReason).toBeUndefined();
    expect(byId(plan, "make-searchable")).toMatchObject({
      stance: "accepted",
      prepDefault: "off",
      defaultChecked: false,
    });
    expect(byId(plan, "split-by-size").impact).toContain("5 MB");
  });

  it("marks Federal CM/ECF court cap as unknown until a local profile supplies a cap", () => {
    const plan = resolvePrepPlan(getPack("federal-cmecf"), baseFacts);

    expect(byId(plan, "split-by-size")).toMatchObject({
      stance: "unknown",
      defaultChecked: false,
      condition: "set this court's cap before Raio can evaluate size",
    });
    expect(byId(plan, "flatten-forms")).toMatchObject({
      stance: "preferred",
      defaultChecked: true,
    });
    expect(byId(plan, "convert-pdfa")).toMatchObject({
      stance: "accepted",
      defaultChecked: false,
    });
  });

  it("keeps Indiana conditional metadata and OCR requirements visible", () => {
    const plan = resolvePrepPlan(getPack("indiana-iefs"), baseFacts);

    expect(byId(plan, "scrub-metadata")).toMatchObject({
      stance: "required",
      condition: "when the filing contains confidential/redacted information",
      defaultChecked: true,
    });
    expect(byId(plan, "make-searchable")).toMatchObject({
      stance: "required",
      condition: "for scanned documents",
      defaultChecked: true,
    });
    expect(byId(plan, "convert-pdfa")).toMatchObject({
      stance: "unknown",
      defaultChecked: false,
    });
  });

  it("describes garbled text layers as re-OCR work", () => {
    const plan = resolvePrepPlan(getPack("florida"), {
      ...baseFacts,
      textLayerCoverage: {
        imageOnlyPages: [],
        mixedPages: [],
        textPages: [0],
        garbledPages: [{
          pageIndex: 0,
          confidence: 0.91,
          reason: "low_alpha_entropy",
          puaRatio: 0,
          replacementRatio: 0,
          alphaRatio: 0.01,
        }],
      },
    });

    expect(byId(plan, "make-searchable").impact).toBe("Text layer looks unreliable - re-OCR is recommended.");
  });

  it("degrades honestly when Phase 1b fact fields are not available yet", () => {
    const plan = resolvePrepPlan(getPack("florida"), baseFacts);

    expect(byId(plan, "sanitize-content").impact).toContain("cannot compute active-content");
    expect(byId(plan, "convert-pdfa").impact).toContain("cannot compute PDF/A conversion impact");
  });
});

function byId(
  plan: readonly PrepPlanStep[],
  id: PrepPlanStep["id"],
): PrepPlanStep {
  const step = plan.find((candidate) => candidate.id === id);

  if (!step) {
    throw new Error(`Missing prep step ${id}`);
  }

  return step;
}
