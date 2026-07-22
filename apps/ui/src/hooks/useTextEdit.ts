import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PdfEngineError, type PdfReplaceTextWarning } from "@raiopdf/engine-api";
import type { TextLayerCoverage } from "@raiopdf/rules";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { loadPdfDocument } from "../lib/pdfjs";
import { extractPageText, type ExtractedPageText } from "../lib/pageTextCache";
import type { ReplaceBytesResult } from "./useDocument";
import type { EngineBridge } from "./useEngineBridge";
import {
  buildTextEditReviewReport,
  canApplyTextEditReview,
  deriveTextEditGate,
  detectsPositionalSpaceRisk,
  findTextMatchesInPages,
  formatReplaceTextResult,
  type PendingTextReplacement,
  type TextEditGate,
  type TextEditMatch,
  type TextEditReviewReport,
} from "../lib/textEdit";
import {
  captureCurrentTextSelection,
  resolveSelectedTextTarget,
  selectionForReplacement,
  type CapturedTextSelection,
} from "../lib/selectedTextEdit";
import type { SignatureInvalidationNotice } from "./useDocument";

const SEARCH_DEBOUNCE_MS = 250;

interface TextEditSource {
  bytes: Uint8Array | null;
  proxy: PDFDocumentProxy | null;
}

export type TextEditPhase = "idle" | "staging" | "review" | "applying" | "done" | "error";

export interface TextEditStagedResult {
  bytes: Uint8Array;
  warnings: readonly PdfReplaceTextWarning[];
  replacedCounts: readonly number[] | null;
  report: TextEditReviewReport;
  originalPages: readonly ExtractedPageText[];
  candidatePages: readonly ExtractedPageText[];
  signatureInvalidationNotice: SignatureInvalidationNotice | null;
  sourceOpenToken: number;
  sourceGeneration: number;
}

export interface SelectedReplacementGateResult {
  blocked: boolean;
  reason: string | null;
}

export interface TextEditState {
  find: string;
  replace: string;
  wholeWord: boolean;
  matches: readonly TextEditMatch[];
  activeMatch: TextEditMatch | null;
  activeMatchIndex: number | null;
  matchLabel: string;
  pendingOps: readonly PendingTextReplacement[];
  phase: TextEditPhase;
  gate: TextEditGate;
  message: string | null;
  staged: TextEditStagedResult | null;
  positionalSpaceRisk: boolean;
  selectionResolving: boolean;
  selectedReplacementText: string | null;
  /** True from selection capture through its review. This is deliberately a
   * separate interaction, never a variant of Find/Replace All. */
  isSelectedReplacementMode: boolean;
  /** Bumped on every stored selection capture — the mode bar keys its
   * focus-the-replace-field effect on this so consecutive captures of
   * identical text still focus. */
  selectionPrimeCount: number;
  setFind: (find: string) => void;
  setReplace: (replace: string) => void;
  setWholeWord: (wholeWord: boolean) => void;
  captureSelectedText: () => void;
  /** Context-menu entry point: gate-checked variant of captureSelectedText
   * for a selection captured at menu-build time. Returns false (with a
   * status message) when the gate blocks. */
  primeSelectedReplacement: (selection: CapturedTextSelection) => boolean;
  /** Surface a host-provided status line in the text-edit message slot
   * (e.g. "reselect the text to replace" after the annotation prompt). */
  showMessage: (message: string) => void;
  /** Single authority for "can a selected replacement start on this page
   * right now" — used for the context-menu disabled state and re-checked at
   * click time. */
  selectedReplacementGate: (pageIndex: number) => SelectedReplacementGateResult;
  queueReplaceAll: () => void;
  queueSelectedReplacement: () => Promise<void>;
  removePendingOp: (id: string) => void;
  clear: () => void;
  goToNext: () => void;
  goToPrevious: () => void;
  review: () => Promise<void>;
  apply: () => Promise<void>;
  cancelReview: () => void;
}

export interface TextEditEngineReplacementOptions {
  engineBridge: Pick<EngineBridge, "replaceSelectedText" | "replaceText">;
  sourceBytes: Uint8Array;
  operations: readonly PendingTextReplacement[];
  allowSignatureInvalidation?: boolean;
  allowPdfAIdentificationRemoval?: boolean;
}

export interface TextEditEngineReplacementResult {
  bytes: Uint8Array;
  replacedCounts: readonly number[] | null;
  warnings: readonly PdfReplaceTextWarning[];
}

export async function runTextEditEngineReplacement({
  engineBridge,
  sourceBytes,
  operations,
  allowSignatureInvalidation = false,
  allowPdfAIdentificationRemoval = false,
}: TextEditEngineReplacementOptions): Promise<TextEditEngineReplacementResult> {
  const selectedOperation = operations.length === 1 ? operations[0] : null;
  if (operations.some((operation) => Boolean(operation.target)) && !selectedOperation?.target) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "Selected-text edits must be reviewed by themselves.",
    );
  }

  if (selectedOperation?.target) {
    return {
      ...(await engineBridge.replaceSelectedText(sourceBytes, {
        target: selectedOperation.target,
        replacement: selectedOperation.replace,
        ...(allowSignatureInvalidation ? { allowSignatureInvalidation: true } : {}),
        ...(allowPdfAIdentificationRemoval ? { allowPdfAIdentificationRemoval: true } : {}),
      })),
      replacedCounts: null,
    };
  }

  return engineBridge.replaceText(sourceBytes, {
    operations: operations.map(({ find, replace }) => ({ find, replace })),
    wholeWord: operations.every((operation) => operation.wholeWord),
    pageIndexes: "all",
    ...(allowSignatureInvalidation ? { allowSignatureInvalidation: true } : {}),
    ...(allowPdfAIdentificationRemoval ? { allowPdfAIdentificationRemoval: true } : {}),
  });
}

export function unsafeSelectedTextPageIndexes(
  textLayerCoverage: TextLayerCoverage | null,
): ReadonlySet<number> {
  return new Set([
    ...(textLayerCoverage?.imageOnlyPages ?? []),
    ...((textLayerCoverage?.trivialTextImagePages ?? []).map((page) => page.pageIndex)),
    ...((textLayerCoverage?.garbledPages ?? []).map((page) => page.pageIndex)),
  ]);
}

export function selectedTextReviewGateMessage(
  operations: readonly PendingTextReplacement[],
  unsafePageIndexes: ReadonlySet<number>,
): string | null {
  const selectedOperation = operations.length === 1 ? operations[0] : null;

  if (operations.some((operation) => Boolean(operation.target)) && !selectedOperation?.target) {
    return "Selected-text edits must be reviewed by themselves.";
  }

  if (selectedOperation?.target && unsafePageIndexes.has(selectedOperation.target.pageIndex)) {
    return "Selected-text editing is not available on pages with scanned or unreliable text layers.";
  }

  return null;
}

export function useTextEdit({
  source,
  documentGeneration,
  sourceOpenToken,
  streamed,
  textLayerCoverage,
  engineBridge,
  replaceBytes,
  fileName,
  confirmSignatureInvalidation,
  confirmPdfAIdentificationRemoval,
  setCurrentPage,
}: {
  source: TextEditSource;
  documentGeneration: number;
  sourceOpenToken: number;
  streamed: boolean;
  textLayerCoverage: TextLayerCoverage | null;
  engineBridge: Pick<
    EngineBridge,
    "available" | "warmEngine" | "inspectTextMap" | "replaceSelectedText" | "replaceText"
  >;
  replaceBytes: (bytes: Uint8Array, options: {
    dirty: boolean;
    hasTextLayer: boolean | null;
    expectedOpenToken: number;
    expectedGeneration: number;
    fileName?: string;
    filePath: string | null;
    signatureInvalidationNotice?: SignatureInvalidationNotice | null;
  }) => Promise<ReplaceBytesResult>;
  fileName: string | null;
  confirmSignatureInvalidation: () => Promise<SignatureInvalidationNotice | null>;
  confirmPdfAIdentificationRemoval: () => Promise<boolean>;
  setCurrentPage: (page: number) => void;
}): TextEditState {
  const [find, setFindState] = useState("");
  const [replace, setReplace] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  const [debouncedFind, setDebouncedFind] = useState("");
  const [pages, setPages] = useState<readonly ExtractedPageText[]>([]);
  const [matches, setMatches] = useState<readonly TextEditMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState<number | null>(null);
  const [pendingOps, setPendingOps] = useState<PendingTextReplacement[]>([]);
  const [phase, setPhase] = useState<TextEditPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [staged, setStaged] = useState<TextEditStagedResult | null>(null);
  const [selectionResolving, setSelectionResolving] = useState(false);
  const [selectionPrimeCount, setSelectionPrimeCount] = useState(0);
  const runRef = useRef(0);
  const reviewRunRef = useRef(0);
  const reviewInFlightRef = useRef(false);
  const stageOperationsRef = useRef<(operations: readonly PendingTextReplacement[]) => Promise<void>>(
    async () => undefined,
  );
  const opIdRef = useRef(0);
  const sourceRef = useRef(source);
  const generationRef = useRef(documentGeneration);
  const openTokenRef = useRef(sourceOpenToken);
  const pendingOpsRef = useRef<readonly PendingTextReplacement[]>([]);
  const selectionResolvingRef = useRef(false);
  const selectedReplacementRef = useRef<CapturedTextSelection | null>(null);
  const [selectedReplacementText, setSelectedReplacementText] = useState<string | null>(null);
  const [isSelectedReplacementMode, setIsSelectedReplacementMode] = useState(false);

  // Keep invalidation identities current during render, rather than waiting
  // for an effect. A document switch that lands while inspect/staging is
  // resolving must make that completion stale in the same commit.
  sourceRef.current = source;
  generationRef.current = documentGeneration;
  openTokenRef.current = sourceOpenToken;

  useEffect(() => {
    sourceRef.current = source;
  }, [source.bytes, source.proxy]);

  useEffect(() => {
    generationRef.current = documentGeneration;
    openTokenRef.current = sourceOpenToken;
  }, [documentGeneration, sourceOpenToken]);

  useEffect(() => {
    pendingOpsRef.current = pendingOps;
  }, [pendingOps]);

  const gate = useMemo(
    () => deriveTextEditGate({
      hasDocument: Boolean(source.proxy),
      streamed,
      textLayerCoverage,
      engineAvailable: engineBridge.available,
    }),
    [engineBridge.available, source.proxy, streamed, textLayerCoverage],
  );

  const excludedPageIndexes = useMemo(
    () => new Set(textLayerCoverage?.imageOnlyPages ?? []),
    [textLayerCoverage],
  );
  const unsafeSelectedPageIndexes = useMemo(
    () => unsafeSelectedTextPageIndexes(textLayerCoverage),
    [textLayerCoverage],
  );

  const clear = useCallback(() => {
    runRef.current += 1;
    reviewInFlightRef.current = false;
    setFindState("");
    setReplace("");
    setDebouncedFind("");
    setMatches([]);
    setActiveMatchIndex(null);
    pendingOpsRef.current = [];
    setPendingOps([]);
    setPhase("idle");
    setMessage(null);
    setStaged(null);
    setSelectionResolving(false);
    selectionResolvingRef.current = false;
    selectedReplacementRef.current = null;
    setSelectedReplacementText(null);
    setIsSelectedReplacementMode(false);
  }, []);

  useEffect(() => {
    clear();
    setPages([]);
  }, [clear, documentGeneration, sourceOpenToken]);

  const setFind = useCallback((nextFind: string) => {
    runRef.current += 1;
    setFindState(nextFind);
    setMatches([]);
    setActiveMatchIndex(null);
  }, []);

  useEffect(() => {
    const trimmed = find.trim();
    if (!trimmed) {
      setDebouncedFind("");
      return;
    }

    const timeoutId = window.setTimeout(() => setDebouncedFind(trimmed), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [find]);

  useEffect(() => {
    const currentSource = source;
    const runId = runRef.current + 1;
    runRef.current = runId;

    if (!currentSource.proxy || !currentSource.bytes || gate.blocked) {
      setPages([]);
      return;
    }

    void extractPageText({ bytes: currentSource.bytes, pdfDocument: currentSource.proxy })
      .then((nextPages) => {
        if (runRef.current !== runId || generationRef.current !== documentGeneration) {
          return;
        }
        setPages(nextPages);
      })
      .catch(() => {
        if (runRef.current !== runId) {
          return;
        }
        setPages([]);
        setMessage("RaioPDF could not read this document's text layer.");
      });
  }, [documentGeneration, gate.blocked, source.bytes, source.proxy]);

  useEffect(() => {
    if (pendingOps.some((operation) => operation.target)) {
      return;
    }

    if (!debouncedFind || pages.length === 0) {
      setMatches([]);
      setActiveMatchIndex(null);
      return;
    }

    const previewOp: PendingTextReplacement = {
      id: "preview",
      find: debouncedFind,
      replace,
      wholeWord,
      pageIndexes: "all",
    };
    const nextMatches = findTextMatchesInPages(pages, previewOp, { excludedPageIndexes });
    setMatches(nextMatches);
    setActiveMatchIndex(nextMatches.length > 0 ? 0 : null);
  }, [debouncedFind, excludedPageIndexes, pages, pendingOps, replace, wholeWord]);

  const positionalSpaceRisk = useMemo(
    () => detectsPositionalSpaceRisk(pages, find),
    [find, pages],
  );

  const queueReplaceAll = useCallback(() => {
    const trimmedFind = find.trim();
    if (!trimmedFind || gate.blocked) {
      return;
    }

    if (selectionResolvingRef.current) {
      setMessage("Wait for the selected text to resolve before queuing another replacement.");
      return;
    }

    if (pendingOpsRef.current.some((operation) => operation.target)) {
      setMessage("Review or clear the selected-text edit before queuing bulk replacements.");
      return;
    }

    opIdRef.current += 1;
    const operation: PendingTextReplacement = {
      id: `text-edit-${opIdRef.current}`,
      find: trimmedFind,
      replace,
      wholeWord,
      pageIndexes: "all",
    };

    setPendingOps((current) => [...current, operation]);
    pendingOpsRef.current = [...pendingOpsRef.current, operation];
    selectedReplacementRef.current = null;
    setSelectedReplacementText(null);
    setIsSelectedReplacementMode(false);
    setPhase("idle");
    setMessage(null);
    setStaged(null);
    engineBridge.warmEngine();
  }, [engineBridge, find, gate.blocked, replace, wholeWord]);

  // Single authority for "can a selected replacement start on this page right
  // now". Click-time freshness comes from EditLayer's latest-value ref
  // dispatch: a stale open menu always calls the newest closure of this gate.
  const selectedReplacementGate = useCallback((pageIndex: number): SelectedReplacementGateResult => {
    if (gate.blocked) {
      return { blocked: true, reason: gate.message };
    }
    if (unsafeSelectedPageIndexes.has(pageIndex)) {
      return {
        blocked: true,
        reason: "Selected-text editing is not available on pages with scanned or unreliable text layers.",
      };
    }
    if (pendingOpsRef.current.length > 0) {
      return { blocked: true, reason: "Review or clear queued replacements before adding a selected-text edit." };
    }
    if (selectionResolvingRef.current) {
      return { blocked: true, reason: "Selected text is already being resolved." };
    }
    if (phase === "staging" || phase === "applying") {
      return { blocked: true, reason: "Wait for the current review to finish before selecting new text." };
    }
    return { blocked: false, reason: null };
  }, [gate.blocked, gate.message, phase, unsafeSelectedPageIndexes]);

  const storeSelectedReplacement = useCallback((selection: CapturedTextSelection) => {
    selectedReplacementRef.current = selection;
    setSelectedReplacementText(selection.text);
    setIsSelectedReplacementMode(true);
    setSelectionPrimeCount((count) => count + 1);
    setMessage(`Selected "${selection.text}" for replacement.`);
  }, []);

  const captureSelectedText = useCallback(() => {
    const captured = captureCurrentTextSelection();
    if (!captured.ok) {
      return;
    }

    const entryGate = selectedReplacementGate(captured.selection.pageIndex);
    if (entryGate.blocked) {
      if (entryGate.reason) {
        setMessage(entryGate.reason);
      }
      return;
    }

    storeSelectedReplacement(captured.selection);
  }, [selectedReplacementGate, storeSelectedReplacement]);

  const primeSelectedReplacement = useCallback((selection: CapturedTextSelection) => {
    const entryGate = selectedReplacementGate(selection.pageIndex);
    if (entryGate.blocked) {
      if (entryGate.reason) {
        setMessage(entryGate.reason);
      }
      return false;
    }

    storeSelectedReplacement(selection);
    return true;
  }, [selectedReplacementGate, storeSelectedReplacement]);

  const queueSelectedReplacement = useCallback(async () => {
    const currentSource = sourceRef.current;
    const sourceBytes = currentSource.bytes;

    if (!sourceBytes || !currentSource.proxy) {
      setMessage("Open a PDF before editing document text.");
      return;
    }

    const queuedSelection = selectionForReplacement(
      captureCurrentTextSelection(),
      selectedReplacementRef.current,
    );
    if (!queuedSelection.ok) {
      setMessage(queuedSelection.message);
      return;
    }
    const selectedText = queuedSelection.selection;

    // One gate for every entry point (context menu, mode-bar button, direct
    // call) — the eligibility rules and their copy live only there.
    const entryGate = selectedReplacementGate(selectedText.pageIndex);
    if (entryGate.blocked) {
      setMessage(entryGate.reason);
      return;
    }

    const runId = runRef.current + 1;
    runRef.current = runId;
    selectionResolvingRef.current = true;
    setSelectionResolving(true);
    setMessage("Resolving selected text...");
    setPhase("idle");
    setStaged(null);

    try {
      const textMap = await engineBridge.inspectTextMap(sourceBytes, {
        pageIndexes: [selectedText.pageIndex],
      });

      if (runRef.current !== runId) {
        return;
      }

      const resolved = resolveSelectedTextTarget(selectedText, textMap);
      if (!resolved.ok) {
        setMessage(resolved.message);
        return;
      }

      if (pendingOpsRef.current.length > 0) {
        setMessage("Selected text was not queued because another replacement was added first.");
        return;
      }

      opIdRef.current += 1;
      const operation: PendingTextReplacement = {
        id: `selected-text-edit-${opIdRef.current}`,
        find: resolved.target.expectedText,
        replace,
        wholeWord: false,
        pageIndexes: [resolved.target.pageIndex],
        target: resolved.target,
        selectedArea: resolved.area,
      };

      // Lock the exact resolved operation before scheduling React state. A
      // second click in this same event turn must not be able to race a
      // duplicate selected edit into the engine.
      pendingOpsRef.current = [operation];
      setPendingOps([operation]);
      setMatches([{
        id: `${operation.id}-selected`,
        operationId: operation.id,
        pageIndex: resolved.target.pageIndex,
        area: resolved.area,
        excerpt: resolved.target.expectedText,
      }]);
      setActiveMatchIndex(0);
      setCurrentPage(resolved.target.pageIndex + 1);
      window.getSelection()?.removeAllRanges();
      selectedReplacementRef.current = null;
      setSelectedReplacementText(resolved.target.expectedText);
      setMessage(null);
      engineBridge.warmEngine();
      // Target resolution is complete before staging takes ownership of the
      // run id. Clear this synchronously; the queue callback's finally block
      // intentionally ignores superseded runs.
      selectionResolvingRef.current = false;
      setSelectionResolving(false);
      // Selected text does not wait for the sidebar's generic Review action:
      // resolving the exact engine target and staging that target is one
      // transaction. This intentionally does not call review() after
      // setPendingOps(), where React's asynchronous state would be a race.
      await stageOperationsRef.current([operation]);
    } catch (error) {
      if (runRef.current !== runId) {
        return;
      }

      setMessage(textEditErrorMessage(error));
    } finally {
      if (runRef.current === runId) {
        selectionResolvingRef.current = false;
        setSelectionResolving(false);
      }
    }
  }, [engineBridge, replace, selectedReplacementGate, setCurrentPage]);

  const removePendingOp = useCallback((id: string) => {
    const removed = pendingOpsRef.current.find((operation) => operation.id === id);
    const nextOperations = pendingOpsRef.current.filter((operation) => operation.id !== id);
    pendingOpsRef.current = nextOperations;
    setPendingOps(nextOperations);
    setStaged(null);
    setPhase("idle");
    selectedReplacementRef.current = null;
    setSelectedReplacementText(null);
    if (removed?.target) {
      setMatches([]);
      setActiveMatchIndex(null);
      setIsSelectedReplacementMode(false);
    }
  }, []);

  const goToResult = useCallback((index: number) => {
    if (matches.length === 0) {
      return;
    }

    const normalizedIndex = (index + matches.length) % matches.length;
    setActiveMatchIndex(normalizedIndex);
    const match = matches[normalizedIndex];
    if (match) {
      setCurrentPage(match.pageIndex + 1);
    }
  }, [matches, setCurrentPage]);

  const goToNext = useCallback(() => {
    goToResult(activeMatchIndex === null ? 0 : activeMatchIndex + 1);
  }, [activeMatchIndex, goToResult]);

  const goToPrevious = useCallback(() => {
    goToResult(activeMatchIndex === null ? matches.length - 1 : activeMatchIndex - 1);
  }, [activeMatchIndex, goToResult, matches.length]);

  const stageOperations = useCallback(async (operations: readonly PendingTextReplacement[]) => {
    const currentSource = sourceRef.current;
    const sourceBytes = currentSource.bytes;
    const sourceProxy = currentSource.proxy;
    const reviewOpenToken = openTokenRef.current;
    const reviewGeneration = generationRef.current;

    if (gate.blocked) {
      setMessage(gate.message);
      return;
    }

    if (!sourceBytes || !sourceProxy) {
      setMessage("Open a PDF before editing document text.");
      return;
    }

    if (operations.length === 0) {
      setMessage("Queue at least one replacement before review.");
      return;
    }

    // This ref is set synchronously, before the first await. It coalesces
    // double activation from keyboard/pointer events and protects selected
    // replacement from being staged twice before React has rendered phase.
    if (reviewInFlightRef.current) {
      return;
    }

    const selectedGate = selectedTextReviewGateMessage(operations, unsafeSelectedPageIndexes);
    if (selectedGate) {
      setMessage(selectedGate);
      return;
    }

    const runId = runRef.current + 1;
    runRef.current = runId;
    reviewRunRef.current = runId;
    reviewInFlightRef.current = true;
    setPhase("staging");
    setMessage(null);
    setStaged(null);

    let signatureInvalidationNotice: SignatureInvalidationNotice | null = null;
    let allowSignatureInvalidation = false;
    let allowPdfAIdentificationRemoval = false;

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await runTextEditEngineReplacement({
            engineBridge,
            sourceBytes,
            operations,
            allowSignatureInvalidation,
            allowPdfAIdentificationRemoval,
          });

          if (
            runRef.current !== runId ||
            openTokenRef.current !== reviewOpenToken ||
            generationRef.current !== reviewGeneration
          ) {
            return;
          }

          const originalPages = await extractPageText({ bytes: sourceBytes, pdfDocument: sourceProxy });
          const candidatePdf = await loadPdfDocument(result.bytes);
          let candidatePages: readonly ExtractedPageText[] = [];
          try {
            candidatePages = await extractPageText({ bytes: result.bytes, pdfDocument: candidatePdf });
          } finally {
            await candidatePdf.loadingTask.destroy();
          }

          if (
            runRef.current !== runId ||
            openTokenRef.current !== reviewOpenToken ||
            generationRef.current !== reviewGeneration
          ) {
            return;
          }

          const report = buildTextEditReviewReport({
            operations,
            originalPages,
            candidatePages,
          });

          setStaged({
            bytes: result.bytes,
            warnings: result.warnings,
            replacedCounts: result.replacedCounts,
            report,
            originalPages,
            candidatePages,
            signatureInvalidationNotice,
            sourceOpenToken: reviewOpenToken,
            sourceGeneration: reviewGeneration,
          });
          setPhase("review");
          setMessage(formatReplaceTextResult(report));
          return;
        } catch (error) {
          if (
            error instanceof PdfEngineError &&
            error.code === "SIGNED_DOCUMENT" &&
            !allowSignatureInvalidation
          ) {
            signatureInvalidationNotice = await confirmSignatureInvalidation();
            if (
              runRef.current !== runId ||
              openTokenRef.current !== reviewOpenToken ||
              generationRef.current !== reviewGeneration
            ) {
              return;
            }
            if (!signatureInvalidationNotice) {
              setPhase("idle");
              setMessage("Text editing was cancelled; the signed document was not modified.");
              return;
            }
            allowSignatureInvalidation = true;
            continue;
          }

          if (
            error instanceof PdfEngineError &&
            error.code === "UNSUPPORTED" &&
            /pdf\/a|pdfa|conformance/i.test(error.message) &&
            !allowPdfAIdentificationRemoval
          ) {
            const confirmed = await confirmPdfAIdentificationRemoval();
            if (
              runRef.current !== runId ||
              openTokenRef.current !== reviewOpenToken ||
              generationRef.current !== reviewGeneration
            ) {
              return;
            }
            if (!confirmed) {
              setPhase("idle");
              setMessage("Text editing was cancelled; the PDF/A (archival format) document was not modified.");
              return;
            }
            allowPdfAIdentificationRemoval = true;
            continue;
          }

          throw error;
        }
      }
    } catch (error) {
      // Terminal errors land here, including confirmation callbacks that
      // themselves throw (e.g. the shell denying a native dialog).
      if (runRef.current === runId) {
        setPhase("error");
        setMessage(textEditErrorMessage(error));
      }
    } finally {
      // The invariant this defends: "staging" must never outlive the run
      // that owns it, or the review dialog spins forever with no work in
      // flight. Every exit path funnels through here — completed reviews,
      // cancels, and errors have already moved phase off "staging", so the
      // demotion only fires for a superseded run's stale bail-outs, and only
      // when no newer review() call has taken ownership of the phase.
      if (reviewRunRef.current === runId) {
        reviewInFlightRef.current = false;
        setPhase((current) => (current === "staging" ? "idle" : current));
      }
    }
  }, [
    confirmPdfAIdentificationRemoval,
    confirmSignatureInvalidation,
    engineBridge,
    gate.blocked,
    gate.message,
    unsafeSelectedPageIndexes,
  ]);

  // The selected path is created above this callback. Updating this ref on
  // every render gives it the current gate/source closures without routing it
  // through the public bulk review action.
  stageOperationsRef.current = stageOperations;

  const review = useCallback(async () => {
    await stageOperations(pendingOpsRef.current);
  }, [stageOperations]);

  const apply = useCallback(async () => {
    const candidate = staged;
    if (!candidate) {
      return;
    }

    if (!canApplyTextEditReview(candidate.report)) {
      setMessage(candidate.report.zeroChange
        ? formatReplaceTextResult(candidate.report)
        : "The staged PDF did not verify every queued replacement. The result was not applied.");
      return;
    }

    setPhase("applying");
    let replaced: ReplaceBytesResult;
    try {
      replaced = await replaceBytes(candidate.bytes, {
        dirty: true,
        hasTextLayer: null,
        expectedOpenToken: candidate.sourceOpenToken,
        expectedGeneration: candidate.sourceGeneration,
        ...(fileName ? { fileName } : {}),
        filePath: null,
        signatureInvalidationNotice: candidate.signatureInvalidationNotice,
      });
    } catch (error) {
      // A rejection here would otherwise leave phase at "applying" forever.
      setPhase("error");
      setMessage(textEditErrorMessage(error));
      return;
    }

    if (replaced !== "replaced") {
      setPhase("error");
      setMessage(
        replaced === "stale"
          ? "The document changed before text editing finished. The result was not applied."
          : "The edited PDF could not be opened. The document was left unchanged.",
      );
      return;
    }

    const firstPageIndex = candidate.report.changedPageIndexes[0];
    if (firstPageIndex !== undefined) {
      setCurrentPage(firstPageIndex + 1);
    }

    setPendingOps([]);
    pendingOpsRef.current = [];
    setStaged(null);
    setPhase("done");
    setIsSelectedReplacementMode(false);
    setSelectedReplacementText(null);
    setMessage(formatReplaceTextResult(candidate.report));
  }, [fileName, replaceBytes, setCurrentPage, staged]);

  const cancelReview = useCallback(() => {
    runRef.current += 1;
    reviewInFlightRef.current = false;
    selectionResolvingRef.current = false;
    setSelectionResolving(false);
    setStaged(null);
    setPhase("idle");
    // Cancelling a selected review discards its resolved target and returns
    // to bulk Find/Replace. Reusing a browser selection after a cancelled
    // review is unsafe because focus/document state may already have moved;
    // the user deliberately selects it again to start a new transaction.
    if (pendingOpsRef.current.some((operation) => operation.target)) {
      pendingOpsRef.current = [];
      setPendingOps([]);
      selectedReplacementRef.current = null;
      setSelectedReplacementText(null);
      setIsSelectedReplacementMode(false);
      setMatches([]);
      setActiveMatchIndex(null);
    }
    setMessage("Review cancelled. The document was not modified.");
  }, []);

  const matchLabel = useMemo(() => {
    if (!find.trim()) {
      return "";
    }
    if (matches.length === 0 || activeMatchIndex === null) {
      return "0 estimated matches";
    }
    return `${activeMatchIndex + 1} of ${matches.length} estimated matches`;
  }, [activeMatchIndex, find, matches.length]);

  return {
    find,
    replace,
    wholeWord,
    matches,
    activeMatch: activeMatchIndex === null ? null : matches[activeMatchIndex] ?? null,
    activeMatchIndex,
    matchLabel,
    pendingOps,
    phase,
    gate,
    message,
    staged,
    positionalSpaceRisk,
    selectionResolving,
    selectedReplacementText,
    isSelectedReplacementMode,
    selectionPrimeCount,
    setFind,
    setReplace,
    setWholeWord,
    captureSelectedText,
    primeSelectedReplacement,
    selectedReplacementGate,
    showMessage: setMessage,
    queueReplaceAll,
    queueSelectedReplacement,
    removePendingOp,
    clear,
    goToNext,
    goToPrevious,
    review,
    apply,
    cancelReview,
  };
}

function textEditErrorMessage(error: unknown): string {
  if (error instanceof PdfEngineError) {
    if (error.code === "ENCRYPTED_DOCUMENT") {
      return "Text editing isn't available for permissions-protected PDFs in this version.";
    }
    return error.message || "Text editing could not finish. The document was left unchanged.";
  }

  return error instanceof Error
    ? error.message
    : "Text editing could not finish. The document was left unchanged.";
}
