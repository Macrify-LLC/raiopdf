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
  deriveTextEditGate,
  detectsPositionalSpaceRisk,
  findTextMatchesInPages,
  formatReplaceTextResult,
  type PendingTextReplacement,
  type TextEditGate,
  type TextEditMatch,
  type TextEditReviewReport,
} from "../lib/textEdit";
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
  setFind: (find: string) => void;
  setReplace: (replace: string) => void;
  setWholeWord: (wholeWord: boolean) => void;
  queueReplaceAll: () => void;
  removePendingOp: (id: string) => void;
  clear: () => void;
  goToNext: () => void;
  goToPrevious: () => void;
  review: () => Promise<void>;
  apply: () => Promise<void>;
  cancelReview: () => void;
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
  engineBridge: Pick<EngineBridge, "available" | "warmEngine" | "replaceText">;
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
  const runRef = useRef(0);
  const opIdRef = useRef(0);
  const sourceRef = useRef(source);
  const generationRef = useRef(documentGeneration);
  const openTokenRef = useRef(sourceOpenToken);

  useEffect(() => {
    sourceRef.current = source;
  }, [source.bytes, source.proxy]);

  useEffect(() => {
    generationRef.current = documentGeneration;
    openTokenRef.current = sourceOpenToken;
  }, [documentGeneration, sourceOpenToken]);

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
  }, [debouncedFind, excludedPageIndexes, pages, replace, wholeWord]);

  const positionalSpaceRisk = useMemo(
    () => detectsPositionalSpaceRisk(pages, find),
    [find, pages],
  );

  const queueReplaceAll = useCallback(() => {
    const trimmedFind = find.trim();
    if (!trimmedFind || gate.blocked) {
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
    setPhase("idle");
    setMessage(null);
    setStaged(null);
    engineBridge.warmEngine();
  }, [engineBridge, find, gate.blocked, replace, wholeWord]);

  const removePendingOp = useCallback((id: string) => {
    setPendingOps((current) => current.filter((operation) => operation.id !== id));
    setStaged(null);
    setPhase("idle");
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
        const result = await engineBridge.replaceText(sourceBytes, {
          operations: operations.map(({ find, replace }) => ({ find, replace })),
          wholeWord: operations.every((operation) => operation.wholeWord),
          pageIndexes: "all",
          ...(allowSignatureInvalidation ? { allowSignatureInvalidation: true } : {}),
          ...(allowPdfAIdentificationRemoval ? { allowPdfAIdentificationRemoval: true } : {}),
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
            setMessage("Text editing was cancelled; the PDF/A document was not modified.");
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
  ]);

  const apply = useCallback(async () => {
    const candidate = staged;
    if (!candidate) {
      return;
    }

    if (candidate.report.zeroChange) {
      setMessage(formatReplaceTextResult(candidate.report));
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
    setFind,
    setReplace,
    setWholeWord,
    queueReplaceAll,
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
