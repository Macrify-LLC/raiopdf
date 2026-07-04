/**
 * Page-range printing for streamed (large) documents.
 *
 * Since v1.1 the native streaming print pipeline (`printPipeline.ts`) is the
 * primary path — whole-document printing is un-gated there. This flow is the
 * FALLBACK when native printing is unavailable (no Ghostscript, unsupported
 * platform): extract the requested range file-to-file
 * (`path_op_extract_pages`), read the SMALL output into memory with one
 * ranged read, release the temp output, and hand the bytes to the caller —
 * which opens them as an ordinary small document so the EXISTING print path
 * (`window.print()` on the rendered viewer) applies unchanged.
 */

import { readPdfRange } from "./filePort";
import type { FileGrant } from "./filePort";
import { getLargeDocThresholdBytes } from "./largeDocThreshold";
import { parsePageRanges } from "./pageRanges";
import {
  pathOpErrorMessage,
  pathOpExtractPages,
  pathOpReleaseOutput,
  type PathOpOutput,
  type PathOpsFileGrant,
} from "./pathOps";

export interface PrintRangeExtraction {
  bytes: Uint8Array;
  name: string;
  pageIndexes: readonly number[];
}

export type PrintRangeResult =
  | { ok: true; extraction: PrintRangeExtraction }
  | { ok: false; error: string };

/** Injectable seams so the flow is unit-testable without a Tauri shell. */
export interface PrintRangeDeps {
  extractPages?: (
    grant: PathOpsFileGrant,
    pageIndexes: readonly number[],
  ) => Promise<PathOpOutput>;
  readWholeByGrant?: (grant: FileGrant, sizeBytes: number) => Promise<Uint8Array>;
  releaseOutput?: (grant: PathOpsFileGrant) => Promise<void>;
  thresholdBytes?: number;
}

const MIN_RANGE_CALL_CAP_BYTES = 4 * 1024 * 1024;

export async function extractPrintableRange(
  grant: FileGrant,
  rangeInput: string,
  pageCount: number,
  baseName: string,
  deps: PrintRangeDeps = {},
): Promise<PrintRangeResult> {
  const parsed = parsePageRanges(rangeInput, pageCount);

  if (parsed.error !== null) {
    return { ok: false, error: parsed.error };
  }

  const extractPages = deps.extractPages ?? pathOpExtractPages;
  const readWholeByGrant = deps.readWholeByGrant ??
    ((outputGrant: FileGrant, sizeBytes: number) => readPdfRange(outputGrant, 0, sizeBytes));
  const releaseOutput = deps.releaseOutput ?? pathOpReleaseOutput;

  let output: PathOpOutput;
  try {
    output = await extractPages(grant, parsed.pageIndexes);
  } catch (error) {
    return {
      ok: false,
      error: pathOpErrorMessage(error, "Those pages could not be extracted for printing."),
    };
  }

  // The whole-output read must fit the shell's per-call range cap
  // (max(4 MB, threshold)); a range that extracts bigger than that is still
  // too large to print through the in-memory path.
  const cap = Math.max(
    MIN_RANGE_CALL_CAP_BYTES,
    deps.thresholdBytes ?? getLargeDocThresholdBytes(),
  );

  if (output.sizeBytes > cap) {
    await releaseOutput(output.outputGrant).catch(() => undefined);
    return {
      ok: false,
      error: "That page range is still too large to print — choose fewer pages.",
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readWholeByGrant(output.outputGrant, output.sizeBytes);
  } catch (error) {
    await releaseOutput(output.outputGrant).catch(() => undefined);
    return {
      ok: false,
      error: pathOpErrorMessage(error, "The extracted pages could not be read for printing."),
    };
  }

  // The bytes are in memory now; the temp file has no further use. Deletion
  // is best-effort — the startup sweep covers anything this misses.
  await releaseOutput(output.outputGrant).catch(() => undefined);

  return {
    ok: true,
    extraction: {
      bytes,
      name: `${baseName} — pages ${rangeInput.trim()}.pdf`,
      pageIndexes: parsed.pageIndexes,
    },
  };
}
