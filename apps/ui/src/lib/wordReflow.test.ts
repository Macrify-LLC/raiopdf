import { describe, expect, it, vi } from "vitest";

import type { FileGrant, SavedFile } from "./filePort";
import {
  resolveWordReflowOcrFirst,
  resolveWordReflowTextLayerSignal,
  runPdfToWordReflow,
  shouldRefuseWordReflow,
  type ScannedPdfChoice,
  type WordReflowDeps,
  type WordReflowOutput,
} from "./wordReflow";
import type { WordCapability } from "./wordCapability";

const grant = (value: string) => value as FileGrant;

const available: WordCapability = { state: "available", reason: null };
const unavailable: WordCapability = {
  state: "unavailable",
  reason: "Microsoft Word was not found.",
};

const output: WordReflowOutput = {
  outputGrant: grant("docx-grant"),
  name: "case.docx",
  sizeBytes: 1024,
  opReport: {
    op: "word_reflow_pdf_to_docx",
    tool: "word",
    durationMs: 12,
    inputSizeBytes: 100,
    outputSizeBytes: 1024,
    notes: [],
  },
};

const saved: SavedFile = { name: "case.docx", path: "saved-grant" };

function deps(overrides: Partial<WordReflowDeps> = {}): WordReflowDeps {
  return {
    getCapability: vi.fn(async () => available),
    promptScannedPdf: vi.fn(async (): Promise<ScannedPdfChoice> => "ocrFirst"),
    reflowPdfToDocx: vi.fn(async () => output),
    saveDocx: vi.fn(async () => saved),
    showWordUnavailable: vi.fn(),
    ...overrides,
  };
}

describe("word reflow decisions", () => {
  it("refuses before text-layer probing or conversion when Word is unavailable", async () => {
    const testDeps = deps({
      getCapability: vi.fn(async () => unavailable),
    });
    const getTextLayer = vi.fn(async () => true);

    const result = await runPdfToWordReflow(
      {
        getInput: async () => ({ grant: grant("pdf-grant"), name: "case.pdf" }),
        getTextLayer,
      },
      testDeps,
    );

    expect(result.status).toBe("refused");
    expect(shouldRefuseWordReflow(unavailable)).toBe(true);
    expect(getTextLayer).not.toHaveBeenCalled();
    expect(testDeps.promptScannedPdf).not.toHaveBeenCalled();
    expect(testDeps.reflowPdfToDocx).not.toHaveBeenCalled();
    expect(testDeps.saveDocx).not.toHaveBeenCalled();
    expect(testDeps.showWordUnavailable).toHaveBeenCalledWith(
      "Word integration not available: Microsoft Word was not found.",
      unavailable,
    );
  });

  it("prompts only for scanned PDFs and defaults that route to OCR-first", async () => {
    const testDeps = deps();

    const result = await runPdfToWordReflow(
      {
        getInput: async () => ({ grant: grant("pdf-grant"), name: "scan.pdf" }),
        getTextLayer: async () => false,
      },
      testDeps,
    );

    expect(result.status).toBe("saved");
    expect(result.status === "saved" ? result.ocrFirst : null).toBe(true);
    expect(testDeps.promptScannedPdf).toHaveBeenCalledTimes(1);
    expect(testDeps.reflowPdfToDocx).toHaveBeenCalledWith("pdf-grant", true);
  });

  it.each([true, null] satisfies Array<boolean | null>)(
    "does not prompt or OCR-first when text-layer signal is %s",
    async (hasTextLayer) => {
      const testDeps = deps();

      await runPdfToWordReflow(
        {
          getInput: async () => ({ grant: grant("pdf-grant"), name: "text.pdf" }),
          getTextLayer: async () => hasTextLayer,
        },
        testDeps,
      );

      expect(testDeps.promptScannedPdf).not.toHaveBeenCalled();
      expect(testDeps.reflowPdfToDocx).toHaveBeenCalledWith("pdf-grant", false);
    },
  );

  it("honors Convert anyway for a scanned PDF", async () => {
    const testDeps = deps({
      promptScannedPdf: vi.fn(async (): Promise<ScannedPdfChoice> => "convertAnyway"),
    });

    await runPdfToWordReflow(
      {
        getInput: async () => ({ grant: grant("pdf-grant"), name: "scan.pdf" }),
        getTextLayer: async () => false,
      },
      testDeps,
    );

    expect(testDeps.reflowPdfToDocx).toHaveBeenCalledWith("pdf-grant", false);
    expect(resolveWordReflowOcrFirst(false, "convertAnyway")).toBe(false);
  });

  it("falls back to probing the grant when the cached text-layer signal is unknown", async () => {
    const testDeps = deps();
    const probeGrant = vi.fn(async () => false);

    await runPdfToWordReflow(
      {
        getInput: async () => ({ grant: grant("pdf-grant"), name: "scan.pdf" }),
        getTextLayer: (input) => resolveWordReflowTextLayerSignal(input, null, probeGrant),
      },
      testDeps,
    );

    expect(probeGrant).toHaveBeenCalledWith("pdf-grant");
    expect(testDeps.promptScannedPdf).toHaveBeenCalledTimes(1);
    expect(testDeps.reflowPdfToDocx).toHaveBeenCalledWith("pdf-grant", true);
  });
});
