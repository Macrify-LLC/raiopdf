import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import type {
  PdfApplyEditsOptions,
  PdfBatesStampOptions,
  PdfBinderOptions,
  PdfCoverStyle,
  PdfEdit,
  PdfCompressOptions,
  PdfImagePageInput,
  PdfPageNumbersOptions,
  PdfRedactionArea,
  PdfSanitizeRemovedItem,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import {
  LocalPdfEngine,
  hideRaioPdfImportedAnnotationsForDisplay,
} from "@raiopdf/engine-local";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  buildDocumentFacts,
  detectSignatureFacts,
  getPack,
  getPackIntegrityBanner,
  hasEmbeddedSignatureMarkers,
  listPacks,
  preflight,
  resolvePrepPlan,
} from "@raiopdf/rules";
import type {
  DocumentFactsTextExtractor,
  DocumentFacts,
  JurisdictionPack,
  JurisdictionPackId,
  PrepPlanStep,
  PrepPlanStepId,
  PreflightReport,
  RectInches,
  SelectionFacts,
  SignatureDetectionFacts,
  TextLayerCoverage,
} from "@raiopdf/rules";
import { AppShell } from "./components/AppShell";
import { UpdatePill } from "./components/UpdatePill";
import { BinderWorkspace } from "./components/BinderWorkspace";
import { CaptionWorkspace } from "./components/CaptionWorkspace";
import { TableOfAuthoritiesWorkspace } from "./components/TableOfAuthoritiesWorkspace";
import {
  OrganizeWorkspace,
  type OrganizeFlowId,
} from "./components/OrganizeWorkspace";
import {
  PrepareForFilingWorkspace,
  FilingOverflowMenu,
  filingProgressSteps,
  formatProgressLabel,
  isFilingProgressActive,
  type CertificateOfServiceDraft,
  type FilingImpactState,
  type FilingPacketBuildInput,
  type FilingPacketFile,
  type FilingPacketProgress,
  type FilingOutputPart,
  type FilingProgressState,
  type FilingResultState,
  type PrepareForFilingWorkspaceHandle,
  type PrepareOptions,
} from "./components/PrepareForFilingWorkspace";
import {
  BatchCleanupWorkspace,
  type BatchCleanupProgress,
  type BatchCleanupRunInput,
} from "./components/BatchCleanupWorkspace";
import {
  ProductionSetWorkspace,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./components/ProductionSetWorkspace";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  CrashReportDialog,
  type CrashReportPayload,
} from "./components/CrashReportDialog";
import { DeletePagesConfirmationDialog } from "./components/DeletePagesConfirmationDialog";
import { DocumentBanner } from "./components/DocumentBanner";
import { EditModeBar } from "./components/EditModeBar";
import { EditTextModeBar } from "./components/EditTextModeBar";
import { EditTextReviewDialog } from "./components/EditTextReviewDialog";
import { FloatingDialog, hasOpenDialogStackEntry } from "./components/FloatingDialog";
import { ForceOcrConfirmationDialog } from "./components/ForceOcrConfirmationDialog";
import { HelpPanel } from "./components/HelpPanel";
import {
  OcrDialog,
  formatOcrRunningMessage,
  toLongProcessProgress,
  type OcrDialogPhase,
} from "./components/OcrDialog";
import { PasswordDialog, type PasswordDialogPhase } from "./components/PasswordDialog";
import { PrintDialog } from "./components/PrintDialog";
import { SignatureUnlockModal } from "./components/SignatureUnlockModal";
import { DockedProcessLoader } from "./components/DockedProcessLoader";
import type { DockedProcessLoaderProps } from "./components/DockedProcessLoader";
import {
  isEngineBridgeUnavailableError,
  useEngineBridge,
} from "./hooks/useEngineBridge";
import {
  NEW_TAB_BUSY_MESSAGE,
  STREAMED_DOCUMENT_GATE_MESSAGE,
  useDocument,
  type BinderExhibitInput,
  type DocumentState,
  type OpenFileResult,
  type SignatureUnlockPrompt,
} from "./hooks/useDocument";
import { useDocumentSearch } from "./hooks/useDocumentSearch";
import { useTextEdit } from "./hooks/useTextEdit";
import { useEditing, type EditingDocumentSnapshot } from "./hooks/useEditing";
import { annotationSavePlanHasChanges, type EditToolId } from "./lib/edits";
import { isTextEntryTarget } from "./lib/domGuards";
import {
  checkForSignedUpdate,
  downloadSignedUpdate,
  installDownloadedUpdate,
  isUpdaterRuntime,
  relaunchForInstalledUpdate,
  UPDATE_IDLE_STATUS,
  UPDATE_UNAVAILABLE_STATUS,
  type AppUpdateStatus,
} from "./lib/appUpdates";
import {
  getPdfLoadErrorMessage,
  loadPdfDocument,
  loadStreamedPdfDocument,
  PasswordException,
  type PDFDocumentProxy,
} from "./lib/pdfjs";
import {
  createFileRangeTransport,
  createGrantRangeTransport,
  type RaioPdfRangeTransport,
} from "./lib/pdfRangeTransport";
import {
  filePort,
  isFileChangedError,
  openFileInNewWindow,
  openGrantInNewWindow,
  readBrowserFileSource,
  saveStreamedCopy,
  saveStreamedCopyIntoDirectory,
  takeStartupFile,
  type FileGrant,
  type OpenedFile,
  type OpenedFileSource,
  type PickedDirectory,
  type SavedFile,
} from "./lib/filePort";
import { materializeDroppedFileGrant } from "./lib/dropMaterialize";
import {
  pickFileForAdd,
  tooLargeToAddMessage,
  type FileAddResult,
  type PickPdfsForAddOptions,
} from "./lib/readFileForAdd";
import {
  describeOcrProgress,
  listenOcrProgress,
  newOcrJobToken,
  type OcrProgressEvent,
} from "./lib/ocrProgress";
import { resolveEngineOpRoute } from "./lib/engineOpRoute";
import {
  isPathOpsRuntime,
  pathOpApplyEdits,
  pathOpBatesStamp,
  pathOpBuildBinder,
  pathOpCancel,
  pathOpCompress,
  pathOpDecrypt,
  pathOpDocumentFacts,
  pathOpExtractPages,
  pathOpInsertPages,
  pathOpMerge,
  pathOpOcr,
  pathOpPageNumbers,
  pathOpPrepareFiling,
  pathOpRedactAreas,
  pathOpReleaseOutput,
  pathOpRepair,
  pathOpSanitize,
  pathOpsStatus,
  isPathOpAvailableForInput,
  isPathOpCancelledError,
  pathOpStatusEntry,
  pathOpWatermark,
  pathOpErrorMessage,
  PathOpsError,
  type PathOpsRedactionVerification,
  type PathOpsStatus,
} from "./lib/pathOps";
import { getWordCapability, isWordPresent } from "./lib/wordCapability";
import { runWordDocumentImport } from "./lib/wordImport";
import { planPathOpReopen } from "./lib/pathOpReopen";
import {
  annotateStreamedPreflight,
  buildPrepareFilingPlan,
  buildStreamedFilingOutputReport,
  buildStreamedUnavailableSteps,
  mapPathOpsFactsToDocumentFacts,
} from "./lib/streamedFiling";
import { extractPrintableRange } from "./lib/printRange";
import { writeProductionLastUsed } from "./lib/productionHints";
import { resolveProtectedPdfBytes, type ProtectedPdfSource } from "./lib/protectedPdfResolver";
import { formatWorkflowError } from "./lib/userMessages";
import { logWorkflowFailure, recordDiagnosticEvent } from "./lib/diagnostics";
import {
  aggregateOutputReports,
  runFilingOutputPreflights,
} from "./lib/filingOutputPreflight";
import { prepareFilingOutputParts } from "./lib/filingOutputParts";
import {
  readFilingPreferences,
  selectCourtProfile,
  selectDefaultCoverStyle,
  selectDefaultPack,
  setPacketPreferences,
  setPrepStepDefaultOverrides,
  upsertCourtProfile,
  writeFilingPreferences,
  type CourtProfile,
  type FilingPreferences,
} from "./lib/filingPreferences";
import {
  buildCrashReportIssueUrl,
  fitCrashReportPayloadToIssueUrl,
} from "./lib/crashReportIssue";
import {
  hasSearchableTextLayerCoverage,
  inspectOpenTextLayerCoverage,
  inspectTextLayer,
  pdfDocumentTextLayerCoverage,
  textLayerCoveragePageCount,
} from "./lib/textLayer";
import { countRaioPdfMarkupAnnotations } from "./lib/markupAnnotations";
import { planOcrRun } from "./lib/ocrRunPlan";
import {
  collectFilingOcrOutputPartNotices,
  filingOcrVerificationNotice,
  verifyOcrTextLayer,
} from "./lib/ocrVerification";
import {
  WORD_REFLOW_EXPERIMENTAL_LABEL,
  pdfGrantHasTextLayer,
  pickStandalonePdfForWord,
  resolveWordReflowTextLayerSignal,
  runPdfToWordReflow,
  type WordReflowStatus,
} from "./lib/wordReflow";
import { describeTextLayerStatus, deriveTextLayerStatus } from "./lib/textLayerStatus";
import { extractPageTextForIndexes } from "./lib/pageTextCache";
import { editToolStreamedGateMessage } from "./lib/editToolGate";
import {
  collectRedactionAreaTexts,
  extractTextBoxes,
  findTextRedactionAreas,
  readMetadataSummary,
  scanSensitivePatterns,
  verifyRedactionAreasClear,
  type PdfMetadataSummary,
  type RedactionVerificationResult,
  type SensitiveHit,
} from "./lib/legalTools";
import type { SignatureInvalidationNotice } from "./hooks/useDocument";
import {
  assessPdfAConversionImpact,
  assessPdfAConversionImpactFromBytes,
  hasPdfAConversionImpact,
  readPdfAIdentification,
  type PdfAConversionImpact,
} from "@raiopdf/engine-pdf-lib";
import {
  BatesPanel,
  DesktopCapabilityMessage,
  formatBytes,
  PasswordsPanel,
  ScrubMetadataPanel,
  SidecarStatusLine,
  type EditDialogToolId,
  type LegalToolId,
  type OrganizeToolId,
} from "./components/ToolPanel";
import type {
  BatesPanelState,
  RedactionPanelState,
  ScannerPanelState,
  ScrubMetadataPanelState,
  SidecarStatus,
} from "./components/ToolPanel";
import { SearchIcon } from "./icons";
import "./components/LegalModeBar.css";

const ZOOM_STEP = 0.25;
const FLORIDA_PACK: JurisdictionPack = getPack();
const AVAILABLE_FILING_PACKS: readonly JurisdictionPack[] = listPacks();
const PACK_INTEGRITY_BANNER = getPackIntegrityBanner();
const POINTS_PER_INCH = 72;
const OCR_FAILURE_MESSAGE = "Couldn't make this document searchable.";
const DROPPED_PDF_MATERIALIZE_MESSAGE = "Preparing this document for filing…";

declare global {
  interface Window {
    __RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__?: number;
    __RAIOPDF_TEST_INSERT_IMAGE_READ_DELAY_MS__?: number;
    __RAIOPDF_TEST_REORDER_DELAY_MS__?: number;
  }
}

export type OcrPhase =
  | "idle"
  | "confirm"
  | "starting-engine"
  | "processing"
  | "verifying"
  | "done"
  | "error";

export interface OcrUiState {
  phase: OcrPhase;
  message: string | null;
  progress?: OcrProgressEvent | null;
  /**
   * Severity of a terminal "done" result. A clean rebuild is "ok" (success);
   * a rebuild that finished with imperfect pages (e.g. a thin text layer over a
   * scan that normal OCR left as-is) is "caution" — the searchable copy is
   * still produced, but the notice reads as a light warning, not success.
   */
  tone?: "ok" | "caution";
}

interface BinderProgressState {
  running: boolean;
  message: string | null;
  detail: string | null;
}

interface ActiveLongProcess {
  label: string;
  loader: DockedProcessLoaderProps;
}

type CancellablePathProcess = "ocr" | "prepare-filing";

interface PathOpCancelState {
  process: CancellablePathProcess;
  jobToken: string;
  backend: "path-op" | "sidecar-local";
  abortController?: AbortController;
  requested: boolean;
}

interface LastPrepareConfiguration {
  generation: number;
  key: string;
  openToken: number;
  certificate: CertificateOfServiceDraft | null;
  options: PrepareOptions;
}

function isOcrDialogPhase(phase: OcrPhase): phase is OcrDialogPhase {
  return (
    phase === "confirm" ||
    phase === "starting-engine" ||
    phase === "processing" ||
    phase === "verifying" ||
    phase === "error"
  );
}

function formatOcrFailureDetail(error: unknown): string | null {
  const detail = formatWorkflowError(error, "OCR could not finish. The document was left unchanged.")
    .replace(/\s+/gu, " ")
    .trim();

  if (!detail || detail === OCR_FAILURE_MESSAGE) {
    return null;
  }

  return detail;
}

type OcrType = "skip-text" | "force-ocr";

type ForceOcrConfirmationReason = "garbled" | "manual";

function delegatedOcrProcessingMessage(ocrType: OcrType): string {
  return ocrType === "force-ocr"
    ? "Rebuilding the searchable text — RaioPDF re-reads every page."
    : "Making searchable — this all happens on your computer.";
}

function memoryOcrProcessingMessage(ocrType: OcrType): string {
  return ocrType === "force-ocr"
    ? "Rebuilding the searchable text — the whole file is being re-read."
    : "Making searchable — working through the pages one at a time.";
}

async function inspectPathOpOutputTextLayer(output: {
  outputGrant: FileGrant;
  name: string;
  sizeBytes: number;
}) {
  const plan = await planPathOpReopen(output);
  if (plan.mode === "memory") {
    return inspectTextLayer(plan.bytes);
  }

  const transport = createGrantRangeTransport(output.outputGrant, output.sizeBytes);
  const pdfDocument = await loadStreamedPdfDocument(transport);

  try {
    return await pdfDocumentTextLayerCoverage(pdfDocument);
  } finally {
    transport.abort();
    await pdfDocument.loadingTask.destroy();
  }
}

/** What the password prompt unlocks: the still-encrypted source bytes
 * (small files, engine decrypt) or a shell grant (streamed large files,
 * path-based qpdf decrypt — bytes never enter the WebView). */
type PasswordPromptSource =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "grant"; grant: FileGrant };

/** B3 (2026-07-03 live-test fix plan): state for the password-prompt dialog
 * shown when opening a password-protected PDF. `source` is the still-
 * encrypted input; `error` is the inline "wrong password" retry message. */
interface PasswordPromptState {
  source: PasswordPromptSource;
  fileName: string;
  filePath: string | null;
  phase: PasswordDialogPhase;
  error: string | null;
}

interface PendingRedaction {
  id: string;
  area: PdfRedactionArea;
}

/**
 * Pending per-document UI state stashed on tab switch-away and restored on
 * switch-back: annotation overlays + form values (useEditing), pending
 * redaction areas, and the overlay-dirty marker so discarding restored edits
 * still returns the tab to clean. Keyed by `document.generation` — a
 * globally monotonic identity [R1-8] — so a snapshot can never apply to a
 * different document than the one it was captured from.
 */
interface TabEditingSnapshot {
  editing: EditingDocumentSnapshot;
  pendingRedactions: readonly PendingRedaction[];
  overlayDirty: { generation: number; marked: boolean } | null;
}

interface FilingFactsCache {
  byBytes: WeakMap<Uint8Array, Map<string, Promise<DocumentFacts>>>;
}

interface FilingFactsOptions {
  fileBytes: number;
  filename?: string;
  pdfaClaimed?: boolean;
  pdfaCompliant?: boolean;
  pdfDocument?: PDFDocumentProxy | null;
  occupiedRegionPages?: "first" | "all";
}

interface DocumentIdentityGuard {
  openToken: number;
  generation: number;
}

export function App() {
  const engineBridge = useEngineBridge();
  const [signatureUnlockPrompt, setSignatureUnlockPrompt] = useState<
    (SignatureUnlockPrompt & { resolve: (confirmed: boolean) => void }) | null
  >(null);
  const confirmSignatureInvalidation = useCallback(
    (prompt: SignatureUnlockPrompt) =>
      new Promise<boolean>((resolve) => {
        setSignatureUnlockPrompt((current) => {
          current?.resolve(false);
          return { ...prompt, resolve };
        });
      }),
    [],
  );
  const protectedPdf = useMemo(
    () => ({
      confirmSignatureInvalidation,
      resolve: (bytes: Uint8Array) =>
        resolveProtectedPdfBytes(bytes, {
          isUnavailableError: isEngineBridgeUnavailableError,
          removeEncryption: engineBridge.removeEncryption,
        }),
    }),
    [confirmSignatureInvalidation, engineBridge.removeEncryption],
  );
  // Decryption strips a document's signature. Callers that decrypt outside the
  // useDocument open path (the manual password dialog, Prepare for Filing) must
  // reuse the same signature-invalidation confirmation the open path runs, so a
  // signed document still warns before we hand back the unlocked bytes. Returns
  // true to proceed, false if the user declines.
  const confirmDecryptSignatureInvalidation = useCallback(
    async (
      unlockedBytes: Uint8Array,
      source: ProtectedPdfSource,
      sourceFileNames: readonly string[],
      sourceFilePath: string | null,
    ): Promise<boolean> => {
      let signature;
      try {
        signature = await detectSignatureFacts(unlockedBytes);
      } catch {
        // Couldn't inspect the unlocked bytes — don't block a legitimate unlock
        // over a detection hiccup (mirrors the resolver's "output-unverified").
        return true;
      }
      if (!hasEmbeddedSignatureMarkers(signature)) {
        return true;
      }
      return confirmSignatureInvalidation({
        source,
        sourceFileNames,
        sourceFilePath,
        signature,
      });
    },
    [confirmSignatureInvalidation],
  );
  const confirmDecryptSignatureFactsInvalidation = useCallback(
    (
      signature: SignatureDetectionFacts,
      source: ProtectedPdfSource,
      sourceFileNames: readonly string[],
      sourceFilePath: string | null,
    ): Promise<boolean> => {
      if (!hasEmbeddedSignatureMarkers(signature)) {
        return Promise.resolve(true);
      }

      return confirmSignatureInvalidation({
        source,
        sourceFileNames,
        sourceFilePath,
        signature,
      });
    },
    [confirmSignatureInvalidation],
  );
  const {
    document,
    tabs: documentTabs,
    activeTabId,
    pageScrollIntent,
    openFile: openDocumentFile,
    openStreamedFile,
    switchTab: switchDocumentTab,
    closeTab: closeDocumentTab,
    setStreamedPageCount,
    upgradeStreamedFileToGrant,
    replaceBytes,
    getOpenToken,
    setCurrentPage,
    syncVisiblePage,
    setZoom,
    setFitZoom,
    setHasTextLayer,
    setTextLayerCoverage,
    setPageSizeInches,
    setError,
    rotatePages,
    deletePages,
    reorderPages,
    mergeWithFiles,
    extractPages,
    splitPages,
    insertFile,
    cropResizePages,
    buildBinder: buildBinderInMemory,
    batesStamp,
    readRaioPdfAnnotations,
    applyAnnotationSavePlan,
    flattenMarkupAnnotations,
    scrubMetadata,
    pageNumbers,
    watermark,
    insertImagePages,
    replaceOutline,
    save: saveDocument,
    markSaved,
    markDirty,
    markClean,
  } = useDocument({ protectedPdf });
  const answerSignatureUnlockPrompt = useCallback((confirmed: boolean) => {
    setSignatureUnlockPrompt((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);
  // Proxy identity is generation-based [R1-8]: the loaded pdf.js document is
  // "current" only while its generation matches the document's. In streamed
  // mode `bytes` is null — the proxy is the ONLY view of the document.
  const [pdfDocumentState, setPdfDocumentState] = useState<{
    generation: number;
    bytes: Uint8Array | null;
    proxy: PDFDocumentProxy;
  } | null>(null);
  const currentPdfDocumentState = pdfDocumentState?.generation === document.generation
    ? pdfDocumentState
    : null;
  const pdfDocument = currentPdfDocumentState?.proxy ?? null;
  const pdfDocumentBytes = currentPdfDocumentState?.bytes ?? null;
  const streamedDocument = document.source !== null && document.source.kind !== "memory";
  // Delegated (path-based) ops need a shell grant AND the Tauri runtime —
  // browser streamed docs (`rangeFile`) have neither, so their gates stay up.
  const pathOpsGrant =
    document.source?.kind === "rangeGrant" && isPathOpsRuntime()
      ? document.source.grant
      : null;
  useEffect(() => {
    let disposed = false;

    if (!pathOpsGrant) {
      setPathOpsGeneralStatus(null);
      return;
    }

    void pathOpsStatus()
      .then((status) => {
        if (!disposed) {
          setPathOpsGeneralStatus(status);
        }
      })
      .catch(() => {
        if (!disposed) {
          setPathOpsGeneralStatus(null);
        }
      });

    return () => {
      disposed = true;
    };
  }, [pathOpsGrant]);
  const editing = useEditing(pdfDocument);
  // The shell file grant to route a memory-mode engine op (OCR, PDF/A, compress,
  // redaction) through the file-based path_ops lane — non-null only when it is
  // SAFE to process the on-disk file instead of shipping the document bytes over
  // the loopback proxy (which WebView2/Chromium-150 rejects above ~1MB). Safe
  // means: desktop runtime, opened from a file (grant present), and clean (no
  // unsaved in-memory edits — those live only in the WebView, so the on-disk
  // file would be the pre-edit content). Streamed docs pass through their
  // existing grant. Dirty / browser / no-grant docs get null and fall back to
  // the in-memory loopback path (correct bytes; fails honestly above ~1MB).
  const engineDelegatedGrant = ((): FileGrant | null => {
    const route = resolveEngineOpRoute({
      isTauriRuntime: isPathOpsRuntime(),
      sourceKind: document.source?.kind ?? null,
      streamedGrant: pathOpsGrant,
      memoryFilePath: document.filePath,
      dirty: document.dirty,
      hasUnsavedEdits: editing.hasUnsavedEdits,
    });
    return route.via === "path-ops" ? route.grant : null;
  })();
  const overlayDirtyRef = useRef<{ generation: number; marked: boolean } | null>(null);
  const documentSearch = useDocumentSearch({
    pdfDocumentState: currentPdfDocumentState,
    documentGeneration: document.generation,
    textLayerCoverage: document.textLayerCoverage,
    setCurrentPage,
  });
  const confirmTextEditSignatureInvalidation = useCallback(async (): Promise<SignatureInvalidationNotice | null> => {
    const sourceBytes = document.bytes;
    if (!sourceBytes) {
      return null;
    }

    let signature: SignatureDetectionFacts;
    try {
      signature = await detectSignatureFacts(sourceBytes);
    } catch {
      signature = {
        standardAcroFormSignatureCount: 1,
        hasByteRangeOrContentsMarkers: false,
        hasCertificationDictionary: false,
      };
    }

    const notice: SignatureInvalidationNotice = {
      source: "owner-restricted",
      sourceFileNames: [document.fileName ?? "this PDF"],
      sourceFilePath: document.filePath,
      signature,
    };
    const confirmed = await confirmSignatureInvalidation(notice);
    return confirmed ? notice : null;
  }, [confirmSignatureInvalidation, document.bytes, document.fileName, document.filePath]);
  const confirmTextEditPdfAIdentificationRemoval = useCallback(
    () => Promise.resolve(window.confirm(
      "Editing will drop this file's PDF/A (archival) format — you can convert it back afterward.",
    )),
    [],
  );
  const textEditSource = useMemo(
    () => ({
      bytes: document.bytes,
      proxy: pdfDocument,
    }),
    [document.bytes, pdfDocument],
  );
  const textEdit = useTextEdit({
    source: textEditSource,
    documentGeneration: document.generation,
    sourceOpenToken: getOpenToken(),
    streamed: streamedDocument,
    textLayerCoverage: document.textLayerCoverage,
    engineBridge,
    replaceBytes,
    fileName: document.fileName,
    confirmSignatureInvalidation: confirmTextEditSignatureInvalidation,
    confirmPdfAIdentificationRemoval: confirmTextEditPdfAIdentificationRemoval,
    setCurrentPage,
  });
  const [selectedPageIndexes, setSelectedPageIndexes] = useState<Set<number>>(
    () => new Set(),
  );
  const [pageDeleteConfirmation, setPageDeleteConfirmation] = useState<
    readonly number[] | null
  >(null);
  const [ocrState, setOcrState] = useState<OcrUiState>({
    phase: "idle",
    message: null,
  });
  const [pathOpCancelState, setPathOpCancelState] =
    useState<PathOpCancelState | null>(null);
  const [lastPrepareConfiguration, setLastPrepareConfiguration] =
    useState<LastPrepareConfiguration | null>(null);

  useEffect(() => {
    if (editing.hasUnsavedEdits) {
      if (!overlayDirtyRef.current) {
        overlayDirtyRef.current = {
          generation: document.generation,
          marked: !document.dirty,
        };

        if (!document.dirty) {
          markDirty();
        }
      }

      return;
    }

    const overlayDirty = overlayDirtyRef.current;
    overlayDirtyRef.current = null;

    if (overlayDirty?.marked && document.generation === overlayDirty.generation) {
      markClean();
    }
  }, [
    document.dirty,
    document.generation,
    editing.hasUnsavedEdits,
    markClean,
    markDirty,
  ]);
  const [forceOcrConfirmation, setForceOcrConfirmation] =
    useState<ForceOcrConfirmationReason | null>(null);
  const [activeLegalTool, setActiveLegalTool] = useState<LegalToolId | null>(
    null,
  );
  // Item 8: the "..." overflow menu moved out of PrepareForFilingWorkspace
  // and into the outer FloatingDialog's header (see getFloatingDialog
  // below), but its one action (insert a Certificate of Service page) is
  // still state that lives inside the workspace. This ref is the bridge.
  const filingWorkspaceRef = useRef<PrepareForFilingWorkspaceHandle>(null);
  const [activeEditDialogTool, setActiveEditDialogTool] = useState<EditDialogToolId | null>(
    null,
  );
  const [activeTextEdit, setActiveTextEdit] = useState(false);
  const [textEditAnnotationPrompt, setTextEditAnnotationPrompt] = useState(false);
  const [activeOrganizeTool, setActiveOrganizeTool] = useState<OrganizeToolId | null>(
    null,
  );
  const [pendingRedactions, setPendingRedactions] = useState<PendingRedaction[]>([]);
  const [redactionPhase, setRedactionPhase] =
    useState<RedactionPanelState["phase"]>("idle");
  const [redactionMessage, setRedactionMessage] = useState<string | null>(null);
  const [redactionSearchOpen, setRedactionSearchOpen] = useState(false);
  const [redactionSearchText, setRedactionSearchText] = useState("");
  const [batesState, setBatesState] = useState<BatesPanelState>({
    applying: false,
    message: null,
  });
  const [scannerState, setScannerState] = useState<ScannerPanelState>({
    scanning: false,
    message: null,
    hits: [],
  });
  const [metadataSummary, setMetadataSummary] = useState<PdfMetadataSummary | null>(null);
  const [filingPreferences, setFilingPreferences] = useState<FilingPreferences>(() => readFilingPreferences());
  const [filingPackId, setFilingPackId] = useState<JurisdictionPackId>(() => (
    filingPreferences.defaultPackId ?? FLORIDA_PACK.id
  ));
  const [filingReport, setFilingReport] = useState<PreflightReport | null>(null);
  const [filingFacts, setFilingFacts] = useState<DocumentFacts | null>(null);
  /** PathOpsEngine status for the streamed filing checklist rule [R7-1]. */
  const [pathOpsFilingStatus, setPathOpsFilingStatus] = useState<PathOpsStatus | null>(null);
  /** General PathOpsEngine status for streamed legal-tool availability gates. */
  const [pathOpsGeneralStatus, setPathOpsGeneralStatus] = useState<PathOpsStatus | null>(null);
  /** Page-range print prompt — the fallback when native printing is out. */
  const [printRangePrompt, setPrintRangePrompt] = useState<{
    value: string;
    message: string | null;
    running: boolean;
  } | null>(null);
  /** Native print dialog for streamed docs (whole-doc print, un-gated). */
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [filingReportLoading, setFilingReportLoading] = useState(false);
  const [filingReportError, setFilingReportError] = useState<string | null>(null);
  const [filingProgress, setFilingProgress] = useState<FilingProgressState>({
    phase: "idle",
    message: null,
  });
  const [filingResult, setFilingResult] = useState<FilingResultState | null>(null);
  const [filingImpact, setFilingImpact] = useState<FilingImpactState | null>(null);
  const [printMarkupAnnotations, setPrintMarkupAnnotations] = useState(true);
  const [markupAnnotationMessage, setMarkupAnnotationMessage] = useState<string | null>(null);
  const [filingPacketProgress, setFilingPacketProgress] = useState<FilingPacketProgress>({
    running: false,
    message: null,
    result: null,
  });
  const [binderProgress, setBinderProgress] = useState<BinderProgressState>({
    running: false,
    message: null,
    detail: null,
  });
  const [productionProgress, setProductionProgress] = useState<ProductionSetProgress>({
    running: false,
    message: null,
    result: null,
  });
  const [batchCleanupProgress, setBatchCleanupProgress] = useState<BatchCleanupProgress>({
    running: false,
    message: null,
    result: null,
  });
  const baseFilingPack = useMemo(() => {
    try {
      return getPack(filingPackId);
    } catch {
      return FLORIDA_PACK;
    }
  }, [filingPackId]);
  const selectedCourtProfile = useMemo(() => {
    const profileId = filingPreferences.lastCourtProfileByPack[baseFilingPack.id];

    return filingPreferences.courtProfiles.find((profile) => profile.id === profileId) ?? null;
  }, [baseFilingPack.id, filingPreferences]);
  const filingPack = useMemo(
    () => applyCourtProfile(baseFilingPack, selectedCourtProfile),
    [baseFilingPack, selectedCourtProfile],
  );
  const filingPrepPlan = useMemo(
    () => resolvePrepPlan(filingPack, filingFacts ?? emptyDocumentFacts(document)),
    [document.fileName, document.fileSizeBytes, filingFacts, filingPack],
  );

  useEffect(() => {
    if (filingProgress.phase === "done" || filingProgress.phase === "error") {
      setActiveLegalTool("prepare-for-filing");
    }
  }, [filingProgress.phase]);

  const longProcessRunning = isFilingProgressActive(filingProgress.phase) ||
    filingPacketProgress.running ||
    binderProgress.running ||
    ocrState.phase === "starting-engine" ||
    ocrState.phase === "processing" ||
    ocrState.phase === "verifying" ||
    textEdit.phase === "staging" ||
    textEdit.phase === "applying";
  // Streamed checklist enablement is the closed-form rule [R7-1]: a step is
  // enabled ⟺ a registered path op implements it AND its toolchain is
  // available — computed from `path_ops_status`, never a hand list.
  const streamedFilingUnavailableSteps = useMemo(
    () => (streamedDocument
      ? buildStreamedUnavailableSteps(filingPrepPlan, pathOpsFilingStatus)
      : undefined),
    [filingPrepPlan, pathOpsFilingStatus, streamedDocument],
  );
  const [scrubState, setScrubState] = useState<{
    scrubbing: boolean;
    message: string | null;
    removedFields: readonly string[];
  }>({
    scrubbing: false,
    message: null,
    removedFields: [],
  });
  const [sidecarStatus, setSidecarStatus] = useState<{
    running: boolean;
    message: string | null;
    removed: readonly PdfSanitizeRemovedItem[];
    beforeBytes: number | null;
    afterBytes: number | null;
  }>({
    running: false,
    message: null,
    removed: [],
    beforeBytes: null,
    afterBytes: null,
  });
  const [wordReflowStatus, setWordReflowStatus] = useState<WordReflowStatus>({
    running: false,
    message: null,
    tone: "neutral",
  });
  const [repairCandidate, setRepairCandidate] = useState<OpenedFile | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPromptState | null>(null);
  const passwordUnlockRunRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpArticleId, setHelpArticleId] = useState<string | undefined>(undefined);
  const [settingsFocusSection, setSettingsFocusSection] = useState<
    "open-raio-to-ai" | "about-macrify" | null
  >(null);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpPath, setMcpPath] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<string | null>(null);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  // Whether Microsoft Word was detected on this PC. Used to proactively gate the
  // Word-only menu items (PDF -> editable Word export) so they gray out with a
  // reason when Word isn't installed, instead of only failing after a click.
  // Defaults `true` so nothing grays before the probe (or on non-desktop / probe
  // error); the click-time deep capability check remains the real gate.
  const [wordAvailable, setWordAvailable] = useState(true);
  useEffect(() => {
    if (!isPathOpsRuntime()) {
      return;
    }
    let cancelled = false;
    void getWordCapability(false)
      .then((capability) => {
        if (!cancelled) {
          // Presence-gate only (see `isWordPresent`): `detected` or `available`
          // both mean Word can be attempted; the deep click-time check is the
          // real gate before any conversion runs.
          setWordAvailable(isWordPresent(capability));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>(() => (
    isUpdaterRuntime() ? UPDATE_IDLE_STATUS : UPDATE_UNAVAILABLE_STATUS
  ));
  // Mirror of the current phase for callbacks that must not close over a stale
  // status (handleCheckForUpdates is created once and must read the live phase).
  const updatePhaseRef = useRef(updateStatus.phase);
  updatePhaseRef.current = updateStatus.phase;
  const updateCheckRequestRef = useRef(0);
  const updateDownloadRequestRef = useRef(0);
  const updateInstallRequestRef = useRef(0);
  const availableUpdateRef = useRef<Awaited<ReturnType<typeof checkForSignedUpdate>>>(null);
  const [crashReportPayload, setCrashReportPayload] =
    useState<CrashReportPayload | null>(null);
  const [crashReportOpenStatus, setCrashReportOpenStatus] = useState<string | null>(null);
  const [isOpeningCrashReportIssue, setIsOpeningCrashReportIssue] = useState(false);
  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const status = await invoke<{ enabled: boolean; path: string | null }>(
          "mcp_status",
        );
        if (!cancelled) {
          setMcpEnabled(status.enabled);
          setMcpPath(status.path);
          setMcpStatus(null);
        }
      } catch {
        // Non-Tauri/dev context or command unavailable -- keep the safe default (off).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);
  const mcpToggleChainRef = useRef<Promise<void>>(Promise.resolve());
  const mcpToggleRequestRef = useRef(0);
  const updateFilingPreferences = useCallback((next: FilingPreferences) => {
    setFilingPreferences(next);
    writeFilingPreferences(next);
  }, []);
  const handleFilingPackChange = useCallback((packId: JurisdictionPackId) => {
    setFilingPackId(packId);
    updateFilingPreferences(selectDefaultPack(filingPreferences, packId));
    setFilingResult(null);
    setFilingImpact(null);
  }, [filingPreferences, updateFilingPreferences]);
  const handleCourtProfileSelect = useCallback((profileId: string) => {
    updateFilingPreferences(selectCourtProfile(filingPreferences, baseFilingPack.id, profileId));
  }, [baseFilingPack.id, filingPreferences, updateFilingPreferences]);
  const handleCourtProfileSave = useCallback((profile: { name: string; maxMegabytes: number }) => {
    const maxFileBytes = Math.round(profile.maxMegabytes * 1024 * 1024);
    updateFilingPreferences(upsertCourtProfile(filingPreferences, {
      packId: baseFilingPack.id,
      name: profile.name,
      maxFileBytes,
    }));
  }, [baseFilingPack.id, filingPreferences, updateFilingPreferences]);
  const handlePacketPreferencesChange = useCallback((
    preferences: { layoutMode: "separate-files" | "combined-pdf"; prefixFilenames: boolean },
  ) => {
    updateFilingPreferences(setPacketPreferences(filingPreferences, preferences));
  }, [filingPreferences, updateFilingPreferences]);
  const handlePrepStepDefaultOverridesChange = useCallback((overrides: Partial<Record<PrepPlanStepId, boolean>>) => {
    updateFilingPreferences(setPrepStepDefaultOverrides(filingPreferences, baseFilingPack.id, overrides));
  }, [baseFilingPack.id, filingPreferences, updateFilingPreferences]);
  const handleDefaultCoverStyleChange = useCallback((style: PdfCoverStyle) => {
    updateFilingPreferences(selectDefaultCoverStyle(filingPreferences, style));
  }, [filingPreferences, updateFilingPreferences]);
  const handleToggleMcpEnabled = useCallback((next: boolean) => {
    const requestId = mcpToggleRequestRef.current + 1;
    mcpToggleRequestRef.current = requestId;
    setMcpEnabled(next);
    setMcpStatus(null);
    // Serialize gate writes so rapid toggles persist in click order (the last
    // click wins) instead of racing a create against a remove.
    mcpToggleChainRef.current = mcpToggleChainRef.current.then(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("mcp_set_enabled", { enabled: next });
        if (mcpToggleRequestRef.current === requestId) {
          setMcpEnabled(next);
          setMcpStatus(null);
        }
      } catch {
        // Best-effort resync to the persisted truth on failure.
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const status = await invoke<{ enabled: boolean; path: string | null }>(
            "mcp_status",
          );
          if (mcpToggleRequestRef.current === requestId) {
            setMcpEnabled(status.enabled);
            setMcpStatus("That setting couldn't be saved. The switch was put back to its last saved state.");
          }
        } catch {
          if (mcpToggleRequestRef.current === requestId) {
            setMcpEnabled(!next);
            setMcpStatus("That setting couldn't be saved. The switch was put back to its last saved state.");
          }
        }
      }
    });
  }, []);
  const handleExportDiagnostics = useCallback(() => {
    setDiagnosticsStatus("Preparing diagnostics...");
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ path: string } | null>("diagnostics_export_dialog");
        setDiagnosticsStatus(result ? `Saved to ${result.path}` : "Export canceled.");
      } catch {
        setDiagnosticsStatus("Diagnostics could not be exported.");
      }
    })();
  }, []);
  const handleCheckForUpdates = useCallback(async (mode: "auto" | "manual" = "manual") => {
    if (!isUpdaterRuntime()) {
      setUpdateStatus(UPDATE_UNAVAILABLE_STATUS);
      return;
    }

    // Never re-check while a download is staged or an install/restart is
    // pending: check() returns a fresh Update handle, and adopting it would
    // discard the one holding the downloaded bytes (install() needs that exact
    // handle) and bounce the pill back to "Download".
    if (
      updatePhaseRef.current === "downloading" ||
      updatePhaseRef.current === "downloaded" ||
      updatePhaseRef.current === "installing" ||
      updatePhaseRef.current === "installed"
    ) {
      return;
    }

    const requestId = updateCheckRequestRef.current + 1;
    updateCheckRequestRef.current = requestId;
    setUpdateStatus({
      phase: "checking",
      message: mode === "auto" ? "Checking for signed updates..." : "Checking GitHub for signed updates...",
    });

    try {
      const update = await checkForSignedUpdate();
      if (updateCheckRequestRef.current !== requestId) {
        return;
      }

      availableUpdateRef.current = update;
      if (update) {
        setUpdateStatus({
          phase: "available",
          message: `RaioPDF ${update.version} is available.`,
          currentVersion: update.currentVersion,
          availableVersion: update.version,
        });
      } else {
        setUpdateStatus({
          phase: "current",
          message: "RaioPDF is up to date.",
        });
      }
    } catch {
      if (updateCheckRequestRef.current === requestId) {
        availableUpdateRef.current = null;
        setUpdateStatus({
          phase: "error",
          message: "Update check could not reach GitHub or verify release metadata.",
        });
      }
    }
  }, []);
  // Download only — stages the update bytes in the plugin's session handle and
  // stops at "downloaded". Nothing installs until the user clicks Install.
  const handleDownloadUpdate = useCallback(async () => {
    if (!isUpdaterRuntime()) {
      setUpdateStatus(UPDATE_UNAVAILABLE_STATUS);
      return;
    }

    let update = availableUpdateRef.current;
    if (!update) {
      await handleCheckForUpdates("manual");
      update = availableUpdateRef.current;
    }

    if (!update) {
      return;
    }

    const requestId = updateDownloadRequestRef.current + 1;
    updateDownloadRequestRef.current = requestId;
    setUpdateStatus({
      phase: "downloading",
      message: `Downloading RaioPDF ${update.version}...`,
      currentVersion: update.currentVersion,
      availableVersion: update.version,
      progress: null,
    });

    try {
      await downloadSignedUpdate(update, (progress) => {
        if (updateDownloadRequestRef.current === requestId) {
          setUpdateStatus((current) => ({
            ...current,
            phase: "downloading",
            message: progress === null
              ? `Downloading RaioPDF ${update.version}...`
              : `Downloading RaioPDF ${update.version} (${Math.round(progress * 100)}%).`,
            progress,
          }));
        }
      });
      if (updateDownloadRequestRef.current === requestId) {
        setUpdateStatus({
          phase: "downloaded",
          message: `RaioPDF ${update.version} is ready to install.`,
          currentVersion: update.currentVersion,
          availableVersion: update.version,
          progress: 1,
        });
      }
    } catch {
      if (updateDownloadRequestRef.current === requestId) {
        setUpdateStatus({
          phase: "error",
          message: "Update download could not be completed. Try again.",
          currentVersion: update.currentVersion,
          availableVersion: update.version,
        });
      }
    }
  }, [handleCheckForUpdates]);
  // Install only — runs the installer for the already-downloaded update on an
  // explicit click. If nothing is staged yet, fall back to downloading first.
  const handleInstallUpdate = useCallback(async () => {
    if (!isUpdaterRuntime()) {
      setUpdateStatus(UPDATE_UNAVAILABLE_STATUS);
      return;
    }

    const update = availableUpdateRef.current;
    if (!update) {
      await handleDownloadUpdate();
      return;
    }

    const requestId = updateInstallRequestRef.current + 1;
    updateInstallRequestRef.current = requestId;
    setUpdateStatus({
      phase: "installing",
      message: `Installing RaioPDF ${update.version}...`,
      currentVersion: update.currentVersion,
      availableVersion: update.version,
    });

    try {
      await installDownloadedUpdate(update);
      if (updateInstallRequestRef.current === requestId) {
        availableUpdateRef.current = null;
        setUpdateStatus({
          phase: "installed",
          message: "Update installed. Restart RaioPDF to finish.",
          currentVersion: update.currentVersion,
          availableVersion: update.version,
          progress: 1,
        });
      }
    } catch {
      if (updateInstallRequestRef.current === requestId) {
        setUpdateStatus({
          phase: "error",
          message: "Update installation failed. Try again.",
          currentVersion: update.currentVersion,
          availableVersion: update.version,
        });
      }
    }
  }, [handleDownloadUpdate]);
  const handleRelaunchForUpdate = useCallback(() => {
    void relaunchForInstalledUpdate().catch(() => {
      // The update is already installed — only the restart failed. Stay in
      // "installed" (whose pill/Settings action is "Restart") so the button
      // retries the relaunch rather than routing to the generic error state,
      // whose "Try again" would start a pointless fresh download.
      setUpdateStatus((current) => ({
        ...current,
        phase: "installed",
        message:
          "RaioPDF couldn't restart automatically — click Restart to try again, or close and reopen it to finish updating.",
      }));
    });
  }, []);
  useEffect(() => {
    if (!isUpdaterRuntime()) {
      return;
    }
    void handleCheckForUpdates("auto");
  }, [handleCheckForUpdates]);
  const handleSaveCrashReport = useCallback(async (): Promise<string | null> => {
    if (!isTauriRuntime() || !crashReportPayload) {
      return null;
    }

    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ path: string } | null>("crash_report_save_dialog", {
      payload: crashReportPayload,
    });
    return result?.path ?? null;
  }, [crashReportPayload]);
  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;

    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const payload = await invoke<CrashReportPayload | null>(
          "crash_report_take_pending",
        );
        if (!disposed && payload) {
          setCrashReportOpenStatus(null);
          setCrashReportPayload(fitCrashReportPayloadToIssueUrl(payload));
        }
      } catch {
        // Non-Tauri/dev context or command unavailable -- default is no prompt.
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);
  const handleOpenCrashReportIssue = useCallback(() => {
    const payload = crashReportPayload;

    if (!payload || isOpeningCrashReportIssue) {
      return;
    }

    void (async () => {
      setCrashReportOpenStatus(null);
      setIsOpeningCrashReportIssue(true);
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(buildCrashReportIssueUrl(payload));
        setCrashReportPayload(null);
        setCrashReportOpenStatus(null);
      } catch {
        setCrashReportOpenStatus(
          "Couldn't open your browser — try again, or use File → Export Diagnostics.",
        );
      } finally {
        setIsOpeningCrashReportIssue(false);
      }
    })();
  }, [crashReportPayload, isOpeningCrashReportIssue]);
  const handleNeverAskCrashReport = useCallback(() => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("crash_report_never_ask");
        setCrashReportPayload(null);
        setCrashReportOpenStatus(null);
      } catch {
        // If the preference cannot be saved, keep the prompt visible.
      }
    })();
  }, []);

  const buildProductionSetFromUi = useCallback(async (input: ProductionSetRunInput) => {
    setProductionProgress({
      running: true,
      message: "Building production package...",
      result: null,
    });

    try {
      const sourceGrants = requireFileGrants(
        input.files.map((file) => file.path),
        "Production package output needs PDFs opened from local desktop paths.",
      );

      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        packageRoot: string;
        indexLocation: string | null;
        nextNumber: number;
        fileCount: number;
      }>("build_production_set", {
        sources: input.files.map((file, index) => {
          const grant = sourceGrants[index];
          if (!grant) {
            throw new Error("Production package output needs PDFs opened from local desktop paths.");
          }

          return {
            grant,
            designation: file.designation || undefined,
          };
        }),
        outputDir: input.outputDir,
        prefix: input.prefix,
        start: input.start,
        digits: input.digits,
        includeIndex: input.includeIndex,
        includeFilenameInIndex: input.includeFilenameInIndex,
        combinedPdf: input.combinedPdf,
        volumeSizeMb: input.volumeSizeMb ?? undefined,
      });

      writeProductionLastUsed(input.prefix, result.nextNumber - 1);
      setProductionProgress({
        running: false,
        message: `Production package built for ${result.fileCount} file(s).`,
        result,
      });
    } catch (error) {
      logWorkflowFailure("production.failed", error);
      const message = formatWorkflowError(error, "Production package could not be built.");
      setProductionProgress({
        running: false,
        message,
        result: null,
      });
    }
  }, []);

  const buildBatchCleanupFromUi = useCallback(async (input: BatchCleanupRunInput) => {
    setBatchCleanupProgress({
      running: true,
      message: "Running batch cleanup...",
      result: null,
    });

    try {
      const inputGrants = requireFileGrants(
        input.files.map((file) => file.path),
        "Batch cleanup needs PDFs opened from local desktop paths.",
      );

      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        packageRoot: string;
        reportPdf: string;
        reportJson: string;
        files: {
          sourceFilename: string;
          status: "pending" | "running" | "done" | "failed" | "skipped";
          reason: string | null;
          signatureInvalidated?: boolean;
          outputs: string[];
        }[];
      }>("batch_cleanup", {
        inputGrants,
        outputDir: input.outputDir,
        packId: input.packId ?? undefined,
        operations: input.operations,
      });

      setBatchCleanupProgress({
        running: false,
        message: batchCleanupCompletionMessage(result.files),
        result,
      });
    } catch (error) {
      logWorkflowFailure("batch.failed", error);
      const message = formatWorkflowError(error, "Batch cleanup could not be completed.");
      setBatchCleanupProgress({
        running: false,
        message,
        result: null,
      });
    }
  }, []);
  const buildFilingPacketFromUi = useCallback(async (input: FilingPacketBuildInput) => {
    setFilingPacketProgress({
      running: true,
      message: "Building filing packet...",
      result: null,
    });

    try {
      const sourceGrants = requireFileGrants(
        input.files.map((file) => file.path),
        "Filing packet needs PDFs opened from local desktop paths.",
      );

      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        packageRoot: string;
        outputs: string[];
        manifestPdf: string;
        packetJson: string;
        combinedPdf: string | null;
      }>("build_filing_packet", {
        sources: input.files.map((file, index) => {
          const grant = sourceGrants[index];
          if (!grant) {
            throw new Error("Filing packet needs PDFs opened from local desktop paths.");
          }

          return {
            grant,
            displayName: file.name,
          };
        }),
        outputDir: input.outputDir,
        pack: filingPack.id,
        layoutMode: input.layoutMode,
        prefixFilenames: input.prefixFilenames,
        maxFileBytes: filingPack.maxFileBytes,
        maxEnvelopeBytes: filingPack.maxEnvelopeBytes,
        selectedStepIds: input.selectedStepIds,
        splitSizeMb: input.customSplitMegabytes ?? undefined,
      });

      setFilingPacketProgress({
        running: false,
        message: `Filing packet built with ${result.outputs.length} upload file(s).`,
        result,
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Filing packet could not be built.";
      setFilingPacketProgress({
        running: false,
        message,
        result: null,
      });
    }
  }, [filingPack.id, filingPack.maxEnvelopeBytes, filingPack.maxFileBytes]);
  const ocrRunRef = useRef(0);
  const ocrActiveRef = useRef(false);
  /** One-shot preserve marker, mirroring `preserveFilingProgressForGenerationRef`:
   * the OCR flow stamps the generation it is about to reopen/replace FROM so the
   * generation-change effect keeps its in-flight ocrState (e.g. the "done"
   * message) instead of resetting it. */
  const preserveOcrStateForGenerationRef = useRef<number | null>(null);
  const pendingOcrTypeRef = useRef<OcrType>("skip-text");
  const savingRef = useRef(false);
  const pendingMoveToNewWindowTabIdRef = useRef<string | null>(null);
  const batesApplyingRef = useRef(false);
  const redactionIdRef = useRef(0);
  const documentGenerationRef = useRef<number>(document.generation);
  const legalStateDocumentGenerationRef = useRef<number>(document.generation);
  const tabEditingSnapshotsRef = useRef(new Map<number, TabEditingSnapshot>());
  const preserveFilingProgressForGenerationRef = useRef<number | null>(null);
  const scannerRunRef = useRef(0);
  const filingRunRef = useRef(0);
  const pathOpCancelRequestsRef = useRef<Set<string>>(new Set());
  const droppedMaterializationRef = useRef<{
    generation: number;
    promise: Promise<OpenedFileSource | null>;
  } | null>(null);
  const filingFactsCacheRef = useRef<FilingFactsCache>({
    byBytes: new WeakMap(),
  });
  const nativeMenuCommandRef = useRef<(command: string) => void>(() => {});
  const filingEngine = useMemo(() => new LocalPdfEngine(), []);
  const isPathOpCancelRequested = useCallback(
    (jobToken: string | null | undefined) => (
      !!jobToken && pathOpCancelRequestsRef.current.has(jobToken)
    ),
    [],
  );
  const clearPathOpCancelRequest = useCallback((jobToken: string | null | undefined) => {
    if (jobToken) {
      pathOpCancelRequestsRef.current.delete(jobToken);
    }
  }, []);

  useLayoutEffect(() => {
    documentGenerationRef.current = document.generation;
  }, [document.generation]);

  const resetLegalState = useCallback(() => {
    preserveFilingProgressForGenerationRef.current = null;
    setPendingRedactions([]);
    setActiveTextEdit(false);
    setTextEditAnnotationPrompt(false);
    setRedactionPhase("idle");
    setRedactionMessage(null);
    setRedactionSearchOpen(false);
    setRedactionSearchText("");
    setScannerState({ scanning: false, message: null, hits: [] });
    setBatesState({ applying: false, message: null });
    setScrubState({ scrubbing: false, message: null, removedFields: [] });
    setFilingReport(null);
    setFilingReportLoading(false);
    setFilingReportError(null);
    setFilingProgress({ phase: "idle", message: null });
    setFilingResult(null);
    setFilingImpact(null);
    setFilingPacketProgress({ running: false, message: null, result: null });
    setBinderProgress({ running: false, message: null, detail: null });
    setProductionProgress({ running: false, message: null, result: null });
    setBatchCleanupProgress({ running: false, message: null, result: null });
    pathOpCancelRequestsRef.current.clear();
    setPathOpCancelState(null);
    setLastPrepareConfiguration(null);
    setSidecarStatus({
      running: false,
      message: null,
      removed: [],
      beforeBytes: null,
      afterBytes: null,
    });
  }, []);

  const clearDocumentBoundLegalState = useCallback((previousGeneration: number) => {
    const preserveFilingProgress =
      preserveFilingProgressForGenerationRef.current === previousGeneration;
    preserveFilingProgressForGenerationRef.current = null;
    const preserveOcrState =
      preserveOcrStateForGenerationRef.current === previousGeneration;
    preserveOcrStateForGenerationRef.current = null;
    scannerRunRef.current += 1;
    filingRunRef.current += 1;
    if (!preserveOcrState) {
      // A generation change the OCR flow didn't announce makes any running
      // OCR stale by construction. Reset the OCR UI (the same way
      // filingProgress is reset) so a mid-run mutation can never leave
      // ocrState frozen at processing/verifying, pinning longProcessRunning
      // and wedging Prepare-for-Filing/ToA/Combine-Exhibits/text-edit.
      ocrRunRef.current += 1;
      ocrActiveRef.current = false;
      setOcrState({ phase: "idle", message: null });
    }
    setPendingRedactions([]);
    setActiveTextEdit(false);
    setTextEditAnnotationPrompt(false);
    setScannerState({ scanning: false, message: null, hits: [] });
    setFilingReport(null);
    setFilingReportLoading(false);
    setFilingReportError(null);
    setFilingResult(null);
    setFilingImpact(null);
    setFilingPacketProgress({ running: false, message: null, result: null });
    setBinderProgress({ running: false, message: null, detail: null });
    setProductionProgress({ running: false, message: null, result: null });
    setBatchCleanupProgress({ running: false, message: null, result: null });
    pathOpCancelRequestsRef.current.clear();
    setPathOpCancelState(null);
    setLastPrepareConfiguration(null);
    if (!preserveFilingProgress) {
      setFilingProgress({ phase: "idle", message: null });
    }
  }, []);

  const resetVisibleDocumentAppState = useCallback((next: "document" | "empty") => {
    ocrRunRef.current += 1;
    ocrActiveRef.current = false;
    preserveOcrStateForGenerationRef.current = null;
    setOcrState({ phase: "idle", message: null });
    pathOpCancelRequestsRef.current.clear();
    setPathOpCancelState(null);
    setLastPrepareConfiguration(null);
    setForceOcrConfirmation(null);
    resetLegalState();
    setSelectedPageIndexes(next === "document" ? new Set([0]) : new Set());
    setPageDeleteConfirmation(null);
    setPasswordPrompt(null);
    setRepairCandidate(null);
  }, [resetLegalState]);

  /**
   * Stash the visible document's pending editing state (annotation overlays,
   * form values, pending redactions, overlay-dirty marker) before another
   * tab takes over, keyed by `document.generation`. The source-change effect
   * below restores it on switch-back instead of resetting, so a tab switch
   * never silently destroys pending work — and the tab's dirty flag keeps
   * describing real, restorable edits.
   */
  const stashVisibleDocumentEditingState = useCallback(() => {
    if (!document.source) {
      return;
    }

    const snapshots = tabEditingSnapshotsRef.current;
    // Drop entries whose document no longer lives in any tab (generations
    // are never reused, so stale entries can only waste memory, not
    // restore into the wrong document).
    const liveGenerations = new Set(documentTabs.map((tab) => tab.document.generation));
    for (const generation of [...snapshots.keys()]) {
      if (!liveGenerations.has(generation)) {
        snapshots.delete(generation);
      }
    }

    if (!editing.hasUnsavedEdits && pendingRedactions.length === 0) {
      // Nothing worth restoring; switch-back re-imports annotations from
      // the document itself.
      snapshots.delete(document.generation);
      return;
    }

    snapshots.set(document.generation, {
      editing: editing.captureDocumentState(),
      pendingRedactions,
      overlayDirty: overlayDirtyRef.current,
    });
  }, [document.generation, document.source, documentTabs, editing, pendingRedactions]);

  const handleTabSelected = useCallback((tabId: string) => {
    if (tabId === activeTabId) {
      return;
    }

    if (longProcessRunning) {
      // A delegated long op resolves against the active document's
      // (openToken, generation); switching tabs mid-run swaps the open
      // token and would silently discard the finished output.
      setError("Finish the current document operation before switching tabs.");
      return;
    }

    if (switchDocumentTab(tabId)) {
      stashVisibleDocumentEditingState();
      resetVisibleDocumentAppState("document");
    }
  }, [activeTabId, longProcessRunning, resetVisibleDocumentAppState, setError, stashVisibleDocumentEditingState, switchDocumentTab]);

  // Document identity is (openToken, generation) [R1-8] — never a
  // Uint8Array reference, which streamed documents don't have.
  const isCurrentDocument = useCallback(
    (sourceOpenToken: number, sourceGeneration: number) => (
      getOpenToken() === sourceOpenToken && documentGenerationRef.current === sourceGeneration
    ),
    [getOpenToken],
  );

  /** Streamed variant of `openOpenedFile`: same per-open state resets, but
   * the document opens over a range transport — no bytes anywhere. */
  const openStreamedSource = useCallback(
    (
      source: Exclude<OpenedFileSource, { kind: "memory" }>,
      options: { openInNewTab?: boolean; markDirty?: boolean } = {},
    ): Promise<OpenFileResult> => {
      const opensNewTab = Boolean(options.openInNewTab && document.source);
      if (opensNewTab && longProcessRunning) {
        // Opening into a new tab implicitly switches tabs, which would
        // silently discard the finished output of the delegated op that is
        // still resolving against the active document.
        setError(NEW_TAB_BUSY_MESSAGE);
        return Promise.resolve({ status: "failed", error: NEW_TAB_BUSY_MESSAGE });
      }
      if (opensNewTab) {
        stashVisibleDocumentEditingState();
      }
      ocrRunRef.current += 1;
      ocrActiveRef.current = false;
      setOcrState({ phase: "idle", message: null });
      resetLegalState();
      setSelectedPageIndexes(new Set());
      setPasswordPrompt(null);
      setRepairCandidate(null);
      return openStreamedFile(
        source.kind === "rangeGrant"
          ? {
              source: { kind: "rangeGrant", grant: source.grant, sizeBytes: source.sizeBytes },
              name: source.name,
              path: source.grant,
            }
          : {
              source: { kind: "rangeFile", file: source.file, sizeBytes: source.sizeBytes },
              name: source.name,
              path: null,
            },
        {
          openMode: options.openInNewTab && document.source ? "new-tab" : "replace-active",
          ...(options.markDirty ? { markDirty: true } : {}),
        },
      ).then((result) => {
        if (result.status === "opened") {
          setSelectedPageIndexes(new Set([0]));
        }

        return result;
      });
    },
    [document.source, longProcessRunning, openStreamedFile, resetLegalState, setError, stashVisibleDocumentEditingState],
  );

  /**
   * The shared reconcile flow for delegated (path-based) ops: an op's output
   * reopens as a NEW document, so the generation bumps by construction
   * [R1-8] — in-flight work for the old document goes stale and
   * per-generation caches drop. Every un-gated streamed workflow (OCR,
   * repair, compress, sanitize, redact, decrypt, stamps, merge/insert)
   * funnels its output through here.
   *
   * Memory-mode reopen (v1.1 decision): a BELOW-threshold output is read
   * once by grant and opened as an ordinary in-memory document — full
   * editing restored (a 283 MB file compressed to 30 MB becomes editable
   * again). At/above the threshold the output reopens streamed over its
   * fresh grant, exactly as before.
   */
  const openPathOpOutput = useCallback(
    async (
      output: { outputGrant: FileGrant; name: string; sizeBytes: number },
      expected: DocumentIdentityGuard,
      // `openInNewTab` is for outputs that are a NEW independent document (e.g.
      // an imported Word file) rather than a reopen of the op's own source: open
      // it in a new tab when a document is already present, exactly like File ->
      // Open, so it never replaces/clobbers an unsaved active tab. Defaults off,
      // so in-place reopens (OCR, decrypt, ...) keep replacing the active tab.
      // `markDirty` opens the reopened copy dirty so Close prompts to save — for
      // outputs that are an unsaved working copy (OCR), not a saved artifact.
      options: { openInNewTab?: boolean; markDirty?: boolean } = {},
    ) => {
      const staleResult = {
        status: "failed" as const,
        error: "The document changed before the operation output could reopen.",
      };
      const releaseStaleOutput = async () => {
        await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
        return staleResult;
      };
      if (!isCurrentDocument(expected.openToken, expected.generation)) {
        return releaseStaleOutput();
      }

      const plan = await planPathOpReopen(output);

      if (!isCurrentDocument(expected.openToken, expected.generation)) {
        return releaseStaleOutput();
      }

      // The in-memory reopen (openDocumentFile) always replaces the active tab.
      // For a NEW independent document (openInNewTab) that would clobber an open
      // doc, so skip it and use the streamed open below, which supports new-tab.
      if (plan.mode === "memory" && !options.openInNewTab) {
        // Same per-open resets as `openOpenedFile` — this IS a fresh open.
        ocrRunRef.current += 1;
        ocrActiveRef.current = false;
        setOcrState({ phase: "idle", message: null });
        resetLegalState();
        setSelectedPageIndexes(new Set());
        setPasswordPrompt(null);
        setRepairCandidate(null);

        const result = await openDocumentFile(
          {
            bytes: plan.bytes,
            name: output.name,
            path: null,
          },
          options.markDirty ? { markDirty: true } : {},
        );

        if (result.status === "opened") {
          setSelectedPageIndexes(new Set([0]));
          // The bytes live in memory now and the document deliberately has
          // no on-disk identity (filePath null, clean, Save As flow) — the
          // temp output file has no further use. Best-effort: the startup
          // sweep covers anything this misses.
          await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
          return result;
        }

        // The in-memory engine couldn't open the small output — fall back
        // to the streamed reopen over the still-valid grant (not released)
        // rather than dead-ending a file qpdf just verified.
        if (result.status === "failed" && !isCurrentDocument(expected.openToken, expected.generation)) {
          return releaseStaleOutput();
        }
      }

      return openStreamedSource(
        {
          kind: "rangeGrant",
          grant: output.outputGrant,
          name: output.name,
          sizeBytes: output.sizeBytes,
        },
        {
          openInNewTab: options.openInNewTab ?? false,
          ...(options.markDirty ? { markDirty: true } : {}),
        },
      );
    },
    [isCurrentDocument, openDocumentFile, openStreamedSource, resetLegalState],
  );

  useEffect(() => {
    let disposed = false;
    let loadedDocument: PDFDocumentProxy | null = null;
    let transport: RaioPdfRangeTransport | null = null;
    const source = document.source;
    const sourceGeneration = document.generation;

    if (!source) {
      setPdfDocumentState(null);
      return;
    }

    setPdfDocumentState(null);

    if (source.kind === "memory") {
      const sourceBytes = source.bytes;

      void hideRaioPdfImportedAnnotationsForDisplay(sourceBytes)
        .then((displayBytes) => loadPdfDocument(displayBytes))
        .then((loaded) => {
          loadedDocument = loaded;

          if (disposed) {
            void loaded.loadingTask.destroy();
            return;
          }

          setPdfDocumentState({ generation: sourceGeneration, bytes: sourceBytes, proxy: loaded });
        })
        .catch((error: unknown) => {
          if (disposed) {
            return;
          }

          if (error instanceof PasswordException) {
            // Defense in depth: today `engine.open()` (pdf-lib) already
            // rejects any encrypted PDF before this preview even runs, so
            // this branch isn't reachable through the normal open path (see
            // openOpenedFile's "password-required" branch above). Kept in
            // case a future engine change lets a document open on the engine
            // side while pdf.js still needs a password to render it --
            // route that into the same unlock dialog instead of a dead-end
            // preview error.
            setPasswordPrompt({
              source: { kind: "bytes", bytes: sourceBytes },
              fileName: document.fileName ?? "Document.pdf",
              filePath: document.filePath,
              phase: "prompt",
              error: null,
            });
            return;
          }

          setError(getPdfLoadErrorMessage(error));
        });
    } else {
      // Streamed open [R1-4]: pdf.js reads the file through a range
      // transport — bytes are fetched on demand and never held whole in the
      // WebView. The transport is keyed to this effect's lifetime: cleanup
      // aborts it so a superseded/closed document ignores late invoke
      // resolutions instead of feeding a destroyed worker.
      const onRangeReadError = (error: unknown) => {
        if (disposed) {
          return;
        }

        setError(
          isFileChangedError(error)
            ? "This file changed on disk — reopen it."
            : "Part of this document could not be read from disk. Scroll again to retry, or reopen the file.",
        );
      };
      transport = source.kind === "rangeGrant"
        ? createGrantRangeTransport(source.grant, source.sizeBytes, onRangeReadError)
        : createFileRangeTransport(source.file, onRangeReadError);

      void loadStreamedPdfDocument(transport)
        .then((loaded) => {
          loadedDocument = loaded;

          if (disposed) {
            void loaded.loadingTask.destroy();
            return;
          }

          // pageCount lives on the pdf.js proxy in streamed mode — there is
          // no engine handle to count pages with.
          setStreamedPageCount(loaded.numPages, { generation: sourceGeneration });
          setPdfDocumentState({ generation: sourceGeneration, bytes: null, proxy: loaded });
        })
        .catch((error: unknown) => {
          if (disposed) {
            return;
          }

          if (error instanceof PasswordException) {
            if (source.kind === "rangeGrant" && isPathOpsRuntime()) {
              // Encrypted large file: prompt for the open password and
              // decrypt by grant through the path-based qpdf op — the file
              // is never materialized in the WebView.
              setPasswordPrompt({
                source: { kind: "grant", grant: source.grant },
                fileName: document.fileName ?? "Document.pdf",
                filePath: document.filePath,
                phase: "prompt",
                error: null,
              });
              return;
            }

            // Browser streamed docs have no shell grant — honest error.
            setError(
              "This PDF is encrypted. Removing encryption isn't available here for very large files.",
            );
            return;
          }

          // Badly malformed large files: typed open error. Repair now runs
          // path-based through the local engine — point at it.
          setError(
            source.kind === "rangeGrant" && isPathOpsRuntime()
              ? "This large PDF could not be opened for streaming view. It may be malformed — try Organize → Repair to fix it."
              : "This large PDF could not be opened for streaming view. It may be malformed.",
          );
        });
    }

    return () => {
      disposed = true;
      transport?.abort();
      void loadedDocument?.loadingTask.destroy();
    };
    // fileName/filePath intentionally excluded: this effect should only
    // reload the preview when the document identity changes (source swap on
    // open/commit), not on a rename (e.g. a Save that only updates the
    // display name).
  }, [document.source, document.generation, setError, setStreamedPageCount]);

  useEffect(() => {
    const sourceBytes = document.bytes;

    if (!pdfDocument) {
      return;
    }

    if (document.textLayerCoverage) {
      setHasTextLayer(hasSearchableTextLayerCoverage(document.textLayerCoverage));
      return;
    }

    if (!sourceBytes && streamedDocument) {
      setTextLayerCoverage(null);
      return;
    }

    let disposed = false;

    const coverage = inspectOpenTextLayerCoverage({
      bytes: sourceBytes,
      pdfDocument,
      streamed: streamedDocument,
    });

    void coverage
      .then((textLayerCoverage) => {
        if (disposed) {
          return;
        }
        if (!textLayerCoverage) {
          setTextLayerCoverage(null);
          setHasTextLayer(false);
          return;
        }

        setTextLayerCoverage(textLayerCoverage);
        setHasTextLayer(hasSearchableTextLayerCoverage(textLayerCoverage));
      })
      .catch(() => {
        if (!disposed) {
          setTextLayerCoverage(null);
          setHasTextLayer(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [
    document.bytes,
    document.textLayerCoverage,
    pdfDocument,
    setHasTextLayer,
    setTextLayerCoverage,
    streamedDocument,
  ]);

  // Keyed on `source` (not generation): a plain Save swaps the source object
  // without bumping generation, and document-bound legal state cleared on
  // save before this change too — the cadence must not loosen.
  useEffect(() => {
    const previousGeneration = legalStateDocumentGenerationRef.current;
    legalStateDocumentGenerationRef.current = document.generation;
    clearDocumentBoundLegalState(previousGeneration);
  }, [clearDocumentBoundLegalState, document.generation, document.source]);

  // Pending edits and form values are geometry- and page-bound, so source
  // swaps reset and re-import annotations. Engine-handle churn for the same
  // source must not force a full annotation re-parse.
  const resetEditingForDocument = editing.resetForDocument;
  const restoreEditingDocumentState = editing.restoreDocumentState;
  const loadImportedAnnotations = editing.loadImportedAnnotations;
  const editingDocumentSourceRef = useRef<typeof document.source | undefined>(undefined);
  const importedAnnotationsSourceRef = useRef<typeof document.source | undefined>(undefined);
  /**
   * The document source whose editing state (snapshot restore or reset) has
   * been APPLIED and re-rendered. The restore/reset scheduled by the effect
   * below lands one flush after a tab switch, so anything that closes over
   * `editing` (e.g. the deferred move-to-new-window save) must wait until
   * this marker matches `document.source` — otherwise it would run with the
   * previous tab's overlays/form values (Codex review, PR #236).
   */
  const [editingSyncedSource, setEditingSyncedSource] = useState<DocumentState["source"]>(null);
  useEffect(() => {
    let disposed = false;
    const sourceChanged = editingDocumentSourceRef.current !== document.source;
    editingDocumentSourceRef.current = document.source;
    // Batched with the restore/reset below, so the render in which the
    // marker matches also carries the target document's editing state.
    setEditingSyncedSource(document.source);

    if (sourceChanged) {
      const snapshot = tabEditingSnapshotsRef.current.get(document.generation);
      if (snapshot && document.source !== null) {
        // Switch-back to a document whose pending editing state was stashed
        // on switch-away: restore instead of resetting. The snapshot already
        // contains the imported annotations, so skip the re-import below.
        tabEditingSnapshotsRef.current.delete(document.generation);
        restoreEditingDocumentState(snapshot.editing);
        setPendingRedactions([...snapshot.pendingRedactions]);
        overlayDirtyRef.current = snapshot.overlayDirty;
        importedAnnotationsSourceRef.current = document.source;
        return;
      }

      resetEditingForDocument();
      importedAnnotationsSourceRef.current = undefined;
    }

    // Imported annotations are document-bound pending edits. Keep reset and
    // import in this flow so a source swap deterministically resets first,
    // then rehydrates imports without relying on sibling effect order.
    if (document.source === null || document.source.kind !== "memory" || !document.engineHandle) {
      if (sourceChanged) {
        loadImportedAnnotations([]);
      }
      return;
    }

    if (importedAnnotationsSourceRef.current === document.source) {
      return;
    }

    void readRaioPdfAnnotations()
      .then((annotations) => {
        if (!disposed) {
          importedAnnotationsSourceRef.current = document.source;
          loadImportedAnnotations(annotations);
        }
      })
      .catch(() => {
        if (!disposed) {
          importedAnnotationsSourceRef.current = document.source;
          loadImportedAnnotations([]);
        }
      });

    return () => {
      disposed = true;
    };
  }, [
    document.engineHandle,
    document.generation,
    document.source,
    loadImportedAnnotations,
    readRaioPdfAnnotations,
    resetEditingForDocument,
    restoreEditingDocumentState,
  ]);

  const selectEditTool = useCallback(
    (toolId: EditToolId) => {
      if (toolId !== "select" && activeTextEdit && textEdit.pendingOps.length > 0) {
        setError("Review or clear queued text replacements before using annotation tools.");
        return;
      }

      // Streamed mode: pending annotation overlays are allowed only when the
      // shell can commit them through the Node one-shot lane [R1-2].
      if (
        toolId !== "select" &&
        streamedDocument &&
        !isPathOpAvailableForInput(pathOpsGeneralStatus, "apply_edits", document.fileSizeBytes)
      ) {
        setError(streamedEditingGateMessage(pathOpsGeneralStatus, document.fileSizeBytes, pathOpsGrant !== null));
        return;
      }

      const streamedToolGate = editToolStreamedGateMessage(toolId, streamedDocument);
      if (streamedToolGate) {
        setError(streamedToolGate);
        return;
      }

      if (toolId !== "select" && activeLegalTool === "redact") {
        setActiveLegalTool(null);
      }

      if (toolId !== "select") {
        setActiveTextEdit(false);
      }

      setActiveEditDialogTool(null);
      editing.setTool(toolId);
    },
    [
      activeLegalTool,
      activeTextEdit,
      document.fileSizeBytes,
      editing,
      pathOpsGeneralStatus,
      pathOpsGrant,
      setError,
      streamedDocument,
      textEdit.pendingOps.length,
    ],
  );

  const enterTextEditMode = useCallback(() => {
    setActiveTextEdit(true);
    setActiveLegalTool(null);
    setActiveOrganizeTool(null);
    setActiveEditDialogTool(null);
    editing.setTool("select");
  }, [editing]);

  const requestTextEditMode = useCallback(() => {
    if (longProcessRunning) {
      return;
    }

    if (activeTextEdit) {
      setActiveTextEdit(false);
      return;
    }

    if (streamedDocument) {
      setError(textEdit.gate.message ?? "This document is too large for in-app text editing.");
      return;
    }

    if (editing.hasUnsavedEdits) {
      setTextEditAnnotationPrompt(true);
      return;
    }

    enterTextEditMode();
  }, [activeTextEdit, editing.hasUnsavedEdits, enterTextEditMode, longProcessRunning, setError, streamedDocument, textEdit.gate.message]);

  const saveAnnotationsAndEnterTextEdit = useCallback(async () => {
    const pendingApply = editing.collectAnnotationSavePlan();

    if (pendingApply) {
      const applied = await applyAnnotationSavePlan({
        appendEdits: pendingApply.plan.appendEdits,
        updateEdits: pendingApply.plan.updateEdits,
        deleteAnnotIds: pendingApply.plan.deleteAnnotIds,
      }, {
        flatten: pendingApply.flatten,
        printMarkupAnnotations,
      });

      if (!applied) {
        setError("Pending annotations could not be saved. Text editing was not started.");
        return;
      }
      editing.clearPending();
    }

    setTextEditAnnotationPrompt(false);
    enterTextEditMode();
  }, [applyAnnotationSavePlan, editing, enterTextEditMode, printMarkupAnnotations, setError]);

  const discardAnnotationsAndEnterTextEdit = useCallback(() => {
    editing.clearPendingEdits();
    setTextEditAnnotationPrompt(false);
    enterTextEditMode();
  }, [editing, enterTextEditMode]);

  // Esc exits any edit mode. Inline editors (text draft, comment popover)
  // consume their own Escape via stopPropagation before this fires.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      if (editing.tool !== "select") {
        editing.setTool("select");
        return;
      }

      if (activeTextEdit) {
        setActiveTextEdit(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTextEdit, editing]);

  useEffect(() => {
    let disposed = false;

    if (!document.bytes) {
      // Streamed mode: metadata comes from pdf.js `getMetadata()` on the
      // shared proxy (no pdf-lib, no full-byte parse); gaps render as "—".
      if (streamedDocument && pdfDocument) {
        void readStreamedMetadataSummary(pdfDocument)
          .then((summary) => {
            if (!disposed) {
              setMetadataSummary(summary);
            }
          })
          .catch(() => {
            if (!disposed) {
              setMetadataSummary(null);
            }
          });

        return () => {
          disposed = true;
        };
      }

      setMetadataSummary(null);
      return;
    }

    void readMetadataSummary(document.bytes)
      .then((summary) => {
        if (!disposed) {
          setMetadataSummary(summary);
        }
      })
      .catch(() => {
        if (!disposed) {
          setMetadataSummary(null);
        }
      });

    return () => {
      disposed = true;
    };
  }, [document.bytes, pdfDocument, streamedDocument]);

  useEffect(() => {
    if (activeLegalTool !== "prepare-for-filing") {
      return;
    }

    const source = document.source;
    if (source?.kind !== "rangeFile" || !isTauriRuntime()) {
      return;
    }

    const sourceGeneration = document.generation;
    const sourceOpenToken = getOpenToken();
    if (droppedMaterializationRef.current?.generation === sourceGeneration) {
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    const promise = materializeDroppedFileGrant(source.file, controller.signal);
    droppedMaterializationRef.current = { generation: sourceGeneration, promise };
    setFilingReport(null);
    setFilingFacts(null);
    setPathOpsFilingStatus(null);
    setFilingReportLoading(true);
    setFilingReportError(null);
    setFilingProgress((current) => (
      current.phase === "idle"
        ? { phase: "normalizing", message: DROPPED_PDF_MATERIALIZE_MESSAGE }
        : current
    ));

    void promise
      .then((materialized) => {
        if (materialized?.kind !== "rangeGrant") {
          return;
        }

        if (disposed || !isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          void pathOpReleaseOutput(materialized.grant).catch(() => undefined);
          return;
        }

        upgradeStreamedFileToGrant(
          {
            grant: materialized.grant,
            sizeBytes: materialized.sizeBytes,
            name: materialized.name,
          },
          { openToken: sourceOpenToken, generation: sourceGeneration },
        );
      })
      .catch((error: unknown) => {
        if (disposed || !isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          return;
        }

        setFilingReport(null);
        setFilingFacts(null);
        setFilingReportError(formatWorkflowError(
          error,
          "RaioPDF could not prepare this dropped PDF for filing. Try opening it with File > Open.",
        ));
        setFilingProgress({
          phase: "error",
          message: "RaioPDF could not prepare this dropped PDF for filing.",
        });
      })
      .finally(() => {
        if (droppedMaterializationRef.current?.generation === sourceGeneration) {
          droppedMaterializationRef.current = null;
        }

        if (!disposed && isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setFilingReportLoading(false);
          setFilingProgress((current) => (
            current.phase === "normalizing" && current.message === DROPPED_PDF_MATERIALIZE_MESSAGE
              ? { phase: "idle", message: null }
              : current
          ));
        }
      });

    return () => {
      disposed = true;
      controller.abort();
      // The abort kills this in-flight materialization, so drop the ref now
      // rather than waiting for the (disposed) promise's `finally`. Otherwise
      // reopening Prepare for the same dropped PDF before the abort settles hits
      // the generation guard above, returns early, and never restarts — leaving
      // the document a `rangeFile` with the checklist disabled. [Codex #187 P2]
      if (droppedMaterializationRef.current?.generation === sourceGeneration) {
        droppedMaterializationRef.current = null;
      }
    };
  }, [
    activeLegalTool,
    document.generation,
    document.source,
    getOpenToken,
    isCurrentDocument,
    upgradeStreamedFileToGrant,
  ]);

  useEffect(() => {
    let disposed = false;
    const sourceBytes = document.bytes;
    const sourceGeneration = document.generation;

    if (activeLegalTool !== "prepare-for-filing") {
      setFilingReportLoading(false);
      setFilingReportError(null);
      return;
    }

    if (!sourceBytes) {
      if (pathOpsGrant) {
        // Streamed preflight [R5-2]: facts come from `document_facts` (qpdf
        // --json) — no bytes, no pdf-lib. Checks the facts can't evaluate
        // render as "not evaluated for very large files", never as passed.
        // The PathOpsEngine status rides along for the closed-form checklist
        // rule [R7-1].
        const grant = pathOpsGrant;
        setFilingReportLoading(true);
        setFilingReportError(null);

        void Promise.all([pathOpDocumentFacts(grant), pathOpsStatus()])
          .then(([rawFacts, status]) => {
            if (disposed || documentGenerationRef.current !== sourceGeneration) {
              return;
            }

            const facts = mapPathOpsFactsToDocumentFacts(rawFacts, {
              ...(document.fileName ? { filename: document.fileName } : {}),
            });
            setPathOpsFilingStatus(status);
            setFilingFacts(facts);
            setFilingReport(annotateStreamedPreflight(runFilingPreflight(facts, filingPack)));
            setFilingReportError(null);
          })
          .catch((error: unknown) => {
            if (disposed || documentGenerationRef.current !== sourceGeneration) {
              return;
            }

            setFilingFacts(null);
            setFilingReport(null);
            setFilingReportError(pathOpErrorMessage(
              error,
              "RaioPDF could not read the facts needed for filing checks. The document was left unchanged; try reopening the PDF.",
            ));
          })
          .finally(() => {
            if (!disposed && documentGenerationRef.current === sourceGeneration) {
              setFilingReportLoading(false);
            }
          });

        return () => {
          disposed = true;
        };
      }

      // Browser streamed docs (no shell grant) and empty state: no report.
      setFilingReport(null);
      setFilingFacts(null);
      setFilingReportLoading(false);
      setFilingReportError(null);
      return;
    }

    const factsOptions: FilingFactsOptions = {
      fileBytes: document.fileSizeBytes ?? sourceBytes.byteLength,
      ...(document.fileName ? { filename: document.fileName } : {}),
      pdfDocument: pdfDocumentBytes === sourceBytes ? pdfDocument : null,
    };

    if (document.textLayerCoverage !== null) {
      factsOptions.occupiedRegionPages = "first";
    }

    setFilingReportLoading(true);
    setFilingReportError(null);

    void getCachedFilingFacts(filingFactsCacheRef, sourceBytes, factsOptions)
      .then((facts) => {
        if (disposed || documentGenerationRef.current !== sourceGeneration) {
          return;
        }

        setFilingFacts(facts);
        setFilingReport(runFilingPreflight(facts, filingPack));
        setFilingReportError(null);
      })
      .catch(() => {
        if (!disposed && documentGenerationRef.current === sourceGeneration) {
          setFilingFacts(null);
          setFilingReport(null);
          setFilingReportError("RaioPDF could not read the facts needed for filing checks. The document was left unchanged; try reopening or repairing the PDF.");
        }
      })
      .finally(() => {
        if (!disposed && documentGenerationRef.current === sourceGeneration) {
          setFilingReportLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [activeLegalTool, document.bytes, document.generation, document.fileName, document.fileSizeBytes, document.textLayerCoverage, filingPack, pathOpsGrant, pdfDocument, pdfDocumentBytes]);

  const runOcrWorkflow = useCallback((ocrType: OcrType) => {
    if (ocrActiveRef.current) {
      return;
    }

    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;
    const delegatedOcrGrant = engineDelegatedGrant;
    const resolveSourceTextLayerCoverage = async (): Promise<TextLayerCoverage | null> => {
      if (ocrType === "force-ocr") {
        return null;
      }

      if (document.textLayerCoverage) {
        return document.textLayerCoverage;
      }

      try {
        if (pdfDocument) {
          return await pdfDocumentTextLayerCoverage(pdfDocument);
        }

        if (sourceBytes) {
          return await inspectTextLayer(sourceBytes);
        }
      } catch {
        // Preflight is advisory. Post-OCR verification still decides whether
        // the output is safe to apply.
      }

      return null;
    };
    const resolveOcrRunPlan = async () => (
      planOcrRun(ocrType, await resolveSourceTextLayerCoverage())
    );

    if (streamedDocument || delegatedOcrGrant) {
      if (!delegatedOcrGrant) {
        // Browser streamed docs have no shell grant — the gate stays up.
        setOcrState({ phase: "error", message: STREAMED_DOCUMENT_GATE_MESSAGE });
        return;
      }

      // Delegated OCR [R2-2]: OCRmyPDF runs file-to-file on the shell side
      // in either mode (`--skip-text` keeps existing text layers;
      // `--force-ocr` re-renders every page and rebuilds the layer); the
      // output reopens as a new document (generation bump).
      const grant = delegatedOcrGrant;
      const runId = ocrRunRef.current + 1;
      ocrRunRef.current = runId;
      ocrActiveRef.current = true;
      const isCurrentStreamedRun = () => (
        ocrRunRef.current === runId && isCurrentDocument(sourceOpenToken, sourceGeneration)
      );
      // Stale-exit UI reset: the document changed under this still-latest
      // run, so nothing may stay frozen at processing/verifying (that pins
      // longProcessRunning and wedges the legal tools until a tab switch).
      // When a NEWER run owns ocrState (runId superseded), leave it alone.
      const resetOcrUiForStaleRun = () => {
        if (ocrRunRef.current === runId) {
          setOcrState({ phase: "idle", message: null });
        }
      };

      setOcrState({
        phase: "starting-engine",
        message: "Getting things ready...",
        progress: null,
      });

      const jobToken = newOcrJobToken();
      setPathOpCancelState({
        process: "ocr",
        jobToken,
        backend: "path-op",
        requested: false,
      });

      void (async () => {
        let unlisten: (() => void) | null = null;
        let outputToReleaseOnError: { outputGrant: FileGrant } | null = null;
        try {
          try {
            unlisten = await listenOcrProgress(jobToken, (progress) => {
              if (!isCurrentStreamedRun()) {
                return;
              }
              setOcrState((current) => (
                current.phase === "starting-engine" || current.phase === "processing"
                  ? {
                      phase: "processing",
                      message: delegatedOcrProcessingMessage(ocrType),
                      progress,
                    }
                  : current
              ));
            });
          } catch {
            // Progress is additive. OCR should still run if event subscription
            // fails in an unusual desktop/runtime state.
          }

          await waitForUiPaint();
          const runPlan = await resolveOcrRunPlan();
          if (!isCurrentStreamedRun()) {
            resetOcrUiForStaleRun();
            return;
          }

          const output = await pathOpOcr(grant, runPlan.ocrType, jobToken, runPlan.pageIndexes);
          outputToReleaseOnError = output;
          if (isPathOpCancelRequested(jobToken)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            outputToReleaseOnError = null;
            if (isCurrentStreamedRun()) {
              setOcrState({ phase: "idle", message: null });
            }
            return;
          }
          if (!isCurrentStreamedRun()) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            outputToReleaseOnError = null;
            resetOcrUiForStaleRun();
            return;
          }

          setOcrState({
            phase: "verifying",
            message: "Checking the searchable text...",
            progress: null,
          });

          const textLayerCoverage = await inspectPathOpOutputTextLayer(output);
          const verification = verifyOcrTextLayer(textLayerCoverage, ocrType);
          if (isPathOpCancelRequested(jobToken)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            outputToReleaseOnError = null;
            if (isCurrentStreamedRun()) {
              setOcrState({ phase: "idle", message: null });
            }
            return;
          }
          if (!isCurrentStreamedRun()) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            outputToReleaseOnError = null;
            resetOcrUiForStaleRun();
            return;
          }

          if (verification.status === "failed") {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            outputToReleaseOnError = null;
            setOcrState({
              phase: "error",
              message: verification.message,
            });
            return;
          }

          // The reopen bumps the generation; announce it so the
          // generation-change effect preserves the in-flight OCR UI instead
          // of resetting it before the "done" message lands.
          preserveOcrStateForGenerationRef.current = sourceGeneration;
          const reopened = await openPathOpOutput(
            output,
            {
              openToken: sourceOpenToken,
              generation: sourceGeneration,
            },
            // The OCR result is an unsaved working copy backed only by a temp
            // file — open it dirty so Close prompts to save and the work isn't
            // silently discarded.
            { markDirty: true },
          );
          outputToReleaseOnError = null;
          if (reopened.status !== "opened") {
            preserveOcrStateForGenerationRef.current = null;
            if (isCurrentStreamedRun()) {
              setOcrState({
                phase: "error",
                message: reopened.status === "failed"
                  ? reopened.error
                  : "OCR finished, but the result could not be reopened. The document was left unchanged.",
              });
            } else {
              resetOcrUiForStaleRun();
            }
            return;
          }

          setOcrState({
            phase: "done",
            message: `${verification.message} It opened as a new document. Use Save As to keep it.`,
            tone: verification.status === "warning" ? "caution" : "ok",
          });
        } catch (error: unknown) {
          // A throw after the preserve marker was stamped must disarm it —
          // otherwise the next unrelated generation change would be
          // preserved once by mistake.
          preserveOcrStateForGenerationRef.current = null;
          if (outputToReleaseOnError) {
            await pathOpReleaseOutput(outputToReleaseOnError.outputGrant).catch(() => undefined);
          }

          if (!isCurrentStreamedRun()) {
            resetOcrUiForStaleRun();
            return;
          }

          if (isPathOpCancelledError(error)) {
            setOcrState({ phase: "idle", message: null });
            return;
          }

          setOcrState({
            phase: "error",
            message: pathOpErrorMessage(error, "OCR could not finish. The document was left unchanged."),
          });
        } finally {
          unlisten?.();
          if (ocrRunRef.current === runId) {
            ocrActiveRef.current = false;
          }
          setPathOpCancelState((current) => (
            current?.jobToken === jobToken ? null : current
          ));
          clearPathOpCancelRequest(jobToken);
        }
      })();
      return;
    }

    if (!sourceBytes) {
      setOcrState({
        phase: "error",
        message: "Open a PDF before running OCR.",
      });
      return;
    }

    if (!engineBridge.ocrAvailable) {
      setOcrState({
        phase: "error",
        message: engineBridge.available
          ? "OCR toolchain missing from this installation."
          : "This tool only works in the installed RaioPDF app.",
      });
      return;
    }

    const runId = ocrRunRef.current + 1;
    ocrRunRef.current = runId;
    ocrActiveRef.current = true;
    const isCurrentRun = () => (
      ocrRunRef.current === runId && getOpenToken() === sourceOpenToken
    );
    // Busy-guard fix: this clears unconditionally once the run settles (see
    // the .finally() below), even if the run went stale along the way.
    // isCurrentRun() still gates every state write above -- it just no
    // longer also gates whether the guard gets released. The old code only
    // released it from inside the isCurrentRun()-gated branches, so a run
    // that went stale without a newer run superseding it (e.g. the document
    // changed but no new OCR was kicked off) left ocrActiveRef stuck at
    // true forever, wedging "Make Searchable" shut.
    const clearBusyGuard = () => {
      if (ocrRunRef.current === runId) {
        ocrActiveRef.current = false;
      }
    };

    setOcrState({
      phase: "starting-engine",
      message: "Getting things ready...",
      progress: null,
    });

    const jobToken = newOcrJobToken();
    const abortController = new AbortController();
    setPathOpCancelState({
      process: "ocr",
      jobToken,
      backend: "sidecar-local",
      abortController,
      requested: false,
    });

    void waitForUiPaint()
      .then(async () => {
        if (!isCurrentRun()) {
          return Promise.reject(new Error("OCR run is stale."));
        }

        const runPlan = await resolveOcrRunPlan();
        if (!isCurrentRun()) {
          return Promise.reject(new Error("OCR run is stale."));
        }

        return engineBridge.runOcr(sourceBytes, {
          ocrType: runPlan.ocrType,
          ...(runPlan.pageIndexes?.length ? { pageIndexes: runPlan.pageIndexes } : {}),
          pageCount: document.pageCount,
          jobToken,
          signal: abortController.signal,
          onEngineReady: () => {
            if (isCurrentRun()) {
              setOcrState({
                phase: "processing",
                message: memoryOcrProcessingMessage(ocrType),
                progress: null,
              });
            }
          },
        });
      })
      .then(async (ocrResult) => {
        if (!isCurrentRun()) {
          return;
        }

        if (isPathOpCancelRequested(jobToken)) {
          setOcrState({ phase: "idle", message: null });
          return;
        }

        setOcrState({
          phase: "verifying",
          message: "Checking the searchable text...",
          progress: null,
        });

        const textLayerCoverage = await inspectTextLayer(ocrResult.bytes);
        const verification = verifyOcrTextLayer(textLayerCoverage, ocrType);
        const workflowResult = {
          ...ocrResult,
          textLayerCoverage,
          verification,
        };

        if (isPathOpCancelRequested(jobToken)) {
          setOcrState({ phase: "idle", message: null });
          return;
        }

        if (!isCurrentRun()) {
          return;
        }

        if (workflowResult.verification.status === "failed") {
          setOcrState({
            phase: "error",
            message: workflowResult.verification.message,
          });
          return;
        }

        // The commit bumps the generation; announce it so the
        // generation-change effect keeps the in-flight OCR UI alive for the
        // "done" message instead of resetting it.
        preserveOcrStateForGenerationRef.current = sourceGeneration;
        const replaced = await replaceBytes(workflowResult.bytes, {
          dirty: true,
          hasTextLayer: true,
          textLayerCoverage: workflowResult.textLayerCoverage,
          // Codex P2 on #107: derive the committed page count from the
          // coverage (counted from the OCR OUTPUT bytes), not the echoed
          // input count, so the navigator can never desync from the
          // committed document.
          knownPageCount: textLayerCoveragePageCount(workflowResult.textLayerCoverage),
          expectedOpenToken: sourceOpenToken,
          expectedGeneration: sourceGeneration,
        });

        if (replaced !== "replaced") {
          preserveOcrStateForGenerationRef.current = null;
        }

        if (!isCurrentRun()) {
          return;
        }

        if (replaced === "stale") {
          setOcrState({
            phase: "error",
            message: "The document changed before OCR finished. The result was not applied.",
          });
          return;
        }

        if (replaced === "failed") {
          setOcrState({
            phase: "error",
            message: "The searchable PDF could not be opened. The document was left unchanged.",
          });
          return;
        }

        setSelectedPageIndexes(new Set([0]));
        setOcrState({
          phase: "done",
          message: workflowResult.verification.message,
          tone: workflowResult.verification.status === "warning" ? "caution" : "ok",
        });
      })
      .catch((error: unknown) => {
        if (!isCurrentRun()) {
          return;
        }

        if (isEngineBridgeUnavailableError(error)) {
          // A missing desktop engine / OCR toolchain is a capability gap,
          // not a bug -- surface its own specific, calm message and skip
          // the diagnostics log (there's nothing actionable to investigate).
          setOcrState({
            phase: "error",
            message: error.message,
          });
          return;
        }

        if (isPathOpCancelledError(error)) {
          setOcrState({ phase: "idle", message: null });
          return;
        }

        const detail = formatOcrFailureDetail(error);
        const message = detail
          ? `${OCR_FAILURE_MESSAGE} ${detail}`
          : OCR_FAILURE_MESSAGE;

        setOcrState({
          phase: "error",
          message,
        });

        logWorkflowFailure("ocr.failed", error);
      })
      .finally(() => {
        clearBusyGuard();
        setPathOpCancelState((current) => (
          current?.jobToken === jobToken ? null : current
        ));
        clearPathOpCancelRequest(jobToken);
      });
  }, [clearPathOpCancelRequest, document.bytes, document.generation, document.pageCount, document.textLayerCoverage, engineBridge, engineDelegatedGrant, getOpenToken, isCurrentDocument, isPathOpCancelRequested, openPathOpOutput, pdfDocument, replaceBytes, streamedDocument]);

  const requestForceOcr = useCallback((reason: ForceOcrConfirmationReason = "manual") => {
    if (!streamedDocument && document.bytes && engineBridge.ocrAvailable) {
      engineBridge.warmEngine();
    }

    setForceOcrConfirmation(reason);
  }, [document.bytes, engineBridge, streamedDocument]);

  const openOcrDialog = useCallback((ocrType: OcrType) => {
    if (longProcessRunning) {
      return;
    }

    if (streamedDocument) {
      if (!pathOpsGrant) {
        setOcrState({ phase: "error", message: STREAMED_DOCUMENT_GATE_MESSAGE });
        return;
      }

      // Delegated OCR runs file-to-file through the PathOpsEngine — no
      // sidecar warm-up. Both passes are available: skip-text (default) and
      // force-ocr (full text-layer rebuild).
      pendingOcrTypeRef.current = ocrType;
      setOcrState({ phase: "confirm", message: null });
      return;
    }

    if (!document.bytes) {
      setOcrState({
        phase: "error",
        message: "Open a PDF before running OCR.",
      });
      return;
    }

    if (!engineBridge.ocrAvailable) {
      setOcrState({
        phase: "error",
        message: engineBridge.available
          ? "OCR toolchain missing from this installation."
          : "This tool only works in the installed RaioPDF app.",
      });
      return;
    }

    pendingOcrTypeRef.current = ocrType;
    // Silent pre-warm while the confirm dialog is up, so the engine may
    // already be ready by the time the user clicks "Make searchable." A
    // pre-warm failure is swallowed here (engineBridge.warmEngine never
    // rejects) -- the real run surfaces its own error if the engine still
    // won't start.
    engineBridge.warmEngine();
    setOcrState({ phase: "confirm", message: null });
  }, [document.bytes, engineBridge, longProcessRunning, pathOpsGrant, streamedDocument]);

  const makeSearchable = useCallback(() => {
    const status = deriveTextLayerStatus(document.textLayerCoverage);

    if (status.state === "garbled") {
      requestForceOcr("garbled");
      return;
    }

    openOcrDialog("skip-text");
  }, [document.textLayerCoverage, openOcrDialog, requestForceOcr]);

  const confirmOcrDialog = useCallback(() => {
    runOcrWorkflow(pendingOcrTypeRef.current);
  }, [runOcrWorkflow]);

  const cancelOcrDialog = useCallback(() => {
    // The dialog is only visible for confirm/error states; active OCR is
    // cancelled from the docked loader.
    ocrRunRef.current += 1;
    ocrActiveRef.current = false;
    setOcrState({ phase: "idle", message: null });
  }, []);

  const cancelPathOperation = useCallback(() => {
    const cancelState = pathOpCancelState;
    if (!cancelState || cancelState.requested) {
      return;
    }

    pathOpCancelRequestsRef.current.add(cancelState.jobToken);
    setPathOpCancelState((current) => (
      current?.jobToken === cancelState.jobToken
        ? { ...current, requested: true }
        : current
    ));

    if (cancelState.backend === "sidecar-local") {
      cancelState.abortController?.abort();
      void engineBridge.cancelLocalJob(cancelState.jobToken).catch(() => undefined);
      return;
    }

    void pathOpCancel(cancelState.jobToken).catch(() => undefined);
  }, [engineBridge, pathOpCancelState]);

  const confirmForceOcr = useCallback(() => {
    setForceOcrConfirmation(null);
    runOcrWorkflow("force-ocr");
  }, [runOcrWorkflow]);

  const openOpenedFile = useCallback(
    (file: OpenedFile, options: { openInNewTab?: boolean } = {}) => {
      const opensNewTab = Boolean(options.openInNewTab && document.source);
      if (opensNewTab && longProcessRunning) {
        // Opening into a new tab implicitly switches tabs, which would
        // silently discard the finished output of the delegated op that is
        // still resolving against the active document.
        setError(NEW_TAB_BUSY_MESSAGE);
        return;
      }
      if (opensNewTab) {
        stashVisibleDocumentEditingState();
      }
      ocrRunRef.current += 1;
      ocrActiveRef.current = false;
      setOcrState({ phase: "idle", message: null });
      resetLegalState();
      setSelectedPageIndexes(new Set());
      setPasswordPrompt(null);
      void openDocumentFile(file, {
        openMode: options.openInNewTab && document.source ? "new-tab" : "replace-active",
      }).then((result) => {
        if (result.status === "opened") {
          setRepairCandidate(null);
          setSelectedPageIndexes(new Set([0]));
        } else if (result.status === "password-required") {
          // A password-protected PDF is not a corrupt/unsupported one --
          // prompt to unlock it instead of routing to the Repair tool,
          // which is a dead end for encryption (issue #2, 2026-07-03
          // live-test fix plan).
          setRepairCandidate(null);
          setPasswordPrompt({
            source: { kind: "bytes", bytes: result.bytes },
            fileName: result.fileName,
            filePath: result.filePath,
            phase: "prompt",
            error: null,
          });
        } else if (result.status === "cancelled") {
          // The user declined the signature-invalidation confirmation.
          // That's a choice, not a broken file -- no Repair routing, no
          // error UI; whatever was on screen stays as-is.
          setRepairCandidate(null);
        } else {
          setRepairCandidate(file);
          setActiveEditDialogTool(null);
          setActiveLegalTool(null);
          setActiveOrganizeTool("repair");
        }
      });
    },
    [document.source, longProcessRunning, openDocumentFile, resetLegalState, setError, stashVisibleDocumentEditingState],
  );

  const cancelPasswordPrompt = useCallback(() => {
    // Invalidate any in-flight unlock so a wrong/right-password result that
    // resolves after Cancel was clicked doesn't reopen a document (or flash
    // a retry state) the user already dismissed.
    passwordUnlockRunRef.current += 1;

    // This dialog can also be triggered by pdf.js failing to preview an
    // already-open document (see the PasswordException branches in the
    // preview-loading effect below) rather than the initial open failing
    // outright. In that case the document is still technically "open" but
    // unrenderable -- restore the informative message instead of leaving a
    // silent, unexplained blank canvas behind the closed dialog.
    const promptCoversOpenDocument = passwordPrompt !== null && (
      passwordPrompt.source.kind === "bytes"
        ? document.bytes === passwordPrompt.source.bytes
        : document.source?.kind === "rangeGrant" &&
          document.source.grant === passwordPrompt.source.grant
    );

    if (promptCoversOpenDocument) {
      setError(
        "This PDF is encrypted. Preview is available after removing encryption with the open password.",
      );
    }

    setPasswordPrompt(null);
  }, [document.bytes, document.source, passwordPrompt, setError]);

  const submitPassword = useCallback(
    (password: string) => {
      if (!passwordPrompt || passwordPrompt.phase !== "prompt") {
        return;
      }

      const prompt = passwordPrompt;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;
      const runId = passwordUnlockRunRef.current + 1;
      passwordUnlockRunRef.current = runId;
      const isCurrentUnlock = () => passwordUnlockRunRef.current === runId;

      if (prompt.source.kind === "grant") {
        // Streamed large file: qpdf decrypts file-to-file by grant; the
        // decrypted copy reopens as a new streamed document [R1-7].
        const { grant } = prompt.source;
        setPasswordPrompt({ ...prompt, phase: "unlocking", error: null });

        void pathOpDecrypt(grant, password)
          .then(async (output) => {
            if (!isCurrentUnlock() || !isCurrentDocument(sourceOpenToken, sourceGeneration)) {
              await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
              return;
            }

            let signature;
            try {
              signature = (await pathOpDocumentFacts(output.outputGrant)).signatureDetection;
            } catch {
              // Match the byte unlock path: a signature-detector hiccup should
              // not block a legitimate unlock.
            }

            if (signature) {
              const proceed = await confirmDecryptSignatureFactsInvalidation(
                signature,
                password ? "user-password" : "owner-restricted",
                [prompt.fileName],
                prompt.filePath,
              );
              if (!isCurrentUnlock() || !isCurrentDocument(sourceOpenToken, sourceGeneration)) {
                await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
                return;
              }
              if (!proceed) {
                await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
                setPasswordPrompt(null);
                return;
              }
            }

            setPasswordPrompt(null);
            const reopened = await openPathOpOutput(output, {
              openToken: sourceOpenToken,
              generation: sourceGeneration,
            });
            if (reopened.status !== "opened" && isCurrentDocument(sourceOpenToken, sourceGeneration)) {
              setError("This PDF could not be unlocked. Try again in a moment.");
            }
          })
          .catch((error: unknown) => {
            if (!isCurrentUnlock() || !isCurrentDocument(sourceOpenToken, sourceGeneration)) {
              return;
            }

            if (
              error instanceof PathOpsError &&
              error.code === "OP_FAILED" &&
              /invalid password/i.test(error.message)
            ) {
              setPasswordPrompt((current) => (
                current
                  ? { ...current, phase: "prompt", error: "That password wasn't accepted. Try again." }
                  : current
              ));
              return;
            }

            setPasswordPrompt(null);
            setError(pathOpErrorMessage(error, "This PDF could not be unlocked. Try again in a moment."));
            void recordDiagnosticEvent(
              "password.unlock-failed",
              "Removing PDF encryption by grant failed",
              [error instanceof Error ? error.message : String(error)],
            );
          });
        return;
      }

      const promptBytes = prompt.source.bytes;
      setPasswordPrompt({ ...prompt, phase: "starting-engine", error: null });

      void engineBridge
        .removeEncryption(promptBytes, password, {
          onEngineReady: () => {
            if (isCurrentUnlock()) {
              setPasswordPrompt((current) => (current ? { ...current, phase: "unlocking" } : current));
            }
          },
        })
        .then(async (decryptedBytes) => {
          if (!isCurrentUnlock()) {
            return;
          }

          // Signed documents: unlocking strips the signature. Warn (and let the
          // user back out) before opening, matching the automatic open path.
          const proceed = await confirmDecryptSignatureInvalidation(
            decryptedBytes,
            password ? "user-password" : "owner-restricted",
            [prompt.fileName],
            prompt.filePath,
          );
          if (!isCurrentUnlock()) {
            return;
          }
          if (!proceed) {
            setPasswordPrompt(null);
            return;
          }

          // Fresh open, marked dirty: the decrypted bytes never had an
          // on-disk representation of their own (the original file on disk
          // is still the encrypted one), so Save As is the natural next
          // step. Keep the original display name -- "Repaired X.pdf"-style
          // renaming doesn't apply here, this is the same document.
          const result = await openDocumentFile(
            { bytes: decryptedBytes, name: prompt.fileName, path: null },
            {
              markDirty: true,
              openMode: document.source ? "new-tab" : "replace-active",
            },
          );

          if (!isCurrentUnlock()) {
            return;
          }

          if (result.status === "opened") {
            setPasswordPrompt(null);
            setRepairCandidate(null);
            setSelectedPageIndexes(new Set([0]));
            return;
          }

          // The server accepted the password and handed back decrypted
          // bytes, but RaioPDF still couldn't finish opening them -- an
          // unusual or partially-supported encryption scheme, most likely.
          // That's not a wrong-password situation, so close the dialog
          // rather than inviting another password attempt that can't help.
          setPasswordPrompt(null);
          setError(
            "The password was accepted, but RaioPDF could not finish opening this PDF. It may use an unusual encryption scheme.",
          );
          void recordDiagnosticEvent(
            "password.unlock-reopen-failed",
            "Decrypted PDF bytes failed to reopen",
            [result.status === "failed" ? result.error : null],
          );
        })
        .catch((error: unknown) => {
          if (!isCurrentUnlock()) {
            return;
          }

          if (error instanceof PdfEngineError && error.code === "ENCRYPTED_DOCUMENT") {
            setPasswordPrompt((current) => (
              current
                ? { ...current, phase: "prompt", error: "That password wasn't accepted. Try again." }
                : current
            ));
            return;
          }

          setPasswordPrompt(null);
          setError(
            isEngineBridgeUnavailableError(error)
              ? error.message
              : "This PDF could not be unlocked. Try again in a moment.",
          );
          void recordDiagnosticEvent(
            "password.unlock-failed",
            "Removing PDF encryption failed",
            [
              error instanceof Error ? error.message : String(error),
              error instanceof Error && error.stack ? error.stack : null,
            ],
          );
        });
    },
    [confirmDecryptSignatureFactsInvalidation, confirmDecryptSignatureInvalidation, document.generation, engineBridge, getOpenToken, isCurrentDocument, openDocumentFile, openPathOpOutput, passwordPrompt, setError],
  );

  const openFileSource = useCallback(
    (source: OpenedFileSource) => {
      if (source.kind === "memory") {
        openOpenedFile(source, { openInNewTab: true });
      } else {
        void openStreamedSource(source, { openInNewTab: true });
      }
    },
    [openOpenedFile, openStreamedSource],
  );

  const requestTabClose = useCallback((tabId: string) => {
    const tab = documentTabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      return;
    }
    const closesVisibleDocument = tabId === activeTabId;
    const nextVisibleState = documentTabs.length > 1 ? "document" : "empty";

    if (tab.document.dirty) {
      const fileName = tab.document.fileName ?? "this document";
      const confirmed = window.confirm(
        `Close ${fileName} and discard unsaved changes?`,
      );
      if (!confirmed) {
        return;
      }
    }

    void closeDocumentTab(tabId).then((closed) => {
      if (closed) {
        tabEditingSnapshotsRef.current.delete(tab.document.generation);
      }
      if (closed && closesVisibleDocument) {
        resetVisibleDocumentAppState(nextVisibleState);
      }
    });
  }, [activeTabId, closeDocumentTab, documentTabs, resetVisibleDocumentAppState]);

  const openFile = useCallback(() => {
    void filePort
      .openFile()
      .then((source) => {
        if (source) {
          openFileSource(source);
        }
      })
      .catch(() => {
        setError("This PDF could not be opened. The file may be corrupt or unsupported.");
      });
  }, [openFileSource, setError]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let drainChain = Promise.resolve();

    const drainPendingFiles = () => {
      drainChain = drainChain.then(async () => {
        while (!disposed) {
          const source = await takeStartupFile();
          if (!source) {
            break;
          }
          openFileSource(source);
        }
      }).catch(() => {
        setError("This startup PDF could not be opened. The file may be corrupt or unsupported.");
      });
    };

    if (!isTauriRuntime()) {
      drainPendingFiles();
      return () => {
        disposed = true;
      };
    }

    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("raiopdf-opened-pdf", drainPendingFiles))
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
        // Register the wake-up listener before draining so a Finder Opened
        // event cannot land in the gap between the initial take and listen.
        drainPendingFiles();
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openFileSource, setError]);

  const openFileInSeparateWindow = useCallback(() => {
    void openFileInNewWindow().catch(() => {
      setError("This PDF could not be opened in a new window.");
    });
  }, [setError]);

  function packageDocxAddOptions(
    setProgress: (progress: { running: boolean; message: string | null; result: null }) => void,
    noun: string,
  ): PickPdfsForAddOptions {
    return {
      onDocxRowsChange: (rows) => {
        const active = rows.find((row) => row.status === "running")
          ?? rows.find((row) => row.status === "queued")
          ?? rows.at(-1);
        setProgress({
          running: false,
          message: active ? `${active.name}: ${active.message}` : null,
          result: null,
        });
      },
      onWordUnavailable: (message) => {
        setProgress({
          running: false,
          message: message || `Word integration not available. Word documents were not added to the ${noun}.`,
          result: null,
        });
      },
      onDocxErrors: (errors) => {
        if (errors.length === 0) {
          return;
        }
        setProgress({
          running: false,
          message: errors.length === 1 && errors[0]
            ? `"${errors[0].name}" could not be converted from Word.`
            : `${errors.length} Word documents could not be converted.`,
          result: null,
        });
      },
    };
  }

  const openProductionFile = useCallback(async (): Promise<FileAddResult | null> => {
    try {
      return await pickFileForAdd(packageDocxAddOptions(setProductionProgress, "production set"));
    } catch {
      setProductionProgress({
        running: false,
        message: "This PDF could not be added to the production set.",
        result: null,
      });
      return null;
    }
  }, []);

  const openBatchCleanupFile = useCallback(async (): Promise<FileAddResult | null> => {
    try {
      // The workspace consumes the FileAddResult directly: descriptor adds
      // carry the grant (batch cleanup is path-based end-to-end), and the
      // browser tooLarge case renders its own honest gate.
      return await pickFileForAdd(packageDocxAddOptions(setBatchCleanupProgress, "batch"));
    } catch {
      setBatchCleanupProgress({
        running: false,
        message: "This PDF could not be added to the batch.",
        result: null,
      });
      return null;
    }
  }, []);

  const openFilingPacketFile = useCallback(async (): Promise<FilingPacketFile | null> => {
    try {
      const result = await pickFileForAdd(packageDocxAddOptions(setFilingPacketProgress, "filing packet"));
      if (!result) {
        return null;
      }

      if (result.kind === "tooLarge") {
        setFilingPacketProgress({
          running: false,
          message: tooLargeToAddMessage(result.name),
          result: null,
        });
        return null;
      }

      if (result.kind === "descriptor") {
        // FilingPacketFile requires a known page count. `path_op_page_count`
        // ships in the same shell now, so a null count only happens when the
        // bundled qpdf is missing or the count itself failed — still gated
        // honestly rather than shown with a fake count.
        if (result.descriptor.pageCount === null) {
          setFilingPacketProgress({
            running: false,
            message: `"${result.descriptor.name}" is too large to add until RaioPDF can count its pages without opening it.`,
            result: null,
          });
          return null;
        }

        return {
          id: `${result.descriptor.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: result.descriptor.name,
          path: result.descriptor.grant,
          pages: result.descriptor.pageCount,
        };
      }

      const file = result.file;
      return {
        id: `${file.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        path: file.path,
        pages: await countPdfPages(file.bytes),
      };
    } catch {
      setFilingPacketProgress({
        running: false,
        message: "This PDF could not be added to the filing packet.",
        result: null,
      });
      return null;
    }
  }, []);

  const openDroppedFile = useCallback(
    (file: File) => {
      // Size-check BEFORE reading [R2-4]: an above-threshold drop becomes a
      // rangeFile source and is never arrayBuffer()ed — a real streamed open,
      // superseding the interim "too large to open this way" gate.
      void readBrowserFileSource(file)
        .then(openFileSource)
        .catch(() => {
          setError("This PDF could not be opened. The file may be corrupt or unsupported.");
        });
    },
    [openFileSource, setError],
  );

  const handleThumbnailClick = useCallback(
    (pageIndex: number, event: MouseEvent<HTMLButtonElement>) => {
      setCurrentPage(pageIndex + 1);
      setSelectedPageIndexes((current) => {
        const next = new Set<number>();

        if (event.shiftKey && current.size > 0) {
          const anchor = Array.from(current).at(-1) ?? pageIndex;
          const start = Math.min(anchor, pageIndex);
          const end = Math.max(anchor, pageIndex);
          for (let index = start; index <= end; index += 1) {
            next.add(index);
          }
          return next;
        }

        if (event.ctrlKey || event.metaKey) {
          for (const selected of current) {
            next.add(selected);
          }

          if (next.has(pageIndex)) {
            next.delete(pageIndex);
          } else {
            next.add(pageIndex);
          }

          return next;
        }

        next.add(pageIndex);
        return next;
      });
    },
    [setCurrentPage],
  );

  const handleBookmarkNavigate = useCallback(
    (pageIndex: number) => {
      setCurrentPage(pageIndex + 1);
    },
    [setCurrentPage],
  );

  const selectedIndexes = useCallback(() => {
    return [...selectedPageIndexes].sort((left, right) => left - right);
  }, [selectedPageIndexes]);

  const rotateSelected = useCallback(() => {
    void rotatePages(selectedIndexes());
  }, [rotatePages, selectedIndexes]);

  /** Backs the sidebar's inline Rotate expansion (item 18) -- unlike
   * `rotateSelected` above, this collapses the expansion once a rotation
   * actually happens, but leaves it open if there was nothing selected to
   * rotate (the scope note stays visible so the user can go select pages). */
  const rotateSelectedByDegrees = useCallback(
    (degrees: number) => {
      void rotatePages(selectedIndexes(), degrees).then((rotated) => {
        if (rotated) {
          setActiveOrganizeTool((current) => (current === "rotate" ? null : current));
        }
      });
    },
    [rotatePages, selectedIndexes],
  );

  const rotateSelectedRight = useCallback(() => {
    rotateSelectedByDegrees(90);
  }, [rotateSelectedByDegrees]);

  const rotateSelectedLeft = useCallback(() => {
    rotateSelectedByDegrees(-90);
  }, [rotateSelectedByDegrees]);

  /** Context-menu rotate: acts on exactly the right-clicked page, independent
   * of whatever the current multi-selection happens to be. */
  const rotatePage = useCallback(
    (pageIndex: number, degrees: number) => {
      void rotatePages([pageIndex], degrees);
    },
    [rotatePages],
  );

  const runDeletePages = useCallback(
    (indexes: readonly number[]) => {
      const nextSelectedPageIndex = Math.max(
        0,
        Math.min(indexes[0] ?? 0, document.pageCount - indexes.length - 1),
      );

      void deletePages(indexes).then((deleted) => {
        if (deleted) {
          setSelectedPageIndexes(new Set([nextSelectedPageIndex]));
        }
      });
    },
    [deletePages, document.pageCount],
  );

  // Page deletion is destructive, so both entry points below only *request*
  // it -- the actual delete happens from confirmDeletePagesRequest, once the
  // DeletePagesConfirmationDialog is accepted.
  const deleteSelected = useCallback(() => {
    const indexes = selectedIndexes();

    if (indexes.length === 0) {
      return;
    }

    if (indexes.length >= document.pageCount) {
      setError("A document must keep at least one page.");
      return;
    }

    setPageDeleteConfirmation(indexes);
  }, [document.pageCount, selectedIndexes, setError]);

  /** Context-menu delete: targets exactly the right-clicked page. */
  const requestDeletePage = useCallback(
    (pageIndex: number) => {
      if (document.pageCount <= 1) {
        setError("A document must keep at least one page.");
        return;
      }

      setPageDeleteConfirmation([pageIndex]);
    },
    [document.pageCount, setError],
  );

  const cancelDeletePagesRequest = useCallback(() => {
    setPageDeleteConfirmation(null);
  }, []);

  const confirmDeletePagesRequest = useCallback(() => {
    const indexes = pageDeleteConfirmation;
    setPageDeleteConfirmation(null);

    if (indexes && indexes.length > 0) {
      runDeletePages(indexes);
    }
  }, [pageDeleteConfirmation, runDeletePages]);

  const moveSelected = useCallback(
    (direction: -1 | 1) => {
      const indexes = selectedIndexes();

      if (indexes.length === 0) {
        return;
      }

      const selected = new Set(indexes);
      const order = Array.from({ length: document.pageCount }, (_, index) => index);

      if (direction === -1) {
        for (let index = 1; index < order.length; index += 1) {
          const current = order[index];
          const previous = order[index - 1];

          if (
            current !== undefined &&
            previous !== undefined &&
            selected.has(current) &&
            !selected.has(previous)
          ) {
            order[index - 1] = current;
            order[index] = previous;
          }
        }
      } else {
        for (let index = order.length - 2; index >= 0; index -= 1) {
          const current = order[index];
          const next = order[index + 1];

          if (
            current !== undefined &&
            next !== undefined &&
            selected.has(current) &&
            !selected.has(next)
          ) {
            order[index + 1] = current;
            order[index] = next;
          }
        }
      }

      const currentSourcePage = document.currentPage - 1;
      const nextCurrentPage = order.indexOf(currentSourcePage) + 1;
      const nextSelectedPageIndexes = new Set<number>();
      order.forEach((sourcePageIndex, nextPageIndex) => {
        if (selected.has(sourcePageIndex)) {
          nextSelectedPageIndexes.add(nextPageIndex);
        }
      });

      void reorderPages(order, nextCurrentPage).then((reordered) => {
        if (reordered) {
          setSelectedPageIndexes(nextSelectedPageIndexes);
        }
      });
    },
    [document.currentPage, document.pageCount, reorderPages, selectedIndexes],
  );

  const reorderPagesFromGrid = useCallback(
    async (pageOrder: readonly number[], nextCurrentPage: number) => {
      const selected = new Set(selectedIndexes());
      const nextSelectedPageIndexes = new Set<number>();
      pageOrder.forEach((sourcePageIndex, nextPageIndex) => {
        if (selected.has(sourcePageIndex)) {
          nextSelectedPageIndexes.add(nextPageIndex);
        }
      });

      await waitForTestDelay(window.__RAIOPDF_TEST_REORDER_DELAY_MS__ ?? 0);
      const reordered = await reorderPages(pageOrder, nextCurrentPage);

      if (reordered) {
        setSelectedPageIndexes(nextSelectedPageIndexes);
      }

      return reordered;
    },
    [reorderPages, selectedIndexes],
  );

  const saveToFile = useCallback(async (forceSaveAs: boolean): Promise<SavedFile | null> => {
    // Re-entry guard: rapid double-clicks must not apply the same pending
    // edits twice or start a second file write mid-save.
    if (savingRef.current) {
      return null;
    }

    // Streamed documents can't dirty, so Save has nothing to write (the
    // button is disabled unless pending overlays made the document dirty).
    // With pending edits, both Save and Save As commit through apply_edits and
    // reopen a generated copy; without pending edits, Save As is a shell-side
    // copy by grant — no bytes cross into the WebView [R1-2].
    if (document.source !== null && document.source.kind !== "memory") {
      const source = document.source;
      const pendingApply = editing.collectAnnotationSavePlan();

      if (pendingApply) {
        const grant = pathOpsGrant;
        if (!grant) {
          setError(STREAMED_DOCUMENT_GATE_MESSAGE);
          return null;
        }

        if (pendingApply.flatten || planHasFormValues(pendingApply.plan.appendEdits)) {
          setError("Form filling is not available for very large documents yet.");
          return null;
        }

        if (
          pendingApply.plan.updateEdits.length > 0 ||
          pendingApply.plan.deleteAnnotIds.length > 0
        ) {
          setError("Editing existing annotations on very large documents is not available yet.");
          return null;
        }

        if (!isPathOpAvailableForInput(pathOpsGeneralStatus, "apply_edits", document.fileSizeBytes)) {
          setError(streamedEditingGateMessage(pathOpsGeneralStatus, document.fileSizeBytes, true));
          return null;
        }

        const sourceOpenToken = getOpenToken();
        const sourceGeneration = document.generation;
        const applyOptions: PdfApplyEditsOptions = {
          markupMode: "annotation",
          printMarkupAnnotations,
        };

        savingRef.current = true;
        setSidecarStatus({
          running: true,
          message: "Saving your edits...",
          removed: [],
          beforeBytes: document.fileSizeBytes,
          afterBytes: null,
        });
        try {
          const output = await pathOpApplyEdits(
            grant,
            pendingApply.plan.appendEdits,
            applyOptions,
            document.fileName ?? "Edited.pdf",
          );

          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            return null;
          }

          const reopened = await openPathOpOutput(output, {
            openToken: sourceOpenToken,
            generation: sourceGeneration,
          });
          if (reopened.status !== "opened") {
            setSidecarStatus({
              running: false,
              message: "Edits were applied, but the edited copy could not be reopened.",
              removed: [],
              beforeBytes: document.fileSizeBytes,
              afterBytes: output.sizeBytes,
            });
            return null;
          }

          editing.clearPending();
          setSidecarStatus({
            running: false,
            message: "Edits saved — the edited copy opened as a new document. Use Save As to keep it.",
            removed: [],
            beforeBytes: document.fileSizeBytes,
            afterBytes: output.sizeBytes,
          });
          return null;
        } catch (error: unknown) {
          if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            void recordDiagnosticEvent("save.failed", errorMessage(error), [
              `forceSaveAs=${forceSaveAs}`,
              `source=${source.kind}`,
              "op=apply_edits",
            ]);
            setError(pathOpErrorMessage(error, "This PDF could not be saved. The document was left unchanged."));
            setSidecarStatus({
              running: false,
              message: "Edits could not be saved. The document was left unchanged.",
              removed: [],
              beforeBytes: document.fileSizeBytes,
              afterBytes: null,
            });
          }
          return null;
        } finally {
          savingRef.current = false;
        }
      }

      // Plain Save on a CLEAN streamed document has nothing to write. A
      // DIRTY streamed document with no pending overlays (e.g. an OCR
      // output reopened as a temp-backed working copy via markDirty) has no
      // in-place target either — its only meaningful save is the Save As
      // copy below, so route Save there instead of silently doing nothing.
      // Both the toolbar button and the File > Save menu land here (Codex
      // review, PR #236).
      if (!forceSaveAs && !document.dirty) {
        return null;
      }

      savingRef.current = true;
      try {
        const written = await saveStreamedCopy(
          source.kind === "rangeGrant"
            ? { kind: "rangeGrant", grant: source.grant }
            : { kind: "rangeFile", file: source.file },
          document.fileName ?? "Document.pdf",
        );

        if (written) {
          markSaved({ fileName: written.name, filePath: written.path });
        }
        return written;
      } catch (error: unknown) {
        void recordDiagnosticEvent("save.failed", errorMessage(error), [
          `forceSaveAs=${forceSaveAs}`,
          `source=${source.kind}`,
        ]);
        setError(
          error instanceof Error && error.message.includes("changed on disk")
            ? "This file changed on disk — reopen it."
            : "This PDF could not be saved. Try reopening the document and saving again.",
        );
        return null;
      } finally {
        savingRef.current = false;
      }
    }

    savingRef.current = true;

    try {
      const pendingApply = editing.collectAnnotationSavePlan();

      if (pendingApply) {
        const applied = await applyAnnotationSavePlan({
          appendEdits: pendingApply.plan.appendEdits,
          updateEdits: pendingApply.plan.updateEdits,
          deleteAnnotIds: pendingApply.plan.deleteAnnotIds,
        }, {
          flatten: pendingApply.flatten,
          printMarkupAnnotations,
        });

        if (!applied) {
          // The mutation queue already surfaced the error; the document is
          // unchanged, so the pending list stays for another attempt.
          return null;
        }

        editing.clearPending();
      }

      // saveDocument() awaits the mutation queue before reading the current
      // filePath, so a redaction (or any other operation) that clears the
      // path while this save was in flight is reflected here. Reading
      // document.filePath at click time instead would race an in-flight
      // path-clearing commit and could overwrite the original file.
      const saved = await saveDocument();

      if (!saved) {
        return null;
      }

      const written = await filePort.saveFile(
        saved.bytes,
        saved.fileName,
        forceSaveAs ? null : saved.filePath,
      );

      if (written) {
        markSaved({
          fileName: written.name,
          filePath: written.path,
        });
      }
      return written;
    } catch (error: unknown) {
      void recordDiagnosticEvent("save.failed", errorMessage(error), [
        `forceSaveAs=${forceSaveAs}`,
        `source=${document.source?.kind ?? "none"}`,
      ]);
      setError("This PDF could not be saved. Try reopening the document and saving again.");
      return null;
    } finally {
      savingRef.current = false;
    }
  }, [
    applyAnnotationSavePlan,
    document.dirty,
    document.fileName,
    document.fileSizeBytes,
    document.generation,
    document.source,
    editing,
    getOpenToken,
    isCurrentDocument,
    markSaved,
    openPathOpOutput,
    pathOpsGeneralStatus,
    pathOpsGrant,
    printMarkupAnnotations,
    saveDocument,
    setError,
  ]);

  const flattenCurrentMarkup = useCallback(() => {
    const sourceBytes = document.bytes;
    const savePlan = editing.collectMarkupAnnotationSavePlan();

    if (!sourceBytes && !annotationSavePlanHasChanges(savePlan)) {
      setMarkupAnnotationMessage(
        streamedDocument ? STREAMED_DOCUMENT_GATE_MESSAGE : "Open a PDF before making markup permanent.",
      );
      return;
    }

    void (async () => {
      const annotationCount = sourceBytes
        ? await countRaioPdfMarkupAnnotations(sourceBytes)
        : 0;
      const targetAnnotationCount = Math.max(0, annotationCount - savePlan.deleteAnnotIds.length) +
        savePlan.appendEdits.length;

      if (annotationSavePlanHasChanges(savePlan)) {
        setMarkupAnnotationMessage("Merging your markup into the page...");
        const applied = await applyAnnotationSavePlan({
          appendEdits: savePlan.appendEdits,
          updateEdits: savePlan.updateEdits,
          deleteAnnotIds: savePlan.deleteAnnotIds,
        }, {
          flatten: false,
          printMarkupAnnotations,
        });

        if (!applied) {
          setMarkupAnnotationMessage("Your markup couldn't be merged into the page. Your document was left unchanged — try again.");
          return;
        }
      }

      if (targetAnnotationCount === 0) {
        setMarkupAnnotationMessage("No RaioPDF markup annotations were found.");
        return;
      }

      setMarkupAnnotationMessage("Merging your markup into the page...");
      const flattened = await flattenMarkupAnnotations();
      setMarkupAnnotationMessage(
        flattened
          ? `Merged ${targetAnnotationCount} ${targetAnnotationCount === 1 ? "markup item" : "markup items"} permanently into the page.`
          : "Your markup couldn't be merged into the page.",
      );
      if (flattened) {
        editing.clearPendingEdits();
      }
    })().catch(() => {
      setMarkupAnnotationMessage("Your markup couldn't be merged into the page. Your document was left unchanged — try again.");
    });
  }, [
    applyAnnotationSavePlan,
    document.bytes,
    editing,
    flattenMarkupAnnotations,
    printMarkupAnnotations,
    streamedDocument,
  ]);

  const save = useCallback(() => {
    void saveToFile(false);
  }, [saveToFile]);

  const saveAs = useCallback(() => {
    void saveToFile(true);
  }, [saveToFile]);

  const moveActiveTabToNewWindow = useCallback(
    async (tabId: string, fileGrant: FileGrant, dirty: boolean) => {
      const nextVisibleState = documentTabs.some((candidate) => candidate.id !== tabId)
        ? "document"
        : "empty";

      if (dirty) {
        const saved = await saveToFile(false);
        if (!saved) {
          return;
        }
      }

      try {
        await openGrantInNewWindow(fileGrant);
        const closed = await closeDocumentTab(tabId);
        if (closed) {
          resetVisibleDocumentAppState(nextVisibleState);
        }
      } catch {
        setError("This PDF could not be moved to a new window.");
      }
    },
    [closeDocumentTab, documentTabs, resetVisibleDocumentAppState, saveToFile, setError],
  );

  const requestTabMoveToNewWindow = useCallback((tabId: string) => {
    const tab = documentTabs.find((candidate) => candidate.id === tabId);
    if (!tab || !tab.document.filePath) {
      setError("Save this document before moving it to a new window.");
      return;
    }

    if (longProcessRunning) {
      // Moving a tab out switches the visible document mid-run, which would
      // silently discard the finished output of the delegated op that is
      // still resolving against the active document.
      setError("Finish the current document operation before moving this document to a new window.");
      return;
    }

    if (tab.document.dirty) {
      const fileName = tab.document.fileName ?? "this document";
      const confirmed = window.confirm(
        `Save changes to ${fileName} before moving it to a new window?`,
      );
      if (!confirmed) {
        return;
      }
    }

    if (tabId !== activeTabId) {
      const switched = switchDocumentTab(tabId);
      if (!switched) {
        return;
      }
      stashVisibleDocumentEditingState();
      resetVisibleDocumentAppState("document");
      pendingMoveToNewWindowTabIdRef.current = tabId;
      return;
    }

    void moveActiveTabToNewWindow(tabId, tab.document.filePath as FileGrant, tab.document.dirty);
  }, [activeTabId, documentTabs, longProcessRunning, moveActiveTabToNewWindow, resetVisibleDocumentAppState, setError, stashVisibleDocumentEditingState, switchDocumentTab]);

  useEffect(() => {
    const pendingTabId = pendingMoveToNewWindowTabIdRef.current;
    if (!pendingTabId || pendingTabId !== activeTabId) {
      return;
    }

    // Defer until the target tab's editing state (snapshot restore or
    // reset) has rendered: this effect runs in the same flush as the
    // switch, when `moveActiveTabToNewWindow`/`saveToFile` still close over
    // the PREVIOUS tab's editing state — saving then could omit the target
    // tab's stashed edits or even apply the previous tab's overlays before
    // closing the tab (Codex review, PR #236). The marker update re-runs
    // this effect one flush later with the restored closures.
    if (editingSyncedSource !== document.source) {
      return;
    }

    const tab = documentTabs.find((candidate) => candidate.id === pendingTabId);
    if (!tab || !tab.document.filePath) {
      pendingMoveToNewWindowTabIdRef.current = null;
      setError("Save this document before moving it to a new window.");
      return;
    }

    pendingMoveToNewWindowTabIdRef.current = null;
    void moveActiveTabToNewWindow(
      pendingTabId,
      tab.document.filePath as FileGrant,
      tab.document.dirty,
    );
  }, [activeTabId, document.source, documentTabs, editingSyncedSource, moveActiveTabToNewWindow, setError]);

  const printDocument = useCallback(() => {
    if (streamedDocument) {
      if (editing.hasUnsavedEdits) {
        setError("Save the pending edits before printing this very large document.");
        return;
      }

      if (pathOpsGrant) {
        // Native streaming print (Lane F): Ghostscript prints straight from
        // disk, so the whole document is available at any size. The dialog
        // probes availability itself and offers the #127 page-range
        // extraction as its fallback when the native pipeline is out.
        setPrintDialogOpen(true);
        return;
      }

      setError(
        "Printing a very large document isn't available here. In the desktop app, a page range can be printed instead.",
      );
      return;
    }

    if (!document.bytes) {
      setError("Open a PDF before printing.");
      return;
    }

    window.print();
  }, [document.bytes, editing.hasUnsavedEdits, pathOpsGrant, setError, streamedDocument]);

  const buildBinder = useCallback(
    async (
      exhibits: readonly BinderExhibitInput[],
      options: PdfBinderOptions,
      fileName: string,
    ) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;
      const detail = `${stripPdfExtension(document.fileName ?? "Untitled")} + ${exhibits.length} ${
        exhibits.length === 1 ? "exhibit" : "exhibits"
      }`;

      setBinderProgress({
        running: true,
        message: "Building binder...",
        detail,
      });

      try {
        if (sourceBytes) {
          const built = await buildBinderInMemory(exhibits, options, fileName);
          setBinderProgress({
            running: false,
            message: built ? "Binder built." : "The binder could not be built.",
            detail,
          });
          if (!built) {
            setActiveLegalTool("combine-exhibits");
          }
          return built;
        }

        if (!streamedDocument || !pathOpsGrant) {
          setError(streamedDocument
            ? STREAMED_DOCUMENT_GATE_MESSAGE
            : "Open a PDF before building an exhibit binder.");
          setBinderProgress({
            running: false,
            message: streamedDocument
              ? STREAMED_DOCUMENT_GATE_MESSAGE
              : "Open a PDF before building an exhibit binder.",
            detail,
          });
          setActiveLegalTool("combine-exhibits");
          return false;
        }

        if (!isPathOpAvailableForInput(
          pathOpsGeneralStatus,
          "build_binder",
          document.fileSizeBytes,
        )) {
          const message = streamedBinderGateMessage(pathOpsGeneralStatus, document.fileSizeBytes);
          setError(message);
          setBinderProgress({ running: false, message, detail });
          setActiveLegalTool("combine-exhibits");
          return false;
        }

        setSidecarStatus({
          running: true,
          message: "Building your exhibit binder...",
          removed: [],
          beforeBytes: document.fileSizeBytes,
          afterBytes: null,
        });

        const output = await pathOpBuildBinder(pathOpsGrant, exhibits, options, fileName);

        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          // Stale exits before openPathOpOutput must release the output
          // grant themselves — nothing downstream ever sees it.
          await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
          setBinderProgress({ running: false, message: null, detail: null });
          return true;
        }

        const reopened = await openPathOpOutput(output, {
          openToken: sourceOpenToken,
          generation: sourceGeneration,
        });
        if (reopened.status !== "opened") {
          const message = reopened.status === "failed"
            ? reopened.error
            : "The binder was built, but the output could not be reopened.";
          setSidecarStatus({
            running: false,
            message,
            removed: [],
            beforeBytes: document.fileSizeBytes,
            afterBytes: null,
          });
          setBinderProgress({ running: false, message, detail });
          setActiveLegalTool("combine-exhibits");
          return false;
        }

        setSidecarStatus({
          running: false,
          message: "Binder built — the combined copy opened as a new document. Use Save As to keep it.",
          removed: [],
          beforeBytes: document.fileSizeBytes,
          afterBytes: output.sizeBytes,
        });
        setBinderProgress({
          running: false,
          message: "Binder built.",
          detail,
        });
        return true;
      } catch (error) {
        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setBinderProgress({ running: false, message: null, detail: null });
          return true;
        }

        const message = pathOpErrorMessage(
          error,
          "The exhibit binder could not be built. Your document was left unchanged — check the source files and try again.",
        );
        setSidecarStatus({
          running: false,
          message,
          removed: [],
          beforeBytes: document.fileSizeBytes,
          afterBytes: null,
        });
        setError(message);
        setBinderProgress({ running: false, message, detail });
        setActiveLegalTool("combine-exhibits");
        return false;
      }
    },
    [
      buildBinderInMemory,
      document.bytes,
      document.fileName,
      document.fileSizeBytes,
      document.generation,
      getOpenToken,
      isCurrentDocument,
      openPathOpOutput,
      pathOpsGeneralStatus,
      pathOpsGrant,
      setError,
      streamedDocument,
    ],
  );

  // The print dialog holds the grant it was opened with — close it when the
  // document changes so it can never print a stale grant (the #127 stale-
  // guard discipline, applied at the dialog boundary). The page-range prompt
  // is document-bound the same way: closing it here also unsticks a prompt
  // left at running=true when the document was replaced mid-extraction.
  useEffect(() => {
    setPrintDialogOpen(false);
    setPrintRangePrompt(null);
  }, [document.generation]);

  const cancelPrintRangePrompt = useCallback(() => {
    setPrintRangePrompt(null);
  }, []);

  const submitPrintRange = useCallback((rangeInput: string) => {
    const grant = pathOpsGrant;

    if (!grant) {
      setPrintRangePrompt(null);
      return;
    }

    const baseName = stripPdfExtension(document.fileName ?? "Untitled");
    // Stale guard (Codex review, PR #127): if the user opens a different
    // document while the extraction runs, the old range must not replace it.
    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;
    setPrintRangePrompt((current) => (
      current ? { ...current, value: rangeInput, running: true, message: null } : current
    ));

    void extractPrintableRange(grant, rangeInput, document.pageCount, baseName)
      .then((result) => {
        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          // The prompt belongs to a document that no longer exists — close
          // it rather than leaving it stuck at "running".
          setPrintRangePrompt(null);
          return;
        }

        if (!result.ok) {
          setPrintRangePrompt((current) => (
            current ? { ...current, running: false, message: result.error } : current
          ));
          return;
        }

        setPrintRangePrompt(null);
        // The extracted range opens as an ordinary small document — the
        // regular Print button (window.print on the rendered pages) now
        // applies to exactly those pages. The temp output on disk was
        // already deleted; these bytes live only in memory.
        openOpenedFile({ bytes: result.extraction.bytes, name: result.extraction.name, path: null });
      });
  }, [document.fileName, document.generation, document.pageCount, getOpenToken, isCurrentDocument, openOpenedFile, pathOpsGrant]);

  const selectLegalTool = useCallback(
    (toolId: LegalToolId) => {
      if (
        longProcessRunning &&
        (toolId === "prepare-for-filing" || toolId === "combine-exhibits")
      ) {
        return;
      }

      // Streamed mode: tools whose flow now runs file-to-file through the
      // PathOpsEngine (or that were already path/proxy-based) are open;
      // everything still byte-based stays gated with the message naming
      // what works [R1-2].
      if (
        streamedDocument &&
        !isStreamedLegalToolAvailable(
          toolId,
          pathOpsGrant !== null,
          pathOpsGeneralStatus,
          document.fileSizeBytes,
        )
      ) {
        setError(streamedLegalToolGateMessage(toolId, pathOpsGeneralStatus, document.fileSizeBytes));
        return;
      }

      setActiveLegalTool(toolId);
      setActiveTextEdit(false);
      setActiveEditDialogTool(null);

      if (toolId === "redact" && editing.tool !== "select") {
        editing.setTool("select");
      }

      setActiveOrganizeTool(null);
    },
    [document.fileSizeBytes, editing, longProcessRunning, pathOpsGeneralStatus, pathOpsGrant, setError, streamedDocument],
  );

  const selectOrganizeTool = useCallback((toolId: OrganizeToolId) => {
    // Streamed mode: Properties works from pdf.js `getMetadata()` on the
    // shared proxy; Compress, Repair, Merge, and Insert run file-to-file
    // through the PathOpsEngine; the Pages grid renders from the shared
    // proxy and its insert delegates too (the byte-bound grid actions keep
    // their own honest gates). PDF -> Word is standalone and picks its own
    // source PDF, so the current document's streamed state is irrelevant.
    // Everything else still mutates bytes — gated [R1-2].
    const streamedOrganizeAvailable =
      toolId === "pdf-to-word" ||
      toolId === "properties" ||
      (pathOpsGrant !== null && (
        toolId === "compress" ||
        toolId === "repair" ||
        toolId === "merge" ||
        toolId === "insert" ||
        toolId === "pages"
      ));

    if (streamedDocument && !streamedOrganizeAvailable) {
      setError(STREAMED_DOCUMENT_GATE_MESSAGE);
      return;
    }

    // Rotate and Compress (item 18) expand inline under their own ToolRow
    // instead of opening a FloatingDialog, so re-clicking the already-open
    // row collapses it -- there's no dialog "X" to close it otherwise.
    if (toolId === "rotate" || toolId === "compress") {
      setActiveOrganizeTool((current) => (current === toolId ? null : toolId));
      setActiveLegalTool(null);
      setActiveTextEdit(false);
      setActiveEditDialogTool(null);
      return;
    }

    setActiveOrganizeTool(toolId);
    setActiveLegalTool(null);
    setActiveTextEdit(false);
    setActiveEditDialogTool(null);
  }, [pathOpsGrant, setError, streamedDocument]);

  const selectEditDialogTool = useCallback((toolId: EditDialogToolId) => {
    // Streamed mode: both entries (Page Numbers, Watermark) run file-to-file
    // through the PathOpsEngine stamping ops when the document has a shell
    // grant; browser streamed docs stay gated.
    if (streamedDocument && !pathOpsGrant) {
      setError(STREAMED_DOCUMENT_GATE_MESSAGE);
      return;
    }

    // Both current entries (Page Numbers, Watermark) are inline expansions
    // (item 18) -- toggle off on reselect, same reasoning as Rotate/Compress
    // above.
    setActiveEditDialogTool((current) => (current === toolId ? null : toolId));
    setActiveLegalTool(null);
    setActiveTextEdit(false);
    setActiveOrganizeTool(null);
    editing.setTool("select");
  }, [editing, pathOpsGrant, setError, streamedDocument]);

  const closeWorkspace = useCallback(() => {
    setActiveOrganizeTool(null);
    setActiveLegalTool(null);
    setActiveTextEdit(false);
    setActiveEditDialogTool(null);
  }, []);

  /**
   * Delegated merge for a streamed current document [item 4]: the current
   * grant goes first, added grants follow in order — one qpdf `--pages`
   * pass, file-to-file — and the merged output funnels through
   * `openPathOpOutput` behind the standard (openToken, generation) guard.
   */
  const mergeStreamedWithGrants = useCallback(
    async (addGrants: readonly FileGrant[]) => {
      const grant = pathOpsGrant;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!grant || addGrants.length === 0) {
        return false;
      }

      try {
        const output = await pathOpMerge([grant, ...addGrants]);

        const reopened = await openPathOpOutput(output, {
          openToken: sourceOpenToken,
          generation: sourceGeneration,
        });
        return reopened.status === "opened";
      } catch (error) {
        if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setError(pathOpErrorMessage(error, "The PDFs could not be merged. Check the files and try again."));
        }

        return false;
      }
    },
    [document.generation, getOpenToken, isCurrentDocument, openPathOpOutput, pathOpsGrant, setError],
  );

  /**
   * Delegated insert-into-current for a streamed document [item 4]: the
   * dedicated `insert_pages` core op composes target and insert grants in a
   * single qpdf `--pages` assembly; the output funnels through
   * `openPathOpOutput` behind the standard stale guard.
   */
  const insertStreamedGrant = useCallback(
    async (insertGrant: FileGrant, insertAtPageIndex: number) => {
      const grant = pathOpsGrant;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!grant) {
        return false;
      }

      try {
        const output = await pathOpInsertPages(grant, insertGrant, insertAtPageIndex);

        const reopened = await openPathOpOutput(output, {
          openToken: sourceOpenToken,
          generation: sourceGeneration,
        });
        return reopened.status === "opened";
      } catch (error) {
        if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setError(pathOpErrorMessage(error, "The selected file could not be inserted. Check the file and try again."));
        }

        return false;
      }
    },
    [document.generation, getOpenToken, isCurrentDocument, openPathOpOutput, pathOpsGrant, setError],
  );

  /** Streamed selected-page extraction delegates to the same qpdf path op used
   * by print-range extraction, then reopens the output through the standard
   * guarded path-op reconcile flow. */
  const extractCurrentPages = useCallback(
    async (pageIndexes: readonly number[]) => {
      if (!streamedDocument) {
        return extractPages(pageIndexes);
      }

      const grant = pathOpsGrant;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!grant) {
        setError(STREAMED_DOCUMENT_GATE_MESSAGE);
        return false;
      }

      try {
        const output = await pathOpExtractPages(grant, pageIndexes);
        const reopened = await openPathOpOutput(output, {
          openToken: sourceOpenToken,
          generation: sourceGeneration,
        });

        if (reopened.status !== "opened" && isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setError(reopened.status === "failed"
            ? reopened.error
            : "The selected pages were extracted, but the output could not be reopened.");
        }

        return reopened.status === "opened";
      } catch (error) {
        if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setError(pathOpErrorMessage(error, "The selected pages could not be extracted. Check the range and try again."));
        }

        return false;
      }
    },
    [
      document.generation,
      extractPages,
      getOpenToken,
      isCurrentDocument,
      openPathOpOutput,
      pathOpsGrant,
      setError,
      streamedDocument,
    ],
  );

  /** Grant-based merge/insert handlers, present only when the streamed current
   * document can delegate (Tauri + shell grant). Browser streamed docs get
   * null and keep their gates. */
  const delegatedOrganizeOps = useMemo(
    () => (streamedDocument && pathOpsGrant !== null
      ? { merge: mergeStreamedWithGrants, insert: insertStreamedGrant }
      : null),
    [insertStreamedGrant, mergeStreamedWithGrants, pathOpsGrant, streamedDocument],
  );

  const splitAndSavePages = useCallback(
    async (pageGroups: readonly (readonly number[])[]) => {
      if (streamedDocument) {
        const grant = pathOpsGrant;
        const sourceOpenToken = getOpenToken();
        const sourceGeneration = document.generation;

        if (!grant) {
          setError(STREAMED_DOCUMENT_GATE_MESSAGE);
          return null;
        }

        const outputGrants: FileGrant[] = [];
        let handedToSave = false;

        try {
          for (const pageIndexes of pageGroups) {
            if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
              return null;
            }

            const output = await pathOpExtractPages(grant, pageIndexes);
            outputGrants.push(output.outputGrant);

            if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
              return null;
            }
          }

          const baseName = stripPdfExtension(document.fileName ?? "Untitled");
          const parts = outputGrants.map((outputGrant, index) => ({
            grant: outputGrant,
            fileName: formatSplitOutputFileName(baseName, index + 1, outputGrants.length),
          }));

          handedToSave = true;
          const saved = await saveStreamedOutputParts(
            parts,
            () => isCurrentDocument(sourceOpenToken, sourceGeneration),
          );

          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            return null;
          }

          return saved.files.filter(isSavedFile);
        } catch (error) {
          if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            setError(pathOpErrorMessage(error, "The page ranges could not be split. Check the ranges and try again."));
          }

          return null;
        } finally {
          if (!handedToSave) {
            await releaseStreamedOutputGrants(outputGrants);
          }
        }
      }

      const parts = await splitPages(
        pageGroups,
        stripPdfExtension(document.fileName ?? "Untitled"),
      );

      if (!parts) {
        return null;
      }

      return (await saveByteOutputParts(parts)).files.filter(isSavedFile);
    },
    [
      document.fileName,
      document.generation,
      getOpenToken,
      isCurrentDocument,
      pathOpsGrant,
      setError,
      splitPages,
      streamedDocument,
    ],
  );

  const cropResize = useCallback(
    async (
      pageIndexes: readonly number[],
      options: { cropMarginIn: number; resizePreset: "original" | "letter" | "legal" },
    ) => {
      if (!document.bytes) {
        setError("Open a PDF before cropping pages.");
        return false;
      }

      try {
        return await cropResizePages(pageIndexes, options);
      } catch {
        setError("The pages could not be cropped. Check the range and try again.");
        return false;
      }
    },
    [cropResizePages, document.bytes, setError],
  );

  const addPendingRedaction = useCallback((area: PdfRedactionArea) => {
    redactionIdRef.current += 1;
    setPendingRedactions((current) => [
      ...current,
      {
        id: `redaction-${redactionIdRef.current}`,
        area,
      },
    ]);
    setRedactionPhase("idle");
    setRedactionMessage(null);
  }, []);

  const removePendingRedaction = useCallback((id: string) => {
    setPendingRedactions((current) => current.filter((area) => area.id !== id));
  }, []);

  const searchTextForRedaction = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!pdfDocument) {
        setRedactionMessage("Open a PDF before searching for redaction text.");
        return;
      }

      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!sourceBytes) {
        setRedactionMessage(
          streamedDocument
            ? "Search-to-redact isn't available for very large files yet — draw boxes over the areas instead."
            : "Open a PDF before searching for redaction text.",
        );
        return;
      }

      const areas = await findTextRedactionAreas(
        { bytes: sourceBytes, pdfDocument },
        redactionSearchText,
      );

      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        return;
      }

      if (areas.length === 0) {
        setRedactionPhase("idle");
        setRedactionMessage("No matching text was found.");
        return;
      }

      setPendingRedactions((current) => [
        ...current,
        ...areas.map((area) => {
          redactionIdRef.current += 1;
          return {
            id: `redaction-${redactionIdRef.current}`,
            area,
          };
        }),
      ]);
      setRedactionPhase("idle");
      setRedactionMessage(`${areas.length} ${areas.length === 1 ? "area" : "areas"} marked from search.`);
    },
    [document.bytes, document.generation, getOpenToken, isCurrentDocument, pdfDocument, redactionSearchText, streamedDocument],
  );

  const requestApplyRedactions = useCallback(() => {
    if (streamedDocument) {
      // Streamed redaction runs file-to-file through the PathOpsEngine —
      // it needs a shell grant, not the sidecar bridge.
      if (!pathOpsGrant) {
        setRedactionPhase("error");
        setRedactionMessage("This tool only works in the installed RaioPDF app.");
        return;
      }
    } else if (!document.bytes) {
      setRedactionPhase("error");
      setRedactionMessage("Open a PDF before applying redactions.");
      return;
    } else if (!engineBridge.available) {
      setRedactionPhase("error");
      setRedactionMessage("This tool only works in the installed RaioPDF app.");
      return;
    }

    if (pendingRedactions.length === 0) {
      setRedactionPhase("error");
      setRedactionMessage("Mark at least one area before applying redactions.");
      return;
    }

    setRedactionPhase("confirming");
    setRedactionMessage(null);
  }, [document.bytes, engineBridge.available, pathOpsGrant, pendingRedactions.length, streamedDocument]);

  const cancelRedactions = useCallback(() => {
    setRedactionPhase("idle");
    setRedactionMessage(null);
  }, []);

  const confirmRedactions = useCallback(async () => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;
    const areas = pendingRedactions.map((pending) => pending.area);

    if (areas.length === 0) {
      return;
    }

    if (!sourceBytes && pathOpsGrant) {
      // Delegated redaction [R3-1][R4-1]: file-to-file with engine-side,
      // fail-closed verification — the op re-extracts text from the redacted
      // regions of the OUTPUT file; any recoverable text (or any inability
      // to verify) rejects with VERIFICATION_FAILED and no output grant ever
      // exists, so an unverified result can never be committed.
      setRedactionPhase("applying");
      setRedactionMessage("Applying redactions and confirming the removed text is really gone...");

      try {
        const result = await pathOpRedactAreas(pathOpsGrant, areas);

        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          // Same leak class as the other pre-openPathOpOutput stale exits.
          await pathOpReleaseOutput(result.outputGrant).catch(() => undefined);
          return;
        }

        const reopened = await openPathOpOutput(result, {
          openToken: sourceOpenToken,
          generation: sourceGeneration,
        });
        if (reopened.status !== "opened") {
          return;
        }

        setRedactionPhase("verified");
        setRedactionMessage(formatStreamedRedactionSuccess(result.verification));
      } catch (error) {
        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          return;
        }

        setRedactionPhase("error");
        setRedactionMessage(
          error instanceof PathOpsError && error.code === "VERIFICATION_FAILED"
            ? `${error.message} The document was NOT modified.`
            : pathOpErrorMessage(error, "Redaction could not finish. The document was left unchanged."),
        );
      }

      return;
    }

    if (!sourceBytes) {
      return;
    }

    setRedactionPhase("applying");
    setRedactionMessage("Applying redactions and double-checking the text, images, markup, and hidden info are all clean...");

    try {
      const redactedTerms = pdfDocument
        ? await collectRedactionAreaTexts({ bytes: sourceBytes, pdfDocument }, areas)
        : [];

      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        return;
      }

      const redactedBytes = await engineBridge.redactAreas(sourceBytes, areas);

      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        return;
      }

      const verified = await verifyRedactionAreasClear(redactedBytes, areas, redactedTerms);

      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        return;
      }

      if (!verified.ok) {
        setRedactionPhase("error");
        setRedactionMessage(`${formatRedactionVerificationFailure(verified)} The document was NOT modified.`);
        return;
      }

      const replaced = await replaceBytes(redactedBytes, {
        dirty: true,
        hasTextLayer: null,
        expectedOpenToken: sourceOpenToken,
        expectedGeneration: sourceGeneration,
        fileName: `${stripPdfExtension(document.fileName ?? "Untitled")}_redacted.pdf`,
        filePath: null,
      });

      if (replaced !== "replaced") {
        setRedactionPhase("error");
        setRedactionMessage("The document changed before redaction finished. The result was not applied.");
        return;
      }

      setPendingRedactions([]);
      setRedactionPhase("verified");
      setRedactionMessage(formatRedactionVerificationSuccess(verified));
    } catch (error) {
      logWorkflowFailure("redaction.failed", error);
      const message = isEngineBridgeUnavailableError(error)
        ? error.message
        : formatWorkflowError(error, "Redaction could not finish. The document was left unchanged.");

      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        return;
      }

      setRedactionPhase("error");
      setRedactionMessage(message);
    }
  }, [
    document.bytes,
    document.fileName,
    engineBridge,
    getOpenToken,
    isCurrentDocument,
    openPathOpOutput,
    pathOpsGrant,
    pdfDocument,
    pendingRedactions,
    replaceBytes,
  ]);

  const applyBates = useCallback(
    async (options: PdfBatesStampOptions) => {
      if (batesApplyingRef.current) {
        return true;
      }

      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!sourceBytes && pathOpsGrant) {
        // Delegated Bates stamping: a generated text overlay + one qpdf
        // --overlay pass, file-to-file. The stamped copy funnels through
        // openPathOpOutput (memory reopen when small, streamed otherwise).
        batesApplyingRef.current = true;
        setBatesState({
          applying: true,
          message: "Applying Bates numbers...",
        });

        try {
          const output = await pathOpBatesStamp(pathOpsGrant, options);

          // Stale guard (same pattern as the post-#127 funnels): a slow op
          // must never reopen its output over a newer document. Release the
          // orphaned output grant — nothing downstream ever sees it.
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            return true;
          }

          const reopened = await openPathOpOutput(output, {
            openToken: sourceOpenToken,
            generation: sourceGeneration,
          });
          if (reopened.status !== "opened") {
            return isCurrentDocument(sourceOpenToken, sourceGeneration) ? false : true;
          }

          setBatesState({
            applying: false,
            message: "Bates numbers applied — the stamped copy opened as a new document. Use Save As to keep it.",
          });
          return true;
        } catch (error) {
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            return true;
          }

          setBatesState({
            applying: false,
            message: pathOpErrorMessage(error, "Bates numbers could not be applied. The document was left unchanged."),
          });
          return false;
        } finally {
          batesApplyingRef.current = false;
        }
      }

      if (!sourceBytes) {
        setBatesState({
          applying: false,
          message: streamedDocument
            ? STREAMED_DOCUMENT_GATE_MESSAGE
            : "Open a PDF before applying Bates numbers.",
        });
        return false;
      }

      batesApplyingRef.current = true;
      setBatesState({ applying: true, message: "Applying Bates numbers..." });
      let applied = false;

      try {
        applied = await batesStamp(options, {
          expectedOpenToken: sourceOpenToken,
          expectedGeneration: sourceGeneration,
        });

        if (applied) {
          setBatesState({
            applying: false,
            message: "Bates numbers applied.",
          });
          return true;
        }

        if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setBatesState({
            applying: false,
            message: "Bates numbers could not be applied. Check the format and try again.",
          });
          return false;
        }

        return true;
      } finally {
        batesApplyingRef.current = false;

        if (!applied && isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setBatesState((current) => (
            current.applying ? { ...current, applying: false } : current
          ));
        }
      }
    },
    [batesStamp, document.bytes, document.generation, getOpenToken, isCurrentDocument, openPathOpOutput, pathOpsGrant, streamedDocument],
  );

  const applyPageNumbers = useCallback(
    async (options: PdfPageNumbersOptions) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!sourceBytes && pathOpsGrant) {
        // Delegated page numbering: overlay technique, file-to-file; the
        // numbered copy funnels through openPathOpOutput with the standard
        // (openToken, generation) stale guard.
        setSidecarStatus({
          running: true,
          message: "Applying page numbers...",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });

        try {
          const output = await pathOpPageNumbers(pathOpsGrant, options);

          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            return false;
          }

          const reopened = await openPathOpOutput(output, {
            openToken: sourceOpenToken,
            generation: sourceGeneration,
          });
          if (reopened.status !== "opened") {
            return false;
          }

          setSidecarStatus({
            running: false,
            message: "Page numbers applied — the numbered copy opened as a new document. Use Save As to keep it.",
            removed: [],
            beforeBytes: null,
            afterBytes: null,
          });
          return true;
        } catch (error) {
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            return false;
          }

          setSidecarStatus({
            running: false,
            message: pathOpErrorMessage(error, "Page numbers could not be applied. The document was left unchanged."),
            removed: [],
            beforeBytes: null,
            afterBytes: null,
          });
          return false;
        }
      }

      if (!sourceBytes) {
        setSidecarStatus((current) => ({
          ...current,
          message: streamedDocument
            ? STREAMED_DOCUMENT_GATE_MESSAGE
            : "Open a PDF before applying page numbers.",
        }));
        return false;
      }

      setSidecarStatus({
        running: true,
        message: "Applying page numbers...",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });

      const applied = await pageNumbers(options, {
        expectedOpenToken: sourceOpenToken,
        expectedGeneration: sourceGeneration,
      });

      if (getOpenToken() === sourceOpenToken) {
        setSidecarStatus({
          running: false,
          message: applied ? "Page numbers applied." : "Page numbers could not be applied.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
      }

      return applied;
    },
    [document.bytes, document.generation, getOpenToken, isCurrentDocument, openPathOpOutput, pageNumbers, pathOpsGrant, streamedDocument],
  );

  const applyWatermark = useCallback(
    async (options: PdfWatermarkOptions) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!sourceBytes && pathOpsGrant) {
        // Delegated watermark: overlay technique with real transparency
        // (ExtGState), file-to-file; funneled through openPathOpOutput with
        // the standard stale guard.
        setSidecarStatus({
          running: true,
          message: "Applying watermark...",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });

        try {
          const output = await pathOpWatermark(pathOpsGrant, options);

          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            return false;
          }

          const reopened = await openPathOpOutput(output, {
            openToken: sourceOpenToken,
            generation: sourceGeneration,
          });
          if (reopened.status !== "opened") {
            return false;
          }

          setSidecarStatus({
            running: false,
            message: "Watermark applied — the watermarked copy opened as a new document. Use Save As to keep it.",
            removed: [],
            beforeBytes: null,
            afterBytes: null,
          });
          return true;
        } catch (error) {
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            return false;
          }

          setSidecarStatus({
            running: false,
            message: pathOpErrorMessage(error, "The watermark could not be applied. The document was left unchanged."),
            removed: [],
            beforeBytes: null,
            afterBytes: null,
          });
          return false;
        }
      }

      if (!sourceBytes) {
        setSidecarStatus((current) => ({
          ...current,
          message: streamedDocument
            ? STREAMED_DOCUMENT_GATE_MESSAGE
            : "Open a PDF before applying a watermark.",
        }));
        return false;
      }

      setSidecarStatus({
        running: true,
        message: "Applying watermark...",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });

      const applied = await watermark(options, {
        expectedOpenToken: sourceOpenToken,
        expectedGeneration: sourceGeneration,
      });

      if (getOpenToken() === sourceOpenToken) {
        setSidecarStatus({
          running: false,
          message: applied ? "Watermark applied." : "Watermark could not be applied.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
      }

      return applied;
    },
    [document.bytes, document.generation, getOpenToken, isCurrentDocument, openPathOpOutput, pathOpsGrant, streamedDocument, watermark],
  );

  const compressDocument = useCallback(
    async (options: PdfCompressOptions) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!sourceBytes && pathOpsGrant) {
        // Delegated compress [R2-2]: qpdf's structural pass (object streams
        // + linearization) file-to-file. The quality/grayscale options are a
        // sidecar (image-downsampling) feature and do not apply here.
        const beforeBytes = document.fileSizeBytes;
        setSidecarStatus({
          running: true,
          message: "Compressing...",
          removed: [],
          beforeBytes,
          afterBytes: null,
        });

        try {
          const output = await pathOpCompress(pathOpsGrant);

          // A slow op must never clobber a document the user opened while it
          // ran (Codex review, PR #127) — same stale guard as the byte branch.
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            return false;
          }

          const reopened = await openPathOpOutput(output, {
            openToken: sourceOpenToken,
            generation: sourceGeneration,
          });
          if (reopened.status !== "opened") {
            return false;
          }

          setSidecarStatus({
            running: false,
            message: "Compression complete. Very large files get lighter cleanup only, so scanned images aren't shrunk as much.",
            removed: [],
            beforeBytes,
            afterBytes: output.sizeBytes,
          });
          return true;
        } catch (error) {
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            return false;
          }
          setSidecarStatus({
            running: false,
            message: pathOpErrorMessage(error, "Compression could not finish. The document was left unchanged."),
            removed: [],
            beforeBytes,
            afterBytes: null,
          });
          return false;
        }
      }

      if (!sourceBytes) {
        setSidecarStatus({
          running: false,
          message: streamedDocument
            ? STREAMED_DOCUMENT_GATE_MESSAGE
            : "Open a PDF before compressing.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      if (!engineBridge.available) {
        setSidecarStatus({
          running: false,
          message: "This tool only works in the installed RaioPDF app.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      setSidecarStatus({
        running: true,
        message: "Compressing...",
        removed: [],
        beforeBytes: sourceBytes.byteLength,
        afterBytes: null,
      });

      try {
        const compressedBytes = await engineBridge.compress(sourceBytes, options);

        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          return false;
        }

        const replaced = await replaceBytes(compressedBytes, {
          dirty: true,
          hasTextLayer: null,
          expectedOpenToken: sourceOpenToken,
          expectedGeneration: sourceGeneration,
        });
        const applied = replaced === "replaced";

        setSidecarStatus({
          running: false,
          message: applied ? "Compression complete." : "The document changed before compression finished.",
          removed: [],
          beforeBytes: sourceBytes.byteLength,
          afterBytes: applied ? compressedBytes.byteLength : null,
        });

        return applied;
      } catch (error) {
        if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          setSidecarStatus({
            running: false,
            message: isEngineBridgeUnavailableError(error)
              ? error.message
              : "Compression could not finish. The document was left unchanged.",
            removed: [],
            beforeBytes: sourceBytes.byteLength,
            afterBytes: null,
          });
        }

        return false;
      }
    },
    [document.bytes, document.fileSizeBytes, document.generation, engineBridge, getOpenToken, isCurrentDocument, openPathOpOutput, pathOpsGrant, replaceBytes, streamedDocument],
  );

  const sanitizeDocument = useCallback(async () => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;

    if (!sourceBytes && pathOpsGrant) {
      // Delegated sanitize [R2-2]: a Ghostscript pdfwrite rewrite on disk —
      // document JavaScript, embedded files, and launch actions don't
      // survive it.
      setSidecarStatus({
        running: true,
        message: "Sanitizing...",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });

      try {
        const output = await pathOpSanitize(pathOpsGrant);

        // Stale guard (Codex review, PR #127): don't reopen an output for a
        // document the user has since replaced.
        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
          return false;
        }

        const reopened = await openPathOpOutput(output, {
          openToken: sourceOpenToken,
          generation: sourceGeneration,
        });
        if (reopened.status !== "opened") {
          return false;
        }

        setSidecarStatus({
          running: false,
          message: "Sanitize complete. The rewrite removes document JavaScript, embedded files, and launch actions; the sanitized copy opened as a new document.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return true;
      } catch (error) {
        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          return false;
        }
        setSidecarStatus({
          running: false,
          message: pathOpErrorMessage(error, "Sanitize could not finish. The document was left unchanged."),
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }
    }

    if (!sourceBytes) {
      setSidecarStatus({
        running: false,
        message: streamedDocument
          ? STREAMED_DOCUMENT_GATE_MESSAGE
          : "Open a PDF before sanitizing.",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });
      return false;
    }

    if (!engineBridge.available) {
      setSidecarStatus({
        running: false,
        message: "This tool only works in the installed RaioPDF app.",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });
      return false;
    }

    setSidecarStatus({
      running: true,
      message: "Sanitizing...",
      removed: [],
      beforeBytes: null,
      afterBytes: null,
    });

    try {
      const result = await engineBridge.sanitize(sourceBytes, {
        removeJavaScript: true,
        removeEmbeddedFiles: true,
        removeLinks: true,
      });

      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        return false;
      }

      const replaced = await replaceBytes(result.bytes, {
        dirty: true,
        hasTextLayer: null,
        expectedOpenToken: sourceOpenToken,
        expectedGeneration: sourceGeneration,
      });
      const applied = replaced === "replaced";

      setSidecarStatus({
        running: false,
        message: applied ? "Sanitize complete." : "The document changed before sanitize finished.",
        removed: applied ? result.removed : [],
        beforeBytes: null,
        afterBytes: null,
      });

      return applied;
    } catch (error) {
      if (isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        setSidecarStatus({
          running: false,
          message: isEngineBridgeUnavailableError(error)
            ? error.message
            : "Sanitize could not finish. The document was left unchanged.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
      }

      return false;
    }
  }, [document.bytes, document.generation, engineBridge, getOpenToken, isCurrentDocument, openPathOpOutput, pathOpsGrant, replaceBytes, streamedDocument]);

  const repairDocument = useCallback(
    async () => {
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;
      const source = repairCandidate ?? (document.bytes
        ? { bytes: document.bytes, name: document.fileName ?? "Repaired.pdf", path: null }
        : null);

      if (!source && pathOpsGrant) {
        // Delegated repair [R2-2]: qpdf rebuilds the file on disk — the
        // malformed-large-file fallback the streamed open error points at.
        const beforeBytes = document.fileSizeBytes;
        setSidecarStatus({
          running: true,
          message: "Repairing...",
          removed: [],
          beforeBytes,
          afterBytes: null,
        });

        try {
          const output = await pathOpRepair(pathOpsGrant);

          // Stale guard (Codex review, PR #127): don't reopen an output for
          // a document the user has since replaced.
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            return false;
          }

          const reopened = await openPathOpOutput(output, {
            openToken: sourceOpenToken,
            generation: sourceGeneration,
          });
          if (reopened.status !== "opened") {
            return false;
          }

          setSidecarStatus({
            running: false,
            message: "Repair complete. The repaired copy opened as a new document — use Save As to keep it.",
            removed: [],
            beforeBytes,
            afterBytes: output.sizeBytes,
          });
          return true;
        } catch (error) {
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
            return false;
          }
          setSidecarStatus({
            running: false,
            message: pathOpErrorMessage(error, "Repair could not finish."),
            removed: [],
            beforeBytes,
            afterBytes: null,
          });
          return false;
        }
      }

      if (!source && streamedDocument) {
        setSidecarStatus({
          running: false,
          message: STREAMED_DOCUMENT_GATE_MESSAGE,
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      if (!source) {
        setSidecarStatus({
          running: false,
          message: "Choose a PDF or open a document before repairing.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      if (!engineBridge.available) {
        setSidecarStatus({
          running: false,
          message: "This tool only works in the installed RaioPDF app.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      setSidecarStatus({
        running: true,
        message: "Repairing...",
        removed: [],
        beforeBytes: source.bytes.byteLength,
        afterBytes: null,
      });

      try {
        const repairedBytes = await engineBridge.repair(source.bytes);
        const openResult = await openDocumentFile({
          bytes: repairedBytes,
          name: `Repaired ${source.name}`,
          path: null,
        });
        const opened = openResult.status === "opened";

        setSidecarStatus({
          running: false,
          message: opened ? "Repair complete." : "Repair finished, but the PDF still could not be opened.",
          removed: [],
          beforeBytes: source.bytes.byteLength,
          afterBytes: repairedBytes.byteLength,
        });

        if (opened) {
          setRepairCandidate(null);
          setSelectedPageIndexes(new Set([0]));
        }

        return opened;
      } catch (error) {
        setSidecarStatus({
          running: false,
          message: isEngineBridgeUnavailableError(error)
            ? error.message
            : "Repair could not finish.",
          removed: [],
          beforeBytes: source.bytes.byteLength,
          afterBytes: null,
        });
        return false;
      }
    },
    [document.bytes, document.fileName, document.fileSizeBytes, document.generation, engineBridge, getOpenToken, isCurrentDocument, openDocumentFile, openPathOpOutput, pathOpsGrant, repairCandidate, streamedDocument],
  );

  const insertImageFilesAsPages = useCallback(
    async (files: readonly File[]) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();
      const sourceGeneration = document.generation;

      if (!sourceBytes) {
        setSidecarStatus({
          running: false,
          message: "Open a PDF before inserting image pages.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      // Fallback is 0-based like the selection indexes — `currentPage` is
      // 1-based (OrganizeWorkspace applies the same `- 1`).
      const insertAt = [...selectedPageIndexes].sort((left, right) => left - right)[0] ?? (document.currentPage - 1);
      setSidecarStatus({
        running: true,
        message: "Inserting image pages...",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });
      const images = await Promise.all(files.map(readImagePageInput));

      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        setSidecarStatus({
          running: false,
          message: "The document changed before image pages finished loading.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      const inserted = await insertImagePages(images, insertAt, {
        expectedOpenToken: sourceOpenToken,
        expectedGeneration: sourceGeneration,
      });
      setSidecarStatus({
        running: false,
        message: inserted ? "Image pages inserted." : "Image pages could not be inserted.",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });
      return inserted;
    },
    [document.bytes, document.currentPage, document.generation, getOpenToken, insertImagePages, isCurrentDocument, selectedPageIndexes],
  );

  const exportPageAsImage = useCallback(
    async (pageIndex: number) => {
      if (!pdfDocument) {
        setError("Open a PDF before exporting a page image.");
        return false;
      }

      try {
        const page = await pdfDocument.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext("2d");

        if (!context) {
          return false;
        }

        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, "image/png");
        });

        if (!blob) {
          return false;
        }

        const url = URL.createObjectURL(blob);
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = `${stripPdfExtension(document.fileName ?? "page")} - page ${pageIndex + 1}.png`;
        anchor.click();
        URL.revokeObjectURL(url);
        return true;
      } catch {
        setError("The page image could not be exported.");
        return false;
      }
    },
    [document.fileName, pdfDocument, setError],
  );

  const runScanner = useCallback(() => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;

    // Streamed mode: allowed — the scan is explicitly user-initiated [R1-3],
    // runs off the shared streamed proxy, and pre-warms the extraction cache
    // page-by-page so progress is visible on a 2,556-page document.
    if (!sourceBytes && !(streamedDocument && pdfDocument)) {
      setScannerState({
        scanning: false,
        message: streamedDocument
          ? "The document is still opening. Try again in a moment."
          : "Open a PDF before running the 2.425 scanner.",
        hits: [],
      });
      return;
    }

    const runId = scannerRunRef.current + 1;
    scannerRunRef.current = runId;
    const isCurrentScannerRun = () => (
      scannerRunRef.current === runId && isCurrentDocument(sourceOpenToken, sourceGeneration)
    );

    setScannerState((current) => ({
      ...current,
      scanning: true,
      message: "Scanning extracted text...",
      hits: [],
    }));

    void (async () => {
      if (!sourceBytes) {
        // Streamed: walk pages in windows first (fills the proxy-keyed text
        // cache) so the user sees progress, then run the pattern scan over
        // the warmed cache in one cheap pass.
        const scanProxy = pdfDocument!;
        const totalPages = scanProxy.numPages;

        for (let start = 0; start < totalPages; start += 8) {
          const windowEnd = Math.min(start + 8, totalPages);
          await extractPageTextForIndexes(
            scanProxy,
            Array.from({ length: windowEnd - start }, (_, offset) => start + offset),
          );

          if (!isCurrentScannerRun()) {
            return [];
          }

          setScannerState((current) => (
            current.scanning
              ? { ...current, message: `Scanning page ${windowEnd} of ${totalPages}...` }
              : current
          ));
        }

        return scanSensitivePatterns(scanProxy);
      }

      const loadedForScan = pdfDocument ? null : await loadPdfDocument(sourceBytes);
      const scanDocument = pdfDocument ?? loadedForScan;

      if (!scanDocument) {
        return [];
      }

      try {
        return await scanSensitivePatterns({ bytes: sourceBytes, pdfDocument: scanDocument });
      } finally {
        await loadedForScan?.loadingTask.destroy();
      }
    })()
      .then((hits) => {
        if (!isCurrentScannerRun()) {
          return;
        }

        setScannerState({
          scanning: false,
          message: hits.length
            ? `${hits.length} possible ${hits.length === 1 ? "item" : "items"} found.`
            : "No obvious sensitive patterns found. Review remains yours.",
          hits,
        });
      })
      .catch(() => {
        if (!isCurrentScannerRun()) {
          return;
        }

        setScannerState({
          scanning: false,
          message: "The scanner could not read text from this PDF.",
          hits: [],
        });
      });
  }, [document.bytes, document.generation, getOpenToken, isCurrentDocument, pdfDocument, streamedDocument]);

  const markScannerHit = useCallback(
    (hit: SensitiveHit) => {
      setActiveLegalTool("redact");
      addPendingRedaction(hit.area);
      setRedactionMessage(`${hit.category} on page ${hit.pageIndex + 1} marked for redaction.`);
    },
    [addPendingRedaction],
  );

  const scrubDocumentMetadata = useCallback(async () => {
    if (!document.bytes) {
      setScrubState({
        scrubbing: false,
        message: "Open a PDF before scrubbing metadata.",
        removedFields: [],
      });
      return;
    }

    const removedFields = metadataSummary?.removedFields.length
      ? metadataSummary.removedFields
      : ["document metadata"];

    setScrubState({
      scrubbing: true,
      message: "Scrubbing metadata...",
      removedFields: [],
    });

    const scrubbed = await scrubMetadata();

    setScrubState({
      scrubbing: false,
      message: scrubbed ? null : "Metadata could not be scrubbed. Try reopening the document.",
      removedFields: scrubbed ? removedFields : [],
    });
  }, [document.bytes, metadataSummary, scrubMetadata]);

  /**
   * The streamed filing run [R6-1]: the reduced, fully path-based pipeline.
   * `prepare_filing` composes the registered ops engine-side in one pass
   * (decrypt → sanitize → normalize → OCR → scrub → split), the part
   * descriptors save by grant (shell-side copy — no bytes in the WebView),
   * and the output preflight is recomputed from `document_facts` per part.
   * Only steps the closed-form rule enabled can appear in the selection.
   */
  const prepareStreamedFilingCopy = useCallback((
    grant: FileGrant,
    certificate: CertificateOfServiceDraft | null,
    options: PrepareOptions,
  ) => {
    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;
    const selectedSteps = new Set(options.selectedStepIds);
    const customSplitBytes = options.customSplitMegabytes
      ? Math.round(options.customSplitMegabytes * 1024 * 1024)
      : null;

    if (certificate && hasCertificateContent(certificate)) {
      setFilingProgress({
        phase: "error",
        message: "Certificate of Service pages aren't available for very large files yet — file the certificate separately.",
      });
      return;
    }

    const runId = filingRunRef.current + 1;
    filingRunRef.current = runId;
    const isCurrentFilingRun = () => (
      filingRunRef.current === runId && isCurrentDocument(sourceOpenToken, sourceGeneration)
    );
    const unappliedRedactionMarks = pendingRedactions.length;

    if (!options.acknowledgeImpact && unappliedRedactionMarks > 0) {
      setFilingImpact({
        conversionImpact: null,
        unappliedRedactionMarks,
        markupAnnotationCount: 0,
        normalizePagesSelected: selectedSteps.has("normalize-pages"),
      });
      setFilingProgress({ phase: "idle", message: null });
      return;
    }

    // Encryption: a rendered streamed doc can only be owner-restricted (an
    // open password would have blocked the viewer), so an empty password is
    // the expected decrypt input; a genuinely encrypted doc still demands one.
    let decryptPassword: string | undefined;
    if (
      selectedSteps.has("remove-encryption") &&
      (filingFacts?.encryptionState === "encrypted" || filingFacts?.encryptionState === "usage_restricted")
    ) {
      decryptPassword = options.removeEncryptionPassword ?? "";

      if (!decryptPassword && filingFacts?.encryptionState === "encrypted") {
        setFilingProgress({
          phase: "error",
          message: "Enter the PDF open password to remove encryption before preparing this file.",
        });
        return;
      }
    }

    const splitTargetBytes = selectedSteps.has("split-by-size")
      ? customSplitBytes ?? filingPack.recommendedMaxFileBytes ?? filingPack.maxFileBytes ?? null
      : null;
    const plan = buildPrepareFilingPlan(options.selectedStepIds, {
      decryptPassword,
      splitMaxBytes: splitTargetBytes,
    });

    setFilingResult(null);
    setFilingImpact(null);

    let pathOpJobToken: string | null = null;
    void (async () => {
      if (decryptPassword !== undefined && filingFacts?.signatureDetection) {
        const proceed = await confirmDecryptSignatureFactsInvalidation(
          filingFacts.signatureDetection,
          decryptPassword ? "user-password" : "owner-restricted",
          [document.fileName ?? "Document.pdf"],
          document.filePath ?? null,
        );
        if (!isCurrentFilingRun()) {
          return;
        }
        if (!proceed) {
          setFilingProgress({ phase: "idle", message: null });
          return;
        }
      }

      setFilingProgress({
        phase: "normalizing",
        message: "Preparing your filing copy — large files are handled a piece at a time so they open smoothly...",
      });
      pathOpJobToken = newOcrJobToken();
      setPathOpCancelState({
        process: "prepare-filing",
        jobToken: pathOpJobToken,
        backend: "path-op",
        requested: false,
      });

      // The whole streamed pipeline (sanitize → normalize → OCR → scrub →
      // split) runs as one opaque engine call, so OCR — by far the slowest
      // step on a large scan — is the only sub-step that can report itself.
      // Subscribe to its per-page events so the loader shows "page X of Y"
      // instead of sitting on the same line for minutes. No OCR step, no token.
      const willOcr = selectedSteps.has("make-searchable");
      const ocrJobToken = willOcr ? pathOpJobToken : null;
      let unlistenOcrProgress: (() => void) | null = null;
      if (ocrJobToken) {
        try {
          unlistenOcrProgress = await listenOcrProgress(ocrJobToken, (event) => {
            if (!isCurrentFilingRun()) {
              return;
            }
            const progress =
              typeof event.total === "number" && event.total > 0
                ? { current: event.completed, total: event.total, unit: event.unit || "page" }
                : null;
            // Only advance from the pre-OCR "normalizing" state or a prior OCR
            // tick — never resurrect the "ocr" phase after the run has moved
            // on to verifying/done/error via a late-delivered event.
            setFilingProgress((current) =>
              current.phase === "normalizing" || current.phase === "ocr"
                ? { phase: "ocr", message: describeOcrProgress(event), progress }
                : current,
            );
          });
        } catch {
          // Progress is additive — the filing run still proceeds without events.
        }
      }

      let result: Awaited<ReturnType<typeof pathOpPrepareFiling>>;
      try {
        result = await pathOpPrepareFiling(grant, plan, pathOpJobToken);
      } finally {
        unlistenOcrProgress?.();
        const finishedJobToken = pathOpJobToken;
        setPathOpCancelState((current) => (
          current?.jobToken === finishedJobToken ? null : current
        ));
      }

      const prepareCancelRequested = isPathOpCancelRequested(pathOpJobToken);
      if (prepareCancelRequested) {
        await Promise.all(
          result.parts.map((part) => (
            pathOpReleaseOutput(part.outputGrant).catch(() => undefined)
          )),
        );
        clearPathOpCancelRequest(pathOpJobToken);
        if (isCurrentFilingRun()) {
          setActiveLegalTool("prepare-for-filing");
          setFilingProgress({ phase: "idle", message: null });
        }
        return;
      }
      clearPathOpCancelRequest(pathOpJobToken);

      if (!isCurrentFilingRun()) {
        return;
      }

      setFilingProgress({
        phase: "verifying",
        message: "Saving the output parts and running the final checks...",
      });

      const baseName = stripPdfExtension(document.fileName ?? "Untitled");
      const saveParts = result.parts.map((part, index) => ({
        grant: part.outputGrant,
        fileName: formatFilingOutputName(
          baseName,
          filingPack,
          index + 1,
          result.parts.length,
        ),
      }));
      const savedOutput = await saveStreamedOutputParts(saveParts, isCurrentFilingRun);

      if (!isCurrentFilingRun()) {
        return;
      }

      setFilingResult({
        parts: result.parts.map((part, index) => ({
          fileName: savedOutput.files[index]?.name ?? saveParts[index]?.fileName ?? part.name,
          byteLength: part.byteLength,
          pageIndexes: part.pageIndexes,
          oversized: part.oversized,
        })),
        report: buildStreamedFilingOutputReport(result.factsReport),
        verifiedAt: new Date().toISOString(),
        savedDirectoryPath: savedOutput.directoryPath,
        skippedSteps: skippedPrepSteps(filingPrepPlan, selectedSteps),
        overrides: filingRunOverrides({
          customSplitBytes,
          packDefaultSplitBytes: filingPack.recommendedMaxFileBytes ?? filingPack.maxFileBytes ?? null,
          scrubbedBeforePdfA: false,
        }),
      });
      setFilingProgress({
        phase: "done",
        message: savedOutput.directoryPath
          ? `Filing output saved to ${savedOutput.directoryPath}. For very large files, some of the pre-filing checks are skipped — review the result before filing.`
          : "Filing output saved. For very large files, some of the pre-filing checks are skipped — review the result before filing.",
      });
      setLastPrepareConfiguration(null);
    })()
      .catch((error: unknown) => {
        if (!isCurrentFilingRun()) {
          return;
        }

        if (isPathOpCancelledError(error)) {
          setActiveLegalTool("prepare-for-filing");
          setFilingProgress({ phase: "idle", message: null });
          return;
        }

        setFilingProgress({
          phase: "error",
          message: pathOpErrorMessage(error, "The filing copy could not be prepared."),
        });
      })
      .finally(() => {
        const finishedJobToken = pathOpJobToken;
        setPathOpCancelState((current) => (
          current?.jobToken === finishedJobToken ? null : current
        ));
        clearPathOpCancelRequest(finishedJobToken);
      });
  }, [
    clearPathOpCancelRequest,
    confirmDecryptSignatureFactsInvalidation,
    document.fileName,
    document.filePath,
    document.generation,
    filingFacts,
    filingPack,
    filingPrepPlan,
    getOpenToken,
    isCurrentDocument,
    isPathOpCancelRequested,
    pendingRedactions.length,
  ]);

  const prepareFilingCopy = useCallback((
    certificate: CertificateOfServiceDraft | null,
    options: PrepareOptions,
  ) => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;
    const selectedSteps = new Set(options.selectedStepIds);
    const convertOutputToPdfA = selectedSteps.has("convert-pdfa");
    const markupAnnotationChoice = options.markupAnnotations ?? null;
    const customSplitBytes = options.customSplitMegabytes
      ? Math.round(options.customSplitMegabytes * 1024 * 1024)
      : null;

    if (!sourceBytes) {
      if (pathOpsGrant && streamedDocument) {
        // Streamed run branch [R6-1]: the reduced, fully path-based filing
        // pipeline replaces the byte pipeline for very large documents.
        const rememberedOptions: PrepareOptions = {
          ...options,
          selectedStepIds: [...options.selectedStepIds],
        };
        delete rememberedOptions.acknowledgeImpact;
        delete rememberedOptions.removeEncryptionPassword;
        setLastPrepareConfiguration({
          generation: sourceGeneration,
          key: `${sourceOpenToken}:${sourceGeneration}`,
          openToken: sourceOpenToken,
          certificate,
          options: rememberedOptions,
        });
        setActiveLegalTool(null);
        prepareStreamedFilingCopy(pathOpsGrant, certificate, options);
        return;
      }

      // Browser streamed docs (no grant) and menu paths like Export PDF/A
      // land here directly -- keep the gate honest rather than claiming no
      // document is open.
      setFilingProgress({
        phase: "error",
        message: streamedDocument
          ? STREAMED_DOCUMENT_GATE_MESSAGE
          : "Open a PDF before preparing a filing copy.",
      });
      return;
    }

    if (convertOutputToPdfA && !engineBridge.available) {
      setFilingProgress({
        phase: "error",
        message: "Saving as PDF/A (archival format) only works in the installed RaioPDF app.",
      });
      return;
    }

    const runId = filingRunRef.current + 1;
    filingRunRef.current = runId;
    const isCurrentFilingRun = () => (
      filingRunRef.current === runId && isCurrentDocument(sourceOpenToken, sourceGeneration)
    );
    const unappliedRedactionMarks = pendingRedactions.length;

    setFilingResult(null);
    setFilingImpact(null);
    setFilingProgress({
      phase: "normalizing",
      message: "Preparing the filing copy from the selected checklist...",
    });
    setActiveLegalTool(null);

    void (async () => {
      let filingSourceBytes = sourceBytes;
      if (
        selectedSteps.has("remove-encryption") &&
        (filingFacts?.encryptionState === "encrypted" || filingFacts?.encryptionState === "usage_restricted")
      ) {
        const ownerRestricted = filingFacts?.encryptionState === "usage_restricted";
        const removeEncryptionPassword = options.removeEncryptionPassword ?? "";
        // Owner-restricted files carry permission flags but no open password, so
        // they decrypt with an empty password -- don't force a prompt for
        // something the user never set. A genuinely encrypted file still needs
        // its open password.
        if (!removeEncryptionPassword && !ownerRestricted) {
          setFilingProgress({
            phase: "error",
            message: "Enter the PDF open password to remove encryption before preparing this file.",
          });
          return;
        }
        if (!engineBridge.available) {
          setFilingProgress({
            phase: "error",
            message: "Removing password protection only works in the installed RaioPDF app.",
          });
          return;
        }

        setFilingProgress({
          phase: "normalizing",
          message:
            ownerRestricted && !removeEncryptionPassword
              ? "Removing owner restrictions from the filing copy..."
              : "Removing encryption with the password you entered...",
        });
        filingSourceBytes = await engineBridge.removeEncryption(
          sourceBytes,
          removeEncryptionPassword,
        );

        if (!isCurrentFilingRun()) {
          return;
        }

        // Decrypting a signed document invalidates its signature; reuse the same
        // confirmation the open path runs so the filing copy never strips a
        // signature silently.
        const proceed = await confirmDecryptSignatureInvalidation(
          filingSourceBytes,
          removeEncryptionPassword ? "user-password" : "owner-restricted",
          [document.fileName ?? "Document.pdf"],
          document.filePath ?? null,
        );
        if (!isCurrentFilingRun()) {
          return;
        }
        if (!proceed) {
          setFilingProgress({ phase: "idle", message: null });
          return;
        }
      }

      // Destructive steps strip annotations, form fields, and signatures silently.
      // Surface what this run would destroy and stop for an explicit go-ahead.
      if (!options.acknowledgeImpact) {
        const needsImpactConfirmation = convertOutputToPdfA || selectedSteps.has("flatten-forms");
        const conversionImpact = needsImpactConfirmation
          ? await getCachedConversionImpact(filingSourceBytes)
          : null;
        const markupAnnotationCount = await countRaioPdfMarkupAnnotations(filingSourceBytes);

        if (!isCurrentFilingRun()) {
          return;
        }

        if (
          unappliedRedactionMarks > 0 ||
          markupAnnotationCount > 0 ||
          (conversionImpact && hasPdfAConversionImpact(conversionImpact))
        ) {
          setFilingImpact({
            conversionImpact,
            unappliedRedactionMarks,
            markupAnnotationCount,
            normalizePagesSelected: selectedSteps.has("normalize-pages"),
          });
          setFilingProgress({ phase: "idle", message: null });
          setActiveLegalTool("prepare-for-filing");
          return;
        }
      }

      let workingHandle: PdfDocumentHandle;
      let filingOcrType: OcrType | null = null;
      const filingOcrNotices: string[] = [];
      const closeHandles: PdfDocumentHandle[] = [];

      try {
        workingHandle = await filingEngine.open(filingSourceBytes);
        closeHandles.push(workingHandle);

        if (markupAnnotationChoice === "flatten") {
          setFilingProgress({
            phase: "normalizing",
            message: "Making your markup permanent for filing...",
          });
          const flattenedMarkupHandle = await filingEngine.flattenMarkupAnnotations(workingHandle);
          closeHandles.push(flattenedMarkupHandle);
          workingHandle = flattenedMarkupHandle;
        }

        if (certificate && hasCertificateContent(certificate)) {
          const certificateBytes = await createCertificateOfServicePdf(certificate);
          const certificateHandle = await filingEngine.open(certificateBytes);
          closeHandles.push(certificateHandle);
          const pageCount = await filingEngine.pageCount(workingHandle);
          const appended = await filingEngine.insertPages(
            workingHandle,
            pageCount,
            certificateHandle,
            { sourceLabel: "Certificate of Service" },
          );
          const appendedHandle = appended.document;
          closeHandles.push(appendedHandle);
          workingHandle = appendedHandle;
        }

        if (selectedSteps.has("normalize-pages")) {
          setFilingProgress({
            phase: "normalizing",
            message: "Normalizing pages to the filing pack size and orientation...",
          });
          const normalizedHandle = await filingEngine.normalizePages(workingHandle, {
            targetSize: filingPack.pageSize,
            orientation: "portrait",
          });
          closeHandles.push(normalizedHandle);
          workingHandle = normalizedHandle;
        }

        if (!isCurrentFilingRun()) {
          return;
        }

        if (selectedSteps.has("sanitize-content")) {
          setFilingProgress({
            phase: "normalizing",
            message: "Sanitizing active and embedded content...",
          });
          workingHandle = await reopenFilingHandle(
            filingEngine,
            closeHandles,
            await engineBridge.sanitize(await filingEngine.saveToBytes(workingHandle), {
              removeJavaScript: true,
              removeEmbeddedFiles: true,
              removeLinks: true,
            }).then((result) => result.bytes),
          );
        }

        if (selectedSteps.has("scrub-metadata")) {
          setFilingProgress({
            phase: "normalizing",
            message: selectedSteps.has("convert-pdfa")
              ? "Removing hidden document info before converting to PDF/A (archival format)..."
              : "Scrubbing metadata...",
          });
          const scrubbedHandle = await filingEngine.scrubMetadata(workingHandle);
          closeHandles.push(scrubbedHandle);
          workingHandle = scrubbedHandle;
        }

        if (!isCurrentFilingRun()) {
          return;
        }

        if (selectedSteps.has("make-searchable")) {
          // Byte pipeline: OCR runs in-memory via the sidecar, which doesn't
          // stream per-page events, so there's no page count here — but flag
          // the OCR phase so the loader highlights the "Making searchable" step
          // (the slowest one) rather than leaving "Normalize" lit through it.
          setFilingProgress({
            phase: "ocr",
            message: "Making the filing copy searchable...",
          });
          const [workingBytes, workingPageCount] = await Promise.all([
            filingEngine.saveToBytes(workingHandle),
            filingEngine.pageCount(workingHandle),
          ]);
          const filingOcrPlan = planOcrRun(
            document.textLayerCoverage?.garbledPages.length ? "force-ocr" : "skip-text",
            document.textLayerCoverage,
          );
          filingOcrType = filingOcrPlan.ocrType;
          const ocrResult = await engineBridge.runOcr(workingBytes, {
            ocrType: filingOcrPlan.ocrType,
            ...(filingOcrPlan.pageIndexes?.length ? { pageIndexes: filingOcrPlan.pageIndexes } : {}),
            pageCount: workingPageCount,
          });

          if (!isCurrentFilingRun()) {
            return;
          }

          setFilingProgress({
            phase: "normalizing",
            message: "Checking the filing copy's searchable text...",
          });
          // Advisory: a less-than-perfect text layer rides along as a warning on
          // the output, it never blocks the save. An unparseable OCR result can't be
          // inspected at all — treat that as a notice too (matching the per-part
          // output check), never an abort that leaves the user with no file.
          try {
            const filingTextLayerCoverage = await inspectTextLayer(ocrResult.bytes);
            const filingOcrVerification = verifyOcrTextLayer(
              filingTextLayerCoverage,
              filingOcrPlan.ocrType,
            );
            const filingOcrNotice = filingOcrVerificationNotice(filingOcrVerification);
            if (filingOcrNotice) {
              filingOcrNotices.push(filingOcrNotice);
            }
          } catch {
            filingOcrNotices.push("The filing copy text layer could not be verified.");
          }

          if (!isCurrentFilingRun()) {
            return;
          }

          workingHandle = await reopenFilingHandle(
            filingEngine,
            closeHandles,
            ocrResult.bytes,
          );
        }

        if (selectedSteps.has("flatten-forms")) {
          setFilingProgress({
            phase: "normalizing",
            message: "Locking the form fields...",
          });
          const flattenedHandle = await filingEngine.flattenForm(workingHandle);
          closeHandles.push(flattenedHandle);
          workingHandle = flattenedHandle;
        }

        const baseName = stripPdfExtension(document.fileName ?? "Untitled");

        setFilingProgress({
          phase: "splitting",
          message: selectedSteps.has("split-by-size")
            ? "Splitting at page boundaries against the configured byte target..."
            : "Saving one filing output file...",
        });

        const splitTargetBytes =
          customSplitBytes ??
          filingPack.recommendedMaxFileBytes ??
          filingPack.maxFileBytes ??
          Number.MAX_SAFE_INTEGER;
        if (convertOutputToPdfA) {
          setFilingProgress({
            phase: "converting",
            message: selectedSteps.has("split-by-size")
              ? "Converting each split filing part to PDF/A (archival format)..."
              : "Converting the filing copy to PDF/A (archival format)...",
          });
        }
        const preparedOutput = await prepareFilingOutputParts({
          engine: filingEngine,
          document: workingHandle,
          splitBySize: selectedSteps.has("split-by-size"),
          splitTargetBytes,
          baseName,
          pack: filingPack,
          ...(convertOutputToPdfA
            ? { pdfAConversion: {
              flavor: filingPack.pdfa.flavor,
              convert: engineBridge.convertToPdfA,
            } }
            : {}),
          formatFileName: formatFilingOutputName,
        });
        closeHandles.push(...preparedOutput.handlesToClose);
        const convertedParts = preparedOutput.parts;

        if (!isCurrentFilingRun()) {
          return;
        }

        setFilingProgress({
          phase: "verifying",
          message: selectedSteps.has("make-searchable")
            ? "Verifying searchable text on the output files..."
            : "Re-running preflight on the output files...",
        });

        if (selectedSteps.has("make-searchable")) {
          // Advisory: collect a per-part notice for any output that isn't cleanly
          // searchable, but always keep going — the file gets produced either way.
          filingOcrNotices.push(
            ...(await collectFilingOcrOutputPartNotices(
              convertedParts,
              filingOcrType ?? "skip-text",
              inspectTextLayer,
            )),
          );

          if (!isCurrentFilingRun()) {
            return;
          }

          setFilingProgress({
            phase: "verifying",
            message: "Re-running preflight on the output files...",
          });
        }

        let finalReport: PreflightReport;
        try {
          const outputReports = await runFilingOutputPreflights(
            convertedParts,
            filingPack,
            (part) => getCachedFilingFacts(filingFactsCacheRef, part.bytes, {
              fileBytes: part.bytes.byteLength,
              filename: part.fileName,
            }),
            runFilingPreflight,
          );
          finalReport = aggregateOutputReports(outputReports);
        } catch {
          finalReport = filingPreflightUnavailableReport();
        }
        const outputParts: FilingOutputPart[] = convertedParts.map((part) => ({
          fileName: part.fileName,
          byteLength: part.bytes.byteLength,
          pageIndexes: part.pageIndexes,
          oversized: part.oversized,
        }));

        const savedOutput = await saveByteOutputParts(convertedParts, isCurrentFilingRun);

        if (!isCurrentFilingRun()) {
          return;
        }

        setFilingResult({
          parts: outputParts.map((part, index) => ({
            ...part,
            fileName: savedOutput.files[index]?.name ?? part.fileName,
          })),
          report: finalReport,
          verifiedAt: new Date().toISOString(),
          savedDirectoryPath: savedOutput.directoryPath,
          skippedSteps: skippedPrepSteps(filingPrepPlan, selectedSteps),
          overrides: filingRunOverrides({
            customSplitBytes,
            packDefaultSplitBytes: filingPack.recommendedMaxFileBytes ?? filingPack.maxFileBytes ?? null,
            scrubbedBeforePdfA: selectedSteps.has("scrub-metadata") && selectedSteps.has("convert-pdfa"),
          }),
          notices: filingOcrNotices,
        });
        setFilingProgress({
          phase: "done",
          message: savedOutput.directoryPath
            ? `Filing output saved to ${savedOutput.directoryPath} after output preflight verification.`
            : "Filing output saved after output preflight verification.",
        });
      } finally {
        await Promise.all(closeHandles.map((handle) => filingEngine.close(handle).catch(() => undefined)));
      }
    })().catch((error: unknown) => {
      if (!isCurrentFilingRun()) {
        return;
      }

      logWorkflowFailure("filing.failed", error);
      const message = isEngineBridgeUnavailableError(error)
        ? error.message
        : formatWorkflowError(error, "The filing copy could not be prepared.");

      setFilingProgress({
        phase: "error",
        message,
      });
    });
  }, [
    document.bytes,
    document.fileName,
    document.textLayerCoverage,
    engineBridge,
    filingEngine,
    filingFacts,
    filingPack,
    filingPrepPlan,
    getOpenToken,
    isCurrentDocument,
    pathOpsGrant,
    pendingRedactions.length,
    prepareStreamedFilingCopy,
    streamedDocument,
  ]);

  const compressBeforeFiling = useCallback(() => {
    preserveFilingProgressForGenerationRef.current = document.generation;
    setFilingProgress({
      phase: "normalizing",
      message: "Compressing before the split check...",
    });

    void compressDocument({ quality: 5, grayscale: false }).then((compressed) => {
      if (!compressed) {
        preserveFilingProgressForGenerationRef.current = null;
      }

      setFilingProgress({
        phase: compressed ? "idle" : "error",
        message: compressed
          ? "Compression complete. Preflight will re-run on the compressed document."
          : "Compression could not finish. The document was left unchanged.",
      });
    });
  }, [compressDocument, document.generation]);

  const undoLastPendingEdit = useCallback(() => {
    const lastEdit = editing.pendingEdits[editing.pendingEdits.length - 1];

    if (lastEdit) {
      editing.removeEdit(lastEdit.id);
    }
  }, [editing]);

  const exportDocx = useCallback(() => {
    if (!document.source) {
      setError("Open a PDF before exporting editable Word.");
      return;
    }

    const grant = engineDelegatedGrant;
    if (!grant) {
      setError(
        document.dirty || editing.hasUnsavedEdits
          ? "Save the current PDF before exporting editable Word."
          : "Exporting editable Word needs a PDF opened from this computer in the desktop app.",
      );
      return;
    }

    const sourceOpenToken = getOpenToken();
    const sourceGeneration = document.generation;
    const hasTextLayerSignal = document.textLayerCoverage
      ? hasSearchableTextLayerCoverage(document.textLayerCoverage)
      : document.hasTextLayer;

    void runPdfToWordReflow({
      getInput: async () => ({
        grant,
        name: document.fileName ?? "Document.pdf",
      }),
      getTextLayer: (input) => resolveWordReflowTextLayerSignal(input, hasTextLayerSignal),
      onStatus: setWordReflowStatus,
      suggestedName: (_input, output) => (
        output.name || `${stripPdfExtension(document.fileName ?? "Document")}.docx`
      ),
    }).then((result) => {
      if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
        return;
      }

      if (result.status === "failed" || result.status === "refused") {
        setError(result.message);
      }
    });
  }, [
    document.dirty,
    document.fileName,
    document.generation,
    document.hasTextLayer,
    document.source,
    document.textLayerCoverage,
    editing.hasUnsavedEdits,
    engineDelegatedGrant,
    getOpenToken,
    isCurrentDocument,
    setError,
  ]);

  const runStandalonePdfToWord = useCallback(() => {
    void runPdfToWordReflow({
      getInput: async () => {
        const picked = await pickStandalonePdfForWord();
        return picked
          ? {
            grant: picked.grant,
            name: picked.name,
          }
          : null;
      },
      getTextLayer: (input) => pdfGrantHasTextLayer(input.grant),
      onStatus: setWordReflowStatus,
    }).then((result) => {
      if (result.status === "failed" || result.status === "refused") {
        setError(result.message);
      }
    });
  }, [setError]);

  const importWordDocument = useCallback(() => {
    void runWordDocumentImport({ onStatus: setWordReflowStatus }).then(async (result) => {
      if (result.status === "unavailable" || result.status === "failed") {
        setError(result.message);
        return;
      }
      if (result.status !== "converted") {
        return;
      }
      // Import opens the converted PDF as a NEW document, like File -> Open: in
      // a new tab when something is already open (never replacing an unsaved
      // active tab), or in place when nothing is open. Capture the identity
      // guard at open time so switching documents during the long conversion
      // doesn't discard the import.
      const reopened = await openPathOpOutput(
        result.output,
        { openToken: getOpenToken(), generation: documentGenerationRef.current },
        { openInNewTab: true },
      );
      if (reopened.status === "failed") {
        setWordReflowStatus({ running: false, tone: "danger", message: reopened.error });
        setError(reopened.error);
        return;
      }
      setWordReflowStatus({
        running: false,
        tone: "ok",
        message: `Imported ${result.sourceName}. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
      });
    });
  }, [getOpenToken, openPathOpOutput, setError]);

  const exportPdfA = useCallback(() => {
    const sourceBytes = document.bytes;

    if (!sourceBytes) {
      setError(
        streamedDocument ? STREAMED_DOCUMENT_GATE_MESSAGE : "Open a PDF before exporting PDF/A.",
      );
      return;
    }

    if (!engineBridge.available) {
      setError("Saving as PDF/A (the long-term archival format) isn't available in this version of RaioPDF.");
      return;
    }

    // A plain "convert this document to PDF/A and save a copy" export. Prepare
    // for Filing is a separate workflow (it also normalizes page size, splits
    // oversized filings, scrubs metadata); Export PDF/A must not pull the user
    // into it — it just converts and hands back a file.
    const flavor = filingPack.pdfa.flavor;
    const suggestedName = `${stripPdfExtension(document.fileName ?? "Untitled")} (PDF-A).pdf`;
    const unappliedRedactionMarks = pendingRedactions.length;

    void (async () => {
      if (unappliedRedactionMarks > 0) {
        const confirmed = window.confirm(
          `${unappliedRedactionMarks} pending redaction `
            + `${unappliedRedactionMarks === 1 ? "mark has" : "marks have"} not been applied. `
            + "Exporting PDF/A now saves a copy of the document exactly as it looks now, so those boxes "
            + "will be omitted and the underlying content will remain in the export. Export anyway?",
        );

        if (!confirmed) {
          return;
        }
      }

      // PDF/A conversion flattens form fields and interactive annotations into
      // the page. Confirm before rewriting when the open document has any so
      // the export is never a silent loss of editability.
      const impact = await getCachedConversionImpact(sourceBytes);
      const markupAnnotationCount = await countRaioPdfMarkupAnnotations(sourceBytes);

      if ((impact && hasPdfAConversionImpact(impact)) || markupAnnotationCount > 0) {
        const confirmed = window.confirm(
          "Converting to PDF/A merges form fields and interactive markup permanently into the page. "
            + "The exported copy keeps how they look, but they'll no longer be fillable or editable. "
            + "Export anyway?",
        );

        if (!confirmed) {
          return;
        }
      }

      try {
        const converted = await engineBridge.convertToPdfA(sourceBytes, flavor);
        await filePort.saveFile(converted, suggestedName, null);
      } catch (error: unknown) {
        logWorkflowFailure("pdfa.failed", error);
        setError(
          isEngineBridgeUnavailableError(error)
            ? error.message
            : formatWorkflowError(error, "This PDF could not be exported to PDF/A."),
        );
      }
    })();
  }, [
    document.bytes,
    document.fileName,
    engineBridge,
    filingPack.pdfa.flavor,
    pendingRedactions.length,
    setError,
    streamedDocument,
  ]);

  const showPasswordProtection = useCallback(() => {
    setActiveOrganizeTool(null);
    setActiveLegalTool("passwords");
  }, []);

  const fitToPageWidth = useCallback(() => {
    if (document.source === null) {
      return;
    }

    setFitZoom(document.zoom);
  }, [document.source, document.zoom, setFitZoom]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.defaultPrevented || isTextEntryTarget(event.target)) {
        return;
      }

      if (document.source === null) {
        return;
      }

      switch (event.key) {
        case "=":
        case "+":
        case "Add":
          event.preventDefault();
          setZoom(document.zoom + ZOOM_STEP);
          break;
        case "-":
        case "Subtract":
          event.preventDefault();
          setZoom(document.zoom - ZOOM_STEP);
          break;
        case "0":
          event.preventDefault();
          setZoom(1);
          break;
        case "1":
          // Acrobat uses Ctrl+1 for actual size and Ctrl+2 for fit width; Raio
          // maps Ctrl+0 to 100% and Ctrl+1 to our existing fit-width command.
          event.preventDefault();
          fitToPageWidth();
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [document.source, document.zoom, fitToPageWidth, setZoom]);

  const openAboutMacrify = useCallback(() => {
    setSettingsFocusSection("about-macrify");
    setSettingsOpen(true);
  }, []);
  // Shared by the File menu's "Open Raio to AI..." item and the tool
  // sidebar's top-level "Connect to AI Agent" entry -- both open the exact
  // same settings surface, not two copies of the same wiring.
  const openConnectToAi = useCallback(() => {
    setSettingsFocusSection("open-raio-to-ai");
    setSettingsOpen(true);
  }, []);
  const openHelp = useCallback((articleId?: string) => {
    setHelpArticleId(articleId);
    setHelpOpen(true);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "F1" || event.defaultPrevented || settingsOpen || hasOpenDialogStackEntry()) {
        return;
      }

      event.preventDefault();
      openHelp();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  const handleNativeMenuCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "file:open":
          openFile();
          break;
        case "file:open-new-window":
          openFileInSeparateWindow();
          break;
        case "file:save":
          save();
          break;
        case "file:save-as":
          saveAs();
          break;
        case "file:export-pdfa":
          exportPdfA();
          break;
        case "file:export-docx":
          exportDocx();
          break;
        case "file:import-docx":
          importWordDocument();
          break;
        case "file:print":
          printDocument();
          break;
        case "file:protect":
          showPasswordProtection();
          break;
        case "file:properties":
          setActiveEditDialogTool(null);
          setActiveLegalTool(null);
          setActiveOrganizeTool("properties");
          break;
        case "file:export-diagnostics":
          handleExportDiagnostics();
          break;
        case "file:preferences":
          setSettingsFocusSection(null);
          setSettingsOpen(true);
          break;
        case "file:open-raio-to-ai":
          openConnectToAi();
          break;
        case "help:open":
          openHelp();
          break;
        case "file:about-macrify":
          openAboutMacrify();
          break;
        case "edit:undo":
          undoLastPendingEdit();
          break;
        case "view:zoom-in":
          setZoom(document.zoom + ZOOM_STEP);
          break;
        case "view:zoom-out":
          setZoom(document.zoom - ZOOM_STEP);
          break;
        case "view:fit":
          fitToPageWidth();
          break;
        default:
          break;
      }
    },
    [
      document.zoom,
      exportDocx,
      importWordDocument,
      exportPdfA,
      fitToPageWidth,
      handleExportDiagnostics,
      openHelp,
      openAboutMacrify,
      openConnectToAi,
      openFileInSeparateWindow,
      openFile,
      printDocument,
      save,
      saveAs,
      setZoom,
      showPasswordProtection,
      undoLastPendingEdit,
    ],
  );

  useEffect(() => {
    nativeMenuCommandRef.current = handleNativeMenuCommand;
  }, [handleNativeMenuCommand]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("raiopdf-menu", (event) => {
        nativeMenuCommandRef.current(event.payload);
      }))
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }

        unlisten = nextUnlisten;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const redactionPanel: RedactionPanelState = {
    phase: redactionPhase,
    message: redactionMessage,
    pendingCount: pendingRedactions.length,
    available: engineBridge.available,
  };
  const scrubMetadataPanel: ScrubMetadataPanelState = {
    metadata: metadataSummary,
    scrubbing: scrubState.scrubbing,
    message: scrubState.message,
    removedFields: scrubState.removedFields,
  };
  const editingForShell = useMemo(
    () => ({ ...editing, setTool: selectEditTool }),
    [editing, selectEditTool],
  );

  const modeBar = activeTextEdit ? (
    <EditTextModeBar
      textEdit={textEdit}
      onExit={() => setActiveTextEdit(false)}
    />
  ) : activeLegalTool === "redact" ? (
    <RedactionModeBar
      pendingCount={pendingRedactions.length}
      searchOpen={redactionSearchOpen}
      searchText={redactionSearchText}
      applying={redactionPhase === "applying"}
      onSearchOpen={() => setRedactionSearchOpen(true)}
      onSearchTextChange={setRedactionSearchText}
      onSearchSubmit={searchTextForRedaction}
      onApply={requestApplyRedactions}
      onExit={() => setActiveLegalTool(null)}
    />
  ) : editing.tool !== "select" ? (
    <EditModeBar editing={editingForShell} />
  ) : null;

  const activeLongProcess = useMemo<ActiveLongProcess | null>(() => {
    if (isFilingProgressActive(filingProgress.phase)) {
      const cancelState = pathOpCancelState?.process === "prepare-filing"
        ? pathOpCancelState
        : null;
      return {
        label: "Prepare for Filing",
        loader: {
          phaseLabel: formatProgressLabel(filingProgress.phase),
          message: filingProgress.message ?? formatProgressLabel(filingProgress.phase),
          detail: document.fileSizeBytes ? `Working on ${formatBytes(document.fileSizeBytes)}` : document.fileName ?? undefined,
          steps: filingProgressSteps(filingProgress.phase),
          progress: filingProgress.progress ?? null,
          ...(cancelState
            ? {
                cancelLabel: "Cancel",
                cancelMessage: "Stops after the current tool step.",
                cancelRequested: cancelState.requested,
                onCancel: cancelPathOperation,
              }
            : {}),
        },
      };
    }

    if (
      ocrState.phase === "starting-engine" ||
      ocrState.phase === "processing" ||
      ocrState.phase === "verifying"
    ) {
      const cancelState = pathOpCancelState?.process === "ocr"
        ? pathOpCancelState
        : null;
      return {
        label: "OCR",
        loader: {
          phaseLabel: "Make Searchable",
          message: formatOcrRunningMessage(ocrState.phase, ocrState.progress ?? null),
          detail: document.pageCount > 0
            ? `${document.pageCount} ${document.pageCount === 1 ? "page" : "pages"}`
            : undefined,
          progress: toLongProcessProgress(ocrState.progress ?? null),
          ...(cancelState
            ? {
                cancelLabel: "Cancel",
                cancelMessage: "Stops the OCR run.",
                cancelRequested: cancelState.requested,
                onCancel: cancelPathOperation,
              }
            : {}),
        },
      };
    }

    if (binderProgress.running) {
      return {
        label: "Combine with Exhibits",
        loader: {
          phaseLabel: "Building binder",
          message: binderProgress.message ?? "Building binder...",
          detail: binderProgress.detail ?? undefined,
        },
      };
    }

    if (textEdit.phase === "staging" || textEdit.phase === "applying") {
      return {
        label: "Find & Replace",
        loader: {
          phaseLabel: textEdit.phase === "staging" ? "Staging replacement" : "Applying replacement",
          message: textEdit.phase === "staging"
            ? "Preparing a preview of your changes."
            : "Opening the edited PDF as a Save As copy.",
          detail: textEdit.phase === "staging"
            ? "Image-heavy documents can take a few minutes."
            : "Save will prompt for a destination.",
        },
      };
    }

    return null;
  }, [
    binderProgress,
    document.fileName,
    document.fileSizeBytes,
    document.pageCount,
    filingProgress,
    cancelPathOperation,
    ocrState.phase,
    ocrState.progress,
    pathOpCancelState,
    textEdit.phase,
  ]);
  const longProcessLockoutLabel = activeLongProcess
    ? `Paused while ${activeLongProcess.label} runs`
    : filingPacketProgress.running
      ? "Paused while Filing Packet runs"
    : null;
  const extractOpenDocumentPageTextByPage = useCallback(
    (bytes: Uint8Array) => extractUiPageTextByPage(bytes, pdfDocument),
    [pdfDocument],
  );

  // Production Set and Batch Cleanup run path-based against the on-disk
  // file. When the open document is dirty or has unsaved in-memory edits,
  // its disk bytes are the pre-edit content — seeding its path would
  // silently Bates-stamp / clean stale bytes. Same discipline as
  // `engineDelegatedGrant` (refuses a grant while dirty) and exportDocx's
  // "Save the current PDF" gate: don't seed, and say why.
  const currentFileHasUnsavedChanges = document.dirty || editing.hasUnsavedEdits;
  const currentFileForPathWorkspaces = document.source && !currentFileHasUnsavedChanges
    ? {
        name: document.fileName ?? "Untitled.pdf",
        path: document.filePath,
      }
    : null;
  const currentFileUnsavedNotice = document.source && currentFileHasUnsavedChanges
    ? "The open document has unsaved changes, so it was not added. Save the current PDF first, then reopen this tool to include it."
    : null;

  const workspace = activeLegalTool === "case-caption" ? (
    <CaptionWorkspace
      document={document}
      onPrependCaption={insertFile}
      onCancel={closeWorkspace}
      onHelpRequested={() => openHelp("case-caption")}
    />
  ) : activeLegalTool === "table-of-authorities" ? (
    <TableOfAuthoritiesWorkspace
      document={document}
      extractPageTextByPage={extractOpenDocumentPageTextByPage}
      onPrependTable={insertFile}
      onForceOcr={() => requestForceOcr("garbled")}
      onCancel={closeWorkspace}
      onHelpRequested={() => openHelp("table-of-authorities")}
    />
  ) : activeLegalTool === "combine-exhibits" ? (
    <BinderWorkspace
      document={document}
      pdfDocument={pdfDocument}
      onBuildBinder={buildBinder}
      onOpenRequested={openFile}
      onCancel={closeWorkspace}
      onHelpRequested={() => openHelp("combine-exhibits")}
      defaultCoverStyle={filingPreferences.defaultCoverStyle ?? "minimal"}
      onCaptionRequested={() => selectLegalTool("case-caption")}
    />
  ) : activeOrganizeTool === "pages" ? (
    <OrganizeWorkspace
      flow="pages"
      document={document}
      pdfDocument={pdfDocument}
      selectedPageIndexes={selectedPageIndexes}
      onCancel={closeWorkspace}
      onPageSelected={handleThumbnailClick}
      onRotateSelected={rotateSelected}
      onDeleteSelected={deleteSelected}
      onRotatePage={rotatePage}
      onDeletePageRequested={requestDeletePage}
      onMoveSelectedUp={() => moveSelected(-1)}
      onMoveSelectedDown={() => moveSelected(1)}
      onReorderPages={reorderPagesFromGrid}
      onMerge={mergeWithFiles}
      onExtract={extractCurrentPages}
      onSplit={splitAndSavePages}
      onInsert={insertFile}
      delegatedOps={delegatedOrganizeOps}
      onExportPageAsImage={exportPageAsImage}
      onCropResize={cropResize}
      onHelpRequested={() => openHelp("pages")}
      defaultCoverStyle={filingPreferences.defaultCoverStyle ?? "minimal"}
    />
  ) : null;

  const overlay = getFloatingDialog();

  function getFloatingDialog() {
    if (activeTextEdit) {
      return textEdit.phase === "staging" || textEdit.phase === "applying"
        ? null
        : <EditTextReviewDialog textEdit={textEdit} />;
    }

    if (activeLegalTool === "prepare-for-filing") {
      if (isFilingProgressActive(filingProgress.phase)) {
        return null;
      }
      const scopedPrepareConfiguration =
        lastPrepareConfiguration?.openToken === getOpenToken() &&
        lastPrepareConfiguration.generation === document.generation
          ? lastPrepareConfiguration
          : null;

      return (
        <FloatingDialog
          title="Prepare for Filing"
          eyebrow="Legal"
          width="lg"
          onClose={closeWorkspace}
          onHelp={() => openHelp("prepare-for-filing")}
          actions={(
            <FilingOverflowMenu
              onInsertCertificate={() => filingWorkspaceRef.current?.openCertificateOfService()}
            />
          )}
        >
          <PrepareForFilingWorkspace
            key={scopedPrepareConfiguration?.key ?? "prepare-current"}
            ref={filingWorkspaceRef}
            document={document}
            pack={filingPack}
            availablePacks={AVAILABLE_FILING_PACKS}
            prepPlan={filingPrepPlan}
            extraUnavailableSteps={streamedFilingUnavailableSteps}
            courtProfiles={filingPreferences.courtProfiles}
            selectedCourtProfile={selectedCourtProfile}
            facts={filingFacts}
            report={filingReport}
            loadingReport={filingReportLoading}
            reportError={filingReportError}
            progress={filingProgress}
            result={filingResult}
            impact={filingImpact}
            pdfAAvailable={engineBridge.available}
            compressAvailable={engineBridge.available}
            onPackChange={handleFilingPackChange}
            onCourtProfileSelect={handleCourtProfileSelect}
            onCourtProfileSave={handleCourtProfileSave}
            onPrepare={prepareFilingCopy}
            onAddPacketFile={openFilingPacketFile}
            onBuildPacket={buildFilingPacketFromUi}
            packetProgress={filingPacketProgress}
            defaultPacketLayoutMode={filingPreferences.packetLayoutMode}
            defaultPacketPrefixFilenames={filingPreferences.packetPrefixFilenames}
            onPacketPreferencesChange={handlePacketPreferencesChange}
            initialCertificate={scopedPrepareConfiguration?.certificate ?? null}
            initialOptions={scopedPrepareConfiguration?.options ?? null}
            stepDefaultOverrides={filingPreferences.stepDefaultOverridesByPack[baseFilingPack.id]}
            onStepDefaultOverridesChange={handlePrepStepDefaultOverridesChange}
            onDismissImpact={() => setFilingImpact(null)}
            onCompressFirst={compressBeforeFiling}
            onCaptionRequested={() => {
              setActiveLegalTool("case-caption");
            }}
          />
        </FloatingDialog>
      );
    }

    if (activeLegalTool === "batch-cleanup") {
      return (
        <FloatingDialog
          title="Batch Cleanup"
          eyebrow="Legal"
          width="lg"
          onClose={closeWorkspace}
          onHelp={() => openHelp("batch-cleanup")}
        >
          <BatchCleanupWorkspace
            currentFile={currentFileForPathWorkspaces}
            currentFileNotice={currentFileUnsavedNotice}
            packs={AVAILABLE_FILING_PACKS}
            progress={batchCleanupProgress}
            onAddFile={openBatchCleanupFile}
            onRun={buildBatchCleanupFromUi}
            onHelpRequested={() => openHelp("batch-cleanup")}
          />
        </FloatingDialog>
      );
    }

    if (activeLegalTool === "production-set") {
      return (
        <FloatingDialog
          title="Production Set"
          eyebrow="Legal"
          width="lg"
          onClose={closeWorkspace}
          onHelp={() => openHelp("production-set")}
        >
          <ProductionSetWorkspace
            currentFile={currentFileForPathWorkspaces}
            currentFileNotice={currentFileUnsavedNotice}
            currentPageCount={document.pageCount}
            progress={productionProgress}
            onAddFile={openProductionFile}
            onRun={buildProductionSetFromUi}
            onHelpRequested={() => openHelp("production-set")}
          />
        </FloatingDialog>
      );
    }

    if (activeLegalTool === "bates-numbering") {
      return (
        <FloatingDialog title="Bates Numbering" eyebrow="Legal" onClose={closeWorkspace} onHelp={() => openHelp("bates-numbering")}>
          <BatesPanel
            state={batesState}
            hasDocument={Boolean(document.bytes) || pathOpsGrant !== null}
            pageCount={document.pageCount}
            onApply={applyBates}
          />
        </FloatingDialog>
      );
    }

    if (activeLegalTool === "scrub-metadata") {
      return (
        <FloatingDialog title="Scrub Metadata" eyebrow="Legal" onClose={closeWorkspace} onHelp={() => openHelp("scrub-metadata")}>
          <ScrubMetadataPanel
            state={scrubMetadataPanel}
            hasDocument={Boolean(document.bytes)}
            onScrub={scrubDocumentMetadata}
          />
        </FloatingDialog>
      );
    }

    if (activeLegalTool === "sanitize") {
      return (
        <FloatingDialog title="Sanitize" eyebrow="Legal" onClose={closeWorkspace} onHelp={() => openHelp("sanitize")}>
          <SanitizePanel
            hasDocument={Boolean(document.bytes || pathOpsGrant)}
            available={document.bytes ? engineBridge.available : pathOpsGrant !== null}
            status={sidecarStatus}
            onSanitize={sanitizeDocument}
          />
        </FloatingDialog>
      );
    }

    if (activeLegalTool === "passwords") {
      return (
        <FloatingDialog title="Passwords" eyebrow="Legal" onClose={closeWorkspace} onHelp={() => openHelp("passwords")}>
          <PasswordsPanel />
        </FloatingDialog>
      );
    }

    if (activeOrganizeTool === "repair") {
      return (
        <FloatingDialog title="Repair" eyebrow="Organize" onClose={closeWorkspace} onHelp={() => openHelp("repair")}>
          <RepairPanel
            hasSource={Boolean(repairCandidate || document.bytes || pathOpsGrant)}
            available={repairCandidate || document.bytes ? engineBridge.available : pathOpsGrant !== null}
            candidateName={repairCandidate?.name ?? document.fileName}
            status={sidecarStatus}
            onRepair={repairDocument}
          />
        </FloatingDialog>
      );
    }

    if (activeOrganizeTool === "insert-images") {
      return (
        <FloatingDialog title="Insert Images as Pages" eyebrow="Organize" onClose={closeWorkspace} onHelp={() => openHelp("insert-images")}>
          <InsertImagesPanel
            hasDocument={Boolean(document.bytes)}
            status={sidecarStatus}
            onInsert={insertImageFilesAsPages}
          />
        </FloatingDialog>
      );
    }

    if (activeOrganizeTool === "properties") {
      return (
        <FloatingDialog title="Document Properties" eyebrow="Organize" onClose={closeWorkspace} onHelp={() => openHelp("properties")}>
          <DocumentPropertiesPanel
            document={document}
            metadata={metadataSummary}
          />
        </FloatingDialog>
      );
    }

    if (activeOrganizeTool === "pdf-to-word") {
      return (
        <FloatingDialog title="PDF -> Word" eyebrow="Organize" onClose={closeWorkspace} onHelp={() => openHelp("pdf-to-word")}>
          <PdfToWordPanel
            status={wordReflowStatus}
            onConvert={runStandalonePdfToWord}
          />
        </FloatingDialog>
      );
    }

    if (activeOrganizeTool === "merge" || activeOrganizeTool === "insert" || activeOrganizeTool === "crop") {
      return (
        <FloatingDialog
          title={getOrganizeDialogTitle(activeOrganizeTool)}
          eyebrow="Organize"
          onClose={closeWorkspace}
          onHelp={() => openHelp(activeOrganizeTool)}
        >
          <OrganizeWorkspace
            flow={activeOrganizeTool as OrganizeFlowId}
            document={document}
            onCancel={closeWorkspace}
            onMerge={mergeWithFiles}
            onExtract={extractCurrentPages}
            onSplit={splitAndSavePages}
            onInsert={insertFile}
            delegatedOps={delegatedOrganizeOps}
            onCropResize={cropResize}
            onHelpRequested={() => openHelp(activeOrganizeTool)}
            defaultCoverStyle={filingPreferences.defaultCoverStyle ?? "minimal"}
          />
        </FloatingDialog>
      );
    }

    return null;
  }

  return (
    <>
      {PACK_INTEGRITY_BANNER ? (
        <div role="alert" className="pack-integrity-banner">
          {PACK_INTEGRITY_BANNER}
        </div>
      ) : null}
      <AppShell
        document={document}
        tabs={documentTabs.map((tab) => ({
          id: tab.id,
          fileName: tab.document.fileName ?? "Untitled.pdf",
          dirty: tab.document.dirty,
          active: tab.id === activeTabId,
          canMoveToNewWindow: Boolean(tab.document.filePath),
        }))}
        onTabSelected={handleTabSelected}
        onTabCloseRequested={requestTabClose}
        onTabMoveToNewWindowRequested={requestTabMoveToNewWindow}
        pdfDocument={pdfDocument}
        documentSearch={documentSearch}
        pageScrollIntent={pageScrollIntent}
        onVisiblePageChange={syncVisiblePage}
        selectedPageIndexes={selectedPageIndexes}
        onOpenRequested={openFile}
        onFileDropped={openDroppedFile}
        onSave={save}
        onPrint={printDocument}
        onPreviousPage={() => setCurrentPage(document.currentPage - 1)}
        onNextPage={() => setCurrentPage(document.currentPage + 1)}
        onGoToPage={setCurrentPage}
        onZoomOut={() => setZoom(document.zoom - ZOOM_STEP)}
        onZoomIn={() => setZoom(document.zoom + ZOOM_STEP)}
        onFitZoomResolved={setFitZoom}
        onPageSizeChange={setPageSizeInches}
        onRenderError={setError}
        onThumbnailClick={handleThumbnailClick}
        onRotateSelected={rotateSelected}
        onRotateLeft={rotateSelectedLeft}
        onRotateRight={rotateSelectedRight}
        onDeleteSelected={deleteSelected}
        onMoveSelectedUp={() => moveSelected(-1)}
        onMoveSelectedDown={() => moveSelected(1)}
        onBookmarkNavigate={handleBookmarkNavigate}
        onOutlineChange={replaceOutline}
        ocrState={ocrState}
        ocrAvailable={engineBridge.ocrAvailable}
        wordAvailable={wordAvailable}
        ocrStarting={forceOcrConfirmation ? false : engineBridge.starting}
        documentBanner={<DocumentBanner notice={document.signatureInvalidationNotice} />}
        workspace={workspace}
        overlay={overlay}
        processLoader={
          activeLongProcess ? (
            <DockedProcessLoader {...activeLongProcess.loader} />
          ) : null
        }
        longProcessLockoutLabel={longProcessLockoutLabel}
        updateSlot={
          <UpdatePill
            status={updateStatus}
            onDownload={() => {
              void handleDownloadUpdate();
            }}
            onInstall={() => {
              void handleInstallUpdate();
            }}
            onRelaunch={handleRelaunchForUpdate}
          />
        }
        activeLegalTool={activeLegalTool}
        activeTextEdit={activeTextEdit}
        activeEditDialogTool={activeEditDialogTool}
        activeOrganizeTool={activeOrganizeTool}
        onEditDialogToolSelected={selectEditDialogTool}
        onTextEditSelected={requestTextEditMode}
        onLegalToolSelected={selectLegalTool}
        onOrganizeToolSelected={selectOrganizeTool}
        onMakeSearchable={makeSearchable}
        onForceOcr={() => requestForceOcr("manual")}
        pageCount={document.pageCount}
        sidecarStatus={sidecarStatus}
        onApplyPageNumbers={applyPageNumbers}
        onApplyWatermark={applyWatermark}
        compressAvailable={engineBridge.available}
        onCompress={compressDocument}
        redaction={redactionPanel}
        textEdit={textEdit}
        scanner={scannerState}
        pendingRedactions={pendingRedactions}
        modeBar={modeBar}
        editing={editingForShell}
        onRedactionAreaCreated={addPendingRedaction}
        onRedactionAreaRemoved={removePendingRedaction}
        onConfirmRedactions={confirmRedactions}
        onCancelRedactions={cancelRedactions}
        onRunScanner={runScanner}
        onMarkScannerHit={markScannerHit}
        onOpenAbout={openAboutMacrify}
        onHelpRequested={openHelp}
        onConnectToAi={openConnectToAi}
        onMenuCommand={handleNativeMenuCommand}
        printMarkupAnnotations={printMarkupAnnotations}
        onPrintMarkupAnnotationsChange={setPrintMarkupAnnotations}
        onFlattenMarkupAnnotations={flattenCurrentMarkup}
        markupAnnotationMessage={markupAnnotationMessage}
      />
      {forceOcrConfirmation ? (
        <ForceOcrConfirmationDialog
          reason={forceOcrConfirmation}
          onConfirm={confirmForceOcr}
          onCancel={() => setForceOcrConfirmation(null)}
        />
      ) : null}
      {isOcrDialogPhase(ocrState.phase) ? (
        <OcrDialog
          phase={ocrState.phase}
          pageCount={document.pageCount}
          progress={ocrState.progress ?? null}
          errorMessage={ocrState.message}
          onConfirm={confirmOcrDialog}
          onCancel={cancelOcrDialog}
        />
      ) : null}
      {pageDeleteConfirmation ? (
        <DeletePagesConfirmationDialog
          pageCount={pageDeleteConfirmation.length}
          onConfirm={confirmDeletePagesRequest}
          onCancel={cancelDeletePagesRequest}
        />
      ) : null}
      {passwordPrompt ? (
        <PasswordDialog
          fileName={passwordPrompt.fileName}
          phase={passwordPrompt.phase}
          error={passwordPrompt.error}
          onSubmit={submitPassword}
          onCancel={cancelPasswordPrompt}
        />
      ) : null}
      {printDialogOpen && pathOpsGrant ? (
        <PrintDialog
          grant={pathOpsGrant}
          pageCount={document.pageCount}
          fileName={document.fileName}
          onClose={() => setPrintDialogOpen(false)}
          onUseRangeFallback={() => {
            setPrintDialogOpen(false);
            setPrintRangePrompt({ value: "", message: null, running: false });
          }}
        />
      ) : null}
      {printRangePrompt ? (
        <FloatingDialog title="Print a Page Range" eyebrow="Print" onClose={cancelPrintRangePrompt}>
          <PrintRangePanel
            pageCount={document.pageCount}
            running={printRangePrompt.running}
            message={printRangePrompt.message}
            onSubmit={submitPrintRange}
            onCancel={cancelPrintRangePrompt}
          />
        </FloatingDialog>
      ) : null}
      {helpOpen ? (
        <HelpPanel
          initialArticleId={helpArticleId}
          onClose={() => setHelpOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          onClose={() => {
            setSettingsOpen(false);
            setSettingsFocusSection(null);
          }}
          mcpEnabled={mcpEnabled}
          onToggleMcpEnabled={handleToggleMcpEnabled}
          mcpPath={mcpPath}
          focusSection={settingsFocusSection}
          onFocusSectionHandled={() => setSettingsFocusSection(null)}
          mcpStatus={mcpStatus}
          diagnosticsStatus={diagnosticsStatus}
          onExportDiagnostics={handleExportDiagnostics}
          updateStatus={updateStatus}
          defaultCoverStyle={filingPreferences.defaultCoverStyle ?? "minimal"}
          onDefaultCoverStyleChange={handleDefaultCoverStyleChange}
          onCheckForUpdates={() => {
            void handleCheckForUpdates("manual");
          }}
          onDownloadUpdate={() => {
            void handleDownloadUpdate();
          }}
          onInstallUpdate={() => {
            void handleInstallUpdate();
          }}
          onRelaunchForUpdate={handleRelaunchForUpdate}
        />
      ) : null}
      <CrashReportDialog
        payload={crashReportPayload}
        onSaveReport={handleSaveCrashReport}
        onOpenGitHubIssue={handleOpenCrashReportIssue}
        isOpening={isOpeningCrashReportIssue}
        openStatus={crashReportOpenStatus}
        onNotNow={() => {
          setCrashReportPayload(null);
          setCrashReportOpenStatus(null);
        }}
        onNeverAsk={handleNeverAskCrashReport}
      />
      <SignatureUnlockModal
        prompt={signatureUnlockPrompt}
        onCancel={() => answerSignatureUnlockPrompt(false)}
        onContinue={() => answerSignatureUnlockPrompt(true)}
      />
      {textEditAnnotationPrompt ? (
        <FloatingDialog
          title="Pending annotations"
          eyebrow="Find & Replace"
          width="sm"
          onClose={() => setTextEditAnnotationPrompt(false)}
        >
          <div className="tool-panel__inline-card">
            <p className="tool-panel__card-copy">
              Save or discard pending annotation edits before editing document text.
            </p>
            <div className="tool-panel__button-row">
              <button
                type="button"
                className="tool-panel__primary-button"
                onClick={() => {
                  void saveAnnotationsAndEnterTextEdit();
                }}
              >
                Save annotations
              </button>
              <button
                type="button"
                className="tool-panel__secondary-button"
                onClick={discardAnnotationsAndEnterTextEdit}
              >
                Discard
              </button>
              <button
                type="button"
                className="tool-panel__secondary-button"
                onClick={() => setTextEditAnnotationPrompt(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </FloatingDialog>
      ) : null}
    </>
  );
}

function RedactionModeBar({
  pendingCount,
  searchOpen,
  searchText,
  applying,
  onSearchOpen,
  onSearchTextChange,
  onSearchSubmit,
  onApply,
  onExit,
}: {
  pendingCount: number;
  searchOpen: boolean;
  searchText: string;
  applying: boolean;
  onSearchOpen: () => void;
  onSearchTextChange: (text: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onApply: () => void;
  onExit: () => void;
}) {
  return (
    <div className="legal-mode-bar" role="toolbar" aria-label="Redaction mode">
      <span className="legal-mode-bar__status">
        Redaction mode — {pendingCount} {pendingCount === 1 ? "area" : "areas"} marked
      </span>
      {searchOpen ? (
        <form className="legal-mode-bar__search" onSubmit={onSearchSubmit}>
          <SearchIcon size={13} />
          <input
            type="search"
            placeholder="Search text..."
            aria-label="Search text to redact"
            value={searchText}
            onChange={(event) => onSearchTextChange(event.target.value)}
          />
        </form>
      ) : (
        <button type="button" className="legal-mode-bar__button" onClick={onSearchOpen}>
          Search text...
        </button>
      )}
      <button
        type="button"
        className="legal-mode-bar__danger-button"
        disabled={pendingCount === 0 || applying}
        onClick={onApply}
      >
        Apply Redactions
      </button>
      <button type="button" className="legal-mode-bar__button" onClick={onExit}>
        Exit
      </button>
    </div>
  );
}

function batchCleanupCompletionMessage(files: readonly {
  signatureInvalidated?: boolean | undefined;
}[]): string {
  const invalidatedCount = files.filter((file) => file.signatureInvalidated).length;

  if (invalidatedCount === 0) {
    return `Batch cleanup finished for ${files.length} file(s).`;
  }

  return `Batch cleanup finished for ${files.length} file(s). ${invalidatedCount} had digital signatures invalidated.`;
}

/**
 * Streamed-mode gate list for the legal tool group [R1-2]: the 2.425 scanner
 * (proxy-based, user-initiated) and the static Passwords panel are always
 * open; the delegated set opens when the document has a shell grant for the
 * PathOpsEngine (Prepare for Filing runs the reduced path pipeline; Batch
 * Cleanup and Production Set are path-based package flows; Redact, Sanitize,
 * and Bates Numbering run file-to-file).
 */
const STREAMED_LEGAL_TOOLS_ALWAYS: readonly LegalToolId[] = ["case-caption", "scanner-2425", "passwords"];
const STREAMED_LEGAL_TOOLS_DELEGATED: readonly LegalToolId[] = [
  "prepare-for-filing",
  "batch-cleanup",
  "production-set",
  "combine-exhibits",
  "redact",
  "sanitize",
  "bates-numbering",
];

function isStreamedLegalToolAvailable(
  toolId: LegalToolId,
  delegated: boolean,
  status: PathOpsStatus | null = null,
  sizeBytes: number | null = null,
): boolean {
  if (STREAMED_LEGAL_TOOLS_ALWAYS.includes(toolId)) {
    return true;
  }
  if (!delegated || !STREAMED_LEGAL_TOOLS_DELEGATED.includes(toolId)) {
    return false;
  }
  if (toolId === "combine-exhibits") {
    return isPathOpAvailableForInput(status, "build_binder", sizeBytes);
  }
  return true;
}

function streamedLegalToolGateMessage(
  toolId: LegalToolId,
  status: PathOpsStatus | null,
  sizeBytes: number | null,
): string {
  if (toolId === "combine-exhibits") {
    return streamedBinderGateMessage(status, sizeBytes);
  }
  return STREAMED_DOCUMENT_GATE_MESSAGE;
}

function streamedBinderGateMessage(status: PathOpsStatus | null, sizeBytes: number | null): string {
  if (status === null) {
    return "Combine with Exhibits for this large document is still starting. Try again in a moment.";
  }
  const entry = pathOpStatusEntry(status, "build_binder");
  if (!entry?.available) {
    return "Combining large documents into an exhibit binder isn't available in this version of RaioPDF. Reinstalling the latest version may add it.";
  }
  if (entry.maxInputBytes !== null && sizeBytes !== null && sizeBytes > entry.maxInputBytes) {
    return `Combine with Exhibits can process large main PDFs up to ${formatBytes(entry.maxInputBytes)}. This document is ${formatBytes(sizeBytes)}.`;
  }
  return STREAMED_DOCUMENT_GATE_MESSAGE;
}

function streamedEditingGateMessage(
  status: PathOpsStatus | null,
  sizeBytes: number | null,
  hasGrant: boolean,
): string {
  if (!hasGrant) {
    return STREAMED_DOCUMENT_GATE_MESSAGE;
  }
  if (status === null) {
    return "Editing for this large document is still starting. Try again in a moment.";
  }
  const entry = pathOpStatusEntry(status, "apply_edits");
  if (!entry?.available) {
    return "Editing very large documents isn't available in this version of RaioPDF. Reinstalling the latest version may add it.";
  }
  if (entry.maxInputBytes !== null && sizeBytes !== null && sizeBytes > entry.maxInputBytes) {
    return `Editing large documents supports PDFs up to ${formatBytes(entry.maxInputBytes)}. This document is ${formatBytes(sizeBytes)}.`;
  }
  return STREAMED_DOCUMENT_GATE_MESSAGE;
}

function planHasFormValues(edits: readonly PdfEdit[]): boolean {
  return edits.some((edit) => edit.type === "formValues");
}

/** Per-area pass/fail rendering for the delegated redaction's verification.
 * Reaching this at all means every area verified (fail-closed contract) —
 * the message still names the count and pages so the pass/fail state per
 * area is visible, not implied. */
function formatStreamedRedactionSuccess(verification: PathOpsRedactionVerification): string {
  const passed = verification.areas.filter((area) => area.pass);
  const pages = [...new Set(passed.map((area) => area.pageIndex + 1))].sort(
    (left, right) => left - right,
  );
  const areaCount = verification.areas.length;

  return (
    `Redacted and verified in the output file: ${passed.length} of ${areaCount} ` +
    `${areaCount === 1 ? "area" : "areas"} verified clean` +
    (pages.length > 0 ? ` (page${pages.length === 1 ? "" : "s"} ${pages.join(", ")})` : "") +
    ". Redacted pages were turned into images to guarantee the text is gone — run Make Searchable if you need to search them again. " +
    "Your original file is untouched; the redacted copy opened as a new document, use Save As to keep it."
  );
}

function PrintRangePanel({
  pageCount,
  running,
  message,
  onSubmit,
  onCancel,
}: {
  pageCount: number;
  running: boolean;
  message: string | null;
  onSubmit: (rangeInput: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");

  return (
    <div className="tool-panel__inline-card">
      <p className="tool-panel__note">
        Whole-document printing isn't available for very large files. Enter a
        page range — those pages open as a small document, then press Print
        once they appear.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <div className="tool-panel__field">
          <label htmlFor="print-range-pages">Pages (1-{Math.max(pageCount, 1)})</label>
          <input
            id="print-range-pages"
            autoFocus
            inputMode="numeric"
            placeholder="e.g. 1-5, 12"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        {message ? (
          <p className="tool-panel__status-line" role="status">{message}</p>
        ) : null}
        <button
          type="submit"
          className="tool-panel__primary-button"
          disabled={running || !value.trim()}
        >
          {running ? "Extracting pages..." : "Open Pages for Printing"}
        </button>
        <button type="button" className="tool-panel__secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </form>
    </div>
  );
}

function SanitizePanel({
  hasDocument,
  available,
  status,
  onSanitize,
}: {
  hasDocument: boolean;
  available: boolean;
  status: SidecarStatus;
  onSanitize: () => Promise<boolean>;
}) {
  return (
    <div className="tool-panel__inline-card">
      {!available ? <DesktopCapabilityMessage /> : null}
      <p className="tool-panel__note">Removes JavaScript, embedded files, and external links.</p>
      {status.removed.length ? (
        <p className="tool-panel__status-line" data-tone="ok">
          Removed {status.removed.map(formatSanitizeItem).join(", ")}.
        </p>
      ) : null}
      <SidecarStatusLine status={status} label="Sanitizing PDF" />
      <button type="button" className="tool-panel__primary-button" disabled={!hasDocument || !available || status.running} onClick={() => void onSanitize()}>
        Sanitize PDF
      </button>
    </div>
  );
}

function PdfToWordPanel({
  status,
  onConvert,
}: {
  status: WordReflowStatus;
  onConvert: () => void;
}) {
  return (
    <div className="tool-panel__inline-card">
      <p className="tool-panel__card-copy">{WORD_REFLOW_EXPERIMENTAL_LABEL}</p>
      <button
        type="button"
        className="tool-panel__primary-button"
        disabled={status.running}
        onClick={onConvert}
      >
        Choose PDF & Convert
      </button>
      {status.message ? (
        <p
          className={status.tone === "danger" ? "tool-panel__field-error" : "tool-panel__status-line"}
          role="status"
        >
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

function RepairPanel({
  hasSource,
  available,
  candidateName,
  status,
  onRepair,
}: {
  hasSource: boolean;
  available: boolean;
  candidateName: string | null | undefined;
  status: SidecarStatus;
  onRepair: () => Promise<boolean>;
}) {
  return (
    <div className="tool-panel__inline-card">
      {!available ? <DesktopCapabilityMessage /> : null}
      <p className="tool-panel__note">{candidateName ?? "No PDF selected"}</p>
      {status.beforeBytes !== null && status.afterBytes !== null ? (
        <p className="tool-panel__status-line">
          {formatBytes(status.beforeBytes)} to {formatBytes(status.afterBytes)}
        </p>
      ) : null}
      <SidecarStatusLine status={status} label="Repairing PDF" />
      <button type="button" className="tool-panel__primary-button" disabled={!hasSource || !available || status.running} onClick={() => void onRepair()}>
        Repair PDF
      </button>
    </div>
  );
}

function InsertImagesPanel({
  hasDocument,
  status,
  onInsert,
}: {
  hasDocument: boolean;
  status: SidecarStatus;
  onInsert: (files: readonly File[]) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<readonly File[]>([]);

  async function submit() {
    await onInsert(selected);
  }

  return (
    <div className="tool-panel__inline-card">
      <div className="tool-panel__field">
        <label htmlFor="insert-image-pages">Images</label>
        <input
          id="insert-image-pages"
          type="file"
          accept="image/png,image/jpeg"
          multiple
          onChange={(event: ChangeEvent<HTMLInputElement>) => setSelected(Array.from(event.target.files ?? []))}
        />
      </div>
      {selected.length ? <p className="tool-panel__status-line">{selected.length} selected.</p> : null}
      <SidecarStatusLine status={status} label="Inserting images" />
      <button type="button" className="tool-panel__primary-button" disabled={!hasDocument || selected.length === 0 || status.running} onClick={() => void submit()}>
        Insert Images
      </button>
    </div>
  );
}

function DocumentPropertiesPanel({
  document,
  metadata,
}: {
  document: DocumentState;
  metadata: PdfMetadataSummary | null;
}) {
  const rows = [
    ...(metadata?.rows ?? []),
    { label: "Pages", value: String(document.pageCount || "Not set") },
    { label: "Page size", value: document.pageSizeInches ? `${document.pageSizeInches.width} x ${document.pageSizeInches.height} in` : "Not set" },
    { label: "File size", value: document.fileSizeBytes ? formatBytes(document.fileSizeBytes) : "Not set" },
    // Streamed docs opened successfully through pdf.js without a password,
    // but the deep pdf-lib inspection never ran -- show the honest gap.
    { label: "Encryption", value: document.bytes ? "Not encrypted" : document.source ? "—" : "Not set" },
    { label: "Searchable", value: describeTextLayerStatus(deriveTextLayerStatus(document.textLayerCoverage)) },
  ];

  return (
    <div className="tool-panel__inline-card">
      <table className="tool-panel__metadata-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function reopenFilingHandle(
  engine: LocalPdfEngine,
  closeHandles: PdfDocumentHandle[],
  bytes: Uint8Array,
): Promise<PdfDocumentHandle> {
  const handle = await engine.open(bytes);
  closeHandles.push(handle);
  return handle;
}

function filingPreflightUnavailableReport(): PreflightReport {
  return {
    checks: [
      {
        checkId: "final-preflight",
        label: "Final output preflight",
        authority: "RaioPDF local verification",
        detail: "The filing output was saved, but Raio could not compute the final preflight report.",
        kind: "rule",
        status: "unknown",
      },
    ],
  };
}

function skippedPrepSteps(
  plan: readonly PrepPlanStep[],
  selectedSteps: ReadonlySet<PrepPlanStepId>,
): readonly string[] {
  return plan
    .filter((step) => step.defaultChecked && !selectedSteps.has(step.id))
    .map((step) => `${step.label} skipped`);
}

function filingRunOverrides({
  customSplitBytes,
  packDefaultSplitBytes,
  scrubbedBeforePdfA,
}: {
  customSplitBytes: number | null;
  packDefaultSplitBytes: number | null;
  scrubbedBeforePdfA: boolean;
}): readonly string[] {
  const overrides: string[] = [];

  if (customSplitBytes !== null) {
    const defaultText = packDefaultSplitBytes === null
      ? "no pack default"
      : `pack default ${formatMegabytes(packDefaultSplitBytes)}`;
    overrides.push(`user set split cap ${formatMegabytes(customSplitBytes)} (${defaultText})`);
  }

  if (scrubbedBeforePdfA) {
    overrides.push("hidden info was removed first so the PDF/A archival format could be written correctly");
  }

  return overrides;
}

function applyCourtProfile(
  pack: JurisdictionPack,
  profile: CourtProfile | null,
): JurisdictionPack {
  if (!profile || profile.packId !== pack.id) {
    return pack;
  }

  return {
    ...pack,
    maxFileBytes: profile.maxFileBytes,
    recommendedMaxFileBytes: profile.maxFileBytes,
  };
}

function emptyDocumentFacts(document: DocumentState): DocumentFacts {
  return {
    pages: [],
    ...(document.fileName ? { filename: document.fileName } : {}),
    ...(document.fileSizeBytes !== null ? { fileBytes: document.fileSizeBytes } : {}),
    ...(document.textLayerCoverage
      ? {
          textLayerCoverage: document.textLayerCoverage,
          searchableText: document.textLayerCoverage.imageOnlyPages.length === 0 &&
            document.textLayerCoverage.garbledPages.length === 0 &&
            (document.textLayerCoverage.trivialTextImagePages?.length ?? 0) === 0,
        }
      : {}),
  };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

// Keyed on bytes identity; populated as a side effect of readFilingFacts (the filing
// dialog's report pass) so the Prepare click usually finds it warm.
const conversionImpactCache = new WeakMap<Uint8Array, PdfAConversionImpact>();

async function getCachedConversionImpact(
  bytes: Uint8Array,
): Promise<PdfAConversionImpact | null> {
  const cached = conversionImpactCache.get(bytes);

  if (cached) {
    return cached;
  }

  try {
    const impact = await assessPdfAConversionImpactFromBytes(bytes);
    conversionImpactCache.set(bytes, impact);
    return impact;
  } catch {
    return null;
  }
}

function getCachedFilingFacts(
  cacheRef: { current: FilingFactsCache },
  bytes: Uint8Array,
  options: FilingFactsOptions,
): Promise<DocumentFacts> {
  const key = filingFactsCacheKey(options);
  let factsForBytes = cacheRef.current.byBytes.get(bytes);

  if (!factsForBytes) {
    factsForBytes = new Map();
    cacheRef.current.byBytes.set(bytes, factsForBytes);
  }

  const cached = factsForBytes.get(key);

  if (cached) {
    return cached;
  }

  const facts = readFilingFacts(bytes, options);
  factsForBytes.set(key, facts);
  return facts;
}

function filingFactsCacheKey(options: FilingFactsOptions): string {
  return JSON.stringify({
    fileBytes: options.fileBytes,
    filename: options.filename ?? null,
    pdfaClaimed: options.pdfaClaimed ?? null,
    pdfaCompliant: options.pdfaCompliant ?? null,
    occupiedRegionPages: options.occupiedRegionPages ?? "all",
  });
}

async function readFilingFacts(
  bytes: Uint8Array,
  options: FilingFactsOptions,
): Promise<DocumentFacts> {
  const sharedFacts = await buildDocumentFacts(bytes, {
    textExtractor: createUiDocumentFactsTextExtractor(options.pdfDocument ?? null),
  });
  const facts: DocumentFacts = {
    ...sharedFacts,
    fileBytes: options.fileBytes,
    ...(options.filename ? { filename: options.filename } : {}),
  };

  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    // Piggyback on this parse: cache what a PDF/A conversion of these bytes would
    // destroy, so the Prepare click's impact gate doesn't need a parse of its own.
    conversionImpactCache.set(bytes, assessPdfAConversionImpact(pdf));

    // A PDF/A conformance claim requires an XMP pdfaid identification. The claim
    // itself is only what the document reports; validator-backed compliance is
    // a separate fact and should not be inferred here.
    facts.pdfaClaimed = options.pdfaClaimed ?? (readPdfAIdentification(pdf) !== null);
    if (options.pdfaCompliant !== undefined) {
      facts.pdfaCompliant = options.pdfaCompliant;
    }
  } catch {
    if (options.pdfaClaimed !== undefined) {
      facts.pdfaClaimed = options.pdfaClaimed;
    }
    if (options.pdfaCompliant !== undefined) {
      facts.pdfaCompliant = options.pdfaCompliant;
    }
  }

  const occupiedRegionPageIndexes = options.occupiedRegionPages === "first" && facts.pages.length > 0
    ? [0]
    : undefined;
  let pageOccupiedRegions = new Map<number, RectInches[]>();
  if (facts.pages.length > 0) {
    try {
      pageOccupiedRegions = await readOccupiedRegions(
        bytes,
        options.pdfDocument ?? null,
        occupiedRegionPageIndexes,
      );
    } catch {
      pageOccupiedRegions = new Map();
    }
  }
  // Page-body text only, and every page must have it — one text page must not
  // make an otherwise image-only scan look searchable. Only used as a fallback
  // when the shared text-layer detector above couldn't determine searchability.
  const hasExtractedTextOnEveryPage = facts.pages.length > 0
    && facts.pages.every((page) => (pageOccupiedRegions.get(page.pageIndex)?.length ?? 0) > 0);

  if (pageOccupiedRegions.size > 0) {
    facts.pages = facts.pages.map((page) => {
      const occupiedRegions = pageOccupiedRegions.get(page.pageIndex);
      return occupiedRegions ? { ...page, occupiedRegions } : page;
    });
  }

  if (facts.searchableText === undefined) {
    facts.searchableText = hasExtractedTextOnEveryPage;
  }

  if (pageOccupiedRegions.has(0)) {
    facts.clerkStampSpaceBlank = !pageOccupiedRegions
      .get(0)!
      .some((region) => intersects(region, FLORIDA_PACK.clerkStampSpace.firstPage));
  }

  return facts;
}

function createUiDocumentFactsTextExtractor(
  currentPdfDocument: PDFDocumentProxy | null,
): DocumentFactsTextExtractor {
  return {
    extractTextLayerCoverage: (bytes) => inspectTextLayer(bytes, currentPdfDocument),
    extractPageTextByPage: (bytes) => extractUiPageTextByPage(bytes, currentPdfDocument),
  };
}

async function withPdfDocument<T>(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null,
  read: (pdfDocument: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  if (currentPdfDocument) {
    return read(currentPdfDocument);
  }

  const pdfDocument = await loadPdfDocument(bytes);
  try {
    return await read(pdfDocument);
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

async function extractUiPageTextByPage(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null,
): Promise<readonly { pageIndex: number; text: string }[]> {
  return withPdfDocument(bytes, currentPdfDocument, async (pdfDocument) => {
    const pages: { pageIndex: number; text: string }[] = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({
        pageIndex: pageNumber - 1,
        text: content.items.map(textItemString).join(" "),
      });
    }

    return pages;
  });
}

function textItemString(item: unknown): string {
  if (typeof item !== "object" || item === null || !("str" in item)) {
    return "";
  }

  const { str } = item as { str?: unknown };
  return typeof str === "string" ? str : "";
}

async function readOccupiedRegions(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null,
  pageIndexes?: readonly number[],
): Promise<Map<number, RectInches[]>> {
  let loadedDocument: PDFDocumentProxy | null = null;
  const pdfDocument = currentPdfDocument ?? await loadPdfDocument(bytes);

  if (!currentPdfDocument) {
    loadedDocument = pdfDocument;
  }

  try {
    const boxes = await extractTextBoxes(
      { bytes, pdfDocument },
      pageIndexes ? { pageIndexes } : undefined,
    );

    if (boxes.length === 0) {
      return new Map();
    }

    const regions = new Map<number, RectInches[]>();

    for (let pageIndex = 0; pageIndex < pdfDocument.numPages; pageIndex += 1) {
      regions.set(pageIndex, []);
    }

    for (const box of boxes) {
      const pageRegions = regions.get(box.pageIndex);

      if (!pageRegions) {
        continue;
      }

      pageRegions.push({
        x: box.area.x / POINTS_PER_INCH,
        y: box.area.y / POINTS_PER_INCH,
        w: box.area.w / POINTS_PER_INCH,
        h: box.area.h / POINTS_PER_INCH,
      });
    }

    return regions;
  } catch {
    return new Map();
  } finally {
    await loadedDocument?.loadingTask.destroy();
  }
}

function runFilingPreflight(
  facts: DocumentFacts,
  pack: JurisdictionPack,
  selection?: SelectionFacts,
): PreflightReport {
  window.__RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__ =
    (window.__RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__ ?? 0) + 1;

  return preflight(facts, pack, selection);
}

function formatRedactionVerificationSuccess(result: RedactionVerificationResult): string {
  const textLayer = result.textLayer.status === "pass"
    ? "hidden text confirmed removed"
    : "no source text was extractable from marked areas";

  return (
    [
      `Redacted and verified: ${textLayer}`,
      "redacted page images replaced",
      "annotations cleaned",
      "metadata scrubbed",
    ].join("; ") +
    ". Your original file is untouched — Save will prompt you for a new file name."
  );
}

function formatRedactionVerificationFailure(result: RedactionVerificationResult): string {
  const failedChecks = [
    result.textLayer,
    result.rasterizedPages,
    result.annotations,
    result.metadata,
  ].filter((check) => check.status === "fail");

  return `Verification failed: ${failedChecks.map((check) => check.detail).join(" ")}`;
}

function formatFilingOutputName(
  baseName: string,
  pack: JurisdictionPack,
  partNumber: number,
  totalParts: number,
): string {
  if (totalParts === 1) {
    return `${baseName} — filing.pdf`;
  }

  return `${pack.splitNaming
    .replace("{name}", baseName)
    .replace("{n}", String(partNumber))
    .replace("{total}", String(totalParts))}.pdf`;
}

interface SaveBytesPart {
  bytes: Uint8Array;
  fileName: string;
}

interface SaveStreamedPart {
  grant: FileGrant;
  fileName: string;
}

interface MultiPartSaveResult {
  files: Array<SavedFile | null>;
  directoryPath: string | null;
}

async function saveByteOutputParts(
  parts: readonly SaveBytesPart[],
  shouldContinue: () => boolean = () => true,
): Promise<MultiPartSaveResult> {
  const directory = parts.length > 1 ? await filePort.pickDirectory() : null;

  if (directory) {
    return saveByteOutputPartsIntoDirectory(parts, directory, shouldContinue);
  }

  const files: Array<SavedFile | null> = [];

  for (const part of parts) {
    if (!shouldContinue()) {
      break;
    }

    files.push(await filePort.saveFile(part.bytes, part.fileName, null));
  }

  return { files, directoryPath: null };
}

async function saveByteOutputPartsIntoDirectory(
  parts: readonly SaveBytesPart[],
  directory: PickedDirectory,
  shouldContinue: () => boolean,
): Promise<MultiPartSaveResult> {
  const files: Array<SavedFile | null> = [];

  for (const part of parts) {
    if (!shouldContinue()) {
      break;
    }

    files.push(await filePort.saveFileIntoDirectory(part.bytes, part.fileName, directory));
  }

  return { files, directoryPath: directory.path };
}

async function saveStreamedOutputParts(
  parts: readonly SaveStreamedPart[],
  shouldContinue: () => boolean = () => true,
): Promise<MultiPartSaveResult> {
  try {
    const directory = parts.length > 1 ? await filePort.pickDirectory() : null;

    if (directory) {
      return saveStreamedOutputPartsIntoDirectory(parts, directory, shouldContinue);
    }

    const files: Array<SavedFile | null> = [];

    for (const part of parts) {
      if (!shouldContinue()) {
        break;
      }

      files.push(await saveStreamedCopy(
        { kind: "rangeGrant", grant: part.grant },
        part.fileName,
      ));
    }

    return { files, directoryPath: null };
  } finally {
    await releaseStreamedOutputGrants(parts.map((part) => part.grant));
  }
}

async function saveStreamedOutputPartsIntoDirectory(
  parts: readonly SaveStreamedPart[],
  directory: PickedDirectory,
  shouldContinue: () => boolean,
): Promise<MultiPartSaveResult> {
  const files: Array<SavedFile | null> = [];

  for (const part of parts) {
    if (!shouldContinue()) {
      break;
    }

    files.push(await saveStreamedCopyIntoDirectory(
      { kind: "rangeGrant", grant: part.grant },
      part.fileName,
      directory,
    ));
  }

  return { files, directoryPath: directory.path };
}

async function releaseStreamedOutputGrants(grants: readonly FileGrant[]): Promise<void> {
  await Promise.all(grants.map((grant) => pathOpReleaseOutput(grant).catch(() => undefined)));
}

function isSavedFile(file: SavedFile | null): file is SavedFile {
  return file !== null;
}

async function createCertificateOfServicePdf(
  certificate: CertificateOfServiceDraft,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([8.5 * POINTS_PER_INCH, 11 * POINTS_PER_INCH]);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const left = 72;
  let y = 720;
  const lines = [
    certificate.caseCaption.trim() || "Case Caption",
    "",
    "CERTIFICATE OF SERVICE",
    "",
    "I HEREBY CERTIFY that a true and correct copy of the foregoing was furnished",
    `on ${certificate.date || new Date().toISOString().slice(0, 10)} to:`,
    "",
    ...certificate.serviceList.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  ];

  for (const line of lines) {
    page.drawText(line, {
      x: left,
      y,
      size: 12,
      font: line === "CERTIFICATE OF SERVICE" ? boldFont : font,
    });
    y -= line === "" ? 12 : 18;
  }

  page.drawText("Respectfully submitted,", {
    x: left,
    y: 140,
    size: 12,
    font,
  });
  page.drawText("________________________________", {
    x: left,
    y: 96,
    size: 12,
    font,
  });

  return pdf.save();
}

function hasCertificateContent(certificate: CertificateOfServiceDraft): boolean {
  return Boolean(
    certificate.caseCaption.trim() ||
    certificate.serviceList.trim() ||
    certificate.date.trim(),
  );
}

function intersects(a: RectInches, b: RectInches): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function getOrganizeDialogTitle(flow: Exclude<OrganizeFlowId, "pages">): string {
  switch (flow) {
    case "merge":
      return "Merge PDFs";
    case "insert":
      return "Insert from File";
    case "crop":
      return "Crop / Resize";
  }
}

function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}

function formatSplitOutputFileName(baseName: string, partNumber: number, totalParts: number): string {
  if (totalParts === 1) {
    return `${baseName} - split.pdf`;
  }

  return `${baseName} - part ${partNumber} of ${totalParts}.pdf`;
}

function formatSanitizeItem(item: PdfSanitizeRemovedItem): string {
  if (item === "javascript") {
    return "JavaScript";
  }

  if (item === "embedded-files") {
    return "embedded files";
  }

  return "external links";
}

/**
 * Streamed-mode metadata: pdf.js `getMetadata()` on the shared proxy — no
 * pdf-lib, no full-byte parse. Fields the info dictionary doesn't carry
 * render as "—" (a real gap, distinct from "Not set" which means the
 * deep pdf-lib read ran and found nothing).
 */
async function readStreamedMetadataSummary(
  pdfDocument: PDFDocumentProxy,
): Promise<PdfMetadataSummary> {
  const { info } = await pdfDocument.getMetadata();
  const record = info as Record<string, unknown>;
  const stringField = (key: string): string => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value : "—";
  };
  const dateField = (key: string): string => {
    const value = record[key];
    const parsed = typeof value === "string" ? parsePdfDateString(value) : null;
    return parsed
      ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(parsed)
      : "—";
  };

  return {
    rows: [
      { label: "Title", value: stringField("Title") },
      { label: "Author", value: stringField("Author") },
      { label: "Creator", value: stringField("Creator") },
      { label: "Producer", value: stringField("Producer") },
      { label: "Created", value: dateField("CreationDate") },
      { label: "Modified", value: dateField("ModDate") },
      { label: "Custom fields", value: "—" },
    ],
    // Scrub is gated in streamed mode, so the removable-field inventory is
    // never consumed -- and claiming one from a shallow read would overstate
    // what a scrub could verify.
    removedFields: [],
  };
}

/** Minimal `D:YYYYMMDDHHmmSS` parser for pdf.js info-dictionary dates. */
function parsePdfDateString(value: string): Date | null {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month ?? "1") - 1,
    Number(day ?? "1"),
    Number(hour ?? "0"),
    Number(minute ?? "0"),
    Number(second ?? "0"),
  );

  return Number.isNaN(date.getTime()) ? null : date;
}

async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPageCount();
}

async function readImagePageInput(file: File): Promise<PdfImagePageInput> {
  const lowerName = file.name.toLowerCase();
  const format = file.type === "image/jpeg" || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")
    ? "jpeg"
    : "png";

  await waitForTestDelay(window.__RAIOPDF_TEST_INSERT_IMAGE_READ_DELAY_MS__ ?? 0);

  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    format,
  };
}

function waitForTestDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function waitForUiPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame !== "function") {
      window.setTimeout(resolve, 0);
      return;
    }

    window.requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

/**
 * Files opened from the desktop carry an opaque shell-issued grant in their
 * `path` field (never a real filesystem path -- see `filePort.ts` [R1-9]).
 * These path-based workflows (production sets, batch cleanup, filing
 * packets) hand that grant straight to the corresponding Tauri command,
 * which resolves it to a real path itself; the renderer never sees or
 * transmits the resolved path. Files with no grant (e.g. opened in-memory in
 * the browser) can't be used here.
 */
function requireFileGrants(grants: readonly (string | null)[], errorMessage: string): string[] {
  return grants.map((grant) => {
    if (!grant) {
      throw new Error(errorMessage);
    }
    return grant;
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
