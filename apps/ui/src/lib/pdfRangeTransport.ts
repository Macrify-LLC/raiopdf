/**
 * pdf.js range transports for streamed (large-doc) viewing [R1-4].
 *
 * Contract notes:
 * - This subclasses the REAL `PDFDataRangeTransport` from the same
 *   `pdfjs-dist` module the viewer uses — `getDocument` does an `instanceof`
 *   check, so a shape-compatible object is not enough.
 * - Callback style, not promises: `requestDataRange(begin, end)` fires the
 *   read and, on completion, calls `this.onDataRange(begin, chunk)`.
 * - Every chunk handed to `onDataRange` is a FRESH `Uint8Array` — pdf.js may
 *   transfer the buffer to its worker, so a chunk buffer must never be
 *   reused. Both readers below allocate per call (Tauri invoke returns a new
 *   ArrayBuffer; `File.slice().arrayBuffer()` does too).
 * - Abort/stale handling: once `abort()` runs (superseded or closed
 *   document), late read resolutions are dropped instead of being pushed
 *   into a destroyed worker.
 */

import { PDFDataRangeTransport } from "pdfjs-dist";
import {
  readPdfRange,
  type FileGrant,
} from "./filePort";
export { STREAMED_RANGE_CHUNK_SIZE } from "./streamedChunks";

type RangeReader = (begin: number, end: number) => Promise<Uint8Array>;

export class RaioPdfRangeTransport extends PDFDataRangeTransport {
  #aborted = false;
  readonly #readRange: RangeReader;
  readonly #onReadError: ((error: unknown) => void) | undefined;

  constructor(
    length: number,
    readRange: RangeReader,
    onReadError?: (error: unknown) => void,
  ) {
    super(length, null);
    this.#readRange = readRange;
    this.#onReadError = onReadError;
  }

  get aborted(): boolean {
    return this.#aborted;
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.#aborted) {
      return;
    }

    // pdf.js may request a final chunk that runs past EOF; the shell's
    // bounds contract is end-exclusive and strict, so clamp here.
    const clampedEnd = Math.min(end, this.length);

    if (clampedEnd <= begin) {
      return;
    }

    void this.#readRange(begin, clampedEnd)
      .then((chunk) => {
        if (this.#aborted) {
          return;
        }

        this.onDataRange(begin, chunk);
      })
      .catch((error: unknown) => {
        if (!this.#aborted) {
          this.#onReadError?.(error);
        }
      });
  }

  override abort(): void {
    this.#aborted = true;
    super.abort();
  }
}

/** Tauri runtime: ranged reads against a shell grant snapshot. */
export function createGrantRangeTransport(
  grant: FileGrant,
  sizeBytes: number,
  onReadError?: (error: unknown) => void,
): RaioPdfRangeTransport {
  return new RaioPdfRangeTransport(
    sizeBytes,
    (begin, end) => readPdfRange(grant, begin, end - begin),
    onReadError,
  );
}

/**
 * Browser runtime: the same transport backed by `File.slice` so the
 * smoke/dev environment exercises the streamed path without Tauri [R1-1].
 */
export function createFileRangeTransport(
  file: File,
  onReadError?: (error: unknown) => void,
): RaioPdfRangeTransport {
  return new RaioPdfRangeTransport(
    file.size,
    async (begin, end) => new Uint8Array(await file.slice(begin, end).arrayBuffer()),
    onReadError,
  );
}
