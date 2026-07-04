// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import type { UnlockResult } from "../lib/protectedPdfResolver";
import { useDocument, type UseDocumentOptions } from "./useDocument";

const engineState = vi.hoisted(() => ({
  openInputs: [] as number[],
  pageCountCalls: 0,
  saveBytes: new Uint8Array([2]),
}));

vi.mock("@raiopdf/engine-local", async () => {
  const { PdfEngineError } = await vi.importActual<typeof import("@raiopdf/engine-api")>(
    "@raiopdf/engine-api",
  );

  class LocalPdfEngine {
    async open(bytes: Uint8Array): Promise<PdfDocumentHandle> {
      engineState.openInputs.push(bytes[0] ?? -1);

      if (bytes[0] === 1) {
        throw new PdfEngineError("ENCRYPTED_DOCUMENT", "Encrypted.");
      }

      return `handle-${bytes[0] ?? 0}` as PdfDocumentHandle;
    }

    async close() {
      return undefined;
    }

    async pageCount() {
      engineState.pageCountCalls += 1;
      return 1;
    }

    async saveToBytes() {
      return engineState.saveBytes;
    }
  }

  return { LocalPdfEngine };
});

describe("useDocument protected PDFs", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    engineState.openInputs.length = 0;
    engineState.pageCountCalls = 0;
    engineState.saveBytes = new Uint8Array([2]);
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

  it("forces Save As for signature-invalidating unlocked copies", async () => {
    const signature = {
      standardAcroFormSignatureCount: 0,
      hasByteRangeOrContentsMarkers: true,
      hasCertificationDictionary: false,
    };
    const confirmSignatureInvalidation = vi.fn(async () => true);
    const resolve = vi.fn(async (): Promise<UnlockResult> => ({
      status: "unlocked",
      bytes: new Uint8Array([2]),
      changed: true,
      warnings: ["signature-invalidated"],
      provenance: {
        source: "owner-restricted",
        signature,
      },
    }));
    const harness = renderUseDocument({
      protectedPdf: {
        confirmSignatureInvalidation,
        resolve,
      },
    });

    let opened = false;
    await act(async () => {
      opened = await harness.current.openFile({
        bytes: new Uint8Array([1]),
        name: "signed.pdf",
        path: "C:\\cases\\signed.pdf",
      });
    });

    expect(opened).toBe(true);
    expect(engineState.openInputs).toEqual([1, 2]);
    expect(harness.current.document.fileName).toBe("signed.pdf");
    expect(harness.current.document.filePath).toBeNull();
    expect(harness.current.document.dirty).toBe(true);
    expect(harness.current.document.signatureInvalidationNotice).toMatchObject({
      sourceFileNames: ["signed.pdf"],
      sourceFilePath: "C:\\cases\\signed.pdf",
      signature,
    });

    const saved = await act(async () => harness.current.save());

    expect(saved?.filePath).toBeNull();
  });

  it("replaceBytes uses a known page count during commit instead of asking the engine again", async () => {
    const harness = renderUseDocument();

    await act(async () => {
      await harness.current.openFile({
        bytes: new Uint8Array([2]),
        name: "brief.pdf",
      });
    });

    const pageCountCallsAfterOpen = engineState.pageCountCalls;
    const textLayerCoverage = {
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0, 1, 2, 3, 4],
      garbledPages: [],
    };
    let result: Awaited<ReturnType<ReturnType<typeof useDocument>["replaceBytes"]>> | undefined;

    await act(async () => {
      result = await harness.current.replaceBytes(new Uint8Array([8]), {
        dirty: true,
        hasTextLayer: true,
        textLayerCoverage,
        knownPageCount: 5,
      });
    });

    expect(result).toBe("replaced");
    expect(engineState.pageCountCalls).toBe(pageCountCallsAfterOpen);
    expect(harness.current.document.pageCount).toBe(5);
    expect(harness.current.document.hasTextLayer).toBe(true);
    expect(harness.current.document.textLayerCoverage).toBe(textLayerCoverage);
  });

  function renderUseDocument(options: UseDocumentOptions = {}) {
    let current: ReturnType<typeof useDocument> | null = null;
    render(<Harness options={options} onReady={(value) => { current = value; }} />);

    return {
      get current() {
        if (!current) {
          throw new Error("useDocument was not rendered.");
        }

        return current;
      },
    };
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

function Harness({
  options,
  onReady,
}: {
  options: UseDocumentOptions;
  onReady: (value: ReturnType<typeof useDocument>) => void;
}) {
  const documentApi = useDocument(options);

  useEffect(() => {
    onReady(documentApi);
  }, [documentApi, onReady]);

  return null;
}
