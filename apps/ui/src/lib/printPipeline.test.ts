import { describe, expect, it } from "vitest";
import {
  describePrintProgress,
  newPrintJobToken,
  parseCopies,
  parsePrintSelection,
  sortPrintersForPicker,
  type PrintProgressEvent,
} from "./printPipeline";

describe("parsePrintSelection", () => {
  it("treats empty input as the whole document", () => {
    expect(parsePrintSelection("", 500)).toEqual({ ok: true, pageIndexes: null });
    expect(parsePrintSelection("   ", 500)).toEqual({ ok: true, pageIndexes: null });
  });

  it("parses explicit ranges through the shared #127 validation", () => {
    expect(parsePrintSelection("1-3,9", 10)).toEqual({
      ok: true,
      pageIndexes: [0, 1, 2, 8],
    });
  });

  it("surfaces range validation errors verbatim", () => {
    const result = parsePrintSelection("0-3", 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("between 1 and 10");
    }
    expect(parsePrintSelection("nonsense", 10).ok).toBe(false);
    expect(parsePrintSelection("5-2", 10).ok).toBe(false);
  });
});

describe("parseCopies", () => {
  it("accepts whole numbers between 1 and 99", () => {
    expect(parseCopies("1")).toBe(1);
    expect(parseCopies(" 42 ")).toBe(42);
    expect(parseCopies("99")).toBe(99);
  });

  it("rejects zero, negatives, fractions, and overflow", () => {
    expect(parseCopies("0")).toBeNull();
    expect(parseCopies("100")).toBeNull();
    expect(parseCopies("-2")).toBeNull();
    expect(parseCopies("1.5")).toBeNull();
    expect(parseCopies("")).toBeNull();
    expect(parseCopies("two")).toBeNull();
  });
});

describe("sortPrintersForPicker", () => {
  it("puts the default printer first, then sorts alphabetically", () => {
    const sorted = sortPrintersForPicker([
      { name: "Zeta Laser", isDefault: false },
      { name: "Microsoft Print to PDF", isDefault: true },
      { name: "Alpha Inkjet", isDefault: false },
    ]);
    expect(sorted.map((printer) => printer.name)).toEqual([
      "Microsoft Print to PDF",
      "Alpha Inkjet",
      "Zeta Laser",
    ]);
  });

  it("does not mutate the input", () => {
    const printers = [
      { name: "B", isDefault: false },
      { name: "A", isDefault: false },
    ];
    sortPrintersForPicker(printers);
    expect(printers[0]?.name).toBe("B");
  });
});

describe("describePrintProgress", () => {
  const base: PrintProgressEvent = {
    jobToken: "t",
    phase: "gs-segment",
    current: 1,
    total: 1,
    firstPage: 0,
    lastPage: 0,
  };

  it("describes a single whole-document invocation", () => {
    expect(describePrintProgress(base)).toBe("Printing all pages...");
  });

  it("describes multi-segment ghostscript progress with page bounds", () => {
    expect(
      describePrintProgress({
        ...base,
        current: 2,
        total: 4,
        firstPage: 151,
        lastPage: 300,
      }),
    ).toBe("Printing pages 151–300 (2 of 4)...");
  });

  it("describes fallback parts in part-of-total terms", () => {
    expect(
      describePrintProgress({
        ...base,
        phase: "fallback-part",
        current: 2,
        total: 17,
        firstPage: 151,
        lastPage: 300,
      }),
    ).toBe("Printing part 2 of 17 (pages 151–300)...");
    expect(
      describePrintProgress({
        ...base,
        phase: "fallback-split",
        current: 1,
        total: 3,
        firstPage: 1,
        lastPage: 1,
      }),
    ).toBe("Preparing part 1 of 3 (page 1)...");
  });
});

describe("newPrintJobToken", () => {
  it("mints unique tokens", () => {
    expect(newPrintJobToken()).not.toBe(newPrintJobToken());
  });
});
