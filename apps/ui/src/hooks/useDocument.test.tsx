// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfApplyEditsOptions, PdfDocumentHandle, PdfEdit } from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { useDocument } from "./useDocument";

type UseDocumentValue = ReturnType<typeof useDocument>;

// Behavior for the NEXT open() call, consumed in call order. Lets a test
// script "the first open fails with ENCRYPTED_DOCUMENT, the second (the
// decrypted retry) succeeds."
const engineState = vi.hoisted(() => ({
  openBehaviors: [] as Array<"succeed" | "encrypted" | "invalid">,
  openCalls: [] as Uint8Array[],
  applyOptions: [] as PdfApplyEditsOptions[],
  flattenedMarkupHandles: [] as PdfDocumentHandle[],
}));

vi.mock("@raiopdf/engine-local", () => {
  class LocalPdfEngine {
    async open(bytes: Uint8Array) {
      engineState.openCalls.push(bytes);
      const behavior = engineState.openBehaviors.shift() ?? "succeed";

      if (behavior === "encrypted") {
        throw new PdfEngineError("ENCRYPTED_DOCUMENT", "Encrypted PDFs are not supported.");
      }

      if (behavior === "invalid") {
        throw new PdfEngineError("INVALID_DOCUMENT", "PDF bytes could not be read.");
      }

      return `handle-${engineState.openCalls.length}` as PdfDocumentHandle;
    }

    async pageCount() {
      return 3;
    }

    async saveToBytes(handle: PdfDocumentHandle) {
      return new Uint8Array([String(handle).length]);
    }

    async close() {
      return undefined;
    }

    async applyEdits(
      _document: PdfDocumentHandle,
      _edits: readonly PdfEdit[],
      options: PdfApplyEditsOptions = {},
    ) {
      engineState.applyOptions.push(options);

      return "edited-handle" as PdfDocumentHandle;
    }

    async flattenForm(document: PdfDocumentHandle) {
      return `${document}-flattened-form` as PdfDocumentHandle;
    }

    async flattenMarkupAnnotations(document: PdfDocumentHandle) {
      engineState.flattenedMarkupHandles.push(document);

      return "flattened-markup-handle" as PdfDocumentHandle;
    }
  }

  return { LocalPdfEngine };
});

describe("useDocument openFile", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latest: UseDocumentValue | null = null;

  beforeEach(() => {
    engineState.openBehaviors.length = 0;
    engineState.openCalls.length = 0;
    engineState.applyOptions.length = 0;
    engineState.flattenedMarkupHandles.length = 0;
    latest = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("returns opened and populates the document on success", async () => {
    mount();
    let result: Awaited<ReturnType<UseDocumentValue["openFile"]>> | undefined;

    await act(async () => {
      result = await getHook().openFile({ bytes: new Uint8Array([1, 2, 3]), name: "brief.pdf" });
    });

    expect(result).toEqual({ status: "opened" });
    expect(getHook().document.fileName).toBe("brief.pdf");
    expect(getHook().document.dirty).toBe(false);
    expect(getHook().document.pageCount).toBe(3);
    expect(getHook().document.error).toBeNull();
  });

  it("returns password-required (and leaves the document clean) for an encrypted PDF", async () => {
    engineState.openBehaviors.push("encrypted");
    mount();
    const sourceBytes = new Uint8Array([9, 9, 9]);
    let result: Awaited<ReturnType<UseDocumentValue["openFile"]>> | undefined;

    await act(async () => {
      result = await getHook().openFile({ bytes: sourceBytes, name: "sealed-order.pdf" });
    });

    expect(result).toEqual({
      status: "password-required",
      bytes: sourceBytes,
      fileName: "sealed-order.pdf",
      filePath: null,
    });
    // The document itself stays in a clean, empty state -- no error banner,
    // no bytes -- while the caller shows a password prompt built from the
    // result above, not from `document`.
    expect(getHook().document.bytes).toBeNull();
    expect(getHook().document.error).toBeNull();
    expect(getHook().document.fileName).toBeNull();
  });

  it("returns failed with a message for a genuinely bad PDF, and sets document.error", async () => {
    engineState.openBehaviors.push("invalid");
    mount();
    let result: Awaited<ReturnType<UseDocumentValue["openFile"]>> | undefined;

    await act(async () => {
      result = await getHook().openFile({ bytes: new Uint8Array([0]), name: "corrupt.pdf" });
    });

    expect(result?.status).toBe("failed");
    expect(getHook().document.error).toContain("could not be opened");
  });

  it("opens decrypted bytes dirty and under the original file name via markDirty", async () => {
    mount();
    let result: Awaited<ReturnType<UseDocumentValue["openFile"]>> | undefined;

    await act(async () => {
      result = await getHook().openFile(
        { bytes: new Uint8Array([4, 5, 6]), name: "sealed-order.pdf", path: null },
        { markDirty: true },
      );
    });

    expect(result).toEqual({ status: "opened" });
    expect(getHook().document.dirty).toBe(true);
    expect(getHook().document.fileName).toBe("sealed-order.pdf");
    expect(getHook().document.filePath).toBeNull();
  });

  it("passes annotation print settings when applying edits", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({
        bytes: new Uint8Array([4]),
        name: "markups.pdf",
      });
    });

    await act(async () => {
      await getHook().applyEdits([
        {
          type: "highlight",
          pageIndex: 0,
          rects: [{ x: 10, y: 10, w: 100, h: 12 }],
        },
      ], {
        flatten: false,
        printMarkupAnnotations: false,
      });
    });

    expect(engineState.applyOptions).toEqual([
      {
        markupMode: "annotation",
        printMarkupAnnotations: false,
      },
    ]);
  });

  it("flattens RaioPDF markup annotations on the current document", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({
        bytes: new Uint8Array([5]),
        name: "markups.pdf",
      });
    });

    let flattened = false;
    await act(async () => {
      flattened = await getHook().flattenMarkupAnnotations();
    });

    expect(flattened).toBe(true);
    expect(engineState.flattenedMarkupHandles).toEqual(["handle-1"]);
    expect(getHook().document.dirty).toBe(true);
  });

  function mount(): void {
    render(<Harness onReady={(value) => { latest = value; }} />);
  }

  function getHook(): UseDocumentValue {
    if (!latest) {
      throw new Error("useDocument was not rendered.");
    }

    return latest;
  }

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
  }
});

function Harness({ onReady }: { onReady: (hook: UseDocumentValue) => void }) {
  const hook = useDocument();

  useEffect(() => {
    onReady(hook);
  });

  return null;
}
