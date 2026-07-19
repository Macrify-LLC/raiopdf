// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PdfEngineError,
  type PdfInspectTextMapResult,
  type PdfSelectedTextTarget,
} from "@raiopdf/engine-api";
import type { TextLayerCoverage } from "@raiopdf/rules";
import {
  selectedTextReviewGateMessage,
  unsafeSelectedTextPageIndexes,
  useTextEdit,
  runTextEditEngineReplacement,
  type TextEditState,
} from "./useTextEdit";
import {
  TEXT_EDIT_ZERO_CHANGE_MESSAGE,
  buildTextEditReviewReport,
  formatReplaceTextResult,
  type PendingTextReplacement,
} from "../lib/textEdit";
import { extractPageText, type ExtractedPageText } from "../lib/pageTextCache";
import type { CapturedTextSelection } from "../lib/selectedTextEdit";

vi.mock("../lib/pdfjs", () => ({
  loadPdfDocument: async () => ({
    numPages: 1,
    loadingTask: { destroy: async () => undefined },
  }),
}));

vi.mock("../lib/pageTextCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/pageTextCache")>()),
  extractPageText: vi.fn(),
}));

describe("useTextEdit contract helpers", () => {
  it("exports the hook used by App and component integrations", () => {
    expect(typeof useTextEdit).toBe("function");
  });

  it("keeps zero-change reviews non-committal", () => {
    const report = buildTextEditReviewReport({
      operations: [op()],
      originalPages: [page("Plaintiff files.")],
      candidatePages: [page("Plaintiff files.")],
    });

    expect(report.zeroChange).toBe(true);
    expect(formatReplaceTextResult(report)).toBe(TEXT_EDIT_ZERO_CHANGE_MESSAGE);
  });

  it("carries source page changes needed for stale apply and scroll targeting", () => {
    const report = buildTextEditReviewReport({
      operations: [op()],
      originalPages: [page("Plaintiff files.")],
      candidatePages: [page("Petitioner files.")],
    });

    expect(report.zeroChange).toBe(false);
    expect(report.changedPageIndexes).toEqual([0]);
  });

  it("dispatches selected operations through replaceSelectedText", async () => {
    const sourceBytes = new Uint8Array([1]);
    const bridge = {
      replaceSelectedText: vi.fn(async () => ({
        bytes: new Uint8Array([2]),
        warnings: [],
      })),
      replaceText: vi.fn(async () => ({
        bytes: new Uint8Array([3]),
        replacedCounts: null,
        warnings: [],
      })),
    };

    const result = await runTextEditEngineReplacement({
      engineBridge: bridge,
      sourceBytes,
      operations: [op({
        id: "selected",
        find: "John Smith",
        replace: "Jane Doe",
        pageIndexes: [0],
        target: selectedTarget(),
      })],
    });

    expect(result).toEqual({
      bytes: new Uint8Array([2]),
      replacedCounts: null,
      warnings: [],
    });
    expect(bridge.replaceSelectedText).toHaveBeenCalledWith(sourceBytes, {
      replacement: "Jane Doe",
      target: expect.objectContaining({ expectedText: "John Smith" }),
    });
    expect(bridge.replaceText).not.toHaveBeenCalled();
  });

  it("dispatches bulk operations through replaceText", async () => {
    const sourceBytes = new Uint8Array([1]);
    const bridge = {
      replaceSelectedText: vi.fn(),
      replaceText: vi.fn(async () => ({
        bytes: new Uint8Array([3]),
        replacedCounts: null,
        warnings: [],
      })),
    };

    await runTextEditEngineReplacement({
      engineBridge: bridge,
      sourceBytes,
      operations: [op()],
      allowSignatureInvalidation: true,
    });

    expect(bridge.replaceText).toHaveBeenCalledWith(sourceBytes, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      wholeWord: false,
      pageIndexes: "all",
      allowSignatureInvalidation: true,
    });
    expect(bridge.replaceSelectedText).not.toHaveBeenCalled();
  });

  it("refuses mixed selected and bulk operations", async () => {
    const bridge = {
      replaceSelectedText: vi.fn(),
      replaceText: vi.fn(),
    };

    await expect(
      runTextEditEngineReplacement({
        engineBridge: bridge,
        sourceBytes: new Uint8Array([1]),
        operations: [
          op({
            id: "selected",
            target: selectedTarget(),
          }),
          op({
            id: "bulk",
            find: "John",
            replace: "Jane",
          }),
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    expect(bridge.replaceSelectedText).not.toHaveBeenCalled();
    expect(bridge.replaceText).not.toHaveBeenCalled();
  });

  it("flags selected-text review on unsafe coverage pages", () => {
    const unsafePages = unsafeSelectedTextPageIndexes({
      imageOnlyPages: [0],
      mixedPages: [],
      textPages: [1, 2],
      garbledPages: [{
        pageIndex: 1,
        confidence: 0.8,
        reason: "low_alpha_entropy",
        puaRatio: 0,
        replacementRatio: 0,
        alphaRatio: 0.01,
      }],
      trivialTextImagePages: [{
        pageIndex: 2,
        textCharacterCount: 8,
        imageCoverageRatio: 0.9,
      }],
    });

    expect([...unsafePages].sort()).toEqual([0, 1, 2]);
    for (const pageIndex of unsafePages) {
      expect(selectedTextReviewGateMessage([
        op({
          target: { ...selectedTarget(), pageIndex },
        }),
      ], unsafePages)).toContain("unreliable text layers");
    }
  });

  it("allows selected-text review only when the latest unsafe-page set permits it", () => {
    const selected = [op({ target: selectedTarget() })];

    expect(selectedTextReviewGateMessage(selected, new Set())).toBeNull();
    expect(selectedTextReviewGateMessage(selected, new Set([0]))).toContain("unreliable text layers");
  });
});

describe("useTextEdit phase lifecycle", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.mocked(extractPageText).mockReset();
  });

  type EngineResult = {
    bytes: Uint8Array;
    replacedCounts: readonly number[] | null;
    warnings: readonly never[];
  };

  function renderTextEdit(overrides: {
    replaceText?: (...args: never[]) => Promise<EngineResult>;
    confirmPdfAIdentificationRemoval?: () => Promise<boolean>;
    replaceBytes?: () => Promise<"replaced" | "stale" | "failed">;
  } = {}) {
    const sourceBytes = new Uint8Array([1]);
    const proxy = { numPages: 1 };

    vi.mocked(extractPageText).mockImplementation(async (input) => (
      "bytes" in input && input.bytes === sourceBytes
        ? [page("Plaintiff files.")]
        : [page("Petitioner files.")]
    ));

    const engineBridge = {
      available: true,
      warmEngine: vi.fn(),
      inspectTextMap: vi.fn(),
      replaceSelectedText: vi.fn(),
      replaceText: overrides.replaceText ?? vi.fn(async () => ({
        bytes: new Uint8Array([9]),
        replacedCounts: [1] as readonly number[],
        warnings: [],
      })),
    };

    let latest: TextEditState | null = null;
    function Probe() {
      latest = useTextEdit({
        source: { bytes: sourceBytes, proxy: proxy as never },
        documentGeneration: 1,
        sourceOpenToken: 1,
        streamed: false,
        textLayerCoverage: null,
        engineBridge: engineBridge as never,
        replaceBytes: (overrides.replaceBytes ?? (async () => "replaced" as const)) as never,
        fileName: "test.pdf",
        confirmSignatureInvalidation: async () => null,
        confirmPdfAIdentificationRemoval:
          overrides.confirmPdfAIdentificationRemoval ?? (async () => true),
        setCurrentPage: () => undefined,
      });
      return null;
    }

    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe />);
    });

    return {
      state: () => {
        if (!latest) {
          throw new Error("hook did not render");
        }
        return latest;
      },
    };
  }

  async function queueReplacement(state: () => TextEditState) {
    await act(async () => {
      state().setFind("Plaintiff");
      await Promise.resolve();
    });
    await act(async () => {
      state().queueReplaceAll();
      await Promise.resolve();
    });
    expect(state().pendingOps).toHaveLength(1);
  }

  it("releases a stranded staging phase when the run is superseded mid-review", async () => {
    const engineResult = createDeferred<EngineResult>();
    const { state } = renderTextEdit({ replaceText: vi.fn(() => engineResult.promise) });

    await queueReplacement(state);

    let reviewDone: Promise<void> = Promise.resolve();
    await act(async () => {
      reviewDone = state().review();
      await Promise.resolve();
    });
    expect(state().phase).toBe("staging");

    // Supersede the run while the engine call is still in flight.
    await act(async () => {
      state().setFind("Different");
      await Promise.resolve();
    });

    await act(async () => {
      engineResult.resolve({ bytes: new Uint8Array([9]), replacedCounts: [1], warnings: [] });
      await reviewDone;
    });

    expect(state().phase).toBe("idle");
  });

  it("surfaces a throwing confirmation callback as an error instead of spinning", async () => {
    const { state } = renderTextEdit({
      replaceText: vi.fn(async () => {
        throw new PdfEngineError("UNSUPPORTED", "PDF/A conformance blocks text edits.");
      }),
      confirmPdfAIdentificationRemoval: async () => {
        throw new Error("Command plugin:dialog|confirm not allowed by ACL");
      },
    });

    await queueReplacement(state);

    await act(async () => {
      await state().review();
    });

    expect(state().phase).toBe("error");
    expect(state().message).toContain("not allowed by ACL");
  });

  it("moves to error when applying staged bytes rejects", async () => {
    const { state } = renderTextEdit({
      replaceBytes: async () => {
        throw new Error("The edited copy could not be written.");
      },
    });

    await queueReplacement(state);

    await act(async () => {
      await state().review();
    });
    expect(state().phase).toBe("review");
    expect(state().staged).not.toBeNull();

    await act(async () => {
      await state().apply();
    });

    expect(state().phase).toBe("error");
    expect(state().message).toContain("could not be written");
  });
});

describe("useTextEdit selected-replacement priming", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.mocked(extractPageText).mockReset();
  });

  function renderTextEdit(overrides: {
    inspectTextMap?: (...args: never[]) => Promise<PdfInspectTextMapResult>;
    textLayerCoverage?: TextLayerCoverage | null;
  } = {}) {
    const sourceBytes = new Uint8Array([1]);
    vi.mocked(extractPageText).mockResolvedValue([page("Plaintiff files.")]);

    const engineBridge = {
      available: true,
      warmEngine: vi.fn(),
      inspectTextMap: overrides.inspectTextMap ?? vi.fn(async () => textMapFixture()),
      replaceSelectedText: vi.fn(),
      replaceText: vi.fn(),
    };

    let latest: TextEditState | null = null;
    function Probe() {
      latest = useTextEdit({
        source: { bytes: sourceBytes, proxy: { numPages: 1 } as never },
        documentGeneration: 1,
        sourceOpenToken: 1,
        streamed: false,
        textLayerCoverage: overrides.textLayerCoverage ?? null,
        engineBridge: engineBridge as never,
        replaceBytes: (async () => "replaced" as const) as never,
        fileName: "test.pdf",
        confirmSignatureInvalidation: async () => null,
        confirmPdfAIdentificationRemoval: async () => true,
        setCurrentPage: () => undefined,
      });
      return null;
    }

    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe />);
    });

    return {
      state: () => {
        if (!latest) {
          throw new Error("hook did not render");
        }
        return latest;
      },
    };
  }

  it("primes a menu-built selection and bumps the prime count on every store", async () => {
    const { state } = renderTextEdit();

    await act(async () => {
      expect(state().primeSelectedReplacement(capturedSelection())).toBe(true);
      await Promise.resolve();
    });

    expect(state().selectedReplacementText).toBe("Plaintiff");
    expect(state().selectionPrimeCount).toBe(1);
    expect(state().message).toContain('Selected "Plaintiff"');

    // Identical text primes again — the count is what the mode bar's focus
    // effect keys on, so it must move even when the text does not.
    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      await Promise.resolve();
    });
    expect(state().selectionPrimeCount).toBe(2);
  });

  it("refuses to prime while replacements are queued", async () => {
    const { state } = renderTextEdit();

    await act(async () => {
      state().setFind("files");
      await Promise.resolve();
    });
    await act(async () => {
      state().queueReplaceAll();
      await Promise.resolve();
    });
    expect(state().pendingOps).toHaveLength(1);

    await act(async () => {
      expect(state().primeSelectedReplacement(capturedSelection())).toBe(false);
      await Promise.resolve();
    });

    expect(state().selectedReplacementText).toBeNull();
    expect(state().selectionPrimeCount).toBe(0);
    expect(state().message).toContain("Review or clear queued replacements");
    expect(state().selectedReplacementGate(0).blocked).toBe(true);
  });

  it("blocks the gate on pages with unreliable text layers", () => {
    const { state } = renderTextEdit({
      textLayerCoverage: {
        imageOnlyPages: [],
        mixedPages: [],
        textPages: [0, 1],
        garbledPages: [{
          pageIndex: 0,
          confidence: 0.8,
          reason: "low_alpha_entropy",
          puaRatio: 0,
          replacementRatio: 0,
          alphaRatio: 0.01,
        }],
        trivialTextImagePages: [],
      },
    });

    expect(state().selectedReplacementGate(0).blocked).toBe(true);
    expect(state().selectedReplacementGate(0).reason).toContain("unreliable text layers");
    expect(state().selectedReplacementGate(1).blocked).toBe(false);
  });

  it("queues a primed selection when the live window selection is collapsed", async () => {
    const { state } = renderTextEdit();

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      await Promise.resolve();
    });

    // jsdom's window selection is collapsed here, so the queue path must
    // fall back to the primed capture.
    await act(async () => {
      await state().queueSelectedReplacement();
    });

    expect(state().pendingOps).toHaveLength(1);
    expect(state().pendingOps[0]?.target?.expectedText).toBe("Plaintiff");
    expect(state().selectedReplacementText).toBeNull();
  });

  function capturedSelection(): CapturedTextSelection {
    return {
      pageIndex: 0,
      text: "Plaintiff",
      pageText: "Plaintiff files.",
      start: 0,
      end: 9,
    };
  }

  function textMapFixture(): PdfInspectTextMapResult {
    return {
      sourceFingerprint: "document-fingerprint",
      pages: [{
        pageIndex: 0,
        text: "Plaintiff files.",
        sourceFingerprint: "page-fingerprint",
        elements: [{
          elementIndex: 0,
          start: 0,
          end: 16,
          text: "Plaintiff files.",
          area: { pageIndex: 0, x: 10, y: 10, w: 120, h: 12 },
        }],
      }],
    };
  }
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function op(overrides: Partial<PendingTextReplacement> = {}): PendingTextReplacement {
  return {
    id: "op",
    find: "Plaintiff",
    replace: "Petitioner",
    wholeWord: false,
    pageIndexes: "all",
    ...overrides,
  };
}

function page(text: string): ExtractedPageText {
  return {
    pageIndex: 0,
    text,
    spans: [{ start: 0, end: text.length, area: { pageIndex: 0, x: 0, y: 0, w: 100, h: 10 } }],
  };
}

function selectedTarget(): PdfSelectedTextTarget {
  return {
    pageIndex: 0,
    start: 14,
    end: 24,
    expectedText: "John Smith",
    sourceDocumentFingerprint: "document",
    sourceFingerprint: "page",
    firstElementIndex: 2,
    lastElementIndex: 2,
    firstElementOffset: 0,
    lastElementOffset: 10,
  };
}
