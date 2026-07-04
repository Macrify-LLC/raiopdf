/**
 * File access boundary between the UI and its runtime (Tauri shell or plain
 * browser).
 *
 * Grant vs path discipline [R1-9]: UI-side file identifiers in the Tauri
 * runtime are ALWAYS opaque grants — resolution to real paths happens only in
 * the shell (or via `resolve_file_grants` for the MCP flows that legitimately
 * need paths). The branded `FileGrant` type makes passing a grant where a
 * path is expected (or vice versa) a type error in new code.
 */

/** Opaque shell-issued file grant. Never a real filesystem path. */
export type FileGrant = string & { readonly __brand: "FileGrant" };

export interface OpenedFile {
  bytes: Uint8Array;
  name: string;
  path: string | null;
}

/**
 * Source-shaped open result [R1-1]: small files keep today's byte path
 * unchanged; files at or above the large-doc threshold come back as a
 * range-readable source (a shell grant in Tauri, the `File` itself in the
 * browser) and are NEVER materialized in memory here.
 */
export type OpenedFileSource =
  | ({ kind: "memory" } & OpenedFile)
  | { kind: "rangeGrant"; grant: FileGrant; name: string; sizeBytes: number }
  | { kind: "rangeFile"; file: File; name: string; sizeBytes: number };

export interface SavedFile {
  name: string;
  path: string | null;
}

/** Descriptor from the multi-select add picker — no bytes were read. */
export interface PickedPdfForAdd {
  grant: FileGrant;
  name: string;
  sizeBytes: number;
}

export interface PickedPdfsForAdd {
  files: readonly PickedPdfForAdd[];
  thresholdBytes: number;
}

export interface FilePort {
  openFile: () => Promise<OpenedFileSource | null>;
  saveFile: (
    bytes: Uint8Array,
    suggestedName: string,
    currentPath: string | null,
  ) => Promise<SavedFile | null>;
}

const HEADER_FILE_GRANT = "x-raio-file-grant";
const HEADER_SUGGESTED_NAME = "x-raio-suggested-name";

/**
 * The UI-side threshold lives in `largeDocThreshold.ts` (single source of
 * truth); re-exported here for existing consumers. The shell owns the real
 * value (env-overridable) and echoes it with every open/pick result — the
 * Tauri flows below feed that echo into `setLargeDocThresholdBytes` so UI
 * and shell can never drift.
 */
export { DEFAULT_LARGE_DOC_THRESHOLD_BYTES } from "./largeDocThreshold";
import {
  getLargeDocThresholdBytes,
  setLargeDocThresholdBytes,
} from "./largeDocThreshold";

export type FileRangeErrorCode =
  | "FILE_CHANGED"
  | "OUT_OF_BOUNDS"
  | "RANGE_TOO_LARGE"
  | "GRANT_NOT_FOUND"
  | "IO";

/** Typed rejection from `readPdfRange`, mirroring the shell's error shape. */
export class FileRangeError extends Error {
  constructor(
    readonly code: FileRangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FileRangeError";
  }
}

export function isFileChangedError(error: unknown): boolean {
  return error instanceof FileRangeError && error.code === "FILE_CHANGED";
}

export const filePort: FilePort = isTauriRuntime()
  ? createTauriFilePort()
  : createBrowserFilePort();

/**
 * Reads a DOM `File` fully into memory with NO size gate.
 *
 * Closed-form rule [R7-2]/[R5-1] (large-PDF-handling plan): outside this
 * module's own main-document open path, `readBrowserFile` may only be called
 * from `readFileForAdd` (`./readFileForAdd.ts`), which size-checks BEFORE
 * reading. Do not import it anywhere else -- route every non-main-document
 * file add through `readFileForAdd` instead.
 */
export async function readBrowserFile(file: File): Promise<OpenedFile> {
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    name: file.name,
    path: null,
  };
}

/**
 * Size-branching wrapper for browser `File` inputs (drop target, browser
 * open dialog) [R2-4]: above the threshold the `File` becomes a `rangeFile`
 * source and is never `arrayBuffer()`ed.
 */
export async function readBrowserFileSource(
  file: File,
  thresholdBytes: number = getLargeDocThresholdBytes(),
): Promise<OpenedFileSource> {
  if (file.size >= thresholdBytes) {
    return {
      kind: "rangeFile",
      file,
      name: file.name,
      sizeBytes: file.size,
    };
  }

  return { kind: "memory", ...(await readBrowserFile(file)) };
}

/**
 * Ranged read against a shell grant. End-exclusive bounds, capped per call
 * shell-side at max(4 MB, threshold); rejects with a typed `FileRangeError`
 * (`FILE_CHANGED` when the file drifted from its open-time snapshot).
 */
export async function readPdfRange(
  grant: FileGrant,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");

  try {
    const bytes = await invoke<BinaryInvokeResponse>("read_pdf_range", {
      grant,
      offset,
      length,
    });
    return toUint8Array(bytes);
  } catch (error) {
    throw toFileRangeError(error);
  }
}

/**
 * Multi-select picker for add-file flows [R5-1][R7-2] — descriptors only, no
 * eager byte read. `filePort.openFile()` stays reserved for opening the MAIN
 * document; every other Tauri file-add goes through this picker. Tauri-only:
 * browser-runtime add flows keep their DOM `<input type=file>` elements.
 */
export async function pickPdfsForAdd(): Promise<PickedPdfsForAdd | null> {
  if (!isTauriRuntime()) {
    throw new Error("pickPdfsForAdd is desktop-only; browser add flows use DOM file inputs.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PickedPdfsForAdd | null>("pick_pdfs_for_add");
}

/**
 * Fetch a picked file for an add flow [R6-2]: below the threshold the whole
 * file arrives via ONE ranged read (`read_pdf_range(grant, 0, sizeBytes)`) —
 * no bytes token in this flow, one consistent contract for all sizes. Above
 * the threshold the caller keeps the descriptor for the path-op pipeline.
 */
export async function readFileForAdd(
  picked: PickedPdfForAdd,
  thresholdBytes: number,
): Promise<OpenedFileSource> {
  if (picked.sizeBytes >= thresholdBytes) {
    return {
      kind: "rangeGrant",
      grant: picked.grant,
      name: picked.name,
      sizeBytes: picked.sizeBytes,
    };
  }

  return {
    kind: "memory",
    bytes: await readPdfRange(picked.grant, 0, picked.sizeBytes),
    name: picked.name,
    path: picked.grant,
  };
}

/**
 * Save As for a streamed document: shell-side copy by grant (no bytes through
 * JS) in Tauri; in the browser the `File` is handed straight to a download
 * anchor — also no read into the JS heap.
 */
export async function saveStreamedCopy(
  source:
    | { kind: "rangeGrant"; grant: FileGrant }
    | { kind: "rangeFile"; file: File },
  suggestedName: string,
): Promise<SavedFile | null> {
  if (source.kind === "rangeGrant") {
    const { invoke } = await import("@tauri-apps/api/core");
    const saved = await invoke<TauriSavedPdf | null>("save_pdf_copy_dialog", {
      sourceGrant: source.grant,
      suggestedName,
    });
    return saved ? savedFromTauri(saved) : null;
  }

  const url = URL.createObjectURL(source.file);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  URL.revokeObjectURL(url);
  return { name: suggestedName, path: null };
}

function createBrowserFilePort(): FilePort {
  return {
    async openFile() {
      const file = await pickBrowserFile();

      if (!file) {
        return null;
      }

      return readBrowserFileSource(file);
    },
    async saveFile(bytes, suggestedName) {
      downloadBytes(bytes, suggestedName);
      return {
        name: suggestedName,
        path: null,
      };
    },
  };
}

function createTauriFilePort(): FilePort {
  return {
    async openFile() {
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await invoke<TauriOpenedPdf | null>("open_pdf_dialog");

      if (!selected) {
        return null;
      }

      // Adopt the shell's authoritative threshold for all UI-side branches.
      setLargeDocThresholdBytes(selected.thresholdBytes);

      // No bytes token means the shell stat'ed the file at or above the
      // large-doc threshold and skipped `fs::read` entirely — the document
      // streams by ranged reads against the grant.
      if (selected.bytesToken === null) {
        return {
          kind: "rangeGrant",
          grant: selected.fileGrant as FileGrant,
          name: selected.name,
          sizeBytes: selected.sizeBytes,
        };
      }

      const bytes = await invoke<BinaryInvokeResponse>(
        "read_opened_pdf_bytes",
        {
          token: selected.bytesToken,
        },
      );

      return {
        kind: "memory",
        bytes: toUint8Array(bytes),
        name: selected.name,
        path: selected.fileGrant,
      };
    },
    async saveFile(bytes, suggestedName, currentPath) {
      const { invoke } = await import("@tauri-apps/api/core");

      if (currentPath) {
        const saved = await invoke<TauriSavedPdf>("save_pdf_to_path", bytes, {
          headers: {
            [HEADER_FILE_GRANT]: encodeURIComponent(currentPath),
          },
        });
        return savedFromTauri(saved);
      }

      const saved = await invoke<TauriSavedPdf | null>("save_pdf_dialog", bytes, {
        headers: {
          [HEADER_SUGGESTED_NAME]: encodeURIComponent(suggestedName),
        },
      });
      return saved ? savedFromTauri(saved) : null;
    },
  };
}

interface TauriOpenedPdf {
  bytesToken: string | null;
  fileGrant: string;
  name: string;
  sizeBytes: number;
  thresholdBytes: number;
}

interface TauriSavedPdf {
  fileGrant: string;
  name: string;
}

export type BinaryInvokeResponse = ArrayBuffer | Uint8Array | number[];

function savedFromTauri(saved: TauriSavedPdf): SavedFile {
  return {
    name: saved.name,
    path: saved.fileGrant,
  };
}

export function toUint8Array(bytes: BinaryInvokeResponse): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }

  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }

  return new Uint8Array(bytes);
}

function toFileRangeError(error: unknown): FileRangeError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const { code, message } = error as { code: string; message?: unknown };
    const knownCodes: readonly FileRangeErrorCode[] = [
      "FILE_CHANGED",
      "OUT_OF_BOUNDS",
      "RANGE_TOO_LARGE",
      "GRANT_NOT_FOUND",
      "IO",
    ];
    return new FileRangeError(
      knownCodes.includes(code as FileRangeErrorCode) ? (code as FileRangeErrorCode) : "IO",
      typeof message === "string" ? message : "The PDF range could not be read.",
    );
  }

  return new FileRangeError(
    "IO",
    error instanceof Error ? error.message : "The PDF range could not be read.",
  );
}

export function isTauriRuntime(): boolean {
  // `typeof window` guard keeps this module importable from node-environment
  // unit tests that pull in UI modules without a DOM.
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function pickBrowserFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf";
    input.addEventListener(
      "change",
      () => {
        resolve(input.files?.[0] ?? null);
      },
      { once: true },
    );
    input.click();
  });
}

function downloadBytes(bytes: Uint8Array, fileName: string) {
  const blobBytes = new Uint8Array(bytes);
  const blob = new Blob([blobBytes.buffer], {
    type: "application/pdf",
  });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
