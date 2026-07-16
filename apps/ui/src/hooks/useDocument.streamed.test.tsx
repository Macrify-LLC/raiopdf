// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import type { FileGrant } from "../lib/filePort";
import { STREAMED_DOCUMENT_GATE_MESSAGE, useDocument } from "./useDocument";

type UseDocumentValue = ReturnType<typeof useDocument>;

const engineState = vi.hoisted(() => ({
  openCalls: [] as Uint8Array[],
}));

vi.mock("@raiopdf/engine-local", () => {
  class LocalPdfEngine {
    async open(bytes: Uint8Array) {
      engineState.openCalls.push(bytes);
      return `handle-${engineState.openCalls.length}` as PdfDocumentHandle;
    }

    async pageCount() {
      return 3;
    }

    async saveToBytes(handle: PdfDocumentHandle) {
      return new Uint8Array([String(handle).length]);
    }

    async getOutline() {
      return { items: [], openMode: "default" as const, revision: "mock" };
    }

    async close() {
      return undefined;
    }

    async rotatePages(handle: PdfDocumentHandle) {
      return `${handle}-rotated` as PdfDocumentHandle;
    }
  }

  return { LocalPdfEngine };
});

describe("useDocument streamed mode", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latest: UseDocumentValue | null = null;

  it("scopes delegated streamed features to the installed app in gate copy", () => {
    expect(STREAMED_DOCUMENT_GATE_MESSAGE).toContain("In the installed app, available");
    expect(STREAMED_DOCUMENT_GATE_MESSAGE).toContain("split, extract");
  });

  beforeEach(() => {
    engineState.openCalls.length = 0;
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

  it("opens a rangeGrant source with no engine handle, no bytes, and pdf-lib never loaded", async () => {
    mount();

    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeGrant", grant: "grant-1" as FileGrant, sizeBytes: 283_000_000 },
        name: "appendix.pdf",
        path: "grant-1",
      });
    });

    const state = getHook().document;
    expect(state.source).toEqual({
      kind: "rangeGrant",
      grant: "grant-1",
      sizeBytes: 283_000_000,
      generation: state.generation,
    });
    expect(state.engineHandle).toBeNull();
    expect(state.bytes).toBeNull();
    expect(state.dirty).toBe(false);
    expect(state.fileName).toBe("appendix.pdf");
    expect(state.filePath).toBe("grant-1");
    expect(state.fileSizeBytes).toBe(283_000_000);
    // hasTextLayer null renders as "not checked" — the eager scan never ran.
    expect(state.hasTextLayer).toBeNull();
    // engine.open (pdf-lib) is skipped ENTIRELY in streamed mode.
    expect(engineState.openCalls).toHaveLength(0);
  });

  it("opens a streamed source dirty when markDirty is set (unsaved OCR working copy)", async () => {
    mount();

    await act(async () => {
      await getHook().openStreamedFile(
        {
          source: { kind: "rangeGrant", grant: "ocr-out" as FileGrant, sizeBytes: 50_000_000 },
          name: "Scan.pdf",
          path: "ocr-out",
        },
        { markDirty: true },
      );
    });

    // Marked dirty so Close prompts to save — the OCR result is backed only by
    // a temp file and would otherwise be discarded silently.
    expect(getHook().document.dirty).toBe(true);
  });

  it("opens a decrypted streamed source as an unsaved copy while retaining its protected original", async () => {
    mount();

    await act(async () => {
      await getHook().openStreamedFile(
        {
          source: { kind: "rangeGrant", grant: "decrypted-temp" as FileGrant, sizeBytes: 50_000_000 },
          name: "Protected.pdf",
          path: "decrypted-temp",
        },
        {
          protectionSource: "user-password",
          protectedSourceGrant: "protected-original" as FileGrant,
        },
      );
    });

    expect(getHook().document.dirty).toBe(true);
    expect(getHook().document.filePath).toBeNull();
    expect(getHook().document.protectionSource).toBe("user-password");
    expect(getHook().document.protectedSourceGrant).toBe("protected-original");
  });

  it("retains inspected owner-restriction facts with the streamed source grant", async () => {
    mount();

    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeGrant", grant: "owner-source" as FileGrant, sizeBytes: 50_000_000 },
        name: "Restricted.pdf",
        path: "owner-source",
      });
    });
    const generation = getHook().document.generation;

    act(() => {
      getHook().setProtectionFacts({
        kind: "owner-restricted",
        encryption: "AES-256",
        permissions: {
          printing: "full",
          copying: "blocked",
          accessibilityExtraction: "allowed",
        },
      }, generation);
    });

    expect(getHook().document.protectionSource).toBe("owner-restricted");
    expect(getHook().document.protectedSourceGrant).toBe("owner-source");
    expect(getHook().document.protectionFacts).toMatchObject({
      kind: "owner-restricted",
      encryption: "AES-256",
    });
  });

  it("commits the pdf.js page count only for the matching generation", async () => {
    mount();

    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeGrant", grant: "grant-1" as FileGrant, sizeBytes: 100 },
        name: "a.pdf",
        path: "grant-1",
      });
    });

    const generation = getHook().document.generation;

    act(() => {
      // A proxy that finished loading for a superseded document must not
      // stamp its count onto the current one.
      getHook().setStreamedPageCount(999, { generation: generation - 1 });
    });
    expect(getHook().document.pageCount).toBe(0);

    act(() => {
      getHook().setStreamedPageCount(2556, { generation });
    });
    expect(getHook().document.pageCount).toBe(2556);
  });

  it("gates every enqueueMutation op with the streamed-document message", async () => {
    mount();

    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeGrant", grant: "grant-1" as FileGrant, sizeBytes: 100 },
        name: "a.pdf",
        path: "grant-1",
      });
    });

    let rotated: boolean | undefined;
    await act(async () => {
      rotated = await getHook().rotatePages([0]);
    });

    expect(rotated).toBe(false);
    expect(getHook().document.error).toBe(STREAMED_DOCUMENT_GATE_MESSAGE);
  });

  it("memory-mode commits bump generation, and replaceBytes goes stale on a generation mismatch", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({ bytes: new Uint8Array([1, 2, 3]), name: "brief.pdf" });
    });

    const openedGeneration = getHook().document.generation;
    expect(getHook().document.source?.kind).toBe("memory");

    await act(async () => {
      await getHook().rotatePages([0]);
    });
    expect(getHook().document.generation).toBe(openedGeneration + 1);

    // A workflow that captured the pre-rotate generation must not commit.
    let result: Awaited<ReturnType<UseDocumentValue["replaceBytes"]>> | undefined;
    await act(async () => {
      result = await getHook().replaceBytes(new Uint8Array([9]), {
        dirty: true,
        expectedGeneration: openedGeneration,
      });
    });
    expect(result).toBe("stale");

    // The current generation commits fine (and bumps again).
    const currentGeneration = getHook().document.generation;
    await act(async () => {
      result = await getHook().replaceBytes(new Uint8Array([9]), {
        dirty: true,
        expectedGeneration: currentGeneration,
      });
    });
    expect(result).toBe("replaced");
    expect(getHook().document.generation).toBe(currentGeneration + 1);
  });

  it("a streamed open supersedes an in-flight memory document identity", async () => {
    mount();

    await act(async () => {
      await getHook().openFile({ bytes: new Uint8Array([1]), name: "small.pdf" });
    });
    const memoryToken = getHook().getOpenToken();
    const memoryGeneration = getHook().getGeneration();

    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeFile", file: new File([new Uint8Array(4)], "big.pdf"), sizeBytes: 4 },
        name: "big.pdf",
        path: null,
      });
    });

    expect(getHook().getOpenToken()).toBe(memoryToken + 1);
    expect(getHook().getGeneration()).toBe(memoryGeneration + 1);
    expect(getHook().document.source?.kind).toBe("rangeFile");
  });

  it("upgrades a grant-less streamed File source to a grant without changing document identity", async () => {
    mount();

    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeFile", file: new File([new Uint8Array(4)], "big.pdf"), sizeBytes: 4 },
        name: "big.pdf",
        path: null,
      });
    });

    const openToken = getHook().getOpenToken();
    const generation = getHook().document.generation;
    let upgraded = false;

    act(() => {
      upgraded = getHook().upgradeStreamedFileToGrant(
        { grant: "temp-grant" as FileGrant, sizeBytes: 4, name: "big.pdf" },
        { openToken, generation },
      );
    });

    expect(upgraded).toBe(true);
    expect(getHook().getOpenToken()).toBe(openToken);
    expect(getHook().document.generation).toBe(generation);
    expect(getHook().document.source).toEqual({
      kind: "rangeGrant",
      grant: "temp-grant",
      sizeBytes: 4,
      generation,
    });
    expect(getHook().document.filePath).toBe("temp-grant");
    expect(engineState.openCalls).toHaveLength(0);
  });

  it("a path-op reconcile reopens the output grant as a NEW identity (generation bump)", async () => {
    mount();

    // Original streamed document (the op input).
    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeGrant", grant: "grant-input" as FileGrant, sizeBytes: 283_000_000 },
        name: "appendix.pdf",
        path: "grant-input",
      });
    });
    const inputToken = getHook().getOpenToken();
    const inputGeneration = getHook().document.generation;

    // Reconcile [R1-8]: the op's output grant opens as a fresh source — the
    // same call `openPathOpOutput` makes in App.tsx.
    await act(async () => {
      await getHook().openStreamedFile({
        source: { kind: "rangeGrant", grant: "grant-output" as FileGrant, sizeBytes: 240_000_000 },
        name: "appendix-ocr.pdf",
        path: "grant-output",
      });
    });

    const state = getHook().document;
    expect(getHook().getOpenToken()).toBe(inputToken + 1);
    expect(state.generation).toBeGreaterThan(inputGeneration);
    expect(state.source).toEqual({
      kind: "rangeGrant",
      grant: "grant-output",
      sizeBytes: 240_000_000,
      generation: state.generation,
    });
    // In-flight work guarded by the old identity is stale by construction.
    act(() => {
      getHook().setStreamedPageCount(2556, { generation: inputGeneration });
    });
    expect(getHook().document.pageCount).toBe(0);
    // Streamed docs stay clean across a reconcile — Save As by grant copy.
    expect(state.dirty).toBe(false);
    expect(state.filePath).toBe("grant-output");
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
