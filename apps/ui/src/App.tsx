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
  PdfBatesStampOptions,
  PdfCompressOptions,
  PdfImagePageInput,
  PdfPageNumbersOptions,
  PdfRedactionArea,
  PdfSanitizeRemovedItem,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { LocalPdfEngine } from "@raiopdf/engine-local";
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
} from "@raiopdf/rules";
import { AppShell } from "./components/AppShell";
import { BinderWorkspace } from "./components/BinderWorkspace";
import {
  OrganizeWorkspace,
  type OrganizeFlowId,
} from "./components/OrganizeWorkspace";
import {
  PrepareForFilingWorkspace,
  FilingOverflowMenu,
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
import { FloatingDialog, hasOpenDialogStackEntry } from "./components/FloatingDialog";
import { ForceOcrConfirmationDialog } from "./components/ForceOcrConfirmationDialog";
import { HelpPanel } from "./components/HelpPanel";
import { OcrDialog, type OcrDialogPhase } from "./components/OcrDialog";
import { PasswordDialog, type PasswordDialogPhase } from "./components/PasswordDialog";
import { PrintDialog } from "./components/PrintDialog";
import { SignatureUnlockModal } from "./components/SignatureUnlockModal";
import {
  isEngineBridgeUnavailableError,
  useEngineBridge,
} from "./hooks/useEngineBridge";
import {
  STREAMED_DOCUMENT_GATE_MESSAGE,
  useDocument,
  type DocumentState,
  type SignatureUnlockPrompt,
} from "./hooks/useDocument";
import { useDocumentSearch } from "./hooks/useDocumentSearch";
import { useEditing } from "./hooks/useEditing";
import { toPdfEdits, type EditToolId } from "./lib/edits";
import { isTextEntryTarget } from "./lib/domGuards";
import {
  checkForSignedUpdate,
  installSignedUpdate,
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
import {
  pickFileForAdd,
  tooLargeToAddMessage,
  type FileAddResult,
} from "./lib/readFileForAdd";
import {
  listenOcrProgress,
  newOcrJobToken,
  type OcrProgressEvent,
} from "./lib/ocrProgress";
import {
  isPathOpsRuntime,
  pathOpBatesStamp,
  pathOpCompress,
  pathOpDecrypt,
  pathOpDocumentFacts,
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
  pathOpWatermark,
  pathOpErrorMessage,
  PathOpsError,
  type PathOpsRedactionVerification,
  type PathOpsStatus,
} from "./lib/pathOps";
import { planPathOpReopen } from "./lib/pathOpReopen";
import {
  annotateStreamedPreflight,
  buildPrepareFilingPlan,
  buildStreamedFilingOutputReport,
  buildStreamedUnavailableSteps,
  mapPathOpsFactsToDocumentFacts,
} from "./lib/streamedFiling";
import { extractPrintableRange } from "./lib/printRange";
import {
  looksLikeAbsolutePath,
  resolveDesktopFileGrantPaths,
} from "./lib/localPaths";
import { writeProductionLastUsed } from "./lib/productionHints";
import { resolveProtectedPdfBytes, type ProtectedPdfSource } from "./lib/protectedPdfResolver";
import { formatWorkflowError } from "./lib/userMessages";
import { recordDiagnosticEvent } from "./lib/diagnostics";
import {
  aggregateOutputReports,
  runFilingOutputPreflights,
} from "./lib/filingOutputPreflight";
import { prepareFilingOutputParts } from "./lib/filingOutputParts";
import {
  readFilingPreferences,
  selectCourtProfile,
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
  inspectTextLayer,
  textLayerCoveragePageCount,
} from "./lib/textLayer";
import { countRaioPdfMarkupAnnotations } from "./lib/markupAnnotations";
import { verifyOcrTextLayer } from "./lib/ocrVerification";
import { describeTextLayerStatus, deriveTextLayerStatus } from "./lib/textLayerStatus";
import { extractPageTextForIndexes } from "./lib/pageTextCache";
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
}

function isOcrDialogPhase(phase: OcrPhase): phase is OcrDialogPhase {
  return (
    phase === "confirm" ||
    phase === "starting-engine" ||
    phase === "processing" ||
    phase === "verifying"
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

interface FilingFactsCache {
  byBytes: WeakMap<Uint8Array, Map<string, Promise<DocumentFacts>>>;
}

interface FilingFactsOptions {
  fileBytes: number;
  filename?: string;
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
    buildBinder,
    batesStamp,
    applyEdits,
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
  const editing = useEditing(pdfDocument);
  const overlayDirtyRef = useRef<{ generation: number; marked: boolean } | null>(null);
  const documentSearch = useDocumentSearch({
    pdfDocumentState: currentPdfDocumentState,
    documentGeneration: document.generation,
    textLayerCoverage: document.textLayerCoverage,
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

  useEffect(() => {
    if (editing.pendingEdits.length > 0) {
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
    editing.pendingEdits.length,
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
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>(() => (
    isUpdaterRuntime() ? UPDATE_IDLE_STATUS : UPDATE_UNAVAILABLE_STATUS
  ));
  const updateCheckRequestRef = useRef(0);
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
            setMcpStatus("Connector setting could not be saved. The switch was restored to the saved setting.");
          }
        } catch {
          if (mcpToggleRequestRef.current === requestId) {
            setMcpEnabled(!next);
            setMcpStatus("Connector setting could not be saved. Try again from the desktop app.");
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
  const handleInstallUpdate = useCallback(async () => {
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

    const requestId = updateInstallRequestRef.current + 1;
    updateInstallRequestRef.current = requestId;
    setUpdateStatus({
      phase: "downloading",
      message: `Downloading RaioPDF ${update.version}...`,
      currentVersion: update.currentVersion,
      availableVersion: update.version,
      progress: null,
    });

    try {
      await installSignedUpdate(update, (progress) => {
        if (updateInstallRequestRef.current === requestId) {
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
          message: "Update download or installation failed. Try again from Preferences.",
          currentVersion: update.currentVersion,
          availableVersion: update.version,
        });
      }
    }
  }, [handleCheckForUpdates]);
  const handleRelaunchForUpdate = useCallback(() => {
    void relaunchForInstalledUpdate().catch(() => {
      setUpdateStatus((current) => ({
        ...current,
        phase: "error",
        message: "RaioPDF could not restart automatically. Close and reopen it to finish updating.",
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
    if (!isTauriRuntime()) {
      return null;
    }

    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ path: string } | null>("diagnostics_export_dialog");
    return result?.path ?? null;
  }, []);
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
      const sourcePaths = requireAbsoluteSourcePaths(
        await resolveDesktopFileGrantPaths(input.files.map((file) => file.path)),
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
          const sourcePath = sourcePaths[index];
          if (!sourcePath) {
            throw new Error("Production package output needs PDFs opened from local desktop paths.");
          }

          return {
            path: sourcePath,
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
      const sourcePaths = requireAbsoluteSourcePaths(
        await resolveDesktopFileGrantPaths(input.files.map((file) => file.path)),
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
        inputs: sourcePaths,
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
      const sourcePaths = requireAbsoluteSourcePaths(
        await resolveDesktopFileGrantPaths(input.files.map((file) => file.path)),
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
          const sourcePath = sourcePaths[index];
          if (!sourcePath) {
            throw new Error("Filing packet needs PDFs opened from local desktop paths.");
          }

          return {
            path: sourcePath,
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
  const pendingOcrTypeRef = useRef<OcrType>("skip-text");
  const savingRef = useRef(false);
  const startupFileTakenRef = useRef(false);
  const pendingMoveToNewWindowTabIdRef = useRef<string | null>(null);
  const batesApplyingRef = useRef(false);
  const redactionIdRef = useRef(0);
  const documentGenerationRef = useRef<number>(document.generation);
  const legalStateDocumentGenerationRef = useRef<number>(document.generation);
  const preserveFilingProgressForGenerationRef = useRef<number | null>(null);
  const scannerRunRef = useRef(0);
  const filingRunRef = useRef(0);
  const filingFactsCacheRef = useRef<FilingFactsCache>({
    byBytes: new WeakMap(),
  });
  const nativeMenuCommandRef = useRef<(command: string) => void>(() => {});
  const filingEngine = useMemo(() => new LocalPdfEngine(), []);

  useLayoutEffect(() => {
    documentGenerationRef.current = document.generation;
  }, [document.generation]);

  const resetLegalState = useCallback(() => {
    preserveFilingProgressForGenerationRef.current = null;
    setPendingRedactions([]);
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
    setProductionProgress({ running: false, message: null, result: null });
    setBatchCleanupProgress({ running: false, message: null, result: null });
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
    scannerRunRef.current += 1;
    filingRunRef.current += 1;
    setPendingRedactions([]);
    setScannerState({ scanning: false, message: null, hits: [] });
    setFilingReport(null);
    setFilingReportLoading(false);
    setFilingReportError(null);
    setFilingResult(null);
    setFilingImpact(null);
    setFilingPacketProgress({ running: false, message: null, result: null });
    setProductionProgress({ running: false, message: null, result: null });
    setBatchCleanupProgress({ running: false, message: null, result: null });
    if (!preserveFilingProgress) {
      setFilingProgress({ phase: "idle", message: null });
    }
  }, []);

  const resetVisibleDocumentAppState = useCallback((next: "document" | "empty") => {
    ocrRunRef.current += 1;
    ocrActiveRef.current = false;
    setOcrState({ phase: "idle", message: null });
    setForceOcrConfirmation(null);
    resetLegalState();
    setSelectedPageIndexes(next === "document" ? new Set([0]) : new Set());
    setPageDeleteConfirmation(null);
    setPasswordPrompt(null);
    setRepairCandidate(null);
  }, [resetLegalState]);

  const handleTabSelected = useCallback((tabId: string) => {
    if (tabId === activeTabId) {
      return;
    }

    if (switchDocumentTab(tabId)) {
      resetVisibleDocumentAppState("document");
    }
  }, [activeTabId, resetVisibleDocumentAppState, switchDocumentTab]);

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
      options: { openInNewTab?: boolean } = {},
    ) => {
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
        { openMode: options.openInNewTab && document.source ? "new-tab" : "replace-active" },
      ).then((result) => {
        if (result.status === "opened") {
          setSelectedPageIndexes(new Set([0]));
        }

        return result;
      });
    },
    [document.source, openStreamedFile, resetLegalState],
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

      if (plan.mode === "memory") {
        // Same per-open resets as `openOpenedFile` — this IS a fresh open.
        ocrRunRef.current += 1;
        ocrActiveRef.current = false;
        setOcrState({ phase: "idle", message: null });
        resetLegalState();
        setSelectedPageIndexes(new Set());
        setPasswordPrompt(null);
        setRepairCandidate(null);

        const result = await openDocumentFile({
          bytes: plan.bytes,
          name: output.name,
          path: null,
        });

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

      return openStreamedSource({
        kind: "rangeGrant",
        grant: output.outputGrant,
        name: output.name,
        sizeBytes: output.sizeBytes,
      });
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

      void loadPdfDocument(sourceBytes)
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
              ? "This large PDF could not be opened for streaming view. It may be malformed — try Organize → Repair, which runs through the local engine."
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

    if (!pdfDocument || !sourceBytes) {
      return;
    }

    if (document.textLayerCoverage) {
      setHasTextLayer(hasSearchableTextLayerCoverage(document.textLayerCoverage));
      return;
    }

    let disposed = false;

    void inspectTextLayer(sourceBytes, pdfDocument)
      .then((textLayerCoverage) => {
        if (disposed) {
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
  ]);

  // Keyed on `source` (not generation): a plain Save swaps the source object
  // without bumping generation, and document-bound legal state cleared on
  // save before this change too — the cadence must not loosen.
  useEffect(() => {
    const previousGeneration = legalStateDocumentGenerationRef.current;
    legalStateDocumentGenerationRef.current = document.generation;
    clearDocumentBoundLegalState(previousGeneration);
  }, [clearDocumentBoundLegalState, document.generation, document.source]);

  // Pending edits and form values are geometry- and page-bound, so any change
  // to the underlying document (rotate, delete, reorder, apply — each swaps
  // the source and bumps the generation) invalidates them.
  const resetEditingForDocument = editing.resetForDocument;
  useEffect(() => {
    resetEditingForDocument();
  }, [resetEditingForDocument, document.source]);

  const selectEditTool = useCallback(
    (toolId: EditToolId) => {
      // Streamed mode: pending edits are applied on Save through the engine
      // (byte path), so every non-Select tool is gated [R1-2].
      if (toolId !== "select" && document.source !== null && document.source.kind !== "memory") {
        setError(STREAMED_DOCUMENT_GATE_MESSAGE);
        return;
      }

      if (toolId !== "select" && activeLegalTool === "redact") {
        setActiveLegalTool(null);
      }

      setActiveEditDialogTool(null);
      editing.setTool(toolId);
    },
    [activeLegalTool, document.source, editing, setError],
  );

  // Esc exits any edit mode. Inline editors (text draft, comment popover)
  // consume their own Escape via stopPropagation before this fires.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      if (editing.tool !== "select") {
        editing.setTool("select");
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing]);

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

    if (streamedDocument) {
      if (!pathOpsGrant) {
        // Browser streamed docs have no shell grant — the gate stays up.
        setOcrState({ phase: "error", message: STREAMED_DOCUMENT_GATE_MESSAGE });
        return;
      }

      // Delegated OCR [R2-2]: OCRmyPDF runs file-to-file on the shell side
      // in either mode (`--skip-text` keeps existing text layers;
      // `--force-ocr` re-renders every page and rebuilds the layer); the
      // output reopens as a new document (generation bump).
      const grant = pathOpsGrant;
      const runId = ocrRunRef.current + 1;
      ocrRunRef.current = runId;
      ocrActiveRef.current = true;
      const isCurrentStreamedRun = () => (
        ocrRunRef.current === runId && isCurrentDocument(sourceOpenToken, sourceGeneration)
      );

      setOcrState({
        phase: "processing",
        message: ocrType === "force-ocr"
          ? "Rebuilding the searchable text layer — the local engine re-renders the file itself; nothing is loaded into memory."
          : "Making searchable — the local engine works on the file itself; nothing is loaded into memory.",
        progress: null,
      });

      void (async () => {
        const jobToken = newOcrJobToken();
        let unlisten: (() => void) | null = null;
        try {
          try {
            unlisten = await listenOcrProgress(jobToken, (progress) => {
              if (!isCurrentStreamedRun()) {
                return;
              }
              setOcrState((current) => (
                current.phase === "processing"
                  ? { ...current, progress }
                  : current
              ));
            });
          } catch {
            // Progress is additive. OCR should still run if event subscription
            // fails in an unusual desktop/runtime state.
          }

          const output = await pathOpOcr(grant, ocrType, jobToken);
          if (!isCurrentStreamedRun()) {
            await pathOpReleaseOutput(output.outputGrant).catch(() => undefined);
            return;
          }

          const reopened = await openPathOpOutput(output, {
            openToken: sourceOpenToken,
            generation: sourceGeneration,
          });
          if (reopened.status !== "opened") {
            return;
          }

          setOcrState({
            phase: "done",
            message: "Searchable copy ready — it opened as a new document. Use Save As to keep it.",
          });
        } catch (error: unknown) {
          if (!isCurrentStreamedRun()) {
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
          : "This action is available in the desktop app.",
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
      message: "Starting the PDF engine...",
      progress: null,
    });

    void engineBridge
      .runOcr(sourceBytes, {
        ocrType,
        pageCount: document.pageCount,
        onEngineReady: () => {
          if (isCurrentRun()) {
            setOcrState({
              phase: "processing",
              message: ocrType === "force-ocr"
                ? "Rebuilding the searchable text layer — the whole file is being re-rendered."
                : "Making searchable — page-by-page work happens in the engine.",
              progress: null,
            });
          }
        },
      })
      .then(async (ocrResult) => {
        if (!isCurrentRun()) {
          return;
        }

        setOcrState({
          phase: "verifying",
          message: "Verifying the text layer...",
          progress: null,
        });

        const textLayerCoverage = await inspectTextLayer(ocrResult.bytes);
        const verification = verifyOcrTextLayer(textLayerCoverage, ocrType);
        const workflowResult = {
          ...ocrResult,
          textLayerCoverage,
          verification,
        };

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

        const detail = formatOcrFailureDetail(error);
        const message = detail
          ? `${OCR_FAILURE_MESSAGE} ${detail}`
          : OCR_FAILURE_MESSAGE;

        setOcrState({
          phase: "error",
          message,
        });

        void recordDiagnosticEvent("ocr.failed", message, [
          error instanceof Error && error.stack ? error.stack : null,
        ]);
      })
      .finally(clearBusyGuard);
  }, [document.bytes, document.generation, document.pageCount, engineBridge, getOpenToken, isCurrentDocument, openPathOpOutput, pathOpsGrant, replaceBytes, streamedDocument]);

  const requestForceOcr = useCallback((reason: ForceOcrConfirmationReason = "manual") => {
    if (!streamedDocument && document.bytes && engineBridge.ocrAvailable) {
      engineBridge.warmEngine();
    }

    setForceOcrConfirmation(reason);
  }, [document.bytes, engineBridge, streamedDocument]);

  const openOcrDialog = useCallback((ocrType: OcrType) => {
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
          : "This action is available in the desktop app.",
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
  }, [document.bytes, engineBridge, pathOpsGrant, streamedDocument]);

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
    // Dismissing mid-run (rather than at the confirm step) can't cancel the
    // in-flight engine call -- there's no abort plumbing for that -- so this
    // just invalidates the run the same way opening a new document does:
    // isCurrentRun() stops applying its result once it eventually settles,
    // and the busy guard is released immediately rather than waiting on it.
    ocrRunRef.current += 1;
    ocrActiveRef.current = false;
    setOcrState({ phase: "idle", message: null });
  }, []);

  const confirmForceOcr = useCallback(() => {
    setForceOcrConfirmation(null);
    runOcrWorkflow("force-ocr");
  }, [runOcrWorkflow]);

  const openOpenedFile = useCallback(
    (file: OpenedFile, options: { openInNewTab?: boolean } = {}) => {
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
    [document.source, openDocumentFile, resetLegalState],
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
    if (startupFileTakenRef.current) {
      return;
    }

    startupFileTakenRef.current = true;
    void takeStartupFile()
      .then((source) => {
        if (source) {
          openFileSource(source);
        }
      })
      .catch(() => {
        setError("This startup PDF could not be opened. The file may be corrupt or unsupported.");
      });
  }, [openFileSource, setError]);

  const openFileInSeparateWindow = useCallback(() => {
    void openFileInNewWindow().catch(() => {
      setError("This PDF could not be opened in a new window.");
    });
  }, [setError]);

  const openProductionFile = useCallback(async (): Promise<FileAddResult | null> => {
    try {
      return await pickFileForAdd();
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
      return await pickFileForAdd();
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
      const result = await pickFileForAdd();
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
    // button is disabled); Save As is a shell-side copy by grant — no bytes
    // cross into the WebView.
    if (document.source !== null && document.source.kind !== "memory") {
      if (!forceSaveAs) {
        return null;
      }

      const source = document.source;
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
      const pendingApply = editing.collectEdits();

      if (pendingApply) {
        const applied = await applyEdits(pendingApply.edits, {
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
    } catch {
      setError("This PDF could not be saved. Try reopening the document and saving again.");
      return null;
    } finally {
      savingRef.current = false;
    }
  }, [applyEdits, document.fileName, document.source, editing, markSaved, printMarkupAnnotations, saveDocument, setError]);

  const flattenCurrentMarkup = useCallback(() => {
    const sourceBytes = document.bytes;
    const overlayEdits = toPdfEdits(editing.pendingEdits);

    if (!sourceBytes && overlayEdits.length === 0) {
      setMarkupAnnotationMessage(
        streamedDocument ? STREAMED_DOCUMENT_GATE_MESSAGE : "Open a PDF before flattening markup.",
      );
      return;
    }

    void (async () => {
      let flattenedOverlayCount = 0;
      const annotationCount = sourceBytes
        ? await countRaioPdfMarkupAnnotations(sourceBytes)
        : 0;

      if (overlayEdits.length > 0) {
        setMarkupAnnotationMessage("Flattening pending annotations...");
        const applied = await applyEdits(overlayEdits, {
          flatten: true,
          printMarkupAnnotations,
        });

        if (!applied) {
          setMarkupAnnotationMessage("Pending annotations were not flattened.");
          return;
        }

        flattenedOverlayCount = editing.pendingEdits.length;
        editing.clearPendingEdits();
      }

      if (annotationCount === 0 && flattenedOverlayCount === 0) {
        setMarkupAnnotationMessage("No RaioPDF markup annotations were found.");
        return;
      }

      setMarkupAnnotationMessage("Flattening markup annotations...");
      const flattened = await flattenMarkupAnnotations();
      const flattenedCount = annotationCount + flattenedOverlayCount;
      setMarkupAnnotationMessage(
        flattened
          ? `Flattened ${flattenedCount} ${flattenedCount === 1 ? "annotation" : "annotations"} into permanent page content.`
          : "Markup annotations were not flattened.",
      );
    })().catch(() => {
      setMarkupAnnotationMessage("Markup annotations could not be flattened.");
    });
  }, [
    applyEdits,
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
      resetVisibleDocumentAppState("document");
      pendingMoveToNewWindowTabIdRef.current = tabId;
      return;
    }

    void moveActiveTabToNewWindow(tabId, tab.document.filePath as FileGrant, tab.document.dirty);
  }, [activeTabId, documentTabs, moveActiveTabToNewWindow, resetVisibleDocumentAppState, setError, switchDocumentTab]);

  useEffect(() => {
    const pendingTabId = pendingMoveToNewWindowTabIdRef.current;
    if (!pendingTabId || pendingTabId !== activeTabId) {
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
  }, [activeTabId, documentTabs, moveActiveTabToNewWindow, setError]);

  const printDocument = useCallback(() => {
    if (streamedDocument) {
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
  }, [document.bytes, pathOpsGrant, setError, streamedDocument]);

  // The print dialog holds the grant it was opened with — close it when the
  // document changes so it can never print a stale grant (the #127 stale-
  // guard discipline, applied at the dialog boundary).
  useEffect(() => {
    setPrintDialogOpen(false);
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
      // Streamed mode: tools whose flow now runs file-to-file through the
      // PathOpsEngine (or that were already path/proxy-based) are open;
      // everything still byte-based stays gated with the message naming
      // what works [R1-2].
      if (streamedDocument && !isStreamedLegalToolAvailable(toolId, pathOpsGrant !== null)) {
        setError(STREAMED_DOCUMENT_GATE_MESSAGE);
        return;
      }

      setActiveLegalTool(toolId);
      setActiveEditDialogTool(null);

      if (toolId === "redact" && editing.tool !== "select") {
        editing.setTool("select");
      }

      setActiveOrganizeTool(null);
    },
    [editing, pathOpsGrant, setError, streamedDocument],
  );

  const selectOrganizeTool = useCallback((toolId: OrganizeToolId) => {
    // Streamed mode: Properties works from pdf.js `getMetadata()` on the
    // shared proxy; Compress, Repair, Merge, and Insert run file-to-file
    // through the PathOpsEngine; the Pages grid renders from the shared
    // proxy and its insert delegates too (the byte-bound grid actions keep
    // their own honest gates). Everything else still mutates bytes — gated
    // [R1-2].
    const streamedOrganizeAvailable =
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
      setActiveEditDialogTool(null);
      return;
    }

    setActiveOrganizeTool(toolId);
    setActiveLegalTool(null);
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
    setActiveOrganizeTool(null);
    editing.setTool("select");
  }, [editing, pathOpsGrant, setError, streamedDocument]);

  const closeWorkspace = useCallback(() => {
    setActiveOrganizeTool(null);
    setActiveLegalTool(null);
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

        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          return false;
        }

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

        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
          return false;
        }

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

  /** Grant-based Organize handlers, present only when the streamed current
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
        // The range-split flow is still byte-bound; the honest gate points
        // at the delegated alternative instead of a generic "could not be
        // split".
        setError(
          "Splitting a very large document by page ranges isn't available yet. Prepare for Filing can split it by size through the local engine.",
        );
        return null;
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
    [document.fileName, setError, splitPages, streamedDocument],
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
        setRedactionMessage("This action is available in the desktop app.");
        return;
      }
    } else if (!document.bytes) {
      setRedactionPhase("error");
      setRedactionMessage("Open a PDF before applying redactions.");
      return;
    } else if (!engineBridge.available) {
      setRedactionPhase("error");
      setRedactionMessage("This action is available in the desktop app.");
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
      setRedactionMessage("Applying redactions in the local engine and verifying the redacted output file...");

      try {
        const result = await pathOpRedactAreas(pathOpsGrant, areas);

        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
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
    setRedactionMessage("Applying redactions and verifying text layer, page images, annotations, and metadata...");

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
          message: "Applying Bates numbers through the local engine...",
        });

        try {
          const output = await pathOpBatesStamp(pathOpsGrant, options);

          // Stale guard (same pattern as the post-#127 funnels): a slow op
          // must never reopen its output over a newer document.
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
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
          message: "Applying page numbers through the local engine...",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });

        try {
          const output = await pathOpPageNumbers(pathOpsGrant, options);

          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
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
          message: "Applying watermark through the local engine...",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });

        try {
          const output = await pathOpWatermark(pathOpsGrant, options);

          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
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
          message: "Compressing through the local engine...",
          removed: [],
          beforeBytes,
          afterBytes: null,
        });

        try {
          const output = await pathOpCompress(pathOpsGrant);

          // A slow op must never clobber a document the user opened while it
          // ran (Codex review, PR #127) — same stale guard as the byte branch.
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
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
            message: "Compression complete — very large files use the engine's structural pass; image downsampling is not applied.",
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
          message: "This action is available in the desktop app.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      setSidecarStatus({
        running: true,
        message: "Compressing in the desktop engine...",
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
        message: "Sanitizing through the local engine...",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });

      try {
        const output = await pathOpSanitize(pathOpsGrant);

        // Stale guard (Codex review, PR #127): don't reopen an output for a
        // document the user has since replaced.
        if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
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
        message: "This action is available in the desktop app.",
        removed: [],
        beforeBytes: null,
        afterBytes: null,
      });
      return false;
    }

    setSidecarStatus({
      running: true,
      message: "Sanitizing in the desktop engine...",
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
          message: "Repairing through the local engine...",
          removed: [],
          beforeBytes,
          afterBytes: null,
        });

        try {
          const output = await pathOpRepair(pathOpsGrant);

          // Stale guard (Codex review, PR #127): don't reopen an output for
          // a document the user has since replaced.
          if (!isCurrentDocument(sourceOpenToken, sourceGeneration)) {
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
          message: "This action is available in the desktop app.",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        });
        return false;
      }

      setSidecarStatus({
        running: true,
        message: "Repairing in the desktop engine...",
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

      const insertAt = [...selectedPageIndexes].sort((left, right) => left - right)[0] ?? document.currentPage;
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
        message: "Preparing the filing copy in the local engine — very large files run file-to-file, nothing loads into memory...",
      });

      const result = await pathOpPrepareFiling(grant, plan);

      if (!isCurrentFilingRun()) {
        return;
      }

      setFilingProgress({
        phase: "verifying",
        message: "Saving the output parts and reading the facts-based output preflight...",
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
          ? `Filing output saved to ${savedOutput.directoryPath}. The output preflight is facts-based for very large files — checks the engine can't compute were not evaluated.`
          : "Filing output saved. The output preflight is facts-based for very large files — checks the engine can't compute were not evaluated.",
      });
    })()
      .catch((error: unknown) => {
        if (!isCurrentFilingRun()) {
          return;
        }

        setFilingProgress({
          phase: "error",
          message: pathOpErrorMessage(error, "The filing copy could not be prepared."),
        });
      });
  }, [
    confirmDecryptSignatureFactsInvalidation,
    document.fileName,
    document.filePath,
    document.generation,
    filingFacts,
    filingPack,
    filingPrepPlan,
    getOpenToken,
    isCurrentDocument,
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
        message: "PDF/A export is available in the desktop app.",
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
            message: "Encryption removal is available in the desktop app.",
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
          return;
        }
      }

      let workingHandle: PdfDocumentHandle;
      const closeHandles: PdfDocumentHandle[] = [];

      try {
        workingHandle = await filingEngine.open(filingSourceBytes);
        closeHandles.push(workingHandle);

        if (markupAnnotationChoice === "flatten") {
          setFilingProgress({
            phase: "normalizing",
            message: "Flattening RaioPDF markup annotations for filing...",
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
              ? "Scrubbing metadata before PDF/A conversion rewrites conformance metadata..."
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
          setFilingProgress({
            phase: "normalizing",
            message: "Making the filing copy searchable...",
          });
          const [workingBytes, workingPageCount] = await Promise.all([
            filingEngine.saveToBytes(workingHandle),
            filingEngine.pageCount(workingHandle),
          ]);
          const ocrResult = await engineBridge.runOcr(workingBytes, {
            ocrType: document.textLayerCoverage?.garbledPages.length ? "force-ocr" : "skip-text",
            pageCount: workingPageCount,
          });
          workingHandle = await reopenFilingHandle(
            filingEngine,
            closeHandles,
            ocrResult.bytes,
          );
        }

        if (selectedSteps.has("flatten-forms")) {
          setFilingProgress({
            phase: "normalizing",
            message: "Flattening form fields...",
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
              ? "Converting each split filing part to PDF/A in the desktop engine..."
              : "Converting the filing copy to PDF/A in the desktop engine...",
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
          message: "Re-running preflight on the output files...",
        });

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

  const exportPdfA = useCallback(() => {
    if (!document.bytes) {
      setError(
        streamedDocument ? STREAMED_DOCUMENT_GATE_MESSAGE : "Open a PDF before exporting PDF/A.",
      );
      return;
    }

    setActiveOrganizeTool(null);
    setActiveEditDialogTool(null);
    setActiveLegalTool("prepare-for-filing");
    prepareFilingCopy(null, {
      selectedStepIds: [
        ...filingPrepPlan
          .filter((step) => step.defaultChecked && !step.disabledReason)
          .map((step) => step.id),
        "convert-pdfa",
      ],
      customSplitMegabytes: null,
    });
  }, [document.bytes, filingPrepPlan, prepareFilingCopy, setError, streamedDocument]);

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

  const modeBar = activeLegalTool === "redact" ? (
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

  const workspace = activeLegalTool === "combine-exhibits" ? (
    <BinderWorkspace
      document={document}
      onBuildBinder={buildBinder}
      onOpenRequested={openFile}
      onCancel={closeWorkspace}
      onHelpRequested={() => openHelp("combine-exhibits")}
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
      onExtract={extractPages}
      onSplit={splitAndSavePages}
      onInsert={insertFile}
      delegatedOps={delegatedOrganizeOps}
      onExportPageAsImage={exportPageAsImage}
      onCropResize={cropResize}
      onHelpRequested={() => openHelp("pages")}
    />
  ) : null;

  const overlay = getFloatingDialog();

  function getFloatingDialog() {
    if (activeLegalTool === "prepare-for-filing") {
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
            stepDefaultOverrides={filingPreferences.stepDefaultOverridesByPack[baseFilingPack.id]}
            onStepDefaultOverridesChange={handlePrepStepDefaultOverridesChange}
            onDismissImpact={() => setFilingImpact(null)}
            onCompressFirst={compressBeforeFiling}
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
            currentFile={document.source ? {
              name: document.fileName ?? "Untitled.pdf",
              path: document.filePath,
            } : null}
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
            currentFile={document.source ? {
              name: document.fileName ?? "Untitled.pdf",
              path: document.filePath,
            } : null}
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
            onExtract={extractPages}
            onSplit={splitAndSavePages}
            onInsert={insertFile}
            delegatedOps={delegatedOrganizeOps}
            onCropResize={cropResize}
            onHelpRequested={() => openHelp(activeOrganizeTool)}
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
        ocrStarting={forceOcrConfirmation ? false : engineBridge.starting}
        documentBanner={<DocumentBanner notice={document.signatureInvalidationNotice} />}
        workspace={workspace}
        overlay={overlay}
        activeLegalTool={activeLegalTool}
        activeEditDialogTool={activeEditDialogTool}
        activeOrganizeTool={activeOrganizeTool}
        onEditDialogToolSelected={selectEditDialogTool}
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
          onCheckForUpdates={() => {
            void handleCheckForUpdates("manual");
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
const STREAMED_LEGAL_TOOLS_ALWAYS: readonly LegalToolId[] = ["scanner-2425", "passwords"];
const STREAMED_LEGAL_TOOLS_DELEGATED: readonly LegalToolId[] = [
  "prepare-for-filing",
  "batch-cleanup",
  "production-set",
  "redact",
  "sanitize",
  "bates-numbering",
];

function isStreamedLegalToolAvailable(toolId: LegalToolId, delegated: boolean): boolean {
  return (
    STREAMED_LEGAL_TOOLS_ALWAYS.includes(toolId) ||
    (delegated && STREAMED_LEGAL_TOOLS_DELEGATED.includes(toolId))
  );
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
    ". Redacted pages were rasterized — run Make Searchable to restore text search on them. " +
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
    overrides.push("metadata scrub ran before PDF/A conversion so the converter can write PDF/A conformance metadata");
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
            document.textLayerCoverage.garbledPages.length === 0,
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

    // A PDF/A conformance claim requires an XMP pdfaid identification, so its absence
    // is a definitive "not PDF/A"; the claim itself is only what the document reports.
    facts.pdfaCompliant = options.pdfaCompliant ?? (readPdfAIdentification(pdf) !== null);
  } catch {
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
    ? "text layer verified clean"
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

function requireAbsoluteSourcePaths(paths: readonly (string | null)[], errorMessage: string): string[] {
  const absolutePaths: string[] = [];

  for (const filePath of paths) {
    if (!looksLikeAbsolutePath(filePath)) {
      throw new Error(errorMessage);
    }
    absolutePaths.push(filePath);
  }

  return absolutePaths;
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
