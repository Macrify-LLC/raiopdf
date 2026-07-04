// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri's invoke is loaded dynamically inside filePort; the mock lets the
// grant-backed helpers run without a shell.
const invokeState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: unknown }>,
  handler: undefined as ((command: string, args?: unknown) => unknown) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    invokeState.calls.push({ command, args });

    if (!invokeState.handler) {
      throw new Error(`Unexpected invoke: ${command}`);
    }

    return invokeState.handler(command, args);
  },
}));

import {
  DEFAULT_LARGE_DOC_THRESHOLD_BYTES,
  FileRangeError,
  isFileChangedError,
  readBrowserFileSource,
  readFileForAdd,
  readPdfRange,
  type FileGrant,
} from "./filePort";

function makeFile(sizeBytes: number, name = "doc.pdf"): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: "application/pdf" });
}

beforeEach(() => {
  invokeState.calls.length = 0;
  invokeState.handler = undefined;
});

describe("readBrowserFileSource", () => {
  it("returns bytes below the threshold (today's path unchanged)", async () => {
    const source = await readBrowserFileSource(makeFile(8), 16);

    expect(source.kind).toBe("memory");

    if (source.kind === "memory") {
      expect(source.bytes).toHaveLength(8);
      expect(source.name).toBe("doc.pdf");
      expect(source.path).toBeNull();
    }
  });

  it("returns the File itself at/above the threshold — never arrayBuffer()ed", async () => {
    const file = makeFile(32);
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");

    const source = await readBrowserFileSource(file, 32);

    expect(source.kind).toBe("rangeFile");

    if (source.kind === "rangeFile") {
      expect(source.file).toBe(file);
      expect(source.sizeBytes).toBe(32);
    }

    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("defaults to the 50 MB shell threshold", () => {
    expect(DEFAULT_LARGE_DOC_THRESHOLD_BYTES).toBe(52_428_800);
  });
});

describe("readPdfRange", () => {
  it("passes grant/offset/length through and normalizes the binary response", async () => {
    invokeState.handler = () => new Uint8Array([7, 8, 9]).buffer;

    const bytes = await readPdfRange("grant-1" as FileGrant, 4, 3);

    expect(Array.from(bytes)).toEqual([7, 8, 9]);
    expect(invokeState.calls).toEqual([
      { command: "read_pdf_range", args: { grant: "grant-1", offset: 4, length: 3 } },
    ]);
  });

  it("rethrows the shell's typed error as a FileRangeError", async () => {
    invokeState.handler = () => {
      throw { code: "FILE_CHANGED", message: "This file changed on disk — reopen it." };
    };

    const error = await readPdfRange("grant-1" as FileGrant, 0, 4).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileRangeError);
    expect((error as FileRangeError).code).toBe("FILE_CHANGED");
    expect(isFileChangedError(error)).toBe(true);
  });

  it("maps unknown rejection shapes to an IO FileRangeError", async () => {
    invokeState.handler = () => {
      throw new Error("socket sadness");
    };

    const error = await readPdfRange("grant-1" as FileGrant, 0, 4).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileRangeError);
    expect((error as FileRangeError).code).toBe("IO");
    expect(isFileChangedError(error)).toBe(false);
  });
});

describe("readFileForAdd", () => {
  it("fetches a below-threshold file with ONE whole-file ranged read", async () => {
    invokeState.handler = () => new Uint8Array(10);

    const result = await readFileForAdd(
      { grant: "grant-2" as FileGrant, name: "exhibit.pdf", sizeBytes: 10 },
      64,
    );

    expect(result.kind).toBe("memory");

    if (result.kind === "memory") {
      expect(result.bytes).toHaveLength(10);
      // Grants double as filePath identifiers in the Tauri runtime [R1-9].
      expect(result.path).toBe("grant-2");
    }

    expect(invokeState.calls).toEqual([
      { command: "read_pdf_range", args: { grant: "grant-2", offset: 0, length: 10 } },
    ]);
  });

  it("keeps an at/above-threshold file as a descriptor — no read at all", async () => {
    const result = await readFileForAdd(
      { grant: "grant-3" as FileGrant, name: "appendix.pdf", sizeBytes: 64 },
      64,
    );

    expect(result).toEqual({
      kind: "rangeGrant",
      grant: "grant-3",
      name: "appendix.pdf",
      sizeBytes: 64,
    });
    expect(invokeState.calls).toHaveLength(0);
  });
});
