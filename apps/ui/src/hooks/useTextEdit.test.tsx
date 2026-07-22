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
import { readPdfRange, type FileGrant } from "../lib/filePort";
import { materializePdfBytesGrant } from "../lib/dropMaterialize";
import {
  pathOpDocumentFacts,
  pathOpExtractPages,
  pathOpReleaseOutput,
  pathOpReplacePage,
} from "../lib/pathOps";
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

vi.mock("../lib/filePort", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/filePort")>()),
  readPdfRange: vi.fn(),
}));
vi.mock("../lib/dropMaterialize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/dropMaterialize")>()),
  materializePdfBytesGrant: vi.fn(),
}));
vi.mock("../lib/pathOps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/pathOps")>()),
  pathOpDocumentFacts: vi.fn(),
  pathOpExtractPages: vi.fn(),
  pathOpReleaseOutput: vi.fn(),
  pathOpReplacePage: vi.fn(),
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
    vi.mocked(readPdfRange).mockReset();
    vi.mocked(materializePdfBytesGrant).mockReset();
    vi.mocked(pathOpDocumentFacts).mockReset();
    vi.mocked(pathOpExtractPages).mockReset();
    vi.mocked(pathOpReleaseOutput).mockReset();
    vi.mocked(pathOpReplacePage).mockReset();
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
      stopEngine: vi.fn(async () => undefined),
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

  type EngineResult = {
    bytes: Uint8Array;
    replacedCounts: readonly number[] | null;
    warnings: readonly never[];
  };

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
    vi.mocked(readPdfRange).mockReset();
    vi.mocked(materializePdfBytesGrant).mockReset();
    vi.mocked(pathOpDocumentFacts).mockReset();
    vi.mocked(pathOpExtractPages).mockReset();
    vi.mocked(pathOpReleaseOutput).mockReset();
    vi.mocked(pathOpReplacePage).mockReset();
  });

  function renderTextEdit(overrides: {
    inspectTextMap?: (...args: never[]) => Promise<PdfInspectTextMapResult>;
    replaceSelectedText?: (...args: never[]) => Promise<EngineResult>;
    textLayerCoverage?: TextLayerCoverage | null;
    source?: { bytes: Uint8Array | null; proxy: never; rangeGrant?: FileGrant | null; rangeFile?: boolean };
    streamed?: boolean;
    replacePathOutput?: (...args: never[]) => Promise<"replaced">;
    documentGeneration?: number;
    sourceOpenToken?: number;
    setCurrentPage?: (page: number) => void;
  } = {}) {
    let activeOverrides = overrides;
    const sourceBytes = new Uint8Array([1]);
    const sourceProxy = { numPages: 1 } as never;
    vi.mocked(extractPageText).mockImplementation(async (input) => (
      "bytes" in input && input.bytes === sourceBytes
        ? [page("Plaintiff files.")]
        : [page("Petitioner files.")]
    ));

    const engineBridge = {
      available: true,
      warmEngine: vi.fn(),
      stopEngine: vi.fn(async () => undefined),
      inspectTextMap: overrides.inspectTextMap ?? vi.fn(async (bytes: Uint8Array) => (
        bytes[0] === 2 || bytes[0] === 4
          ? textMapFixture("Petitioner files.")
          : textMapFixture()
      )),
      replaceSelectedText: overrides.replaceSelectedText ?? vi.fn(async () => ({
        bytes: new Uint8Array([2]),
        replacedCounts: null,
        warnings: [],
      })),
      replaceText: vi.fn(),
    };

    let latest: TextEditState | null = null;
    function Probe() {
      latest = useTextEdit({
        source: activeOverrides.source ?? { bytes: sourceBytes, proxy: sourceProxy },
        documentGeneration: activeOverrides.documentGeneration ?? 1,
        sourceOpenToken: activeOverrides.sourceOpenToken ?? 1,
        streamed: activeOverrides.streamed ?? false,
        textLayerCoverage: activeOverrides.textLayerCoverage ?? null,
        engineBridge: engineBridge as never,
        replaceBytes: (async () => "replaced" as const) as never,
        replacePathOutput: activeOverrides.replacePathOutput as never,
        fileName: "test.pdf",
        confirmSignatureInvalidation: async () => null,
        confirmPdfAIdentificationRemoval: async () => true,
        setCurrentPage: activeOverrides.setCurrentPage ?? (() => undefined),
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
      engineBridge,
      rerender(next: typeof overrides) {
        activeOverrides = { ...activeOverrides, ...next };
        act(() => root?.render(<Probe />));
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
    expect(state().selectedReplacementText).toBe("Plaintiff");
  });

  it("stages one resolved selected target through the scoped engine path exactly once", async () => {
    const { state, engineBridge } = renderTextEdit();

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      state().setReplace("Petitioner");
      await Promise.resolve();
    });
    await act(async () => {
      await state().queueSelectedReplacement();
    });

    expect(state().pendingOps).toHaveLength(1);
    expect(state().pendingOps[0]?.target).toMatchObject({
      pageIndex: 0,
      expectedText: "Plaintiff",
    });
    // Resolve once, then verify the source and staged PDF in the same engine
    // text model used for the selected mutation.
    expect(engineBridge.inspectTextMap).toHaveBeenCalledTimes(3);

    expect(engineBridge.replaceSelectedText).toHaveBeenCalledTimes(1);
    expect(engineBridge.replaceSelectedText).toHaveBeenCalledWith(
      new Uint8Array([1]),
      expect.objectContaining({ replacement: "Petitioner", target: expect.objectContaining({ expectedText: "Plaintiff" }) }),
    );
    expect(engineBridge.replaceText).not.toHaveBeenCalled();
    expect(state().phase).toBe("review");
    expect(state().staged?.report.operations).toHaveLength(1);
    expect(state().staged?.report.operations[0]).toMatchObject({
      selected: true,
      status: "changed",
      replacedEstimate: 1,
    });
  });

  it("verifies the anchored replacement when regenerated text-run serialization expands", async () => {
    const expandedCandidate: PdfInspectTextMapResult = {
      sourceFingerprint: "regenerated-document",
      pages: [{
        pageIndex: 0,
        text: "Petitioner files.EXTRA REGENERATED RUNS",
        sourceFingerprint: "regenerated-page",
        elements: [
          {
            elementIndex: 0,
            start: 0,
            end: 17,
            text: "Petitioner files.",
            area: { pageIndex: 0, x: 10, y: 10, w: 128, h: 12 },
          },
          {
            elementIndex: 1,
            start: 17,
            end: 40,
            text: "EXTRA REGENERATED RUNS",
            area: { pageIndex: 0, x: 300, y: 300, w: 100, h: 12 },
          },
        ],
      }],
    };
    const inspectTextMap = vi.fn(async (bytes: Uint8Array) => (
      bytes[0] === 2 ? expandedCandidate : textMapFixture()
    ));
    const { state } = renderTextEdit({ inspectTextMap: inspectTextMap as never });

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      state().setReplace("Petitioner");
      await Promise.resolve();
    });
    await act(async () => { await state().queueSelectedReplacement(); });

    expect(state().phase).toBe("review");
    expect(state().staged?.report.operations[0]).toMatchObject({
      selected: true,
      status: "changed",
      replacedEstimate: 1,
    });
  });

  it("verifies the anchored replacement when regeneration reorders element indexes", async () => {
    const reorderedCandidate: PdfInspectTextMapResult = {
      sourceFingerprint: "regenerated-document",
      pages: [{
        pageIndex: 0,
        text: "UNRELATEDPetitioner files.",
        sourceFingerprint: "regenerated-page",
        elements: [
          {
            elementIndex: 0,
            start: 0,
            end: 9,
            text: "UNRELATED",
            area: { pageIndex: 0, x: 300, y: 300, w: 70, h: 12 },
          },
          {
            elementIndex: 1,
            start: 9,
            end: 26,
            text: "Petitioner files.",
            area: { pageIndex: 0, x: 10, y: 10, w: 128, h: 12 },
          },
        ],
      }],
    };
    const inspectTextMap = vi.fn(async (bytes: Uint8Array) => (
      bytes[0] === 2 ? reorderedCandidate : textMapFixture()
    ));
    const { state } = renderTextEdit({ inspectTextMap: inspectTextMap as never });

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      state().setReplace("Petitioner");
      await Promise.resolve();
    });
    await act(async () => { await state().queueSelectedReplacement(); });

    expect(state().phase).toBe("review");
    expect(state().staged?.report.operations[0]).toMatchObject({
      selected: true,
      status: "changed",
      replacedEstimate: 1,
    });
  });

  it("does not queue twice when selected replacement is activated twice before resolution completes", async () => {
    const inspection = createDeferred<PdfInspectTextMapResult>();
    const { state, engineBridge } = renderTextEdit({
      inspectTextMap: vi.fn(() => inspection.promise),
    });

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      await Promise.resolve();
    });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      first = state().queueSelectedReplacement();
      second = state().queueSelectedReplacement();
      await Promise.resolve();
    });

    expect(engineBridge.inspectTextMap).toHaveBeenCalledTimes(1);
    await act(async () => {
      inspection.resolve(textMapFixture());
      await Promise.all([first, second]);
    });

    expect(state().pendingOps).toHaveLength(1);
    expect(state().pendingOps[0]?.target).toBeDefined();
  });

  it("clears a selected replacement before target resolution can stage it", async () => {
    const inspection = createDeferred<PdfInspectTextMapResult>();
    const { state, engineBridge } = renderTextEdit({
      inspectTextMap: vi.fn(() => inspection.promise),
    });

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      await Promise.resolve();
    });
    let queued: Promise<void> = Promise.resolve();
    await act(async () => {
      queued = state().queueSelectedReplacement();
      await Promise.resolve();
    });
    expect(engineBridge.inspectTextMap).toHaveBeenCalledTimes(1);

    await act(async () => {
      state().clear();
      inspection.resolve(textMapFixture());
      await queued;
    });

    expect(engineBridge.replaceSelectedText).not.toHaveBeenCalled();
    expect(engineBridge.stopEngine).toHaveBeenCalledTimes(1);
    expect(state().pendingOps).toHaveLength(0);
    expect(state().phase).toBe("idle");
    expect(state().staged).toBeNull();
    expect(engineBridge.stopEngine).toHaveBeenCalledTimes(1);
  });

  it("keeps inferred selected spacing in the review-facing operation while sending raw offsets to the engine", async () => {
    const textMap: PdfInspectTextMapResult = {
      sourceFingerprint: "document-fingerprint",
      pages: [{
        pageIndex: 0,
        text: "JohnSmith",
        sourceFingerprint: "page-fingerprint",
        elements: [
          { elementIndex: 0, start: 0, end: 4, text: "John", area: { pageIndex: 0, x: 72, y: 700, w: 28, h: 12 }, direction: { x: 1, y: 0 } },
          { elementIndex: 1, start: 4, end: 9, text: "Smith", area: { pageIndex: 0, x: 108, y: 700, w: 35, h: 12 }, direction: { x: 1, y: 0 } },
        ],
      }],
    };
    const { state, engineBridge } = renderTextEdit({ inspectTextMap: vi.fn(async () => textMap) });
    const selected = { pageIndex: 0, text: "John Smith", pageText: "John Smith", start: 0, end: 10 };

    await act(async () => {
      state().primeSelectedReplacement(selected);
      state().setReplace("Jane Doe");
      await Promise.resolve();
    });
    await act(async () => { await state().queueSelectedReplacement(); });

    expect(state().pendingOps[0]).toMatchObject({ find: "John Smith", target: {
      expectedText: "JohnSmith", expectedVisibleText: "John Smith", start: 0, end: 9,
    } });
    expect(state().selectedReplacementText).toBe("John Smith");
    expect(engineBridge.replaceSelectedText).toHaveBeenCalledWith(
      new Uint8Array([1]),
      expect.objectContaining({ target: expect.objectContaining({ expectedText: "JohnSmith", expectedVisibleText: "John Smith" }) }),
    );
  });

  it("allows a streamed range grant for selected text while bulk remains gated", () => {
    const { state } = renderTextEdit({
      streamed: true,
      source: { bytes: null, proxy: { numPages: 10_000 } as never, rangeGrant: "source-grant" as FileGrant },
    });
    expect(state().gate.blocked).toBe(true);
    expect(state().selectedReplacementGate(0)).toEqual({ blocked: false, reason: null });
  });

  it("materializes an in-memory large PDF and stages only the selected page", async () => {
    const sourceBytes = new Uint8Array([9, 9, 9]);
    const pageBytes = new Uint8Array([3, 3, 3]);
    const editedBytes = new Uint8Array([4, 4, 4]);
    const sourceGrant = "materialized-large-source" as FileGrant;
    const extractedGrant = "materialized-large-page" as FileGrant;

    vi.mocked(materializePdfBytesGrant).mockResolvedValue({
      kind: "rangeGrant",
      grant: sourceGrant,
      name: "large.pdf",
      sizeBytes: sourceBytes.byteLength,
    });
    vi.mocked(pathOpDocumentFacts).mockResolvedValue(editableDocumentFacts(500));
    vi.mocked(pathOpExtractPages).mockResolvedValue(pathOutput(extractedGrant, pageBytes.byteLength));
    vi.mocked(readPdfRange).mockResolvedValue(pageBytes);
    vi.mocked(pathOpReleaseOutput).mockResolvedValue(undefined);

    const { state } = renderTextEdit({
      source: { bytes: sourceBytes, proxy: { numPages: 500 } as never },
      replaceSelectedText: vi.fn(async () => ({ bytes: editedBytes, replacedCounts: null, warnings: [] })),
      replacePathOutput: vi.fn(async () => "replaced" as const) as never,
    });
    vi.mocked(extractPageText).mockImplementation(async (input) => (
      "bytes" in input && input.bytes === pageBytes
        ? [page("Plaintiff files.")]
        : [page("Petitioner files.")]
    ));

    expect(state().gate.blocked).toBe(true);
    expect(state().selectedReplacementGate(0).blocked).toBe(false);
    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      state().setReplace("Petitioner");
      await Promise.resolve();
    });
    await act(async () => { await state().queueSelectedReplacement(); });

    expect(materializePdfBytesGrant).toHaveBeenCalledWith(sourceBytes, "test.pdf");
    expect(pathOpExtractPages).toHaveBeenCalledWith(sourceGrant, [0]);
    expect(state().phase).toBe("review");
    expect(state().staged?.pageLocal).toEqual({ sourceGrant, originalPageIndex: 0 });
    expect(state().message).not.toContain("too large");

    act(() => state().cancelReview());
    expect(pathOpReleaseOutput).toHaveBeenCalledWith(sourceGrant);
  });

  it("edits only the extracted page of a streamed document and splices it at the original index", async () => {
    const sourceGrant = "large-source" as FileGrant;
    const extractedGrant = "extracted-page" as FileGrant;
    const editedGrant = "edited-page" as FileGrant;
    const outputGrant = "replaced-document" as FileGrant;
    const pageBytes = new Uint8Array([3, 3, 3]);
    const editedBytes = new Uint8Array([4, 4, 4]);
    const setCurrentPage = vi.fn();
    const replacePathOutput = vi.fn(async () => "replaced" as const);

    vi.mocked(pathOpDocumentFacts).mockResolvedValue(editableDocumentFacts(10_000));
    vi.mocked(pathOpExtractPages).mockResolvedValue(pathOutput(extractedGrant, pageBytes.byteLength));
    vi.mocked(readPdfRange).mockResolvedValue(pageBytes);
    vi.mocked(materializePdfBytesGrant).mockResolvedValue({
      kind: "rangeGrant",
      grant: editedGrant,
      name: "edited-page.pdf",
      sizeBytes: editedBytes.byteLength,
    });
    const replacedOutput = pathOutput(outputGrant, 123_456);
    vi.mocked(pathOpReplacePage).mockResolvedValue(replacedOutput);
    vi.mocked(pathOpReleaseOutput).mockResolvedValue(undefined);

    const { state, engineBridge } = renderTextEdit({
      streamed: true,
      source: { bytes: null, proxy: { numPages: 10_000 } as never, rangeGrant: sourceGrant },
      replaceSelectedText: vi.fn(async () => ({ bytes: editedBytes, replacedCounts: null, warnings: [] })),
      replacePathOutput: replacePathOutput as never,
      setCurrentPage,
    });
    vi.mocked(extractPageText).mockImplementation(async (input) => (
      "bytes" in input && input.bytes === pageBytes
        ? [page("Plaintiff files.")]
        : [page("Petitioner files.")]
    ));

    const originalPageIndex = 437;
    await act(async () => {
      state().primeSelectedReplacement({ ...capturedSelection(), pageIndex: originalPageIndex });
      state().setReplace("Petitioner");
      await Promise.resolve();
    });
    await act(async () => { await state().queueSelectedReplacement(); });

    expect(pathOpDocumentFacts).toHaveBeenCalledWith(sourceGrant);
    expect(pathOpExtractPages).toHaveBeenCalledWith(sourceGrant, [originalPageIndex]);
    expect(readPdfRange).toHaveBeenCalledWith(extractedGrant, 0, pageBytes.byteLength);
    expect(pathOpReleaseOutput).toHaveBeenCalledWith(extractedGrant);
    expect(engineBridge.inspectTextMap).toHaveBeenCalledWith(pageBytes, { pageIndexes: [0] });
    expect(engineBridge.replaceSelectedText).toHaveBeenCalledWith(
      pageBytes,
      expect.objectContaining({
        replacement: "Petitioner",
        target: expect.objectContaining({ pageIndex: 0, expectedText: "Plaintiff" }),
      }),
    );
    expect(state().phase).toBe("review");
    expect(state().staged?.pageLocal).toEqual({ sourceGrant, originalPageIndex });
    expect(state().staged?.report.changedPageIndexes).toEqual([originalPageIndex]);
    expect(state().matches[0]?.pageIndex).toBe(originalPageIndex);
    expect(setCurrentPage).toHaveBeenCalledWith(originalPageIndex + 1);

    await act(async () => { await state().apply(); });

    expect(materializePdfBytesGrant).toHaveBeenCalledWith(editedBytes, "edited-page.pdf");
    expect(pathOpReplacePage).toHaveBeenCalledWith(sourceGrant, editedGrant, originalPageIndex);
    expect(replacePathOutput).toHaveBeenCalledWith(replacedOutput, {
      expectedOpenToken: 1,
      expectedGeneration: 1,
    });
    expect(pathOpReleaseOutput).toHaveBeenCalledWith(editedGrant);
    expect(state().phase).toBe("done");
  });

  it("drops a deferred extraction from an obsolete document before it can stage or splice", async () => {
    const sourceA = "source-a" as FileGrant;
    const sourceB = "source-b" as FileGrant;
    const extractedA = createDeferred<ReturnType<typeof pathOutput>>();
    const pageBytesB = new Uint8Array([8]);

    vi.mocked(pathOpDocumentFacts).mockResolvedValue(editableDocumentFacts(2_000));
    vi.mocked(pathOpExtractPages)
      .mockImplementationOnce(() => extractedA.promise)
      .mockResolvedValue(pathOutput("page-b" as FileGrant, pageBytesB.byteLength));
    vi.mocked(readPdfRange).mockResolvedValue(pageBytesB);
    vi.mocked(pathOpReleaseOutput).mockResolvedValue(undefined);

    const harness = renderTextEdit({
      streamed: true,
      source: { bytes: null, proxy: { numPages: 2_000 } as never, rangeGrant: sourceA },
    });
    await act(async () => {
      harness.state().primeSelectedReplacement({ ...capturedSelection(), pageIndex: 100 });
      await Promise.resolve();
    });
    let staleRun: Promise<void> = Promise.resolve();
    await act(async () => {
      staleRun = harness.state().queueSelectedReplacement();
      await Promise.resolve();
    });
    expect(pathOpExtractPages).toHaveBeenCalledWith(sourceA, [100]);

    harness.rerender({
      streamed: true,
      source: { bytes: null, proxy: { numPages: 2_000 } as never, rangeGrant: sourceB },
      documentGeneration: 2,
      sourceOpenToken: 2,
    });
    await act(async () => {
      extractedA.resolve(pathOutput("page-a" as FileGrant, 1));
      await staleRun;
    });

    expect(harness.engineBridge.inspectTextMap).not.toHaveBeenCalled();
    expect(harness.engineBridge.replaceSelectedText).not.toHaveBeenCalled();
    expect(pathOpReplacePage).not.toHaveBeenCalled();
    expect(harness.state().pendingOps).toHaveLength(0);
    expect(harness.state().staged).toBeNull();
  });

  it("releases an extracted page that exceeds the per-page safety cap", async () => {
    const sourceGrant = "large-source" as FileGrant;
    const extractedGrant = "oversized-page" as FileGrant;
    vi.mocked(pathOpDocumentFacts).mockResolvedValue(editableDocumentFacts(10_000));
    vi.mocked(pathOpExtractPages).mockResolvedValue(pathOutput(extractedGrant, 32 * 1024 * 1024 + 1));
    vi.mocked(pathOpReleaseOutput).mockResolvedValue(undefined);
    const { state, engineBridge } = renderTextEdit({
      streamed: true,
      source: { bytes: null, proxy: { numPages: 10_000 } as never, rangeGrant: sourceGrant },
    });

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      await Promise.resolve();
    });
    await act(async () => { await state().queueSelectedReplacement(); });

    expect(readPdfRange).not.toHaveBeenCalled();
    expect(pathOpReleaseOutput).toHaveBeenCalledWith(extractedGrant);
    expect(engineBridge.inspectTextMap).not.toHaveBeenCalled();
    expect(state().phase).toBe("error");
    expect(state().message).toContain("too large");
  });

  it("visibly refuses browser range files for selected editing", () => {
    const { state } = renderTextEdit({
      streamed: true,
      source: { bytes: null, proxy: { numPages: 10_000 } as never, rangeFile: true },
    });

    expect(state().selectedReplacementGate(0)).toMatchObject({ blocked: true });
  });


  it("cancels a selected review so late scoped engine work cannot open a dialog", async () => {
    const inspection = createDeferred<PdfInspectTextMapResult>();
    const replacement = createDeferred<EngineResult>();
    const { state, engineBridge } = renderTextEdit({
      inspectTextMap: vi.fn(() => inspection.promise),
      replaceSelectedText: vi.fn(() => replacement.promise),
    });

    await act(async () => {
      state().primeSelectedReplacement(capturedSelection());
      await Promise.resolve();
    });
    let queued: Promise<void> = Promise.resolve();
    await act(async () => {
      queued = state().queueSelectedReplacement();
      await Promise.resolve();
    });
    expect(engineBridge.inspectTextMap).toHaveBeenCalledTimes(1);
    await act(async () => {
      inspection.resolve(textMapFixture());
      await Promise.resolve();
    });
    expect(state().phase).toBe("staging");
    expect(engineBridge.replaceSelectedText).toHaveBeenCalledTimes(1);

    await act(async () => {
      state().cancelReview();
      replacement.resolve({ bytes: new Uint8Array([2]), replacedCounts: null, warnings: [] });
      await queued;
    });

    expect(state().phase).toBe("idle");
    expect(state().staged).toBeNull();
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

  function textMapFixture(text = "Plaintiff files."): PdfInspectTextMapResult {
    return {
      sourceFingerprint: "document-fingerprint",
      pages: [{
        pageIndex: 0,
        text,
        sourceFingerprint: "page-fingerprint",
        elements: [{
          elementIndex: 0,
          start: 0,
          end: text.length,
          text,
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

function editableDocumentFacts(pageCount: number) {
  return {
    pageCount,
    sizeBytes: 512 * 1024 * 1024,
    encrypted: false,
    pdfaClaimed: false,
    signatureDetection: {
      standardAcroFormSignatureCount: 0,
      hasByteRangeOrContentsMarkers: false,
      hasCertificationDictionary: false,
    },
    hasAcroForm: false,
    hasTaggedStructure: false,
    hasEmbeddedFiles: false,
    hasAnnotations: false,
    pages: [],
  };
}

function pathOutput(outputGrant: FileGrant, sizeBytes: number) {
  return {
    outputGrant,
    name: "page.pdf",
    sizeBytes,
    pageCount: 1,
    opReport: {
      op: "test",
      tool: "qpdf",
      durationMs: 1,
      inputSizeBytes: sizeBytes,
      outputSizeBytes: sizeBytes,
      notes: [],
    },
  };
}

function selectedTarget(): PdfSelectedTextTarget {
  return {
    pageIndex: 0,
    start: 14,
    end: 24,
    expectedText: "John Smith",
    expectedVisibleText: "John Smith",
    sourceDocumentFingerprint: "document",
    sourceFingerprint: "page",
    firstElementIndex: 2,
    lastElementIndex: 2,
    firstElementOffset: 0,
    lastElementOffset: 10,
  };
}
