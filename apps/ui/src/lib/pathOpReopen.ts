/**
 * Memory-mode reopen for small path-op outputs (large-pdf v1.1 decision).
 *
 * A delegated op on a huge document often produces a SMALL output — a 283 MB
 * file compressed to 30 MB, a decrypted copy of a modest scan, an OCR pass
 * that deflated bloat. Reopening such an output as a streamed document keeps
 * all in-memory editing gated for no reason. Below the large-doc threshold
 * the output is instead read ONCE by grant (`read_pdf_range(grant, 0,
 * sizeBytes)` — the whole-file ranged read fits the shell's per-call cap by
 * contract [R6-2]) and opened as an ordinary MEMORY document with full
 * editing restored. At or above the threshold the streamed reopen stays.
 *
 * The caller (App's `openPathOpOutput` funnel) releases the temp output grant
 * after a successful memory open: the bytes live in memory, the temp file has
 * no further use, and the document deliberately has no on-disk identity
 * (filePath null, clean, Save As is the natural next step).
 */

import { readPdfRange, type FileGrant } from "./filePort";
import { getLargeDocThresholdBytes } from "./largeDocThreshold";

export interface PathOpReopenInput {
  outputGrant: FileGrant;
  name: string;
  sizeBytes: number;
}

export type PathOpReopenPlan =
  | { mode: "memory"; bytes: Uint8Array }
  | { mode: "streamed" };

/** Injectable seams so the branch logic is unit-testable without a shell. */
export interface PathOpReopenDeps {
  readWholeByGrant?: (grant: FileGrant, sizeBytes: number) => Promise<Uint8Array>;
  thresholdBytes?: number;
}

/**
 * Decide how a path-op output reopens. Below the threshold: one whole-file
 * ranged read → memory plan. At/above: streamed plan, no read. If the read
 * fails (grant raced a shell restart, disk hiccup), fall back to the
 * streamed reopen rather than surfacing an error — the output grant itself
 * is still valid and the streamed path re-reads on demand.
 */
export async function planPathOpReopen(
  output: PathOpReopenInput,
  deps: PathOpReopenDeps = {},
): Promise<PathOpReopenPlan> {
  const threshold = deps.thresholdBytes ?? getLargeDocThresholdBytes();

  if (output.sizeBytes >= threshold) {
    return { mode: "streamed" };
  }

  const readWholeByGrant = deps.readWholeByGrant ??
    ((grant: FileGrant, sizeBytes: number) => readPdfRange(grant, 0, sizeBytes));

  try {
    return { mode: "memory", bytes: await readWholeByGrant(output.outputGrant, output.sizeBytes) };
  } catch {
    return { mode: "streamed" };
  }
}
