import { describe, expect, it } from "vitest";

import {
  formatOcrRunningMessage,
  toLongProcessProgress,
} from "./OcrDialog";

describe("OcrDialog long-process loader", () => {
  it("formats OCR progress for the docked loader", () => {
    const progress = {
      jobToken: "job-1",
      phase: "ocr" as const,
      description: "OCR",
      completed: 2.5,
      total: 5,
      unit: "page",
    };

    expect(formatOcrRunningMessage("processing", progress)).toBe("Making searchable: 2 of 5 pages");
    expect(toLongProcessProgress(progress)).toEqual({
      current: 2.5,
      total: 5,
      unit: "page",
    });
  });
});
