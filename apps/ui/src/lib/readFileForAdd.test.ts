// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDocxMarkupGate,
  mergeConvertedDocxPicks,
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

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
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

  it("converts clean DOCX picks without showing the markup gate", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const confirmDocxMarkup = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        return {
          thresholdBytes: THRESHOLD,
          files: [
            { grant: "pdf-1", name: "a.pdf", sizeBytes: 10, source: "pdf" },
            { grant: "docx-1", name: "b.docx", sizeBytes: 20, source: "docx", markupScan: "clean" },
          ],
        };
      }
      if (command === "word_capability") {
        return { state: "available", reason: null };
      }
      if (command === "convert_docx_for_add") {
        return {
          files: [{
            grant: "converted-1",
            name: "b.pdf",
            sizeBytes: 30,
            source: "pdf",
            convertedFromGrant: "docx-1",
          }],
          errors: [],
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(pickPdfsForAdd({ confirmDocxMarkup })).resolves.toEqual([
      { grant: "pdf-1", name: "a.pdf", sizeBytes: 10 },
      { grant: "converted-1", name: "b.pdf", sizeBytes: 30 },
    ]);
    expect(confirmDocxMarkup).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("convert_docx_for_add", {
      files: [{ grant: "docx-1", name: "b.docx" }],
      markup: "final",
    });
  });

  it("runs one batch gate for markup or uninspectable DOCX picks", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const confirmDocxMarkup = vi.fn(async () => "showMarkup" as const);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        return {
          thresholdBytes: THRESHOLD,
          files: [
            { grant: "docx-1", name: "tracked.docx", sizeBytes: 20, source: "docx", markupScan: "hasMarkup" },
            { grant: "docx-2", name: "locked.docx", sizeBytes: 20, source: "docx", markupScan: "uninspectable" },
          ],
        };
      }
      if (command === "word_capability") {
        return { state: "available", reason: null };
      }
      if (command === "convert_docx_for_add") {
        return { files: [], errors: [] };
      }
      throw new Error(`unexpected command ${command}`);
    });

    await pickPdfsForAdd({ confirmDocxMarkup });

    expect(confirmDocxMarkup).toHaveBeenCalledWith({
      markupCount: 1,
      uninspectableCount: 1,
      markupFiles: ["tracked.docx"],
      uninspectableFiles: ["locked.docx"],
    });
    expect(invokeMock).toHaveBeenCalledWith("convert_docx_for_add", {
      files: [
        { grant: "docx-1", name: "tracked.docx" },
        { grant: "docx-2", name: "locked.docx" },
      ],
      markup: "showMarkup",
    });
  });

  it("refuses DOCX conversion when Word is unavailable but keeps picked PDFs", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const onWordUnavailable = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        return {
          thresholdBytes: THRESHOLD,
          files: [
            { grant: "pdf-1", name: "a.pdf", sizeBytes: 10, source: "pdf" },
            { grant: "docx-1", name: "b.docx", sizeBytes: 20, source: "docx", markupScan: "clean" },
          ],
        };
      }
      if (command === "word_capability") {
        return { state: "notApplicable", reason: null };
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(pickPdfsForAdd({ onWordUnavailable })).resolves.toEqual([
      { grant: "pdf-1", name: "a.pdf", sizeBytes: 10 },
    ]);
    expect(onWordUnavailable).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("convert_docx_for_add", expect.anything());
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

  it("treats a picker-less shell as a cancel — no legacy main-document dialog fallback", async () => {
    // The UI and shell ship as one binary, so `pick_pdfs_for_add` always
    // exists in production; the old `filePort.openFile()` fallback is gone.
    invokeMock.mockRejectedValue(missingCommandError("pick_pdfs_for_add"));

    await expect(pickFileForAdd()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("open_pdf_dialog");
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

describe("DOCX add gate helpers", () => {
  it("does not gate clean DOCX batches", () => {
    expect(buildDocxMarkupGate([
      { grant: "g", name: "clean.docx", sizeBytes: 1, source: "docx", markupScan: "clean" },
    ])).toBeNull();
  });

  it("gates both markup and uninspectable classifications", () => {
    expect(buildDocxMarkupGate([
      { grant: "a", name: "tracked.docx", sizeBytes: 1, source: "docx", markupScan: "hasMarkup" },
      { grant: "b", name: "bad.docx", sizeBytes: 1, source: "docx", markupScan: "uninspectable" },
    ])).toEqual({
      markupCount: 1,
      uninspectableCount: 1,
      markupFiles: ["tracked.docx"],
      uninspectableFiles: ["bad.docx"],
    });
  });

  it("preserves original order while dropping failed DOCX conversions", () => {
    expect(mergeConvertedDocxPicks(
      [
        { grant: "pdf", name: "a.pdf", sizeBytes: 1, source: "pdf" },
        { grant: "docx-failed", name: "b.docx", sizeBytes: 2, source: "docx" },
        { grant: "docx-ok", name: "c.docx", sizeBytes: 3, source: "docx" },
      ],
      [
        { grant: "converted", name: "c.pdf", sizeBytes: 4, convertedFromGrant: "docx-ok" },
      ],
    )).toEqual([
      { grant: "pdf", name: "a.pdf", sizeBytes: 1 },
      { grant: "converted", name: "c.pdf", sizeBytes: 4 },
    ]);
  });
});
