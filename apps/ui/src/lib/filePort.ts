export interface OpenedFile {
  bytes: Uint8Array;
  name: string;
  path: string | null;
}

export interface SavedFile {
  name: string;
  path: string | null;
}

export interface FilePort {
  openFile: () => Promise<OpenedFile | null>;
  saveFile: (
    bytes: Uint8Array,
    suggestedName: string,
    currentPath: string | null,
  ) => Promise<SavedFile | null>;
}

const HEADER_FILE_GRANT = "x-raio-file-grant";
const HEADER_SUGGESTED_NAME = "x-raio-suggested-name";

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

function createBrowserFilePort(): FilePort {
  return {
    async openFile() {
      const file = await pickBrowserFile();

      if (!file) {
        return null;
      }

      return readBrowserFile(file);
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

      const bytes = await invoke<BinaryInvokeResponse>(
        "read_opened_pdf_bytes",
        {
          token: selected.bytesToken,
        },
      );

      return {
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
  bytesToken: string;
  fileGrant: string;
  name: string;
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
