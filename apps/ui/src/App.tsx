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
import { LocalPdfEngine } from "@raiopdf/engine-local";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  buildDocumentFacts,
  getPack,
  getPackIntegrityBanner,
  listPacks,
  preflight,
  resolvePrepPlan,
  scoreGarbledPage,
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
} from "@raiopdf/rules";
import { AppShell } from "./components/AppShell";
import { BinderWorkspace } from "./components/BinderWorkspace";
import {
  OrganizeWorkspace,
  type OrganizeFlowId,
} from "./components/OrganizeWorkspace";
import {
  PrepareForFilingWorkspace,
  type CertificateOfServiceDraft,
  type FilingImpactState,
  type FilingPacketBuildInput,
  type FilingPacketFile,
  type FilingPacketProgress,
  type FilingOutputPart,
  type FilingProgressState,
  type FilingResultState,
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
import { EditModeBar } from "./components/EditModeBar";
import { FloatingDialog, hasOpenDialogStackEntry } from "./components/FloatingDialog";
import { ForceOcrConfirmationDialog } from "./components/ForceOcrConfirmationDialog";
import { HelpPanel } from "./components/HelpPanel";
import { LoadingSun } from "./components/LoadingSun";
import { OcrDialog, type OcrDialogPhase } from "./components/OcrDialog";
import {
  isEngineBridgeUnavailableError,
  useEngineBridge,
} from "./hooks/useEngineBridge";
import { useDocument, type DocumentState } from "./hooks/useDocument";
import { useDocumentSearch } from "./hooks/useDocumentSearch";
import { useEditing } from "./hooks/useEditing";
import type { EditToolId } from "./lib/edits";
import { isTextEntryTarget } from "./lib/domGuards";
import { formatDefaultRange, parsePageRanges } from "./lib/pageRanges";
import {
  getPdfLoadErrorMessage,
  loadPdfDocument,
  OPS,
  type PDFDocumentProxy,
} from "./lib/pdfjs";
import { filePort, readBrowserFile, type OpenedFile } from "./lib/filePort";
import {
  looksLikeAbsolutePath,
  resolveDesktopFileGrantPaths,
} from "./lib/localPaths";
import { writeProductionLastUsed } from "./lib/productionHints";
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
  inspectTextLayer,
} from "./lib/textLayer";
import { verifyOcrTextLayer } from "./lib/ocrVerification";
import { describeTextLayerStatus, deriveTextLayerStatus } from "./lib/textLayerStatus";
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
  PasswordsPanel,
  ScrubMetadataPanel,
  type EditDialogToolId,
  type LegalToolId,
  type OrganizeToolId,
} from "./components/ToolPanel";
import type {
  BatesPanelState,
  RedactionPanelState,
  ScannerPanelState,
  ScrubMetadataPanelState,
} from "./components/ToolPanel";
import { SearchIcon } from "./icons";
import "./components/LegalModeBar.css";

const ZOOM_STEP = 0.25;
const FLORIDA_PACK: JurisdictionPack = getPack();
const AVAILABLE_FILING_PACKS: readonly JurisdictionPack[] = listPacks();
const PACK_INTEGRITY_BANNER = getPackIntegrityBanner();
const POINTS_PER_INCH = 72;

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
}

function isOcrDialogPhase(phase: OcrPhase): phase is OcrDialogPhase {
  return (
    phase === "confirm" ||
    phase === "starting-engine" ||
    phase === "processing" ||
    phase === "verifying"
  );
}

type OcrType = "skip-text" | "force-ocr";

type ForceOcrConfirmationReason = "garbled" | "manual";

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

export function App() {
  const {
    document,
    pageScrollIntent,
    openFile: openDocumentFile,
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
    scrubMetadata,
    pageNumbers,
    watermark,
    insertImagePages,
    save: saveDocument,
    markSaved,
  } = useDocument();
  const engineBridge = useEngineBridge();
  const [pdfDocumentState, setPdfDocumentState] = useState<{
    bytes: Uint8Array;
    proxy: PDFDocumentProxy;
  } | null>(null);
  const currentPdfDocumentState = pdfDocumentState?.bytes === document.bytes
    ? pdfDocumentState
    : null;
  const pdfDocument = currentPdfDocumentState?.proxy ?? null;
  const pdfDocumentBytes = currentPdfDocumentState?.bytes ?? null;
  const editing = useEditing(pdfDocument);
  const documentSearch = useDocumentSearch({
    pdfDocumentState: currentPdfDocumentState,
    documentBytes: document.bytes,
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
  const [forceOcrConfirmation, setForceOcrConfirmation] =
    useState<ForceOcrConfirmationReason | null>(null);
  const [activeLegalTool, setActiveLegalTool] = useState<LegalToolId | null>(
    null,
  );
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
  const [filingReportLoading, setFilingReportLoading] = useState(false);
  const [filingReportError, setFilingReportError] = useState<string | null>(null);
  const [filingProgress, setFilingProgress] = useState<FilingProgressState>({
    phase: "idle",
    message: null,
  });
  const [filingResult, setFilingResult] = useState<FilingResultState | null>(null);
  const [filingImpact, setFilingImpact] = useState<FilingImpactState | null>(null);
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
        message: `Batch cleanup finished for ${result.files.length} file(s).`,
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
  const batesApplyingRef = useRef(false);
  const redactionIdRef = useRef(0);
  const documentBytesRef = useRef<Uint8Array | null>(null);
  const legalStateDocumentBytesRef = useRef<Uint8Array | null>(document.bytes);
  const preserveFilingProgressForBytesRef = useRef<Uint8Array | null>(null);
  const scannerRunRef = useRef(0);
  const filingRunRef = useRef(0);
  const filingFactsCacheRef = useRef<FilingFactsCache>({
    byBytes: new WeakMap(),
  });
  const nativeMenuCommandRef = useRef<(command: string) => void>(() => {});
  const filingEngine = useMemo(() => new LocalPdfEngine(), []);

  useLayoutEffect(() => {
    documentBytesRef.current = document.bytes;
  }, [document.bytes]);

  const resetLegalState = useCallback(() => {
    preserveFilingProgressForBytesRef.current = null;
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

  const clearDocumentBoundLegalState = useCallback((previousBytes: Uint8Array | null) => {
    const preserveFilingProgress = Boolean(
      previousBytes && preserveFilingProgressForBytesRef.current === previousBytes,
    );
    preserveFilingProgressForBytesRef.current = null;
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

  const isCurrentDocument = useCallback(
    (sourceOpenToken: number, sourceBytes: Uint8Array) => (
      getOpenToken() === sourceOpenToken && documentBytesRef.current === sourceBytes
    ),
    [getOpenToken],
  );

  useEffect(() => {
    let disposed = false;
    let loadedDocument: PDFDocumentProxy | null = null;
    const sourceBytes = document.bytes;

    if (!sourceBytes) {
      setPdfDocumentState(null);
      return;
    }

    setPdfDocumentState(null);

    void loadPdfDocument(sourceBytes)
      .then((loaded) => {
        loadedDocument = loaded;

        if (disposed) {
          void loaded.loadingTask.destroy();
          return;
        }

        setPdfDocumentState({ bytes: sourceBytes, proxy: loaded });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setError(getPdfLoadErrorMessage(error));
        }
      });

    return () => {
      disposed = true;
      void loadedDocument?.loadingTask.destroy();
    };
  }, [document.bytes, setError]);

  useEffect(() => {
    const sourceBytes = document.bytes;

    if (!pdfDocument || !sourceBytes) {
      return;
    }

    let disposed = false;

    void extractUiTextLayerCoverage(sourceBytes, pdfDocument)
      .then((textLayerCoverage) => {
        if (disposed) {
          return;
        }

        setTextLayerCoverage(textLayerCoverage);
        setHasTextLayer(
          textLayerCoverage.imageOnlyPages.length +
            textLayerCoverage.mixedPages.length +
            textLayerCoverage.textPages.length > 0 &&
            textLayerCoverage.imageOnlyPages.length === 0,
        );
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
  }, [document.bytes, pdfDocument, setHasTextLayer, setTextLayerCoverage]);

  useEffect(() => {
    const previousBytes = legalStateDocumentBytesRef.current;
    legalStateDocumentBytesRef.current = document.bytes;
    clearDocumentBoundLegalState(previousBytes);
  }, [clearDocumentBoundLegalState, document.bytes]);

  // Pending edits and form values are geometry- and page-bound, so any change
  // to the underlying bytes (rotate, delete, reorder, apply) invalidates them.
  const resetEditingForDocument = editing.resetForDocument;
  useEffect(() => {
    resetEditingForDocument();
  }, [resetEditingForDocument, document.bytes]);

  const selectEditTool = useCallback(
    (toolId: EditToolId) => {
      if (toolId !== "select" && activeLegalTool === "redact") {
        setActiveLegalTool(null);
      }

      setActiveEditDialogTool(null);
      editing.setTool(toolId);
    },
    [activeLegalTool, editing],
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
  }, [document.bytes]);

  useEffect(() => {
    let disposed = false;
    const sourceBytes = document.bytes;

    if (activeLegalTool !== "prepare-for-filing") {
      setFilingReportLoading(false);
      setFilingReportError(null);
      return;
    }

    if (!sourceBytes) {
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
        if (disposed || documentBytesRef.current !== sourceBytes) {
          return;
        }

        setFilingFacts(facts);
        setFilingReport(runFilingPreflight(facts, filingPack));
        setFilingReportError(null);
      })
      .catch(() => {
        if (!disposed && documentBytesRef.current === sourceBytes) {
          setFilingFacts(null);
          setFilingReport(null);
          setFilingReportError("RaioPDF could not read the facts needed for filing checks. The document was left unchanged; try reopening or repairing the PDF.");
        }
      })
      .finally(() => {
        if (!disposed && documentBytesRef.current === sourceBytes) {
          setFilingReportLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [activeLegalTool, document.bytes, document.fileName, document.fileSizeBytes, document.textLayerCoverage, filingPack, pdfDocument, pdfDocumentBytes]);

  const runOcrWorkflow = useCallback((ocrType: OcrType) => {
    if (ocrActiveRef.current) {
      return;
    }

    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();

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
    });

    void engineBridge
      .runOcr(sourceBytes, {
        ocrType,
        onEngineReady: () => {
          if (isCurrentRun()) {
            setOcrState({
              phase: "processing",
              message: ocrType === "force-ocr"
                ? "Rebuilding the searchable text layer — the whole file is being re-rendered."
                : "Making searchable — page-by-page work happens in the engine.",
            });
          }
        },
      })
      .then(async (ocrBytes) => {
        if (!isCurrentRun()) {
          return;
        }

        setOcrState({
          phase: "verifying",
          message: "Verifying the text layer...",
        });

        const coverage = await inspectTextLayer(ocrBytes);
        const verification = verifyOcrTextLayer(coverage);

        if (!isCurrentRun()) {
          return;
        }

        if (verification.status === "failed") {
          setOcrState({
            phase: "error",
            message: verification.message,
          });
          return;
        }

        const replaced = await replaceBytes(ocrBytes, {
          dirty: true,
          hasTextLayer: true,
          expectedOpenToken: sourceOpenToken,
          expectedSourceBytes: sourceBytes,
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
          message: verification.message,
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

        const detail = formatWorkflowError(error, "OCR could not finish. The document was left unchanged.");

        setOcrState({
          phase: "error",
          message: "Couldn't make this document searchable.",
        });

        void recordDiagnosticEvent("ocr.failed", detail, [
          error instanceof Error && error.stack ? error.stack : null,
        ]);
      })
      .finally(clearBusyGuard);
  }, [document.bytes, engineBridge, getOpenToken, replaceBytes]);

  const requestForceOcr = useCallback((reason: ForceOcrConfirmationReason = "manual") => {
    setForceOcrConfirmation(reason);
  }, []);

  const openOcrDialog = useCallback((ocrType: OcrType) => {
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
  }, [document.bytes, engineBridge]);

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
    (file: OpenedFile) => {
      ocrRunRef.current += 1;
      ocrActiveRef.current = false;
      setOcrState({ phase: "idle", message: null });
      resetLegalState();
      setSelectedPageIndexes(new Set());
      void openDocumentFile(file).then((opened) => {
        if (opened) {
          setRepairCandidate(null);
          setSelectedPageIndexes(new Set([0]));
        } else {
          setRepairCandidate(file);
          setActiveEditDialogTool(null);
          setActiveLegalTool(null);
          setActiveOrganizeTool("repair");
        }
      });
    },
    [openDocumentFile, resetLegalState],
  );

  const openFile = useCallback(() => {
    void filePort
      .openFile()
      .then((file) => {
        if (file) {
          openOpenedFile(file);
        }
      })
      .catch(() => {
        setError("This PDF could not be opened. The file may be corrupt or unsupported.");
      });
  }, [openOpenedFile, setError]);

  const openProductionFile = useCallback(async (): Promise<OpenedFile | null> => {
    try {
      return await filePort.openFile();
    } catch {
      setProductionProgress({
        running: false,
        message: "This PDF could not be added to the production set.",
        result: null,
      });
      return null;
    }
  }, []);

  const openBatchCleanupFile = useCallback(async (): Promise<OpenedFile | null> => {
    try {
      return await filePort.openFile();
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
      const file = await filePort.openFile();
      if (!file) {
        return null;
      }

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
      void readBrowserFile(file)
        .then(openOpenedFile)
        .catch(() => {
          setError("This PDF could not be opened. The file may be corrupt or unsupported.");
        });
    },
    [openOpenedFile, setError],
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

  const selectedIndexes = useCallback(() => {
    return [...selectedPageIndexes].sort((left, right) => left - right);
  }, [selectedPageIndexes]);

  const rotateSelected = useCallback(() => {
    void rotatePages(selectedIndexes());
  }, [rotatePages, selectedIndexes]);

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

  const saveToFile = useCallback((forceSaveAs: boolean) => {
    // Re-entry guard: rapid double-clicks must not apply the same pending
    // edits twice or start a second file write mid-save.
    if (savingRef.current) {
      return;
    }

    savingRef.current = true;

    void (async () => {
      const pendingApply = editing.collectEdits();

      if (pendingApply) {
        const applied = await applyEdits(pendingApply.edits, {
          flatten: pendingApply.flatten,
        });

        if (!applied) {
          // The mutation queue already surfaced the error; the document is
          // unchanged, so the pending list stays for another attempt.
          return;
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
        return;
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
    })()
      .catch(() => {
        setError("This PDF could not be saved. Try reopening the document and saving again.");
      })
      .finally(() => {
        savingRef.current = false;
      });
  }, [applyEdits, editing, markSaved, saveDocument, setError]);

  const save = useCallback(() => {
    saveToFile(false);
  }, [saveToFile]);

  const saveAs = useCallback(() => {
    saveToFile(true);
  }, [saveToFile]);

  const printDocument = useCallback(() => {
    if (!document.bytes) {
      setError("Open a PDF before printing.");
      return;
    }

    window.print();
  }, [document.bytes, setError]);

  const selectLegalTool = useCallback(
    (toolId: LegalToolId) => {
      setActiveLegalTool(toolId);
      setActiveEditDialogTool(null);

      if (toolId === "redact" && editing.tool !== "select") {
        editing.setTool("select");
      }

      setActiveOrganizeTool(null);
    },
    [editing],
  );

  const selectOrganizeTool = useCallback((toolId: OrganizeToolId) => {
    if (toolId === "rotate") {
      rotateSelected();
      // The sidebar's "Rotate Pages" row is a standalone action from the
      // plain canvas, but when the Organize Pages workspace is already open
      // it must stay open -- rotating shouldn't kick the reader back to the
      // canvas. Read the current value functionally so this stays a no-op
      // dependency (the callback below doesn't need to be recreated when
      // activeOrganizeTool changes).
      setActiveOrganizeTool((current) => (current === "pages" ? current : null));
      setActiveLegalTool(null);
      return;
    }

    setActiveOrganizeTool(toolId);
    setActiveLegalTool(null);
    setActiveEditDialogTool(null);
  }, [rotateSelected]);

  const selectEditDialogTool = useCallback((toolId: EditDialogToolId) => {
    setActiveEditDialogTool(toolId);
    setActiveLegalTool(null);
    setActiveOrganizeTool(null);
    editing.setTool("select");
  }, [editing]);

  const closeWorkspace = useCallback(() => {
    setActiveOrganizeTool(null);
    setActiveLegalTool(null);
    setActiveEditDialogTool(null);
  }, []);

  const splitAndSavePages = useCallback(
    async (pageGroups: readonly (readonly number[])[]) => {
      const parts = await splitPages(
        pageGroups,
        stripPdfExtension(document.fileName ?? "Untitled"),
      );

      if (!parts) {
        return null;
      }

      const saved = [];
      for (const part of parts) {
        const written = await filePort.saveFile(part.bytes, part.fileName, null);

        if (written) {
          saved.push(written);
        }
      }

      return saved;
    },
    [document.fileName, splitPages],
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

      if (!sourceBytes) {
        setRedactionMessage("Open a PDF before searching for redaction text.");
        return;
      }

      const areas = await findTextRedactionAreas(
        { bytes: sourceBytes, pdfDocument },
        redactionSearchText,
      );

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
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
    [document.bytes, getOpenToken, isCurrentDocument, pdfDocument, redactionSearchText],
  );

  const requestApplyRedactions = useCallback(() => {
    if (!document.bytes) {
      setRedactionPhase("error");
      setRedactionMessage("Open a PDF before applying redactions.");
      return;
    }

    if (!engineBridge.available) {
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
  }, [document.bytes, engineBridge.available, pendingRedactions.length]);

  const cancelRedactions = useCallback(() => {
    setRedactionPhase("idle");
    setRedactionMessage(null);
  }, []);

  const confirmRedactions = useCallback(async () => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();
    const areas = pendingRedactions.map((pending) => pending.area);

    if (!sourceBytes || areas.length === 0) {
      return;
    }

    setRedactionPhase("applying");
    setRedactionMessage("Applying redactions and verifying text layer, page images, annotations, and metadata...");

    try {
      const redactedTerms = pdfDocument
        ? await collectRedactionAreaTexts({ bytes: sourceBytes, pdfDocument }, areas)
        : [];

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
        return;
      }

      const redactedBytes = await engineBridge.redactAreas(sourceBytes, areas);

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
        return;
      }

      const verified = await verifyRedactionAreasClear(redactedBytes, areas, redactedTerms);

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
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
        expectedSourceBytes: sourceBytes,
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

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
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

      if (!sourceBytes) {
        setBatesState({
          applying: false,
          message: "Open a PDF before applying Bates numbers.",
        });
        return false;
      }

      batesApplyingRef.current = true;
      setBatesState({ applying: true, message: "Applying Bates numbers..." });
      let applied = false;

      try {
        applied = await batesStamp(options, {
          expectedOpenToken: sourceOpenToken,
          expectedSourceBytes: sourceBytes,
        });

        if (applied) {
          setBatesState({
            applying: false,
            message: "Bates numbers applied.",
          });
          return true;
        }

        if (isCurrentDocument(sourceOpenToken, sourceBytes)) {
          setBatesState({
            applying: false,
            message: "Bates numbers could not be applied. Check the format and try again.",
          });
          return false;
        }

        return true;
      } finally {
        batesApplyingRef.current = false;

        if (!applied && isCurrentDocument(sourceOpenToken, sourceBytes)) {
          setBatesState((current) => (
            current.applying ? { ...current, applying: false } : current
          ));
        }
      }
    },
    [batesStamp, document.bytes, getOpenToken, isCurrentDocument],
  );

  const applyPageNumbers = useCallback(
    async (options: PdfPageNumbersOptions) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();

      if (!sourceBytes) {
        setSidecarStatus((current) => ({
          ...current,
          message: "Open a PDF before applying page numbers.",
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
        expectedSourceBytes: sourceBytes,
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
    [document.bytes, getOpenToken, pageNumbers],
  );

  const applyWatermark = useCallback(
    async (options: PdfWatermarkOptions) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();

      if (!sourceBytes) {
        setSidecarStatus((current) => ({
          ...current,
          message: "Open a PDF before applying a watermark.",
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
        expectedSourceBytes: sourceBytes,
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
    [document.bytes, getOpenToken, watermark],
  );

  const compressDocument = useCallback(
    async (options: PdfCompressOptions) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();

      if (!sourceBytes) {
        setSidecarStatus({
          running: false,
          message: "Open a PDF before compressing.",
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

        if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
          return false;
        }

        const replaced = await replaceBytes(compressedBytes, {
          dirty: true,
          hasTextLayer: null,
          expectedOpenToken: sourceOpenToken,
          expectedSourceBytes: sourceBytes,
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
        if (isCurrentDocument(sourceOpenToken, sourceBytes)) {
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
    [document.bytes, engineBridge, getOpenToken, isCurrentDocument, replaceBytes],
  );

  const sanitizeDocument = useCallback(async () => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();

    if (!sourceBytes) {
      setSidecarStatus({
        running: false,
        message: "Open a PDF before sanitizing.",
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

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
        return false;
      }

      const replaced = await replaceBytes(result.bytes, {
        dirty: true,
        hasTextLayer: null,
        expectedOpenToken: sourceOpenToken,
        expectedSourceBytes: sourceBytes,
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
      if (isCurrentDocument(sourceOpenToken, sourceBytes)) {
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
  }, [document.bytes, engineBridge, getOpenToken, isCurrentDocument, replaceBytes]);

  const repairDocument = useCallback(
    async () => {
      const source = repairCandidate ?? (document.bytes
        ? { bytes: document.bytes, name: document.fileName ?? "Repaired.pdf", path: null }
        : null);

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
        const opened = await openDocumentFile({
          bytes: repairedBytes,
          name: `Repaired ${source.name}`,
          path: null,
        });

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
    [document.bytes, document.fileName, engineBridge, openDocumentFile, repairCandidate],
  );

  const insertImageFilesAsPages = useCallback(
    async (files: readonly File[]) => {
      const sourceBytes = document.bytes;
      const sourceOpenToken = getOpenToken();

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

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
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
        expectedSourceBytes: sourceBytes,
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
    [document.bytes, document.currentPage, getOpenToken, insertImagePages, isCurrentDocument, selectedPageIndexes],
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

    if (!sourceBytes) {
      setScannerState({
        scanning: false,
        message: "Open a PDF before running the 2.425 scanner.",
        hits: [],
      });
      return;
    }

    const runId = scannerRunRef.current + 1;
    scannerRunRef.current = runId;
    const isCurrentScannerRun = () => (
      scannerRunRef.current === runId && isCurrentDocument(sourceOpenToken, sourceBytes)
    );

    setScannerState((current) => ({
      ...current,
      scanning: true,
      message: "Scanning extracted text...",
      hits: [],
    }));

    void (async () => {
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
  }, [document.bytes, getOpenToken, isCurrentDocument, pdfDocument]);

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

  const prepareFilingCopy = useCallback((
    certificate: CertificateOfServiceDraft | null,
    options: PrepareOptions,
  ) => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();
    const selectedSteps = new Set(options.selectedStepIds);
    const convertOutputToPdfA = selectedSteps.has("convert-pdfa");
    const customSplitBytes = options.customSplitMegabytes
      ? Math.round(options.customSplitMegabytes * 1024 * 1024)
      : null;

    if (!sourceBytes) {
      setFilingProgress({
        phase: "error",
        message: "Open a PDF before preparing a filing copy.",
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
      filingRunRef.current === runId && isCurrentDocument(sourceOpenToken, sourceBytes)
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
        if (!options.removeEncryptionPassword) {
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
          message: "Removing encryption with the password you entered...",
        });
        filingSourceBytes = await engineBridge.removeEncryption(
          sourceBytes,
          options.removeEncryptionPassword,
        );

        if (!isCurrentFilingRun()) {
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

        if (!isCurrentFilingRun()) {
          return;
        }

        if (unappliedRedactionMarks > 0 || (conversionImpact && hasPdfAConversionImpact(conversionImpact))) {
          setFilingImpact({
            conversionImpact,
            unappliedRedactionMarks,
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

        if (certificate && hasCertificateContent(certificate)) {
          const certificateBytes = await createCertificateOfServicePdf(certificate);
          const certificateHandle = await filingEngine.open(certificateBytes);
          closeHandles.push(certificateHandle);
          const pageCount = await filingEngine.pageCount(workingHandle);
          const appendedHandle = await filingEngine.insertPages(
            workingHandle,
            pageCount,
            certificateHandle,
          );
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
          workingHandle = await reopenFilingHandle(
            filingEngine,
            closeHandles,
            await engineBridge.runOcr(await filingEngine.saveToBytes(workingHandle), {
              ocrType: document.textLayerCoverage?.garbledPages.length ? "force-ocr" : "skip-text",
            }),
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

        for (const part of convertedParts) {
          if (!isCurrentFilingRun()) {
            return;
          }

          await filePort.saveFile(part.bytes, part.fileName, null);
        }

        if (!isCurrentFilingRun()) {
          return;
        }

        setFilingResult({
          parts: outputParts,
          report: finalReport,
          verifiedAt: new Date().toISOString(),
          skippedSteps: skippedPrepSteps(filingPrepPlan, selectedSteps),
          overrides: filingRunOverrides({
            customSplitBytes,
            packDefaultSplitBytes: filingPack.recommendedMaxFileBytes ?? filingPack.maxFileBytes ?? null,
            scrubbedBeforePdfA: selectedSteps.has("scrub-metadata") && selectedSteps.has("convert-pdfa"),
          }),
        });
        setFilingProgress({
          phase: "done",
          message: "Filing output saved after output preflight verification.",
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
    pendingRedactions.length,
  ]);

  const compressBeforeFiling = useCallback(() => {
    preserveFilingProgressForBytesRef.current = document.bytes;
    setFilingProgress({
      phase: "normalizing",
      message: "Compressing before the split check...",
    });

    void compressDocument({ quality: 5, grayscale: false }).then((compressed) => {
      if (!compressed) {
        preserveFilingProgressForBytesRef.current = null;
      }

      setFilingProgress({
        phase: compressed ? "idle" : "error",
        message: compressed
          ? "Compression complete. Preflight will re-run on the compressed document."
          : "Compression could not finish. The document was left unchanged.",
      });
    });
  }, [compressDocument, document.bytes]);

  const undoLastPendingEdit = useCallback(() => {
    const lastEdit = editing.pendingEdits[editing.pendingEdits.length - 1];

    if (lastEdit) {
      editing.removeEdit(lastEdit.id);
    }
  }, [editing]);

  const exportPdfA = useCallback(() => {
    if (!document.bytes) {
      setError("Open a PDF before exporting PDF/A.");
      return;
    }

    prepareFilingCopy(null, {
      selectedStepIds: [
        ...filingPrepPlan
          .filter((step) => step.defaultChecked && !step.disabledReason)
          .map((step) => step.id),
        "convert-pdfa",
      ],
      customSplitMegabytes: null,
    });
  }, [document.bytes, filingPrepPlan, prepareFilingCopy, setError]);

  const showPasswordProtection = useCallback(() => {
    setActiveOrganizeTool(null);
    setActiveLegalTool("passwords");
  }, []);

  const fitToPageWidth = useCallback(() => {
    if (!document.bytes) {
      return;
    }

    setFitZoom(document.zoom);
  }, [document.bytes, document.zoom, setFitZoom]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.defaultPrevented || isTextEntryTarget(event.target)) {
        return;
      }

      if (!document.bytes) {
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
  }, [document.bytes, document.zoom, fitToPageWidth, setZoom]);

  const openAboutMacrify = useCallback(() => {
    setSettingsFocusSection("about-macrify");
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
          setSettingsFocusSection("open-raio-to-ai");
          setSettingsOpen(true);
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
        >
          <PrepareForFilingWorkspace
            document={document}
            pack={filingPack}
            availablePacks={AVAILABLE_FILING_PACKS}
            prepPlan={filingPrepPlan}
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
            onDismissImpact={() => setFilingImpact(null)}
            onCompressFirst={compressBeforeFiling}
            onHelpRequested={() => openHelp("prepare-for-filing")}
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
            currentFile={document.bytes ? {
              bytes: document.bytes,
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
            currentFile={document.bytes ? {
              bytes: document.bytes,
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
            hasDocument={Boolean(document.bytes)}
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
            hasDocument={Boolean(document.bytes)}
            available={engineBridge.available}
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

    if (activeEditDialogTool === "page-numbers") {
      return (
        <FloatingDialog title="Page Numbers" eyebrow="Edit" onClose={closeWorkspace} onHelp={() => openHelp("page-numbers")}>
          <PageNumbersPanel
            hasDocument={Boolean(document.bytes)}
            pageCount={document.pageCount}
            status={sidecarStatus}
            onApply={applyPageNumbers}
          />
        </FloatingDialog>
      );
    }

    if (activeEditDialogTool === "watermark") {
      return (
        <FloatingDialog title="Watermark" eyebrow="Edit" onClose={closeWorkspace} onHelp={() => openHelp("watermark")}>
          <WatermarkPanel
            hasDocument={Boolean(document.bytes)}
            pageCount={document.pageCount}
            status={sidecarStatus}
            onApply={applyWatermark}
          />
        </FloatingDialog>
      );
    }

    if (activeOrganizeTool === "compress") {
      return (
        <FloatingDialog title="Compress" eyebrow="Organize" onClose={closeWorkspace} onHelp={() => openHelp("compress")}>
          <CompressPanel
            hasDocument={Boolean(document.bytes)}
            available={engineBridge.available}
            status={sidecarStatus}
            onCompress={compressDocument}
          />
        </FloatingDialog>
      );
    }

    if (activeOrganizeTool === "repair") {
      return (
        <FloatingDialog title="Repair" eyebrow="Organize" onClose={closeWorkspace} onHelp={() => openHelp("repair")}>
          <RepairPanel
            hasSource={Boolean(repairCandidate || document.bytes)}
            available={engineBridge.available}
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
        onZoomOut={() => setZoom(document.zoom - ZOOM_STEP)}
        onZoomIn={() => setZoom(document.zoom + ZOOM_STEP)}
        onFitZoomResolved={setFitZoom}
        onPageSizeChange={setPageSizeInches}
        onRenderError={setError}
        onThumbnailClick={handleThumbnailClick}
        onRotateSelected={rotateSelected}
        onDeleteSelected={deleteSelected}
        onMoveSelectedUp={() => moveSelected(-1)}
        onMoveSelectedDown={() => moveSelected(1)}
        ocrState={ocrState}
        ocrAvailable={engineBridge.ocrAvailable}
        ocrStarting={engineBridge.starting}
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

type SidecarStatus = {
  running: boolean;
  message: string | null;
  removed: readonly PdfSanitizeRemovedItem[];
  beforeBytes: number | null;
  afterBytes: number | null;
};

function PageNumbersPanel({
  hasDocument,
  pageCount,
  status,
  onApply,
}: {
  hasDocument: boolean;
  pageCount: number;
  status: SidecarStatus;
  onApply: (options: PdfPageNumbersOptions) => Promise<boolean>;
}) {
  const [range, setRange] = useState(formatDefaultRange(pageCount));
  const [format, setFormat] = useState<PdfPageNumbersOptions["format"]>("number");
  const [startAt, setStartAt] = useState(1);
  const [fontSizePt, setFontSizePt] = useState(11);
  const [placement, setPlacement] = useState<PdfPageNumbersOptions["placement"]>({
    edge: "footer",
    align: "center",
  });
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parsePageRanges(range, pageCount), [pageCount, range]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);

    if (parsed.error) {
      return;
    }

    await onApply({
      startAt,
      pageIndexes: parsed.pageIndexes,
      format,
      placement,
      fontSizePt,
    });
  }

  return (
    <form className="tool-panel__inline-card" onSubmit={submit}>
      <div className="tool-panel__field">
        <label htmlFor="page-number-range">Pages</label>
        <input id="page-number-range" value={range} onBlur={() => setTouched(true)} onChange={(event) => setRange(event.target.value)} />
        {touched && parsed.error ? <span className="tool-panel__field-error">{parsed.error}</span> : null}
      </div>
      <div className="tool-panel__field-grid">
        <div className="tool-panel__field">
          <label htmlFor="page-number-start">Start at</label>
          <input id="page-number-start" type="number" min="0" value={startAt} onChange={(event) => setStartAt(Number(event.target.value))} />
        </div>
        <div className="tool-panel__field">
          <label htmlFor="page-number-size">Font size</label>
          <input id="page-number-size" type="number" min="1" value={fontSizePt} onChange={(event) => setFontSizePt(Number(event.target.value))} />
        </div>
      </div>
      <div className="tool-panel__field">
        <label htmlFor="page-number-format">Format</label>
        <select id="page-number-format" value={format} onChange={(event) => setFormat(event.target.value as PdfPageNumbersOptions["format"])}>
          <option value="number">1, 2, 3</option>
          <option value="page-of-total">Page N of M</option>
        </select>
      </div>
      <div className="tool-panel__field">
        <label htmlFor="page-number-position">Position</label>
        <select id="page-number-position" value={`${placement.edge}-${placement.align}`} onChange={(event) => setPlacement(parsePlacementValue(event.target.value))}>
          <option value="footer-left">Footer left</option>
          <option value="footer-center">Footer center</option>
          <option value="footer-right">Footer right</option>
          <option value="header-left">Header left</option>
          <option value="header-center">Header center</option>
          <option value="header-right">Header right</option>
        </select>
      </div>
      <SidecarStatusLine status={status} label="Applying page numbers" />
      <button type="submit" className="tool-panel__primary-button" disabled={!hasDocument || status.running}>
        Apply Page Numbers
      </button>
    </form>
  );
}

function WatermarkPanel({
  hasDocument,
  pageCount,
  status,
  onApply,
}: {
  hasDocument: boolean;
  pageCount: number;
  status: SidecarStatus;
  onApply: (options: PdfWatermarkOptions) => Promise<boolean>;
}) {
  const [text, setText] = useState("DRAFT");
  const [range, setRange] = useState(formatDefaultRange(pageCount));
  const [orientation, setOrientation] = useState<PdfWatermarkOptions["orientation"]>("diagonal");
  const [opacity, setOpacity] = useState(0.18);
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parsePageRanges(range, pageCount), [pageCount, range]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);

    if (parsed.error || !text.trim()) {
      return;
    }

    await onApply({
      text: text.trim(),
      pageIndexes: parsed.pageIndexes,
      orientation,
      opacity,
    });
  }

  return (
    <form className="tool-panel__inline-card" onSubmit={submit}>
      <div className="tool-panel__button-row">
        <button type="button" className="tool-panel__secondary-button" onClick={() => setText("DRAFT")}>DRAFT</button>
        <button type="button" className="tool-panel__secondary-button" onClick={() => setText("CONFIDENTIAL")}>CONFIDENTIAL</button>
      </div>
      <div className="tool-panel__field">
        <label htmlFor="watermark-text">Text</label>
        <input id="watermark-text" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <div className="tool-panel__field">
        <label htmlFor="watermark-range">Pages</label>
        <input id="watermark-range" value={range} onBlur={() => setTouched(true)} onChange={(event) => setRange(event.target.value)} />
        {touched && parsed.error ? <span className="tool-panel__field-error">{parsed.error}</span> : null}
      </div>
      <div className="tool-panel__field-grid">
        <div className="tool-panel__field">
          <label htmlFor="watermark-orientation">Direction</label>
          <select id="watermark-orientation" value={orientation} onChange={(event) => setOrientation(event.target.value as PdfWatermarkOptions["orientation"])}>
            <option value="diagonal">Diagonal</option>
            <option value="horizontal">Horizontal</option>
          </select>
        </div>
        <div className="tool-panel__field">
          <label htmlFor="watermark-opacity">Opacity</label>
          <input id="watermark-opacity" type="number" min="0.05" max="1" step="0.05" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
        </div>
      </div>
      <SidecarStatusLine status={status} label="Applying watermark" />
      <button type="submit" className="tool-panel__primary-button" disabled={!hasDocument || status.running}>
        Apply Watermark
      </button>
    </form>
  );
}

function CompressPanel({
  hasDocument,
  available,
  status,
  onCompress,
}: {
  hasDocument: boolean;
  available: boolean;
  status: SidecarStatus;
  onCompress: (options: PdfCompressOptions) => Promise<boolean>;
}) {
  const [quality, setQuality] = useState(5);
  const [grayscale, setGrayscale] = useState(false);

  return (
    <div className="tool-panel__inline-card">
      {!available ? <DesktopCapabilityMessage /> : null}
      <div className="tool-panel__field">
        <label htmlFor="compress-quality">Quality</label>
        <input id="compress-quality" type="number" min="1" max="9" value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
      </div>
      <label className="tool-panel__check-row">
        <input type="checkbox" checked={grayscale} onChange={(event) => setGrayscale(event.target.checked)} />
        Grayscale
      </label>
      {status.beforeBytes !== null && status.afterBytes !== null ? (
        <p className="tool-panel__status-line">
          {formatBytes(status.beforeBytes)} to {formatBytes(status.afterBytes)}
        </p>
      ) : null}
      <SidecarStatusLine status={status} label="Compressing PDF" />
      <button type="button" className="tool-panel__primary-button" disabled={!hasDocument || !available || status.running} onClick={() => void onCompress({ quality, grayscale })}>
        Compress PDF
      </button>
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
    { label: "Encryption", value: document.bytes ? "Not encrypted" : "Not set" },
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

function DesktopCapabilityMessage() {
  return (
    <p className="tool-panel__status-line">
      This action is available in the desktop app.
    </p>
  );
}

function SidecarStatusLine({
  status,
  label,
}: {
  status: SidecarStatus;
  label: string;
}) {
  if (!status.message) {
    return null;
  }

  return (
    <p className="tool-panel__status-line tool-panel__status-line--inline">
      {status.running ? <LoadingSun size={13} label={label} /> : null}
      {status.message}
    </p>
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
    extractTextLayerCoverage: (bytes) => extractUiTextLayerCoverage(bytes, currentPdfDocument),
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

async function extractUiTextLayerCoverage(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null,
): Promise<NonNullable<DocumentFacts["textLayerCoverage"]>> {
  return withPdfDocument(bytes, currentPdfDocument, async (pdfDocument) => {
    const imageOnlyPages: number[] = [];
    const mixedPages: number[] = [];
    const textPages: number[] = [];
    const garbledPages: NonNullable<DocumentFacts["textLayerCoverage"]>["garbledPages"][number][] = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map(textItemString).join(" ");
      const hasText = pageText.trim().length > 0;
      const operatorList = await page.getOperatorList();
      const hasImage = operatorList.fnArray.some(isImageOperator);
      const pageIndex = pageNumber - 1;
      const garbleInfo = scoreGarbledPage(pageText, pageIndex);
      if (garbleInfo) {
        garbledPages.push(garbleInfo);
      }

      if (!hasText) {
        imageOnlyPages.push(pageIndex);
      } else if (hasImage) {
        mixedPages.push(pageIndex);
      } else {
        textPages.push(pageIndex);
      }
    }

    return { imageOnlyPages, mixedPages, textPages, garbledPages };
  });
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

function isImageOperator(fn: number): boolean {
  return fn === OPS.paintImageXObject ||
    fn === OPS.paintInlineImageXObject ||
    fn === OPS.paintInlineImageXObjectGroup ||
    fn === OPS.paintImageMaskXObject ||
    fn === OPS.paintImageMaskXObjectGroup ||
    fn === OPS.paintImageXObjectRepeat ||
    fn === OPS.paintImageMaskXObjectRepeat;
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

function parsePlacementValue(value: string): PdfPageNumbersOptions["placement"] {
  const [edge, align] = value.split("-");

  return {
    edge: edge === "header" ? "header" : "footer",
    align: align === "left" || align === "right" ? align : "center",
  };
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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
