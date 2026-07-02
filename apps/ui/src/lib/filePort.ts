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

const PDF_FILTER = {
  name: "PDF",
  extensions: ["pdf"],
};

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
      const [{ open }, { readFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [PDF_FILTER],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;

      if (typeof path !== "string") {
        return null;
      }

      return {
        bytes: await readFile(path),
        name: basename(path),
        path,
      };
    },
    async saveFile(bytes, suggestedName, currentPath) {
      const [{ save }, { writeFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const path =
        currentPath ??
        (await save({
          defaultPath: ensurePdfExtension(suggestedName),
          filters: [PDF_FILTER],
        }));

      if (typeof path !== "string") {
        return null;
      }

      await writeFile(path, bytes);

      return {
        name: basename(path),
        path,
      };
    },
  };
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

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Untitled.pdf";
}

function ensurePdfExtension(fileName: string): string {
  if (/\.pdf$/i.test(fileName)) {
    return fileName;
  }

  return `${fileName}.pdf`;
}
