// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfApplyEditsOptions, PdfDocumentHandle, PdfEdit } from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { useDocument } from "./useDocument";

type UseDocumentValue = ReturnType<typeof useDocument>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
type OpenBehavior =
  | "succeed"
  | "encrypted"
  | "invalid"
  | { type: "defer"; deferred: Deferred<PdfDocumentHandle> };

// Behavior for the NEXT open() call, consumed in call order. Lets a test
// script "the first open fails with ENCRYPTED_DOCUMENT, the second (the
// decrypted retry) succeeds."
const engineState = vi.hoisted(() => ({
  openBehaviors: [] as OpenBehavior[],
  openCalls: [] as Uint8Array[],
  closeCalls: [] as PdfDocumentHandle[],
  saveCalls: [] as PdfDocumentHandle[],
  applyOptions: [] as PdfApplyEditsOptions[],
  flattenedMarkupHandles: [] as PdfDocumentHandle[],
  applyEditsDeferred: null as Deferred<PdfDocumentHandle> | null,
  applyEditsStarted: null as Deferred<void> | null,
  // When true, close() takes a macrotask (like the real engine's async
  // work), giving React a chance to flush state between a commit and the
  // mutation queue's finally — the window the tab-store regression needs.
  slowClose: false,
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

      if (typeof behavior === "object" && behavior.type === "defer") {
        return await behavior.deferred.promise;
      }

      return `handle-${engineState.openCalls.length}` as PdfDocumentHandle;
    }

    async pageCount() {
      return 3;
    }

    async saveToBytes(handle: PdfDocumentHandle) {
      engineState.saveCalls.push(handle);
      return new Uint8Array([String(handle).length]);
    }

    async getOutline() {
      return { items: [], openMode: "default" as const, revision: "mock" };
    }

    async close(handle: PdfDocumentHandle) {
      engineState.closeCalls.push(handle);
      if (engineState.slowClose) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return undefined;
    }

    async applyEdits(
      _document: PdfDocumentHandle,
      _edits: readonly PdfEdit[],
      options: PdfApplyEditsOptions = {},
    ) {
      engineState.applyOptions.push(options);
      engineState.applyEditsStarted?.resolve(undefined);

      if (engineState.applyEditsDeferred) {
        return await engineState.applyEditsDeferred.promise;
      }

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
    engineState.closeCalls.length = 0;
    engineState.saveCalls.length = 0;
    engineState.applyOptions.length = 0;
    engineState.flattenedMarkupHandles.length = 0;
    engineState.applyEditsDeferred = null;
    engineState.applyEditsStarted = null;
    engineState.slowClose = false;
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

  it("serializes pending edits into a copy without mutating the open document", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({
        bytes: new Uint8Array([4]),
        name: "draft.pdf",
      });
    });

    const generation = getHook().document.generation;
    const sourceHandle = getHook().document.engineHandle;
    let snapshot: Uint8Array | null = null;

    await act(async () => {
      snapshot = await getHook().serializeAnnotationSavePlan({
        appendEdits: [
          {
            type: "highlight",
            pageIndex: 0,
            rects: [{ x: 10, y: 10, w: 100, h: 12 }],
          },
        ],
        updateEdits: [],
        deleteAnnotIds: [],
      }, {
        flatten: false,
        printMarkupAnnotations: false,
        expectedGeneration: generation,
      });
    });

    expect(snapshot).toEqual(new Uint8Array(["edited-handle".length]));
    expect(engineState.applyOptions).toEqual([{
      markupMode: "annotation",
      printMarkupAnnotations: false,
    }]);
    expect(engineState.saveCalls).toEqual([
      sourceHandle,
      "edited-handle",
    ]);
    expect(engineState.closeCalls).toEqual(expect.arrayContaining([
      "handle-2",
      "edited-handle",
    ]));
    expect(getHook().document.engineHandle).toBe(sourceHandle);
    expect(getHook().document.generation).toBe(generation);
    expect(getHook().document.dirty).toBe(false);
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

  it("saves bytes without swapping the preview source or generation", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({
        bytes: new Uint8Array([7, 8, 9]),
        name: "save-preview.pdf",
      });
    });

    const beforeSource = getHook().document.source;
    const beforeGeneration = getHook().document.generation;
    const saved = await act(async () => await getHook().save());

    expect(saved).not.toBeNull();
    expect(saved!.bytes).toEqual(new Uint8Array([8]));
    expect(getHook().document.bytes).toEqual(new Uint8Array([8]));
    expect(getHook().document.source).toBe(beforeSource);
    expect(getHook().document.generation).toBe(beforeGeneration);
    expect(getHook().document.fileSizeBytes).toBe(1);
  });

  it("keeps preview-loading callbacks stable across page navigation", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({
        bytes: new Uint8Array([1, 2, 3]),
        name: "navigation-preview.pdf",
      });
    });

    const beforeSetError = getHook().setError;
    const beforeSetStreamedPageCount = getHook().setStreamedPageCount;

    act(() => {
      getHook().setCurrentPage(2);
    });

    expect(getHook().document.currentPage).toBe(2);
    expect(getHook().setError).toBe(beforeSetError);
    expect(getHook().setStreamedPageCount).toBe(beforeSetStreamedPageCount);
  });

  it("opens, switches, and closes independent document tabs", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({ bytes: new Uint8Array([1]), name: "one.pdf" });
    });
    const firstTabId = getHook().activeTabId;

    await act(async () => {
      await getHook().openFile(
        { bytes: new Uint8Array([2]), name: "two.pdf" },
        { openMode: "new-tab" },
      );
    });
    const secondTabId = getHook().activeTabId;

    expect(firstTabId).toBeTruthy();
    expect(secondTabId).toBeTruthy();
    expect(secondTabId).not.toBe(firstTabId);
    expect(getHook().tabs.map((tab) => tab.document.fileName)).toEqual([
      "one.pdf",
      "two.pdf",
    ]);
    expect(getHook().document.fileName).toBe("two.pdf");
    expect(engineState.closeCalls).toEqual([]);

    act(() => {
      getHook().switchTab(firstTabId!);
    });

    expect(getHook().document.fileName).toBe("one.pdf");

    await act(async () => {
      await getHook().closeTab(firstTabId!);
    });

    expect(engineState.closeCalls).toEqual(["handle-1"]);
    expect(getHook().document.fileName).toBe("two.pdf");
    expect(getHook().tabs).toHaveLength(1);

    await act(async () => {
      await getHook().closeTab(secondTabId!);
    });

    expect(engineState.closeCalls).toEqual(["handle-1", "handle-2"]);
    expect(getHook().tabs).toHaveLength(0);
    expect(getHook().document.source).toBeNull();
  });

  it("allocates a fresh open token for a pending new tab so stale old-tab work is discarded", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({ bytes: new Uint8Array([1]), name: "one.pdf" });
    });
    const firstOpenToken = getHook().getOpenToken();
    const deferredOpen = createDeferred<PdfDocumentHandle>();
    engineState.openBehaviors.push({ type: "defer", deferred: deferredOpen });

    let secondOpen: Promise<Awaited<ReturnType<UseDocumentValue["openFile"]>>> | null = null;
    await act(async () => {
      secondOpen = getHook().openFile(
        { bytes: new Uint8Array([2]), name: "two.pdf" },
        { openMode: "new-tab" },
      );
      await Promise.resolve();
    });

    expect(getHook().getOpenToken()).toBeGreaterThan(firstOpenToken);
    let staleResult: Awaited<ReturnType<UseDocumentValue["replaceBytes"]>> | undefined;
    await act(async () => {
      staleResult = await getHook().replaceBytes(new Uint8Array([9]), {
        dirty: true,
        expectedOpenToken: firstOpenToken,
        fileName: "stale.pdf",
      });
    });
    expect(staleResult).toBe("failed");
    expect(getHook().document.fileName).toBe("one.pdf");

    await act(async () => {
      deferredOpen.resolve("handle-2" as PdfDocumentHandle);
      await secondOpen;
    });

    expect(getHook().document.fileName).toBe("two.pdf");
    expect(getHook().tabs.map((tab) => tab.document.fileName)).toEqual([
      "one.pdf",
      "two.pdf",
    ]);
  });

  it("keeps the tab store generation in sync after a queued mutation commits", async () => {
    // Regression (audit #3): the mutation queue used to write the
    // render-time document captured at enqueue time back into the tab store
    // in its `finally`, regressing the stored generation to N after the
    // commit had already moved it to N+1 — so generation guards read a
    // stale value ("document changed" rejections, or worse, a real lost
    // update when a slow byte op passed its guard against the regressed
    // value).
    mount();

    await act(async () => {
      await getHook().openFile({ bytes: new Uint8Array([1]), name: "one.pdf" });
    });

    // The real engine's close spans a macrotask, so React flushes the
    // commit before the queue's finally runs — the exact window in which
    // the old code stomped the tab store with the pre-mutation document.
    engineState.slowClose = true;
    engineState.applyEditsDeferred = createDeferred<PdfDocumentHandle>();
    engineState.applyEditsStarted = createDeferred<void>();
    let mutation: Promise<boolean> | null = null;
    act(() => {
      mutation = getHook().applyEdits([
        {
          type: "highlight",
          pageIndex: 0,
          rects: [{ x: 10, y: 10, w: 100, h: 12 }],
        },
      ], { flatten: false });
    });
    await engineState.applyEditsStarted.promise;

    // Resolve OUTSIDE act(): the regression needs React's real scheduler to
    // flush the commit (macrotask) before the queue's finally runs — inside
    // act() all updates coalesce into one batch and the stale write is
    // masked by application order.
    engineState.applyEditsDeferred!.resolve("edited-handle" as PdfDocumentHandle);
    await mutation!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await act(async () => {});

    const committedGeneration = getHook().document.generation;
    // The tab store must reflect the committed generation, not the
    // pre-mutation snapshot captured at enqueue time.
    expect(getHook().getGeneration()).toBe(committedGeneration);

    // And a follow-up guarded byte replacement against the committed
    // generation must not be spuriously rejected as stale.
    let replaced: Awaited<ReturnType<UseDocumentValue["replaceBytes"]>> | undefined;
    await act(async () => {
      replaced = await getHook().replaceBytes(new Uint8Array([9]), {
        dirty: true,
        expectedGeneration: committedGeneration,
        fileName: "replaced.pdf",
      });
    });
    expect(replaced).toBe("replaced");
  });

  it("blocks opening a new tab while the current document has a mutation in flight", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({ bytes: new Uint8Array([1]), name: "one.pdf" });
    });

    engineState.applyEditsDeferred = createDeferred<PdfDocumentHandle>();
    engineState.applyEditsStarted = createDeferred<void>();
    let mutation: Promise<boolean> | null = null;
    act(() => {
      mutation = getHook().applyEdits([
        {
          type: "highlight",
          pageIndex: 0,
          rects: [{ x: 10, y: 10, w: 100, h: 12 }],
        },
      ], { flatten: false });
    });
    await engineState.applyEditsStarted.promise;

    let openResult: Awaited<ReturnType<UseDocumentValue["openFile"]>> | undefined;
    await act(async () => {
      openResult = await getHook().openFile(
        { bytes: new Uint8Array([2]), name: "two.pdf" },
        { openMode: "new-tab" },
      );
    });

    expect(openResult).toEqual({
      status: "failed",
      error: "Finish the current document operation before opening another document.",
    });
    expect(getHook().document.fileName).toBe("one.pdf");
    expect(getHook().tabs.map((tab) => tab.document.fileName)).toEqual(["one.pdf"]);

    await act(async () => {
      engineState.applyEditsDeferred!.resolve("edited-handle" as PdfDocumentHandle);
      await mutation!;
    });

    expect(getHook().document.fileName).toBe("one.pdf");
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

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
