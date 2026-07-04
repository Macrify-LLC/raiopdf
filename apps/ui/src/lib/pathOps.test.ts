import { describe, expect, it } from "vitest";

import { isFilingStepEnabled, type PathOpsStatus } from "./pathOps";

function statusFixture(overrides?: Partial<PathOpsStatus>): PathOpsStatus {
  return {
    toolchain: { qpdf: true, ghostscript: true, ocrmypdf: false },
    ops: [
      {
        name: "normalize_to_letter_portrait",
        available: true,
        missingTools: [],
        filingStep: "normalize-pages",
      },
      {
        name: "split_by_max_bytes",
        available: true,
        missingTools: [],
        filingStep: "split-by-size",
      },
      {
        name: "ocr",
        available: false,
        missingTools: ["ocrmypdf"],
        filingStep: "make-searchable",
      },
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
    ...overrides,
  };
}

describe("isFilingStepEnabled (closed-form checklist rule)", () => {
  it("enables a step when a registered path op implements it and is available", () => {
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "normalize-pages")).toBe(true);
    expect(isFilingStepEnabled(status, "split-by-size")).toBe(true);
  });

  it("disables steps with no registered path op", () => {
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "flatten-forms")).toBe(false);
    expect(isFilingStepEnabled(status, "convert-pdfa")).toBe(false);
  });

  it("disables a registered step whose toolchain is missing", () => {
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "make-searchable")).toBe(false);
  });

  it("disables a step whose mapped op is absent from the ops list", () => {
    // "remove-encryption" maps to "decrypt" but the fixture ops list does not
    // include it — the rule must fail closed, not assume availability.
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "remove-encryption")).toBe(false);
  });
});
