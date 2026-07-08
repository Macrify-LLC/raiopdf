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
  setFind: (find: string) => void;
  setReplace: (replace: string) => void;
  setWholeWord: (wholeWord: boolean) => void;
  captureSelectedText: () => void;
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
  const runRef = useRef(0);
  const opIdRef = useRef(0);
  const sourceRef = useRef(source);
  const generationRef = useRef(documentGeneration);
  const openTokenRef = useRef(sourceOpenToken);
  const pendingOpsRef = useRef<readonly PendingTextReplacement[]>([]);
  const selectionResolvingRef = useRef(false);
  const selectedReplacementRef = useRef<CapturedTextSelection | null>(null);
  const [selectedReplacementText, setSelectedReplacementText] = useState<string | null>(null);

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
    setFindState("");
    setReplace("");
    setDebouncedFind("");
    setMatches([]);
    setActiveMatchIndex(null);
    setPendingOps([]);
    setPhase("idle");
    setMessage(null);
    setStaged(null);
    setSelectionResolving(false);
    selectionResolvingRef.current = false;
    selectedReplacementRef.current = null;
    setSelectedReplacementText(null);
  }, []);

  useEffect(() => {
    clear();
    setPages([]);
  }, [clear, documentGeneration]);

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
    selectedReplacementRef.current = null;
    setSelectedReplacementText(null);
    setPhase("idle");
    setMessage(null);
    setStaged(null);
    engineBridge.warmEngine();
  }, [engineBridge, find, gate.blocked, replace, wholeWord]);

  const captureSelectedText = useCallback(() => {
    const captured = captureCurrentTextSelection();
    if (!captured.ok) {
      return;
    }

    selectedReplacementRef.current = captured.selection;
    setSelectedReplacementText(captured.selection.text);
    setMessage(`Selected "${captured.selection.text}" for replacement.`);
  }, []);

  const queueSelectedReplacement = useCallback(async () => {
    const currentSource = sourceRef.current;
    const sourceBytes = currentSource.bytes;

    if (gate.blocked) {
      setMessage(gate.message);
      return;
    }

    if (!sourceBytes || !currentSource.proxy) {
      setMessage("Open a PDF before editing document text.");
      return;
    }

    if (selectionResolvingRef.current) {
      setMessage("Selected text is already being resolved.");
      return;
    }

    if (pendingOpsRef.current.length > 0) {
      setMessage("Review or clear queued replacements before adding a selected-text edit.");
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

    if (unsafeSelectedPageIndexes.has(selectedText.pageIndex)) {
      setMessage("Selected-text editing is not available on pages with scanned or unreliable text layers.");
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
      setSelectedReplacementText(null);
      setMessage(null);
      engineBridge.warmEngine();
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
  }, [engineBridge, gate.blocked, gate.message, replace, setCurrentPage, unsafeSelectedPageIndexes]);

  const removePendingOp = useCallback((id: string) => {
    const removed = pendingOpsRef.current.find((operation) => operation.id === id);
    setPendingOps((current) => current.filter((operation) => operation.id !== id));
    setStaged(null);
    setPhase("idle");
    selectedReplacementRef.current = null;
    setSelectedReplacementText(null);
    if (removed?.target) {
      setMatches([]);
      setActiveMatchIndex(null);
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

  const review = useCallback(async () => {
    const currentSource = sourceRef.current;
    const sourceBytes = currentSource.bytes;
    const sourceProxy = currentSource.proxy;
    const operations = pendingOps;
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

    const selectedGate = selectedTextReviewGateMessage(operations, unsafeSelectedPageIndexes);
    if (selectedGate) {
      setMessage(selectedGate);
      return;
    }

    const runId = runRef.current + 1;
    runRef.current = runId;
    setPhase("staging");
    setMessage(null);
    setStaged(null);

    let signatureInvalidationNotice: SignatureInvalidationNotice | null = null;
    let allowSignatureInvalidation = false;
    let allowPdfAIdentificationRemoval = false;

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
          if (!confirmed) {
            setPhase("idle");
            setMessage("Text editing was cancelled; the PDF/A (archival format) document was not modified.");
            return;
          }
          allowPdfAIdentificationRemoval = true;
          continue;
        }

        if (runRef.current !== runId) {
          return;
        }

        setPhase("error");
        setMessage(textEditErrorMessage(error));
        return;
      }
    }
  }, [
    confirmPdfAIdentificationRemoval,
    confirmSignatureInvalidation,
    engineBridge,
    gate.blocked,
    gate.message,
    pendingOps,
    unsafeSelectedPageIndexes,
  ]);

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
    const replaced = await replaceBytes(candidate.bytes, {
      dirty: true,
      hasTextLayer: null,
      expectedOpenToken: candidate.sourceOpenToken,
      expectedGeneration: candidate.sourceGeneration,
      ...(fileName ? { fileName } : {}),
      filePath: null,
      signatureInvalidationNotice: candidate.signatureInvalidationNotice,
    });

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
    setStaged(null);
    setPhase("done");
    setMessage(formatReplaceTextResult(candidate.report));
  }, [fileName, replaceBytes, setCurrentPage, staged]);

  const cancelReview = useCallback(() => {
    runRef.current += 1;
    setStaged(null);
    setPhase("idle");
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
    setFind,
    setReplace,
    setWholeWord,
    captureSelectedText,
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
