// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The transport must subclass the REAL PDFDataRangeTransport (getDocument
// does an instanceof check), but for unit tests a minimal stand-in with the
// same surface lets us observe onDataRange/abort without a worker.
vi.mock("pdfjs-dist", () => {
  class PDFDataRangeTransport {
    length: number;
    initialData: Uint8Array | null;
    abortCalls = 0;
    received: Array<{ begin: number; chunk: Uint8Array | null }> = [];

    constructor(length: number, initialData: Uint8Array | null) {
      this.length = length;
      this.initialData = initialData;
    }

    onDataRange(begin: number, chunk: Uint8Array | null) {
      this.received.push({ begin, chunk });
    }

    abort() {
      this.abortCalls += 1;
    }
  }

  return { PDFDataRangeTransport };
});

import {
  createFileRangeTransport,
  RaioPdfRangeTransport,
  STREAMED_RANGE_CHUNK_SIZE,
} from "./pdfRangeTransport";

type TransportInternals = RaioPdfRangeTransport & {
  received: Array<{ begin: number; chunk: Uint8Array | null }>;
  abortCalls: number;
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RaioPdfRangeTransport", () => {
  it("starts at a 1 MB chunk size", () => {
    expect(STREAMED_RANGE_CHUNK_SIZE).toBe(1024 * 1024);
  });

  it("delivers the requested range via onDataRange with begin preserved", async () => {
    const reads: Array<[number, number]> = [];
    const transport = new RaioPdfRangeTransport(100, async (begin, end) => {
      reads.push([begin, end]);
      return new Uint8Array(end - begin);
    }) as TransportInternals;

    transport.requestDataRange(10, 30);
    await flushMicrotasks();

    expect(reads).toEqual([[10, 30]]);
    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]!.begin).toBe(10);
    expect(transport.received[0]!.chunk).toHaveLength(20);
  });

  it("clamps a final chunk that runs past EOF to the document length", async () => {
    const reads: Array<[number, number]> = [];
    const transport = new RaioPdfRangeTransport(100, async (begin, end) => {
      reads.push([begin, end]);
      return new Uint8Array(end - begin);
    }) as TransportInternals;

    // pdf.js may ask for a rangeChunkSize-aligned end past EOF; the shell's
    // bounds contract is strict, so the transport clamps.
    transport.requestDataRange(96, 128);
    await flushMicrotasks();

    expect(reads).toEqual([[96, 100]]);
    expect(transport.received[0]!.chunk).toHaveLength(4);
  });

  it("produces a fresh chunk buffer per read (never reuses one)", async () => {
    const transport = new RaioPdfRangeTransport(64, async (begin, end) => {
      return new Uint8Array(end - begin);
    }) as TransportInternals;

    transport.requestDataRange(0, 16);
    transport.requestDataRange(16, 32);
    await flushMicrotasks();

    expect(transport.received).toHaveLength(2);
    expect(transport.received[0]!.chunk).not.toBe(transport.received[1]!.chunk);
  });

  it("drops a late resolution after abort instead of feeding the worker", async () => {
    let releaseRead: (() => void) | undefined;
    const transport = new RaioPdfRangeTransport(64, async (begin, end) => {
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return new Uint8Array(end - begin);
    }) as TransportInternals;

    transport.requestDataRange(0, 16);
    transport.abort();
    releaseRead?.();
    await flushMicrotasks();

    expect(transport.received).toHaveLength(0);
    expect(transport.abortCalls).toBe(1);
    expect(transport.aborted).toBe(true);
  });

  it("ignores new range requests after abort", async () => {
    const reads: Array<[number, number]> = [];
    const transport = new RaioPdfRangeTransport(64, async (begin, end) => {
      reads.push([begin, end]);
      return new Uint8Array(end - begin);
    }) as TransportInternals;

    transport.abort();
    transport.requestDataRange(0, 16);
    await flushMicrotasks();

    expect(reads).toHaveLength(0);
    expect(transport.received).toHaveLength(0);
  });

  it("routes read failures to onReadError, but not after abort", async () => {
    const onReadError = vi.fn();
    const failing = new RaioPdfRangeTransport(
      64,
      async () => {
        throw new Error("FILE_CHANGED");
      },
      onReadError,
    );

    failing.requestDataRange(0, 16);
    await flushMicrotasks();
    expect(onReadError).toHaveBeenCalledTimes(1);

    const abortedErrors = vi.fn();
    let releaseRead: (() => void) | undefined;
    const aborted = new RaioPdfRangeTransport(
      64,
      async () => {
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        throw new Error("late failure");
      },
      abortedErrors,
    );
    aborted.requestDataRange(0, 16);
    aborted.abort();
    releaseRead?.();
    await flushMicrotasks();
    expect(abortedErrors).not.toHaveBeenCalled();
  });

  it("backs the browser transport with File.slice of exactly [begin, end)", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])], "big.pdf", {
      type: "application/pdf",
    });
    const transport = createFileRangeTransport(file) as TransportInternals;

    transport.requestDataRange(2, 6);
    await flushMicrotasks();

    expect(transport.received).toHaveLength(1);
    expect(Array.from(transport.received[0]!.chunk!)).toEqual([2, 3, 4, 5]);
  });
});
