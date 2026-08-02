// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addFolderFilesForAdd,
  buildDocxMarkupGate,
  confirmFolderAdd,
  folderAddNotes,
  docxConversionProgressMessage,
  fileAddBatchMessage,
  mergeConvertedDocxPicks,
  pickFileForAdd,
  pickFilesForAdd,
  pickPdfsForAdd,
  readFileForAdd,
  summarizeFileAddResults,
  tooLargeToAddMessage,
  wordDocxAddErrorMessage,
  type FileAddResult,
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

  it("returns the shared macOS Automation guidance for a batch conversion error", () => {
    expect(wordDocxAddErrorMessage([{
      grant: "docx-1",
      name: "motion.docx",
      code: "WORD_AUTOMATION_DENIED",
      message: "Application isn't allowed to send Apple events to Microsoft Word. (-1743)",
    }])).toContain("Retrying before you allow it will not show the macOS permission prompt again");
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

describe("pickFilesForAdd (Tauri, pick_pdfs_for_add available)", () => {
  beforeEach(() => {
    setLargeDocThresholdBytes(THRESHOLD);
    invokeMock.mockReset();
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    setLargeDocThresholdBytes(null);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("reports shell-side skipped picks as error entries without dropping the batch", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        return {
          files: [{ grant: "g-1", name: "a.pdf", sizeBytes: 8 }],
          thresholdBytes: THRESHOLD,
          skipped: [{ name: "vanished.pdf", message: "The PDF could not be read." }],
        };
      }
      if (command === "read_pdf_range") {
        return new Uint8Array(8).fill(1).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const results = await pickFilesForAdd();

    expect(results).toHaveLength(2);
    expect(results?.[0]).toMatchObject({ kind: "bytes", file: { name: "a.pdf" } });
    expect(results?.[1]).toEqual({
      kind: "error",
      name: "vanished.pdf",
      message: "The PDF could not be read.",
    });
  });

  it("reads every picked file, in picker order (all-success)", async () => {
    invokeMock.mockImplementation(async (command: string, params?: { grant?: string }) => {
      if (command === "pick_pdfs_for_add") {
        return {
          files: [
            { grant: "g-1", name: "a.pdf", sizeBytes: 8 },
            { grant: "g-2", name: "b.pdf", sizeBytes: 8 },
          ],
          thresholdBytes: THRESHOLD,
        };
      }
      if (command === "read_pdf_range") {
        return new Uint8Array(8).fill(params?.grant === "g-1" ? 1 : 2).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const results = await pickFilesForAdd();

    expect(results).toHaveLength(2);
    expect(results?.map((result) => result.kind)).toEqual(["bytes", "bytes"]);
    expect(results?.[0]).toMatchObject({ kind: "bytes", file: { name: "a.pdf", path: "g-1" } });
    expect(results?.[1]).toMatchObject({ kind: "bytes", file: { name: "b.pdf", path: "g-2" } });
  });

  it("keeps the successful reads and reports a per-file read failure as an error entry", async () => {
    invokeMock.mockImplementation(async (command: string, params?: { grant?: string }) => {
      if (command === "pick_pdfs_for_add") {
        return {
          files: [
            { grant: "g-ok", name: "ok.pdf", sizeBytes: 8 },
            { grant: "g-bad", name: "bad.pdf", sizeBytes: 8 },
          ],
          thresholdBytes: THRESHOLD,
        };
      }
      if (command === "read_pdf_range") {
        if (params?.grant === "g-bad") {
          // Mirrors the shell's typed FileRangeError shape (e.g. the file
          // changed on disk between the pick and the read).
          throw { code: "FILE_CHANGED", message: "The file changed on disk." };
        }
        return new Uint8Array(8).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const results = await pickFilesForAdd();

    expect(results).toHaveLength(2);
    expect(results?.[0]).toMatchObject({ kind: "bytes", file: { name: "ok.pdf" } });
    expect(results?.[1]).toEqual({
      kind: "error",
      name: "bad.pdf",
      message: "The file changed on disk.",
    });
  });

  it("returns [] when the dialog is cancelled — matches pickPdfsForAdd's own convention", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        // Shell returns null when the dialog is cancelled.
        return null;
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(pickFilesForAdd()).resolves.toEqual([]);
  });

  it("returns null when the shell predates pick_pdfs_for_add", async () => {
    invokeMock.mockRejectedValue(missingCommandError("pick_pdfs_for_add"));

    await expect(pickFilesForAdd()).resolves.toBeNull();
  });

  it("pickFileForAdd still returns only the first pick (thin wrapper over pickFilesForAdd)", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pick_pdfs_for_add") {
        return {
          files: [
            { grant: "g-1", name: "a.pdf", sizeBytes: 8 },
            { grant: "g-2", name: "b.pdf", sizeBytes: 8 },
          ],
          thresholdBytes: THRESHOLD,
        };
      }
      if (command === "read_pdf_range") {
        return new Uint8Array(8).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const result = await pickFileForAdd();

    expect(result).toMatchObject({ kind: "bytes", file: { name: "a.pdf" } });
  });
});

describe("summarizeFileAddResults / fileAddBatchMessage", () => {
  it("counts bytes and descriptor results as added, with no failures", () => {
    const results: FileAddResult[] = [
      { kind: "bytes", file: { bytes: new Uint8Array(1), name: "a.pdf", path: null } },
      { kind: "descriptor", descriptor: { grant: "g", name: "b.pdf", sizeBytes: 1, pageCount: 3 } },
    ];

    const summary = summarizeFileAddResults(results);

    expect(summary).toEqual({ addedCount: 2, totalCount: 2, failures: [] });
    expect(fileAddBatchMessage(summary)).toBeNull();
  });

  it("reports tooLarge and error results as failures without dropping the successes", () => {
    const results: FileAddResult[] = [
      { kind: "bytes", file: { bytes: new Uint8Array(1), name: "ok.pdf", path: null } },
      { kind: "tooLarge", name: "huge.pdf", sizeBytes: 999 },
      { kind: "error", name: "broken.pdf", message: "Could not be read." },
    ];

    const summary = summarizeFileAddResults(results);

    expect(summary).toEqual({
      addedCount: 1,
      totalCount: 3,
      failures: [
        { name: "huge.pdf", reason: "too large to add here" },
        { name: "broken.pdf", reason: "Could not be read." },
      ],
    });
    expect(fileAddBatchMessage(summary)).toBe(
      "1 of 3 added; 2 failed: huge.pdf (too large to add here), broken.pdf (Could not be read.)",
    );
  });

  it("reports every-file-failed with a plural/singular-aware noun and no added count", () => {
    const results: FileAddResult[] = [
      { kind: "tooLarge", name: "huge.pdf", sizeBytes: 999 },
    ];

    const summary = summarizeFileAddResults(results);

    expect(fileAddBatchMessage(summary, "document")).toBe(
      "1 document could not be added: huge.pdf (too large to add here)",
    );

    const twoFailures = summarizeFileAddResults([
      { kind: "tooLarge", name: "huge.pdf", sizeBytes: 999 },
      { kind: "error", name: "broken.pdf", message: "Could not be read." },
    ]);
    expect(fileAddBatchMessage(twoFailures, "document")).toBe(
      "2 documents could not be added: huge.pdf (too large to add here), broken.pdf (Could not be read.)",
    );
  });
});

describe("tooLargeToAddMessage", () => {
  it("names the file in the gate copy", () => {
    expect(tooLargeToAddMessage("big.pdf")).toBe('"big.pdf" is too large to add here.');
  });
});

describe("DOCX add gate helpers", () => {
  it("uses neutral preparation copy instead of claiming it starts Word", () => {
    expect(docxConversionProgressMessage("preparing", 1, 2)).toBe(
      "Preparing 1 of 2 for conversion in Microsoft Word...",
    );
    // Older shells can still emit this phase while the UI and shell are
    // upgraded together. It must remain truthful for a reused Word instance.
    expect(docxConversionProgressMessage("startingWord", 1, 2)).toBe(
      "Preparing 1 of 2 for conversion in Microsoft Word...",
    );
    expect(docxConversionProgressMessage("converting", 2, 2)).toBe("Converting 2 of 2...");
  });

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

describe("addFolderFilesForAdd", () => {
  const summary = {
    token: "scan-token",
    folderName: "Discovery",
    totalPdfs: 3,
    topLevelPdfs: 1,
    subfolderPdfs: 2,
    skippedNonPdf: 2,
    skippedHidden: 1,
    skippedLinks: 1,
    permissionFailures: 1,
    permissionFailureExamples: ["locked"],
    truncated: false,
  };

  beforeEach(() => {
    setLargeDocThresholdBytes(THRESHOLD);
    invokeMock.mockReset();
  });

  afterEach(() => {
    setLargeDocThresholdBytes(null);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    document.querySelector(".folder-add-gate")?.remove();
  });

  it("returns null in the browser runtime instead of scanning", async () => {
    await expect(addFolderFilesForAdd()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("issues no grants when the user cancels the folder picker", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const confirmFolderAdd = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "scan_folder_for_add") {
        return null;
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(addFolderFilesForAdd({ confirmFolderAdd })).resolves.toBeNull();
    expect(confirmFolderAdd).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("claim_folder_scan", expect.anything());
  });

  it("issues no grants when the user cancels the confirm dialog", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "scan_folder_for_add") {
        return summary;
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(addFolderFilesForAdd({ confirmFolderAdd: async () => null })).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith("claim_folder_scan", expect.anything());
  });

  it("claims only the confirmed scope and reads every claimed file", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "scan_folder_for_add") {
        return summary;
      }
      if (command === "claim_folder_scan") {
        return {
          thresholdBytes: 1024,
          files: [
            { grant: "g-1", name: "a.pdf", sizeBytes: 10 },
            { grant: "g-2", name: "b.pdf", sizeBytes: 20 },
          ],
          skipped: [{ name: "vanished.pdf", message: "The PDF could not be read." }],
        };
      }
      if (command === "read_pdf_range") {
        return new Uint8Array(10).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const results = await addFolderFilesForAdd({
      confirmFolderAdd: async () => ({ includeSubfolders: false }),
    });

    expect(invokeMock).toHaveBeenCalledWith("claim_folder_scan", {
      token: "scan-token",
      includeSubfolders: false,
    });
    // The shell's threshold echo wins here exactly as it does for the picker.
    expect(getLargeDocThresholdBytes()).toBe(1024);
    expect(results?.map((result) => result.kind)).toEqual(["bytes", "bytes", "error"]);
    expect(summarizeFileAddResults(results ?? [])).toEqual({
      addedCount: 2,
      totalCount: 3,
      failures: [{ name: "vanished.pdf", reason: "The PDF could not be read." }],
    });
  });

  it("keeps the rest of a folder when one file fails to read", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (command: string, args?: { grant?: string }) => {
      if (command === "scan_folder_for_add") {
        return summary;
      }
      if (command === "claim_folder_scan") {
        return {
          thresholdBytes: THRESHOLD,
          files: [
            { grant: "g-1", name: "good.pdf", sizeBytes: 10 },
            { grant: "g-2", name: "broken.pdf", sizeBytes: 10 },
          ],
        };
      }
      if (command === "read_pdf_range") {
        if (args?.grant === "g-2") {
          throw new Error("The PDF range could not be read.");
        }
        return new Uint8Array(10).buffer;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const results = await addFolderFilesForAdd({
      confirmFolderAdd: async () => ({ includeSubfolders: true }),
    });

    expect(results?.[0]?.kind).toBe("bytes");
    expect(results?.[1]).toMatchObject({ kind: "error", name: "broken.pdf" });
  });

  it("states every omission the scan made", () => {
    expect(folderAddNotes(summary)).toEqual([
      "2 files skipped (not a PDF).",
      "1 hidden item skipped.",
      "1 shortcut skipped — RaioPDF does not follow shortcuts out of the folder you chose.",
      "1 item could not be read (locked).",
    ]);
    expect(folderAddNotes({ ...summary, truncated: true })[0]).toContain("more than 3 PDFs");
    expect(folderAddNotes({
      ...summary,
      skippedNonPdf: 0,
      skippedHidden: 0,
      skippedLinks: 0,
      permissionFailures: 0,
    })).toEqual([]);
  });

  it("confirms the whole tree by default and reports the toggled scope", async () => {
    const pending = confirmFolderAdd(summary);
    const gate = document.querySelector(".folder-add-gate");
    expect(gate?.textContent).toContain('Add 3 PDFs from "Discovery"?');

    const subfolders = gate?.querySelector<HTMLInputElement>("[data-action='subfolders']");
    expect(subfolders?.checked).toBe(true);
    const add = gate?.querySelector<HTMLButtonElement>("[data-action='add']");
    expect(add?.textContent).toBe("Add 3 PDFs");

    subfolders!.checked = false;
    subfolders!.dispatchEvent(new Event("change"));
    expect(add?.textContent).toBe("Add 1 PDF");

    add?.click();
    await expect(pending).resolves.toEqual({ includeSubfolders: false });
    expect(document.querySelector(".folder-add-gate")).toBeNull();
  });

  it("offers no way to add an empty folder", async () => {
    const pending = confirmFolderAdd({
      ...summary,
      totalPdfs: 0,
      topLevelPdfs: 0,
      subfolderPdfs: 0,
    });
    const gate = document.querySelector(".folder-add-gate");
    expect(gate?.textContent).toContain('No PDFs in "Discovery"');
    expect(gate?.querySelector<HTMLButtonElement>("[data-action='add']")?.disabled).toBe(true);

    gate?.querySelector<HTMLButtonElement>("[data-action='cancel']")?.click();
    await expect(pending).resolves.toBeNull();
  });
});
