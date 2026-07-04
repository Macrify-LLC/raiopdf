// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pickFileForAdd,
  pickPdfsForAdd,
  readFileForAdd,
  tooLargeToAddMessage,
} from "./readFileForAdd";
import { getLargeDocThresholdBytes, setLargeDocThresholdBytes } from "./largeDocThreshold";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const THRESHOLD = 64;

function pdfFile(name: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], name, { type: "application/pdf" });
}

function missingCommandError(command: string): string {
  // Tauri v2 rejects unknown commands with a string like this.
  return `Command ${command} not found`;
}

describe("readFileForAdd", () => {
  beforeEach(() => {
    setLargeDocThresholdBytes(THRESHOLD);
    invokeMock.mockReset();
  });

  afterEach(() => {
    setLargeDocThresholdBytes(null);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("returns bytes for a browser File at or below the threshold", async () => {
    const result = await readFileForAdd(pdfFile("small.pdf", THRESHOLD));

    expect(result.kind).toBe("bytes");

    if (result.kind === "bytes") {
      expect(result.file.name).toBe("small.pdf");
      expect(result.file.path).toBeNull();
      expect(result.file.bytes.byteLength).toBe(THRESHOLD);
    }
  });

  it("gates an above-threshold browser File without reading it", async () => {
    const file = pdfFile("huge.pdf", THRESHOLD + 1);
    const arrayBufferSpy = vi.spyOn(file, "arrayBuffer");

    const result = await readFileForAdd(file);

    expect(result).toEqual({ kind: "tooLarge", name: "huge.pdf", sizeBytes: THRESHOLD + 1 });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads a below-threshold Tauri pick with one whole-file read_pdf_range call", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "read_pdf_range") {
        return new Uint8Array(32).fill(1).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const result = await readFileForAdd({ grant: "grant-1", name: "picked.pdf", sizeBytes: 32 });

    expect(result.kind).toBe("bytes");

    if (result.kind === "bytes") {
      expect(result.file.name).toBe("picked.pdf");
      expect(result.file.path).toBe("grant-1");
      expect(result.file.bytes.byteLength).toBe(32);
    }

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("read_pdf_range", {
      grant: "grant-1",
      offset: 0,
      length: 32,
    });
  });

  it("returns a descriptor with page count for an above-threshold Tauri pick", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "path_op_page_count") {
        return { pageCount: 12 };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const result = await readFileForAdd({ grant: "grant-2", name: "big.pdf", sizeBytes: THRESHOLD + 100 });

    expect(result).toEqual({
      kind: "descriptor",
      descriptor: { grant: "grant-2", name: "big.pdf", sizeBytes: THRESHOLD + 100, pageCount: 12 },
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith("read_pdf_range", expect.anything());
  });

  it("defers the page count (null) when path_op_page_count is unavailable", async () => {
    invokeMock.mockRejectedValue(missingCommandError("path_op_page_count"));

    const result = await readFileForAdd({ grant: "grant-3", name: "big.pdf", sizeBytes: THRESHOLD + 1 });

    expect(result).toEqual({
      kind: "descriptor",
      descriptor: { grant: "grant-3", name: "big.pdf", sizeBytes: THRESHOLD + 1, pageCount: null },
    });
  });
});

describe("pickPdfsForAdd", () => {
  beforeEach(() => {
    setLargeDocThresholdBytes(THRESHOLD);
    invokeMock.mockReset();
  });

  afterEach(() => {
    setLargeDocThresholdBytes(null);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("returns null in the browser runtime so callers use their DOM input", async () => {
    await expect(pickPdfsForAdd()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns null when the Tauri shell predates pick_pdfs_for_add", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(missingCommandError("pick_pdfs_for_add"));

    await expect(pickPdfsForAdd()).resolves.toBeNull();
  });

  it("returns picked descriptors and adopts the shell threshold", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const picks = [{ grant: "g", name: "a.pdf", sizeBytes: 10 }];
    invokeMock.mockResolvedValue({ files: picks, thresholdBytes: 1024 });

    await expect(pickPdfsForAdd()).resolves.toEqual(picks);
    expect(invokeMock).toHaveBeenCalledWith("pick_pdfs_for_add");
    expect(getLargeDocThresholdBytes()).toBe(1024);
    setLargeDocThresholdBytes(null);
  });

  it("treats a null pick result as a cancel (empty array)", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(null);

    await expect(pickPdfsForAdd()).resolves.toEqual([]);
  });
});

describe("pickFileForAdd (Tauri, pick_pdfs_for_add available)", () => {
  beforeEach(() => {
    setLargeDocThresholdBytes(THRESHOLD);
    invokeMock.mockReset();
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    setLargeDocThresholdBytes(null);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("picks then reads a below-threshold file in one ranged call", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        return {
          files: [{ grant: "g-small", name: "small.pdf", sizeBytes: 16 }],
          thresholdBytes: THRESHOLD,
        };
      }
      if (command === "read_pdf_range") {
        return new Uint8Array(16).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const result = await pickFileForAdd();

    expect(result?.kind).toBe("bytes");
    expect(invokeMock).toHaveBeenCalledWith("read_pdf_range", {
      grant: "g-small",
      offset: 0,
      length: 16,
    });
  });

  it("returns null when the user cancels the pick", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        // Shell returns null when the dialog is cancelled.
        return null;
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(pickFileForAdd()).resolves.toBeNull();
  });

  it("returns a descriptor for an above-threshold pick", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        return {
          files: [{ grant: "g-big", name: "big.pdf", sizeBytes: THRESHOLD * 10 }],
          thresholdBytes: THRESHOLD,
        };
      }
      if (command === "path_op_page_count") {
        return { pageCount: 250 };
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(pickFileForAdd()).resolves.toEqual({
      kind: "descriptor",
      descriptor: { grant: "g-big", name: "big.pdf", sizeBytes: THRESHOLD * 10, pageCount: 250 },
    });
  });
});

describe("tooLargeToAddMessage", () => {
  it("names the file in the gate copy", () => {
    expect(tooLargeToAddMessage("big.pdf")).toBe('"big.pdf" is too large to add here.');
  });
});
