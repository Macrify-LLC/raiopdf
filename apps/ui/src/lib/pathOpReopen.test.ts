import { describe, expect, it, vi } from "vitest";

import type { FileGrant } from "./filePort";
import { planPathOpReopen } from "./pathOpReopen";

const grant = "grant-out" as FileGrant;

describe("planPathOpReopen (memory-mode reopen for small op outputs)", () => {
  it("reads a below-threshold output once, whole-file, and plans a memory open", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const readWholeByGrant = vi.fn().mockResolvedValue(bytes);

    const plan = await planPathOpReopen(
      { outputGrant: grant, name: "small.pdf", sizeBytes: 3 },
      { readWholeByGrant, thresholdBytes: 100 },
    );

    expect(plan).toEqual({ mode: "memory", bytes });
    // Exactly one ranged read of the whole file: (grant, 0, sizeBytes) is
    // implied by the seam's contract — offset handling lives in filePort.
    expect(readWholeByGrant).toHaveBeenCalledTimes(1);
    expect(readWholeByGrant).toHaveBeenCalledWith(grant, 3);
  });

  it("keeps the streamed reopen at the threshold, without reading", async () => {
    const readWholeByGrant = vi.fn();

    const plan = await planPathOpReopen(
      { outputGrant: grant, name: "big.pdf", sizeBytes: 100 },
      { readWholeByGrant, thresholdBytes: 100 },
    );

    expect(plan).toEqual({ mode: "streamed" });
    expect(readWholeByGrant).not.toHaveBeenCalled();
  });

  it("keeps the streamed reopen above the threshold", async () => {
    const plan = await planPathOpReopen(
      { outputGrant: grant, name: "huge.pdf", sizeBytes: 5_000 },
      { readWholeByGrant: vi.fn(), thresholdBytes: 100 },
    );

    expect(plan).toEqual({ mode: "streamed" });
  });

  it("falls back to the streamed reopen when the whole-file read fails", async () => {
    const readWholeByGrant = vi.fn().mockRejectedValue(new Error("io"));

    const plan = await planPathOpReopen(
      { outputGrant: grant, name: "small.pdf", sizeBytes: 3 },
      { readWholeByGrant, thresholdBytes: 100 },
    );

    expect(plan).toEqual({ mode: "streamed" });
  });
});
