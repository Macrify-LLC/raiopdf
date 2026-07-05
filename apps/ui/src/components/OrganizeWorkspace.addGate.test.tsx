// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentState } from "../hooks/useDocument";
import { setLargeDocThresholdBytes } from "../lib/largeDocThreshold";
import { OrganizeWorkspace } from "./OrganizeWorkspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue("Command pick_pdfs_for_add not found"),
}));

const THRESHOLD = 64;

const documentState = {
  bytes: new Uint8Array([1, 2, 3]),
  source: { kind: "memory", bytes: new Uint8Array([1, 2, 3]) },
  generation: 1,
  engineHandle: null,
  pageCount: 2,
  currentPage: 1,
  zoom: 1,
  dirty: false,
  fitWidth: false,
  fileName: "current.pdf",
  filePath: null,
  fileSizeBytes: 3,
  hasTextLayer: null,
  textLayerCoverage: null,
  pageSizeInches: null,
  outline: null,
  outlineStatus: null,
  signatureInvalidationNotice: null,
  error: null,
} satisfies DocumentState;

function pdfFile(name: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], name, { type: "application/pdf" });
}

function fileList(files: readonly File[]): FileList {
  return {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    ...Object.fromEntries(files.map((file, index) => [index, file])),
  } as unknown as FileList;
}

describe("OrganizeWorkspace pages-tab insert gate", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const onInsert = vi.fn(async () => true);

  beforeEach(() => {
    setLargeDocThresholdBytes(THRESHOLD);
    onInsert.mockClear();
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <OrganizeWorkspace
          flow="pages"
          document={documentState}
          onCancel={() => undefined}
          onMerge={async () => true}
          onExtract={async () => true}
          onSplit={async () => null}
          onInsert={onInsert}
          onCropResize={async () => true}
        />,
      );
    });
  });

  afterEach(() => {
    setLargeDocThresholdBytes(null);
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  async function insertViaInput(file: File) {
    const input = window.document.querySelector<HTMLInputElement>(
      'input[aria-label="Insert PDF in Organize Pages"]',
    );
    expect(input).not.toBeNull();

    Object.defineProperty(input, "files", {
      value: fileList([file]),
      configurable: true,
    });

    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("gates an above-threshold insert with the too-large message and never inserts", async () => {
    await insertViaInput(pdfFile("huge.pdf", THRESHOLD + 1));

    expect(onInsert).not.toHaveBeenCalled();
    expect(container?.textContent).toContain('"huge.pdf" is too large to add here.');
  });

  it("inserts a below-threshold file through readFileForAdd", async () => {
    await insertViaInput(pdfFile("small.pdf", 16));

    expect(onInsert).toHaveBeenCalledTimes(1);
    const [openedFile, insertAt] = onInsert.mock.calls[0] as unknown as [
      { name: string; bytes: Uint8Array; path: string | null },
      number,
    ];
    expect(openedFile.name).toBe("small.pdf");
    expect(openedFile.bytes.byteLength).toBe(16);
    expect(insertAt).toBe(0);
    expect(container?.textContent).toContain("Inserted pages opened as the working document.");
  });
});
