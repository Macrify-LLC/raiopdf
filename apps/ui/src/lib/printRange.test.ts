import { describe, expect, it, vi } from "vitest";
import type { FileGrant } from "./filePort";
import type { PathOpOutput } from "./pathOps";
import { PathOpsError } from "./pathOps";
import { extractPrintableRange } from "./printRange";

const GRANT = "grant-source" as FileGrant;

function output(overrides: Partial<PathOpOutput> = {}): PathOpOutput {
  return {
    outputGrant: "grant-extract" as FileGrant,
    name: "appendix-extract.pdf",
    sizeBytes: 2_000,
    pageCount: 3,
    opReport: {
      op: "extract_pages",
      tool: "qpdf",
      durationMs: 5,
      inputSizeBytes: 283_000_000,
      outputSizeBytes: 2_000,
      notes: [],
    },
    ...overrides,
  };
}

describe("extractPrintableRange", () => {
  it("extracts, reads the whole output once, releases the temp, and names the copy", async () => {
    const extractPages = vi.fn(async () => output());
    const readWholeByGrant = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const releaseOutput = vi.fn(async () => undefined);

    const result = await extractPrintableRange(GRANT, "1-2, 5", 2556, "Appendix", {
      extractPages,
      readWholeByGrant,
      releaseOutput,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extraction.name).toBe("Appendix — pages 1-2, 5.pdf");
      expect(result.extraction.pageIndexes).toEqual([0, 1, 4]);
      expect(result.extraction.bytes).toEqual(new Uint8Array([1, 2, 3]));
    }

    expect(extractPages).toHaveBeenCalledWith(GRANT, [0, 1, 4]);
    expect(readWholeByGrant).toHaveBeenCalledWith("grant-extract", 2_000);
    // The temp output is deleted once the bytes are in memory.
    expect(releaseOutput).toHaveBeenCalledWith("grant-extract");
  });

  it("rejects an invalid range before touching the shell", async () => {
    const extractPages = vi.fn(async () => output());

    const result = await extractPrintableRange(GRANT, "0-9999", 2556, "Appendix", {
      extractPages,
    });

    expect(result).toEqual({ ok: false, error: "Pages must be between 1 and 2556." });
    expect(extractPages).not.toHaveBeenCalled();
  });

  it("releases and refuses an extraction still above the per-call read cap", async () => {
    const releaseOutput = vi.fn(async () => undefined);
    const result = await extractPrintableRange(GRANT, "1-2000", 2556, "Appendix", {
      extractPages: async () => output({ sizeBytes: 200_000_000 }),
      releaseOutput,
      thresholdBytes: 50 * 1024 * 1024,
    });

    expect(result).toEqual({
      ok: false,
      error: "That page range is still too large to print — choose fewer pages.",
    });
    expect(releaseOutput).toHaveBeenCalledWith("grant-extract");
  });

  it("maps a FILE_CHANGED extraction failure onto the reopen message", async () => {
    const result = await extractPrintableRange(GRANT, "1-3", 2556, "Appendix", {
      extractPages: async () => {
        throw new PathOpsError({ code: "FILE_CHANGED", message: "drifted" });
      },
    });

    expect(result).toEqual({ ok: false, error: "This file changed on disk — reopen it." });
  });

  it("releases the temp when the whole-output read fails", async () => {
    const releaseOutput = vi.fn(async () => undefined);
    const result = await extractPrintableRange(GRANT, "1", 2556, "Appendix", {
      extractPages: async () => output(),
      readWholeByGrant: async () => {
        throw new Error("read failed");
      },
      releaseOutput,
    });

    expect(result.ok).toBe(false);
    expect(releaseOutput).toHaveBeenCalledWith("grant-extract");
  });
});
