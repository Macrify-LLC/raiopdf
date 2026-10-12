import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokePathOp, PathOpsError } from "./pathOps";
import {
  describePrintProgress,
  newPrintJobToken,
  parseCopies,
  parsePrintSelection,
  printPdf,
  printErrorPresentation,
  printerCapabilities,
  sortPrintersForPicker,
  type PrintProgressEvent,
} from "./printPipeline";

vi.mock("./pathOps", async (importOriginal) => ({
  ...await importOriginal<typeof import("./pathOps")>(),
  invokePathOp: vi.fn(),
}));

const invokePathOpMock = vi.mocked(invokePathOp);

beforeEach(() => {
  invokePathOpMock.mockReset();
});

describe("printerCapabilities", () => {
  it("returns the selected printer's advertised choices through the typed path op", async () => {
    const capabilities = {
      media: [{ value: "DMPAPER:1", label: "Letter" }],
      paperSources: [{ value: "DMBIN:4", label: "Lower tray" }],
    };
    invokePathOpMock.mockResolvedValue(capabilities);

    await expect(printerCapabilities("Office Printer")).resolves.toEqual(capabilities);
    expect(invokePathOpMock).toHaveBeenCalledWith("print_printer_capabilities", {
      printer: "Office Printer",
    });
  });
});

describe("printPdf option payload", () => {
  it("keeps advertised media and paper source in the submission payload", async () => {
    invokePathOpMock.mockResolvedValue({});

    await printPdf("grant", "job", "Office Printer", [0, 2], 2, {
      media: "DMPAPER:1",
      paperSource: "DMBIN:4",
    });

    expect(invokePathOpMock).toHaveBeenCalledWith("print_pdf", {
      grant: "grant",
      jobToken: "job",
      printer: "Office Printer",
      pageIndexes: [0, 2],
      copies: 2,
      options: { media: "DMPAPER:1", paperSource: "DMBIN:4" },
    });
  });

  it("preserves default paper and source by omitting both fields", async () => {
    invokePathOpMock.mockResolvedValue({});

    await printPdf("grant", "job", "Office Printer", null, 1);

    expect(invokePathOpMock).toHaveBeenCalledWith("print_pdf", expect.objectContaining({
      options: {},
    }));
  });
});

describe("printErrorPresentation", () => {
  it("preserves actionable print validation and backend failure messages", () => {
    const invalidPaper = new PathOpsError({
      code: "INVALID_INPUT",
      message: "The selected paper size is no longer available. Choose a paper size again.",
    });
    const failedJob = new PathOpsError({
      code: "PRINT_FAILED",
      message: "The printer stopped after page 4. Check the printer and retry.",
    });

    expect(printErrorPresentation(invalidPaper, "generic fallback")).toEqual({
      kind: "failed",
      message: invalidPaper.message,
    });
    expect(printErrorPresentation(failedJob, "generic fallback")).toEqual({
      kind: "failed",
      message: failedJob.message,
    });
  });

  it("shows the driver's controlled paper settings rejection", () => {
    const rejectedSettings = new PathOpsError({
      code: "PRINT_FAILED",
      message: "printer did not preserve the requested paper source. Choose different printer settings and try again.",
    });

    expect(printErrorPresentation(rejectedSettings, "generic fallback")).toEqual({
      kind: "failed",
      message: rejectedSettings.message,
    });
  });

  it("surfaces post-start cancellation as a warning with the native details", () => {
    const partialCancel = new PathOpsError({
      code: "PRINT_PARTIAL_CANCELLED",
      message: "Some selected pages or copies may already have printed. Check the output before retrying.",
    });

    expect(printErrorPresentation(partialCancel, "generic fallback")).toEqual({
      kind: "partial-cancelled",
      message: `Printing was cancelled after it started. ${partialCancel.message}`,
    });
  });

  it("suppresses only pre-start cancellation and otherwise uses shared fallback policy", () => {
    const cancelledBeforeStart = new PathOpsError({
      code: "PRINT_CANCELLED",
      message: "Printing was cancelled.",
    });
    const unrelatedPrintFailure = new PathOpsError({
      code: "PRINT_NOT_SUPPORTED",
      message: "Native printing is unavailable.",
    });
    const missingTool = new PathOpsError({
      code: "TOOLCHAIN_MISSING",
      message: "The native print helper is missing.",
    });

    expect(printErrorPresentation(cancelledBeforeStart, "generic fallback")).toEqual({
      kind: "cancelled",
    });
    expect(printErrorPresentation(unrelatedPrintFailure, "generic fallback")).toEqual({
      kind: "failed",
      message: "generic fallback",
    });
    expect(printErrorPresentation(missingTool, "generic fallback")).toEqual({
      kind: "failed",
      message: "The native print helper is missing.",
    });
  });
});

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

  it("describes CUPS queued and printing phases without page numbers", () => {
    expect(describePrintProgress({ ...base, phase: "cups-queued" })).toBe(
      "Sending to the printer...",
    );
    expect(describePrintProgress({ ...base, phase: "cups-printing" })).toBe(
      "Printing...",
    );
  });
});

describe("newPrintJobToken", () => {
  it("mints unique tokens", () => {
    expect(newPrintJobToken()).not.toBe(newPrintJobToken());
  });
});
