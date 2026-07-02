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

const HEADER_PATH = "x-raio-path";
const HEADER_SUGGESTED_NAME = "x-raio-suggested-name";

export const filePort: FilePort = isTauriRuntime()
  ? createTauriFilePort()
  : createBrowserFilePort();

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
        path: selected.path,
      };
    },
    async saveFile(bytes, suggestedName, currentPath) {
      const { invoke } = await import("@tauri-apps/api/core");

      if (currentPath) {
        return invoke<SavedFile>("save_pdf_to_path", bytes, {
          headers: {
            [HEADER_PATH]: encodeURIComponent(currentPath),
          },
        });
      }

      return invoke<SavedFile | null>("save_pdf_dialog", bytes, {
        headers: {
          [HEADER_SUGGESTED_NAME]: encodeURIComponent(suggestedName),
        },
      });
    },
  };
}

interface TauriOpenedPdf {
  bytesToken: string;
  name: string;
  path: string;
}

type BinaryInvokeResponse = ArrayBuffer | Uint8Array | number[];

function toUint8Array(bytes: BinaryInvokeResponse): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }

  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }

  return new Uint8Array(bytes);
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function pickBrowserFile(): Promise<File | null> {
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
