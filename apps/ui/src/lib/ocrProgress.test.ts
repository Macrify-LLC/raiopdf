import { describe, expect, it } from "vitest";

import { describeOcrProgress, type OcrProgressEvent } from "./ocrProgress";

describe("describeOcrProgress", () => {
  const base: OcrProgressEvent = {
    jobToken: "job-1",
    phase: "ocr",
    description: "OCR",
    completed: 2.5,
    total: 5,
    unit: "page",
  };

  it("formats page progress without overstating fractional completion", () => {
    expect(describeOcrProgress(base)).toBe("Making searchable: 2 of 5 pages");
  });

  it("formats postprocess progress separately", () => {
    expect(describeOcrProgress({ ...base, phase: "postprocess", completed: 1, total: 2, unit: "step" })).toBe(
      "Finishing searchable copy: 1 of 2 steps",
    );
  });

  it("formats percent progress without pluralizing the unit", () => {
    expect(describeOcrProgress({ ...base, phase: "postprocess", completed: 49, total: 100, unit: "%" })).toBe(
      "Finishing searchable copy: 49%",
    );
  });

  it("does not double-pluralize units that arrive pluralized", () => {
    expect(describeOcrProgress({ ...base, unit: "pages" })).toBe("Making searchable: 2 of 5 pages");
  });

  it("leaves unknown units alone", () => {
    expect(describeOcrProgress({ ...base, completed: 1, total: 2, unit: "batch" })).toBe(
      "Making searchable: 1 of 2 batch",
    );
  });

  it("falls back to the description when the total is unknown", () => {
    expect(describeOcrProgress({ ...base, description: "Optimizing", total: null })).toBe(
      "Making searchable: Optimizing",
    );
  });
});
