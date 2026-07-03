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
import { getPack, getPackIntegrityBanner, preflight } from "@raiopdf/rules";
import type {
  DocumentFacts,
  JurisdictionPack,
  PageFacts,
  PreflightCheck,
  PreflightReport,
  RectInches,
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
  type FilingOutputPart,
  type FilingProgressState,
  type FilingResultState,
} from "./components/PrepareForFilingWorkspace";
import { SettingsDialog } from "./components/SettingsDialog";
import { EditModeBar } from "./components/EditModeBar";
import { FloatingDialog } from "./components/FloatingDialog";
import { LoadingSun } from "./components/LoadingSun";
import {
  isEngineBridgeUnavailableError,
  useEngineBridge,
} from "./hooks/useEngineBridge";
import { useDocument, type DocumentState } from "./hooks/useDocument";
import { useDocumentSearch } from "./hooks/useDocumentSearch";
import { useEditing } from "./hooks/useEditing";
import type { EditToolId } from "./lib/edits";
import { formatDefaultRange, parsePageRanges } from "./lib/pageRanges";
import {
  getPdfLoadErrorMessage,
  loadPdfDocument,
  type PDFDocumentProxy,
} from "./lib/pdfjs";
import { filePort, readBrowserFile, type OpenedFile } from "./lib/filePort";
import {
  hasExtractableTextLayer,
  pdfDocumentHasTextLayer,
} from "./lib/textLayer";
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
  | "starting-engine"
  | "processing"
  | "verifying"
  | "done"
  | "error";

export interface OcrUiState {
  phase: OcrPhase;
  message: string | null;
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
  searchableText?: boolean;
  pdfaCompliant?: boolean;
  pdfDocument?: PDFDocumentProxy | null;
  occupiedRegionPages?: "first" | "all";
}

export function App() {
  const {
    document,
    openFile: openDocumentFile,
    replaceBytes,
    getOpenToken,
    setCurrentPage,
    setZoom,
    setFitZoom,
    setHasTextLayer,
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
  const [ocrState, setOcrState] = useState<OcrUiState>({
    phase: "idle",
    message: null,
  });
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
  const [filingReport, setFilingReport] = useState<PreflightReport | null>(null);
  const [filingReportLoading, setFilingReportLoading] = useState(false);
  const [filingProgress, setFilingProgress] = useState<FilingProgressState>({
    phase: "idle",
    message: null,
  });
  const [filingResult, setFilingResult] = useState<FilingResultState | null>(null);
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
  const [settingsFocusSection, setSettingsFocusSection] = useState<
    "open-raio-to-ai" | null
  >(null);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpPath, setMcpPath] = useState<string | null>(null);
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
        }
      } catch {
        // Non-Tauri/dev context or command unavailable -- keep the safe default (off).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);
  const handleToggleMcpEnabled = useCallback((next: boolean) => {
    setMcpEnabled(next);
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("mcp_set_enabled", { enabled: next });
      } catch {
        setMcpEnabled(!next);
      }
    })();
  }, []);
  const ocrRunRef = useRef(0);
  const ocrActiveRef = useRef(false);
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
    setFilingProgress({ phase: "idle", message: null });
    setFilingResult(null);
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
    setFilingResult(null);
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
    if (!pdfDocument) {
      return;
    }

    let disposed = false;

    void pdfDocumentHasTextLayer(pdfDocument)
      .then((hasTextLayer) => {
        if (disposed) {
          return;
        }

        setHasTextLayer(hasTextLayer);
      })
      .catch(() => {
        if (!disposed) {
          setHasTextLayer(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [pdfDocument, setHasTextLayer]);

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
      return;
    }

    if (!sourceBytes) {
      setFilingReport(null);
      setFilingReportLoading(false);
      return;
    }

    const factsOptions: FilingFactsOptions = {
      fileBytes: document.fileSizeBytes ?? sourceBytes.byteLength,
      pdfaCompliant: false,
      pdfDocument: pdfDocumentBytes === sourceBytes ? pdfDocument : null,
    };

    if (document.hasTextLayer !== null) {
      factsOptions.searchableText = document.hasTextLayer;
      factsOptions.occupiedRegionPages = "first";
    }

    setFilingReportLoading(true);

    void getCachedFilingFacts(filingFactsCacheRef, sourceBytes, factsOptions)
      .then((facts) => {
        if (disposed || documentBytesRef.current !== sourceBytes) {
          return;
        }

        setFilingReport(runFilingPreflight(facts, FLORIDA_PACK));
      })
      .catch(() => {
        if (!disposed && documentBytesRef.current === sourceBytes) {
          setFilingReport(null);
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
  }, [activeLegalTool, document.bytes, document.fileSizeBytes, document.hasTextLayer, pdfDocument, pdfDocumentBytes]);

  const makeSearchable = useCallback(() => {
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
    const finishCurrentRun = () => {
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
        onEngineReady: () => {
          if (isCurrentRun()) {
            setOcrState({
              phase: "processing",
              message: "Making searchable — page-by-page work happens in the engine.",
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

        const hasTextLayer = await hasExtractableTextLayer(ocrBytes);

        if (!isCurrentRun()) {
          return;
        }

        if (!hasTextLayer) {
          finishCurrentRun();
          setOcrState({
            phase: "error",
            message: "OCR produced no text layer. The document was left unchanged.",
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
          finishCurrentRun();
          setOcrState({
            phase: "error",
            message: "The document changed before OCR finished. The result was not applied.",
          });
          return;
        }

        if (replaced === "failed") {
          finishCurrentRun();
          setOcrState({
            phase: "error",
            message: "The searchable PDF could not be opened. The document was left unchanged.",
          });
          return;
        }

        setSelectedPageIndexes(new Set([0]));
        finishCurrentRun();
        setOcrState({
          phase: "done",
          message: "Searchable — verified",
        });
      })
      .catch((error: unknown) => {
        if (!isCurrentRun()) {
          return;
        }

        if (isEngineBridgeUnavailableError(error)) {
          finishCurrentRun();
          setOcrState({
            phase: "error",
            message: error.message,
          });
          return;
        }

        const message = error instanceof Error
          ? error.message
          : "OCR could not finish. The document was left unchanged.";

        finishCurrentRun();
        setOcrState({
          phase: "error",
          message,
        });
      });
  }, [document.bytes, engineBridge, getOpenToken, replaceBytes]);

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

  const deleteSelected = useCallback(() => {
    const indexes = selectedIndexes();

    if (indexes.length === 0) {
      return;
    }

    if (indexes.length >= document.pageCount) {
      setError("A document must keep at least one page.");
      return;
    }

    const confirmed = window.confirm(
      `Delete ${indexes.length} selected ${indexes.length === 1 ? "page" : "pages"}?`,
    );

    if (!confirmed) {
      return;
    }

    const nextSelectedPageIndex = Math.max(
      0,
      Math.min(indexes[0] ?? 0, document.pageCount - indexes.length - 1),
    );

    void deletePages(indexes).then((deleted) => {
      if (deleted) {
        setSelectedPageIndexes(new Set([nextSelectedPageIndex]));
      }
    });
  }, [deletePages, document.pageCount, selectedIndexes, setError]);

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

  const saveToFile = useCallback((currentPath: string | null) => {
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

      const saved = await saveDocument();

      if (!saved) {
        return;
      }

      const written = await filePort.saveFile(
        saved.bytes,
        saved.fileName,
        currentPath,
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
    saveToFile(document.filePath);
  }, [document.filePath, saveToFile]);

  const saveAs = useCallback(() => {
    saveToFile(null);
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

      if (toolId === "combine-exhibits") {
        setActiveOrganizeTool(null);
      }
    },
    [editing],
  );

  const selectOrganizeTool = useCallback((toolId: OrganizeToolId) => {
    if (toolId === "rotate") {
      rotateSelected();
      setActiveOrganizeTool(null);
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
        : error instanceof Error
          ? error.message
          : "Redaction could not finish. The document was left unchanged.";

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
        return;
      }

      setRedactionPhase("error");
      setRedactionMessage(message);
    }
  }, [document.bytes, engineBridge, getOpenToken, isCurrentDocument, pdfDocument, pendingRedactions, replaceBytes]);

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

  const prepareFilingCopy = useCallback((certificate: CertificateOfServiceDraft | null) => {
    const sourceBytes = document.bytes;
    const sourceOpenToken = getOpenToken();

    if (!sourceBytes) {
      setFilingProgress({
        phase: "error",
        message: "Open a PDF before preparing a filing copy.",
      });
      return;
    }

    if (!engineBridge.available) {
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

    setFilingResult(null);
    setFilingProgress({
      phase: "normalizing",
      message: "Normalizing pages to the filing pack size and orientation...",
    });

    void (async () => {
      let workingHandle: PdfDocumentHandle;
      const closeHandles: PdfDocumentHandle[] = [];

      try {
        workingHandle = await filingEngine.open(sourceBytes);
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

        const normalizedHandle = await filingEngine.normalizePages(workingHandle, {
          targetSize: FLORIDA_PACK.pageSize,
          orientation: "portrait",
        });
        closeHandles.push(normalizedHandle);
        workingHandle = normalizedHandle;

        if (!isCurrentFilingRun()) {
          return;
        }

        setFilingProgress({
          phase: "splitting",
          message: "Splitting at page boundaries against the portal byte cap...",
        });

        const splitResult = await filingEngine.splitByMaxBytes(
          workingHandle,
          FLORIDA_PACK.recommendedMaxFileBytes,
        );
        closeHandles.push(...splitResult.parts.map((part) => part.document));

        if (!isCurrentFilingRun()) {
          return;
        }

        setFilingProgress({
          phase: "converting",
          message: "Converting each output part to PDF/A in the desktop engine...",
        });

        const baseName = stripPdfExtension(document.fileName ?? "Untitled");
        const convertedParts = [];

        for (const [index, part] of splitResult.parts.entries()) {
          const partBytes = await filingEngine.saveToBytes(part.document);
          const convertedBytes = await engineBridge.convertToPdfA(
            partBytes,
            FLORIDA_PACK.pdfa.flavor,
          );
          convertedParts.push({
            bytes: convertedBytes,
            fileName: formatFilingOutputName(baseName, FLORIDA_PACK, index + 1, splitResult.parts.length),
            pageIndexes: part.pageIndexes,
            oversized: part.oversized,
          });
        }

        if (!isCurrentFilingRun()) {
          return;
        }

        setFilingProgress({
          phase: "verifying",
          message: "Re-running preflight on the output files...",
        });

        const outputReports: PreflightReport[] = [];
        const outputParts: FilingOutputPart[] = [];

        for (const part of convertedParts) {
          const facts = await getCachedFilingFacts(filingFactsCacheRef, part.bytes, {
            fileBytes: part.bytes.byteLength,
            pdfaCompliant: true,
          });
          const report = runFilingPreflight(facts, FLORIDA_PACK);
          outputReports.push(report);
          outputParts.push({
            fileName: part.fileName,
            byteLength: part.bytes.byteLength,
            pageIndexes: part.pageIndexes,
            oversized: part.oversized,
          });
        }

        const finalReport = aggregateOutputReports(outputReports);

        if (hasPortalFix(finalReport)) {
          setFilingProgress({
            phase: "error",
            message: "Output preflight still found portal work. The files were not saved.",
          });
          setFilingResult({
            parts: outputParts,
            report: finalReport,
            verifiedAt: new Date().toISOString(),
          });
          return;
        }

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
        : error instanceof Error
          ? error.message
          : "The filing copy could not be prepared.";

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
    getOpenToken,
    isCurrentDocument,
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

    prepareFilingCopy(null);
  }, [document.bytes, prepareFilingCopy, setError]);

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
        case "file:preferences":
          setSettingsFocusSection(null);
          setSettingsOpen(true);
          break;
        case "file:open-raio-to-ai":
          setSettingsFocusSection("open-raio-to-ai");
          setSettingsOpen(true);
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
      onMoveSelectedUp={() => moveSelected(-1)}
      onMoveSelectedDown={() => moveSelected(1)}
      onReorderPages={reorderPagesFromGrid}
      onMerge={mergeWithFiles}
      onExtract={extractPages}
      onSplit={splitAndSavePages}
      onInsert={insertFile}
      onExportPageAsImage={exportPageAsImage}
      onCropResize={cropResize}
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
        >
          <PrepareForFilingWorkspace
            document={document}
            pack={FLORIDA_PACK}
            report={filingReport}
            loadingReport={filingReportLoading}
            progress={filingProgress}
            result={filingResult}
            pdfAAvailable={engineBridge.available}
            compressAvailable={engineBridge.available}
            onPrepare={prepareFilingCopy}
            onCompressFirst={compressBeforeFiling}
          />
        </FloatingDialog>
      );
    }

    if (activeLegalTool === "bates-numbering") {
      return (
        <FloatingDialog title="Bates Numbering" eyebrow="Legal" onClose={closeWorkspace}>
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
        <FloatingDialog title="Scrub Metadata" eyebrow="Legal" onClose={closeWorkspace}>
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
        <FloatingDialog title="Sanitize" eyebrow="Legal" onClose={closeWorkspace}>
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
        <FloatingDialog title="Passwords" eyebrow="Legal" onClose={closeWorkspace}>
          <PasswordsPanel />
        </FloatingDialog>
      );
    }

    if (activeEditDialogTool === "page-numbers") {
      return (
        <FloatingDialog title="Page Numbers" eyebrow="Edit" onClose={closeWorkspace}>
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
        <FloatingDialog title="Watermark" eyebrow="Edit" onClose={closeWorkspace}>
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
        <FloatingDialog title="Compress" eyebrow="Organize" onClose={closeWorkspace}>
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
        <FloatingDialog title="Repair" eyebrow="Organize" onClose={closeWorkspace}>
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
        <FloatingDialog title="Insert Images as Pages" eyebrow="Organize" onClose={closeWorkspace}>
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
        <FloatingDialog title="Document Properties" eyebrow="Organize" onClose={closeWorkspace}>
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
      />
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
        />
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
    { label: "Searchable", value: document.hasTextLayer === null ? "Not checked" : document.hasTextLayer ? "Yes" : "No" },
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
    searchableText: options.searchableText ?? null,
    pdfaCompliant: options.pdfaCompliant ?? null,
    occupiedRegionPages: options.occupiedRegionPages ?? "all",
  });
}

async function readFilingFacts(
  bytes: Uint8Array,
  options: FilingFactsOptions,
): Promise<DocumentFacts> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pdfPages = pdf.getPages();
  const occupiedRegionPageIndexes = options.occupiedRegionPages === "first" && pdfPages.length > 0
    ? [0]
    : undefined;
  const pageOccupiedRegions = await readOccupiedRegions(
    bytes,
    options.pdfDocument ?? null,
    occupiedRegionPageIndexes,
  );
  const pages: PageFacts[] = pdfPages.map((page, pageIndex) => {
    const widthIn = page.getWidth() / POINTS_PER_INCH;
    const heightIn = page.getHeight() / POINTS_PER_INCH;
    const occupiedRegions = pageOccupiedRegions.get(pageIndex);
    const pageFacts: PageFacts = {
      pageIndex,
      size: {
        w: roundInches(widthIn),
        h: roundInches(heightIn),
        in: true,
      },
      orientation: heightIn >= widthIn ? "portrait" : "landscape",
    };

    if (occupiedRegions) {
      pageFacts.occupiedRegions = occupiedRegions;
    }

    return pageFacts;
  });
  const hasExtractedText = [...pageOccupiedRegions.values()].some((regions) => regions.length > 0);
  const facts: DocumentFacts = {
    pages,
    fileBytes: options.fileBytes,
  };

  facts.searchableText = options.searchableText ?? hasExtractedText;

  if (options.pdfaCompliant !== undefined) {
    facts.pdfaCompliant = options.pdfaCompliant;
  }

  if (pageOccupiedRegions.has(0)) {
    facts.clerkStampSpaceBlank = !pageOccupiedRegions
      .get(0)!
      .some((region) => intersects(region, FLORIDA_PACK.clerkStampSpace.firstPage));
  }

  return facts;
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

function runFilingPreflight(facts: DocumentFacts, pack: JurisdictionPack): PreflightReport {
  window.__RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__ =
    (window.__RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__ ?? 0) + 1;

  return preflight(facts, pack);
}

function formatRedactionVerificationSuccess(result: RedactionVerificationResult): string {
  const textLayer = result.textLayer.status === "pass"
    ? "text layer verified clean"
    : "no source text was extractable from marked areas";

  return [
    `Redacted and verified: ${textLayer}`,
    "redacted page images replaced",
    "annotations cleaned",
    "metadata scrubbed",
  ].join("; ") + ".";
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

function aggregateOutputReports(reports: readonly PreflightReport[]): PreflightReport {
  const [firstReport] = reports;

  if (!firstReport) {
    return { checks: [] };
  }

  return {
    checks: firstReport.checks.map((firstCheck) => {
      const matchingChecks = reports
        .map((report) => report.checks.find((check) => check.checkId === firstCheck.checkId))
        .filter((check): check is PreflightCheck => Boolean(check));
      const failedChecks = matchingChecks.filter((check) => check.status !== "pass");

      return {
        ...firstCheck,
        status: aggregateStatus(firstCheck, matchingChecks),
        detail: failedChecks.length === 0
          ? `All ${reports.length} output ${reports.length === 1 ? "file passes" : "files pass"}.`
          : failedChecks.map((check, index) => `Part ${index + 1}: ${check.detail}`).join(" "),
      } as PreflightCheck;
    }),
  };
}

function aggregateStatus(
  firstCheck: PreflightCheck,
  checks: readonly PreflightCheck[],
): PreflightCheck["status"] {
  if (firstCheck.kind === "portal") {
    if (checks.some((check) => check.status === "fix")) {
      return "fix";
    }

    if (checks.some((check) => check.status === "unknown")) {
      return "unknown";
    }

    return "pass";
  }

  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }

  if (checks.some((check) => check.status === "unknown")) {
    return "unknown";
  }

  return "pass";
}

function hasPortalFix(report: PreflightReport): boolean {
  return report.checks.some((check) => check.kind === "portal" && check.status === "fix");
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

function roundInches(value: number): number {
  return Math.round(value * 100) / 100;
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

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
