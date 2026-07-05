// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri's invoke is loaded dynamically inside filePort; the mock lets the
// grant-backed helpers run without a shell.
const invokeState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: unknown; options?: unknown }>,
  handler: undefined as
    | ((command: string, args?: unknown, options?: unknown) => unknown)
    | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown, options?: unknown) => {
    const call: { command: string; args: unknown; options?: unknown } = { command, args };

    if (options !== undefined) {
      call.options = options;
    }

    invokeState.calls.push(call);

    if (!invokeState.handler) {
      throw new Error(`Unexpected invoke: ${command}`);
    }

    return invokeState.handler(command, args, options);
  },
}));

import {
  DEFAULT_LARGE_DOC_THRESHOLD_BYTES,
  FileRangeError,
  isFileChangedError,
  readBrowserFileSource,
  readPdfRange,
  readPickedFileSource,
  saveStreamedCopyIntoDirectory,
  type FileGrant,
  type PickedDirectory,
} from "./filePort";

function makeFile(sizeBytes: number, name = "doc.pdf"): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: "application/pdf" });
}

beforeEach(() => {
  invokeState.calls.length = 0;
  invokeState.handler = undefined;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

describe("readPickedFileSource", () => {
  it("fetches a below-threshold file with ONE whole-file ranged read", async () => {
    invokeState.handler = () => new Uint8Array(10);

    const result = await readPickedFileSource(
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
    const result = await readPickedFileSource(
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

describe("directory saves", () => {
  it("Tauri filePort writes raw bytes through typed dialog arguments", async () => {
    vi.resetModules();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    invokeState.handler = (command) => {
      if (command === "save_pdf_dialog") {
        return { fileGrant: "saved-grant", name: "saved.pdf" };
      }

      throw new Error(`Unexpected invoke: ${command}`);
    };

    const { filePort } = await import("./filePort");
    const saved = await filePort.saveFile(new Uint8Array([1, 2, 3]), "saved.pdf", null);

    expect(saved).toEqual({ name: "saved.pdf", path: "saved-grant" });
    expect(invokeState.calls).toEqual([
      {
        command: "save_pdf_dialog",
        args: {
          suggestedName: "saved.pdf",
          bytes: [1, 2, 3],
        },
      },
    ]);
  });

  it("Tauri filePort writes in-place bytes through typed grant arguments", async () => {
    vi.resetModules();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    invokeState.handler = (command) => {
      if (command === "save_pdf_to_path") {
        return { fileGrant: "saved-grant", name: "case.pdf" };
      }

      throw new Error(`Unexpected invoke: ${command}`);
    };

    const { filePort } = await import("./filePort");
    const saved = await filePort.saveFile(
      new Uint8Array([4, 5, 6]),
      "case.pdf",
      "open-grant" as FileGrant,
    );

    expect(saved).toEqual({ name: "case.pdf", path: "saved-grant" });
    expect(invokeState.calls).toEqual([
      {
        command: "save_pdf_to_path",
        args: {
          fileGrant: "open-grant",
          bytes: [4, 5, 6],
        },
      },
    ]);
  });

  it("copies a streamed grant into a picked directory without opening another save dialog", async () => {
    invokeState.handler = () => ({ fileGrant: "saved-grant", name: "part (2).pdf" });

    const saved = await saveStreamedCopyIntoDirectory(
      { kind: "rangeGrant", grant: "source-grant" as FileGrant },
      "part.pdf",
      { grant: "dir-grant" as FileGrant, path: "/tmp/output" },
    );

    expect(saved).toEqual({ name: "part (2).pdf", path: "saved-grant" });
    expect(invokeState.calls).toEqual([
      {
        command: "save_pdf_copy_into_dir",
        args: {
          sourceGrant: "source-grant",
          directoryGrant: "dir-grant",
          fileName: "part.pdf",
        },
      },
    ]);
  });

  it("Tauri filePort picks a directory and writes raw bytes into it", async () => {
    vi.resetModules();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    invokeState.handler = (command) => {
      if (command === "pick_output_directory") {
        return { grant: "dir-grant", path: "/tmp/output" };
      }

      if (command === "save_pdf_into_dir") {
        return { fileGrant: "saved-grant", name: "part.pdf" };
      }

      throw new Error(`Unexpected invoke: ${command}`);
    };

    const { filePort } = await import("./filePort");
    const directory = await filePort.pickDirectory();
    const saved = await filePort.saveFileIntoDirectory(
      new Uint8Array([1, 2, 3]),
      "part.pdf",
      directory as PickedDirectory,
    );

    expect(directory).toEqual({ grant: "dir-grant", path: "/tmp/output" });
    expect(saved).toEqual({ name: "part.pdf", path: "saved-grant" });
    expect(invokeState.calls).toEqual([
      { command: "pick_output_directory", args: undefined },
      {
        command: "save_pdf_into_dir",
        args: {
          directoryGrant: "dir-grant",
          fileName: "part.pdf",
          bytes: [1, 2, 3],
        },
      },
    ]);
  });
});
