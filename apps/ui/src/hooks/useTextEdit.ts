import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PdfEngineError,
  type PdfInspectTextMapResult,
  type PdfReplaceTextWarning,
} from "@raiopdf/engine-api";
import type { TextLayerCoverage } from "@raiopdf/rules";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { loadPdfDocument } from "../lib/pdfjs";
import { extractPageText, type ExtractedPageText } from "../lib/pageTextCache";
import { readPdfRange, type FileGrant } from "../lib/filePort";
import { materializePdfBytesGrant } from "../lib/dropMaterialize";
import { pathOpDocumentFacts, pathOpExtractPages, pathOpReleaseOutput, pathOpReplacePage, type PathOpOutput } from "../lib/pathOps";
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
  rangeGrant?: FileGrant | null;
  rangeFile?: boolean;
}

interface SelectedPageLocalSource {
  bytes: Uint8Array;
  originalPageIndex: number;
  /** Grant qpdf reads when splicing the edited page back into the source. */
  sourceGrant: FileGrant;
  /** The document-owned grant at capture time; null for a materialized byte source. */
  boundRangeGrant: FileGrant | null;
  /** True when this flow materialized an in-memory PDF and owns its temp grant. */
  ownsSourceGrant: boolean;
  openToken: number;
  generation: number;
}

const SELECTED_PAGE_MAX_BYTES = 32 * 1024 * 1024;

export type TextEditPhase = "idle" | "staging" | "review" | "applying" | "done" | "error";
export type TextEditActivity = "resolving-selection" | "building-preview" | null;

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
  pageLocal?: { sourceGrant: FileGrant; originalPageIndex: number };
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
  activity: TextEditActivity;
  gate: TextEditGate;
  /** Selection-scoped eligibility. Unlike `gate`, this deliberately ignores
   * whole-document page/byte limits when the native page-local lane exists. */
  selectedGate: TextEditGate;
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
        target: selectedOperation.engineTarget ?? selectedOperation.target,
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

function applyEngineTextMap(
  pages: readonly ExtractedPageText[],
  textMap: PdfInspectTextMapResult,
  pageLocalOriginalIndex?: number,
): readonly ExtractedPageText[] {
  const rawTextByPage = new Map(textMap.pages.map((page) => [
    pageLocalOriginalIndex ?? page.pageIndex,
    page.text,
  ]));

  return pages.map((page) => {
    const rawText = rawTextByPage.get(page.pageIndex);
    return rawText === undefined ? page : { ...page, flatText: rawText };
  });
}

function applyFlatTextOverride(
  pages: readonly ExtractedPageText[],
  pageIndex: number,
  flatText: string,
): readonly ExtractedPageText[] {
  return pages.map((page) => (
    page.pageIndex === pageIndex ? { ...page, flatText } : page
  ));
}

/**
 * Confirms the regenerated text object at the anchored engine element. Some
 * PDFs expand into a different set/order of text runs when the editor writes
 * them, so whole-page serialization equality is not a stable proof. The
 * affected element's source offsets, text, and page-space anchor prove that
 * the selected visual object contains the replacement. Element indexes are
 * only a fast path: the editor may insert or split unrelated runs.
 */
function verifiedSelectedCandidateText(
  operation: PendingTextReplacement,
  originalMap: PdfInspectTextMapResult,
  candidateMap: PdfInspectTextMapResult,
): string | null {
  const target = operation.engineTarget ?? operation.target;
  if (!target) {
    return null;
  }
  const originalPage = originalMap.pages.find((page) => page.pageIndex === target.pageIndex) ??
    (originalMap.pages.length === 1 ? originalMap.pages[0] : undefined);
  const candidatePage = candidateMap.pages.find((page) => page.pageIndex === target.pageIndex) ??
    (candidateMap.pages.length === 1 ? candidateMap.pages[0] : undefined);
  if (!originalPage || !candidatePage ||
    originalPage.text.slice(target.start, target.end) !== target.expectedText) {
    return null;
  }

  const originalFirst = originalPage.elements[target.firstElementIndex];
  const originalLast = originalPage.elements[target.lastElementIndex];
  if (!originalFirst || !originalLast) {
    return null;
  }

  if (target.firstElementIndex === target.lastElementIndex) {
    const expectedElement = `${originalFirst.text.slice(0, target.firstElementOffset)}` +
      `${operation.replace}${originalFirst.text.slice(target.lastElementOffset)}`;
    const indexedCandidate = candidatePage.elements[target.firstElementIndex];
    const matchingCandidates = candidatePage.elements.filter((element) =>
      element.text === expectedElement && sameTextAnchor(originalFirst.area, element.area));
    const candidateFirst = indexedCandidate?.text === expectedElement &&
      sameTextAnchor(originalFirst.area, indexedCandidate.area)
      ? indexedCandidate
      : matchingCandidates.length === 1 ? matchingCandidates[0] : undefined;
    if (!candidateFirst) {
      return null;
    }
  } else {
    const candidateFirst = candidatePage.elements[target.firstElementIndex];
    const candidateLast = candidatePage.elements[target.lastElementIndex];
    const expectedFirst = `${originalFirst.text.slice(0, target.firstElementOffset)}${operation.replace}`;
    const expectedLast = originalLast.text.slice(target.lastElementOffset);
    if (!candidateFirst || !candidateLast ||
      candidateFirst.text !== expectedFirst || candidateLast.text !== expectedLast ||
      !sameTextAnchor(originalFirst.area, candidateFirst.area) ||
      !sameTextAnchor(originalLast.area, candidateLast.area)) {
      return null;
    }
    for (let index = target.firstElementIndex + 1; index < target.lastElementIndex; index += 1) {
      if (candidatePage.elements[index]?.text !== "") {
        return null;
      }
    }
  }

  return `${originalPage.text.slice(0, target.start)}${operation.replace}${originalPage.text.slice(target.end)}`;
}

function sameTextAnchor(
  original: { x: number; y: number; w: number; h: number },
  candidate: { x: number; y: number; w: number; h: number },
): boolean {
  const xTolerance = Math.max(2, Math.min(original.w, candidate.w) * 0.2);
  const yTolerance = Math.max(2, Math.min(original.h, candidate.h) * 0.5);
  return Math.abs(original.x - candidate.x) <= xTolerance &&
    Math.abs(original.y - candidate.y) <= yTolerance;
}

function releaseSelectedPageLocal(
  ref: { current: SelectedPageLocalSource | null },
): void {
  const local = ref.current;
  ref.current = null;
  if (local?.ownsSourceGrant) {
    void pathOpReleaseOutput(local.sourceGrant).catch(() => undefined);
  }
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
  replacePathOutput,
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
    "available" | "warmEngine" | "stopEngine" | "inspectTextMap" | "replaceSelectedText" | "replaceText"
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
  /** App-owned reopen funnel for a fresh shell output grant. */
  replacePathOutput?: (output: PathOpOutput, options: { expectedOpenToken: number; expectedGeneration: number }) => Promise<ReplaceBytesResult>;
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
  const [activity, setActivity] = useState<TextEditActivity>(null);
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
  const engineWorkActiveRef = useRef(false);
  const selectedReplacementRef = useRef<CapturedTextSelection | null>(null);
  const selectedPageLocalRef = useRef<SelectedPageLocalSource | null>(null);
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
      pageCount: source.proxy?.numPages ?? 0,
      fileSizeBytes: source.bytes?.byteLength ?? 0,
    }),
    [engineBridge.available, source.bytes, source.proxy, streamed, textLayerCoverage],
  );

  // A selected rangeGrant edit is page-local. It is still subject to every
  // document safety gate except the whole-document streamed/size/page limits.
  const selectedGate = useMemo(
    () => deriveTextEditGate({
      hasDocument: Boolean(source.proxy),
      streamed: Boolean(source.rangeFile),
      textLayerCoverage,
      engineAvailable: engineBridge.available,
      pageCount: 0,
      fileSizeBytes: 0,
    }),
    [engineBridge.available, source.proxy, source.rangeFile, textLayerCoverage],
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
    if (engineWorkActiveRef.current) {
      engineWorkActiveRef.current = false;
      void engineBridge.stopEngine();
    }
    reviewInFlightRef.current = false;
    setFindState("");
    setReplace("");
    setDebouncedFind("");
    setMatches([]);
    setActiveMatchIndex(null);
    pendingOpsRef.current = [];
    setPendingOps([]);
    setPhase("idle");
    setActivity(null);
    setMessage(null);
    setStaged(null);
    setSelectionResolving(false);
    selectionResolvingRef.current = false;
    selectedReplacementRef.current = null;
    releaseSelectedPageLocal(selectedPageLocalRef);
    setSelectedReplacementText(null);
    setIsSelectedReplacementMode(false);
  }, [engineBridge.stopEngine]);

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
    if (selectedGate.blocked) {
      return { blocked: true, reason: selectedGate.message };
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
  }, [phase, selectedGate.blocked, selectedGate.message, unsafeSelectedPageIndexes]);

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
    if (!currentSource.proxy) {
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
    const sourceBytes = currentSource.bytes;
    const currentRangeGrant = currentSource.rangeGrant;
    const currentRangeFile = currentSource.rangeFile;

    // One gate for every entry point (context menu, mode-bar button, direct
    // call) — the eligibility rules and their copy live only there.
    const entryGate = selectedReplacementGate(selectedText.pageIndex);
    if (entryGate.blocked) {
      setMessage(entryGate.reason);
      return;
    }

    const runId = runRef.current + 1;
    runRef.current = runId;
    const localOpenToken = openTokenRef.current;
    const localGeneration = generationRef.current;
    engineWorkActiveRef.current = true;
    selectionResolvingRef.current = true;
    setSelectionResolving(true);
    setMessage(null);
    setPhase("staging");
    setActivity("resolving-selection");
    setStaged(null);

    let unownedMaterializedGrant: FileGrant | null = null;
    try {
      let editorBytes = sourceBytes;
      let editorPageIndex = selectedText.pageIndex;
      let editorSelection = selectedText;
      let pageLocalSourceGrant = currentRangeGrant;
      // Desktop selected edits always rewrite one extracted page, even for a
      // small in-memory PDF. Besides keeping the work bounded, qpdf can then
      // splice that page into the untouched source document instead of asking
      // the text engine to regenerate every page.
      if (!pageLocalSourceGrant && sourceBytes) {
        const materialized = await materializePdfBytesGrant(
          sourceBytes,
          fileName ?? "selected-text-source.pdf",
        );
        if (materialized?.kind === "rangeGrant") {
          pageLocalSourceGrant = materialized.grant;
          unownedMaterializedGrant = materialized.grant;
        } else if (gate.blocked) {
          throw new PdfEngineError(
            "UNSUPPORTED",
            "RaioPDF could not prepare this large document for page-local text editing.",
          );
        }
      }
      if (pageLocalSourceGrant) {
        const facts = await pathOpDocumentFacts(pageLocalSourceGrant);
        const hasSignature = facts.signatureDetection.standardAcroFormSignatureCount > 0 ||
          facts.signatureDetection.hasByteRangeOrContentsMarkers ||
          facts.signatureDetection.hasCertificationDictionary;
        const pageLocalUnsafe = facts.encrypted || facts.pdfaClaimed || hasSignature ||
          facts.hasAcroForm || facts.hasTaggedStructure || facts.hasEmbeddedFiles || facts.hasAnnotations;
        if (pageLocalUnsafe && unownedMaterializedGrant && !gate.blocked) {
          // Small special-structure documents retain the existing full-copy
          // confirmation/restoration path. Large/streamed documents cannot
          // safely use that path and remain explicitly blocked.
          await pathOpReleaseOutput(unownedMaterializedGrant).catch(() => undefined);
          unownedMaterializedGrant = null;
          pageLocalSourceGrant = null;
        } else if (pageLocalUnsafe) {
          throw new PdfEngineError(
            "UNSUPPORTED",
            facts.encrypted || facts.pdfaClaimed || hasSignature
              ? "Selected-page editing is unavailable for encrypted, signed, or PDF/A documents."
              : "Selected-page editing is unavailable for PDFs with forms, tags, attachments, or annotations because this version cannot safely preserve those structures.",
          );
        }
      }
      if (pageLocalSourceGrant) {
        if (runRef.current !== runId || openTokenRef.current !== localOpenToken || generationRef.current !== localGeneration || sourceRef.current.rangeGrant !== currentRangeGrant) return;
        const extracted = await pathOpExtractPages(pageLocalSourceGrant, [selectedText.pageIndex]);
        try {
          if (extracted.sizeBytes > SELECTED_PAGE_MAX_BYTES) {
            throw new PdfEngineError("INVALID_DOCUMENT", "The selected page is too large for safe in-app text editing.");
          }
          editorBytes = await readPdfRange(extracted.outputGrant, 0, extracted.sizeBytes);
        } finally {
          await pathOpReleaseOutput(extracted.outputGrant).catch(() => undefined);
        }
        if (runRef.current !== runId || openTokenRef.current !== localOpenToken || generationRef.current !== localGeneration || sourceRef.current.rangeGrant !== currentRangeGrant) {
          return;
        }
        editorPageIndex = 0;
        editorSelection = { ...selectedText, pageIndex: 0 };
        selectedPageLocalRef.current = {
          bytes: editorBytes,
          originalPageIndex: selectedText.pageIndex,
          sourceGrant: pageLocalSourceGrant,
          boundRangeGrant: currentRangeGrant ?? null,
          ownsSourceGrant: pageLocalSourceGrant === unownedMaterializedGrant,
          openToken: localOpenToken,
          generation: localGeneration,
        };
        unownedMaterializedGrant = null;
      }
      if (!editorBytes) {
        throw new PdfEngineError("UNSUPPORTED", currentRangeFile
          ? "Selected-text editing needs the installed app's native file access for large PDFs."
          : "Open a PDF before editing selected text.");
      }

      const textMap = await engineBridge.inspectTextMap(editorBytes, { pageIndexes: [editorPageIndex] });

      if (runRef.current !== runId || openTokenRef.current !== localOpenToken || generationRef.current !== localGeneration) {
        releaseSelectedPageLocal(selectedPageLocalRef);
        return;
      }

      const resolved = resolveSelectedTextTarget(editorSelection, textMap);
      if (!resolved.ok) {
        setPhase("error");
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
        find: resolved.target.expectedVisibleText,
        replace,
        wholeWord: false,
        pageIndexes: [selectedText.pageIndex],
        target: { ...resolved.target, pageIndex: selectedText.pageIndex },
        ...(editorPageIndex === 0 && selectedText.pageIndex !== 0 ? { engineTarget: resolved.target } : {}),
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
        pageIndex: selectedText.pageIndex,
        area: resolved.area,
        excerpt: resolved.target.expectedVisibleText,
      }]);
      setActiveMatchIndex(0);
      setCurrentPage(selectedText.pageIndex + 1);
      window.getSelection()?.removeAllRanges();
      selectedReplacementRef.current = null;
      setSelectedReplacementText(resolved.target.expectedVisibleText);
      setMessage(null);
      setActivity("building-preview");
      engineBridge.warmEngine();
      // Target resolution is complete before staging takes ownership of the
      // run id. Clear this synchronously; the queue callback's finally block
      // intentionally ignores superseded runs.
      selectionResolvingRef.current = false;
      setSelectionResolving(false);
      // Selected text goes directly from the canvas bar into review:
      // resolving the exact engine target and staging that target is one
      // transaction. This intentionally does not call review() after
      // setPendingOps(), where React's asynchronous state would be a race.
      await stageOperationsRef.current([operation]);
    } catch (error) {
      if (runRef.current !== runId) {
        return;
      }

      setMessage(textEditErrorMessage(error));
      setPhase("error");
      releaseSelectedPageLocal(selectedPageLocalRef);
    } finally {
      if (unownedMaterializedGrant) {
        void pathOpReleaseOutput(unownedMaterializedGrant).catch(() => undefined);
      }
      if (runRef.current === runId) {
        engineWorkActiveRef.current = false;
        selectionResolvingRef.current = false;
        setSelectionResolving(false);
        setActivity((current) => (current === "resolving-selection" ? null : current));
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
    if (removed?.target) releaseSelectedPageLocal(selectedPageLocalRef);
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
    const selectedPageLocal = operations.length === 1 && operations[0]?.target
      ? selectedPageLocalRef.current
      : null;
    const sourceBytes = currentSource.bytes ?? selectedPageLocal?.bytes ?? null;
    const sourceProxy = currentSource.proxy;
    const reviewOpenToken = openTokenRef.current;
    const reviewGeneration = generationRef.current;

    if (selectedPageLocal && (
      selectedPageLocal.openToken !== reviewOpenToken ||
      selectedPageLocal.generation !== reviewGeneration ||
      selectedPageLocal.boundRangeGrant !== (currentSource.rangeGrant ?? null)
    )) {
      releaseSelectedPageLocal(selectedPageLocalRef);
      setPhase("error");
      setMessage("The document changed before the selected page could be edited. Reselect the text.");
      return;
    }

    if (!selectedPageLocal && gate.blocked) {
      setPhase("error");
      setActivity(null);
      setMessage(gate.message);
      return;
    }

    if (!sourceBytes || (!sourceProxy && !selectedPageLocal)) {
      setPhase("error");
      setActivity(null);
      setMessage("Open a PDF before editing document text.");
      return;
    }

    if (operations.length === 0) {
      setPhase("error");
      setActivity(null);
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
      setPhase("error");
      setActivity(null);
      setMessage(selectedGate);
      return;
    }

    const runId = runRef.current + 1;
    runRef.current = runId;
    reviewRunRef.current = runId;
    reviewInFlightRef.current = true;
    engineWorkActiveRef.current = true;
    setPhase("staging");
    setActivity("building-preview");
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
            releaseSelectedPageLocal(selectedPageLocalRef);
            return;
          }

          let localProxy: PDFDocumentProxy | null = null;
          try {
            localProxy = selectedPageLocal ? await loadPdfDocument(sourceBytes) : sourceProxy;
            const originalPagesRaw = await extractPageText({ bytes: sourceBytes, pdfDocument: localProxy! });
            const candidatePdf = await loadPdfDocument(result.bytes);
            let candidatePages: readonly ExtractedPageText[] = [];
            try {
              candidatePages = await extractPageText({
                bytes: result.bytes,
                pdfDocument: candidatePdf,
              });
            } finally {
              await candidatePdf.loadingTask.destroy();
            }
            let originalPages: readonly ExtractedPageText[] = selectedPageLocal
              ? originalPagesRaw.map((page) => ({
                  ...page,
                  pageIndex: selectedPageLocal.originalPageIndex,
                }))
              : originalPagesRaw;
            if (selectedPageLocal) {
              candidatePages = candidatePages.map((page) => ({
                ...page,
                pageIndex: selectedPageLocal.originalPageIndex,
              }));
            }

            const selectedOperation = operations.length === 1 && operations[0]?.target
              ? operations[0]
              : null;
            if (selectedOperation) {
              // pdf.js can expose a different run order/whitespace after the
              // text-editor endpoint regenerates a perfectly valid PDF. That
              // made real selected edits look unchanged even though Stirling's
              // own text model contained the exact replacement. Verify selected
              // edits in the same raw engine model that targeted and performed
              // the mutation, while still comparing every page fail-closed.
              const [originalTextMap, candidateTextMap] = await Promise.all([
                engineBridge.inspectTextMap(sourceBytes),
                engineBridge.inspectTextMap(result.bytes),
              ]);
              const originalPageIndex = selectedPageLocal?.originalPageIndex;
              const verifiedCandidateText = verifiedSelectedCandidateText(
                selectedOperation,
                originalTextMap,
                candidateTextMap,
              );
              originalPages = applyEngineTextMap(
                originalPages,
                originalTextMap,
                originalPageIndex,
              );
              candidatePages = applyEngineTextMap(
                candidatePages,
                candidateTextMap,
                originalPageIndex,
              );
              if (verifiedCandidateText !== null) {
                // The selected mutation is proven against the regenerated
                // engine element at its page-space anchor. Stirling may still
                // reserialize every unrelated run in the PDF, so normalize the
                // semantic review model to the original pages plus that one
                // verified splice. The actual staged PDF remains unchanged and
                // is what the canvas shows for visual review.
                candidatePages = applyFlatTextOverride(
                  originalPages,
                  originalPageIndex ?? selectedOperation.target!.pageIndex,
                  verifiedCandidateText,
                );
              }
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
              ...(selectedPageLocal ? {
                pageLocal: {
                  sourceGrant: selectedPageLocal.sourceGrant,
                  originalPageIndex: selectedPageLocal.originalPageIndex,
                },
              } : {}),
            });
            setPhase("review");
            setMessage(formatReplaceTextResult(report));
            return;
          } finally {
            if (selectedPageLocal && localProxy) {
              await localProxy.loadingTask.destroy();
            }
          }
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
              setActivity(null);
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
              setActivity(null);
              setMessage("Nothing changed. The PDF/A archival copy remains intact.");
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
        engineWorkActiveRef.current = false;
        setActivity(null);
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
      if (candidate.pageLocal) {
        const local = selectedPageLocalRef.current;
        if (!local || local.sourceGrant !== candidate.pageLocal.sourceGrant ||
          local.openToken !== candidate.sourceOpenToken || local.generation !== candidate.sourceGeneration ||
          openTokenRef.current !== candidate.sourceOpenToken || generationRef.current !== candidate.sourceGeneration) {
          releaseSelectedPageLocal(selectedPageLocalRef);
          throw new PdfEngineError("INVALID_DOCUMENT", "The document changed before the selected page could be applied.");
        }
        if (!replacePathOutput) {
          throw new PdfEngineError("UNSUPPORTED", "Selected-page editing needs the installed RaioPDF app.");
        }
        const editedPage = await materializePdfBytesGrant(candidate.bytes, "edited-page.pdf");
        if (!editedPage || editedPage.kind !== "rangeGrant") {
          throw new PdfEngineError("UNSUPPORTED", "RaioPDF could not prepare the edited page for replacement.");
        }
        try {
          const output = await pathOpReplacePage(
            candidate.pageLocal.sourceGrant,
            editedPage.grant,
            candidate.pageLocal.originalPageIndex,
          );
          replaced = await replacePathOutput(output, {
            expectedOpenToken: candidate.sourceOpenToken,
            expectedGeneration: candidate.sourceGeneration,
          });
        } finally {
          await pathOpReleaseOutput(editedPage.grant).catch(() => undefined);
        }
      } else {
        replaced = await replaceBytes(candidate.bytes, {
          dirty: true,
          hasTextLayer: null,
          expectedOpenToken: candidate.sourceOpenToken,
          expectedGeneration: candidate.sourceGeneration,
          ...(fileName ? { fileName } : {}),
          filePath: null,
          signatureInvalidationNotice: candidate.signatureInvalidationNotice,
        });
      }
    } catch (error) {
      // A rejection here would otherwise leave phase at "applying" forever.
      setPhase("error");
      setMessage(textEditErrorMessage(error));
      releaseSelectedPageLocal(selectedPageLocalRef);
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
    releaseSelectedPageLocal(selectedPageLocalRef);
    setStaged(null);
    setPhase("done");
    setIsSelectedReplacementMode(false);
    setSelectedReplacementText(null);
    setMessage(formatReplaceTextResult(candidate.report));
  }, [fileName, replaceBytes, replacePathOutput, setCurrentPage, staged]);

  const cancelReview = useCallback(() => {
    runRef.current += 1;
    if (engineWorkActiveRef.current) {
      engineWorkActiveRef.current = false;
      void engineBridge.stopEngine();
    }
    reviewInFlightRef.current = false;
    selectionResolvingRef.current = false;
    setSelectionResolving(false);
    setStaged(null);
    setPhase("idle");
    setActivity(null);
    // Cancelling a selected review discards its resolved target and returns
    // to bulk Find/Replace. Reusing a browser selection after a cancelled
    // review is unsafe because focus/document state may already have moved;
    // the user deliberately selects it again to start a new transaction.
    if (pendingOpsRef.current.some((operation) => operation.target)) {
      pendingOpsRef.current = [];
      setPendingOps([]);
      selectedReplacementRef.current = null;
      releaseSelectedPageLocal(selectedPageLocalRef);
      setSelectedReplacementText(null);
      setIsSelectedReplacementMode(false);
      setMatches([]);
      setActiveMatchIndex(null);
    }
    setMessage("Review cancelled. The document was not modified.");
  }, [engineBridge.stopEngine]);

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
    activity,
    gate,
    selectedGate,
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
