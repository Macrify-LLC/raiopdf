import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import type { PdfBatesStampOptions, PdfRedactionArea } from "@raiopdf/engine-api";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import { LocalPdfEngine } from "@raiopdf/engine-local";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { floridaPack, preflight } from "@raiopdf/rules";
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
import {
  isEngineBridgeUnavailableError,
  useEngineBridge,
} from "./hooks/useEngineBridge";
import { useDocument } from "./hooks/useDocument";
import { useEditing } from "./hooks/useEditing";
import type { EditToolId } from "./lib/edits";
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
  extractTextBoxes,
  findTextRedactionAreas,
  readMetadataSummary,
  scanSensitivePatterns,
  verifyRedactionAreasClear,
  type PdfMetadataSummary,
  type SensitiveHit,
} from "./lib/legalTools";
import type { LegalToolId, OrganizeToolId } from "./components/ToolPanel";
import type {
  BatesPanelState,
  RedactionPanelState,
  ScannerPanelState,
  ScrubMetadataPanelState,
} from "./components/ToolPanel";
import { SearchIcon } from "./icons";
import "./components/LegalModeBar.css";

const ZOOM_STEP = 0.25;
const FLORIDA_PACK: JurisdictionPack = floridaPack;
const POINTS_PER_INCH = 72;

declare global {
  interface Window {
    __RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__?: number;
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
    save: saveDocument,
    markSaved,
  } = useDocument();
  const engineBridge = useEngineBridge();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const editing = useEditing(pdfDocument);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ocrRunRef = useRef(0);
  const ocrActiveRef = useRef(false);
  const savingRef = useRef(false);
  const redactionIdRef = useRef(0);
  const documentBytesRef = useRef<Uint8Array | null>(null);
  const scannerRunRef = useRef(0);
  const filingRunRef = useRef(0);
  const filingEngine = useMemo(() => new LocalPdfEngine(), []);

  useLayoutEffect(() => {
    documentBytesRef.current = document.bytes;
  }, [document.bytes]);

  const resetLegalState = useCallback(() => {
    setPendingRedactions([]);
    setRedactionPhase("idle");
    setRedactionMessage(null);
    setRedactionSearchOpen(false);
    setRedactionSearchText("");
    setScannerState({ scanning: false, message: null, hits: [] });
    setBatesState({ applying: false, message: null });
    setScrubState({ scrubbing: false, message: null, removedFields: [] });
    setFilingProgress({ phase: "idle", message: null });
    setFilingResult(null);
  }, []);

  const clearDocumentBoundLegalState = useCallback(() => {
    scannerRunRef.current += 1;
    filingRunRef.current += 1;
    setPendingRedactions([]);
    setScannerState({ scanning: false, message: null, hits: [] });
    setFilingResult(null);
    setFilingProgress({ phase: "idle", message: null });
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

    if (!document.bytes) {
      setPdfDocument(null);
      return;
    }

    setPdfDocument(null);

    void loadPdfDocument(document.bytes)
      .then((loaded) => {
        loadedDocument = loaded;

        if (disposed) {
          void loaded.loadingTask.destroy();
          return;
        }

        setPdfDocument(loaded);
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
    clearDocumentBoundLegalState();
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

    if (!sourceBytes) {
      setFilingReport(null);
      setFilingReportLoading(false);
      return;
    }

    setFilingReportLoading(true);

    const factsOptions: {
      fileBytes: number;
      searchableText?: boolean;
      pdfaCompliant?: boolean;
      pdfDocument?: PDFDocumentProxy | null;
    } = {
      fileBytes: document.fileSizeBytes ?? sourceBytes.byteLength,
      pdfaCompliant: false,
      pdfDocument,
    };

    if (document.hasTextLayer !== null) {
      factsOptions.searchableText = document.hasTextLayer;
    }

    void readFilingFacts(sourceBytes, factsOptions)
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
  }, [document.bytes, document.fileSizeBytes, document.hasTextLayer, pdfDocument]);

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
          : "OCR runs in the desktop app.",
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
          setSelectedPageIndexes(new Set([0]));
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
    setActiveOrganizeTool(toolId);
    setActiveLegalTool(null);
  }, []);

  const closeWorkspace = useCallback(() => {
    setActiveOrganizeTool(null);

    if (activeLegalTool === "combine-exhibits") {
      setActiveLegalTool(null);
    }
  }, [activeLegalTool]);

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

      const areas = await findTextRedactionAreas(pdfDocument, redactionSearchText);

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
      setRedactionMessage("True redaction runs in the desktop app.");
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
    setRedactionMessage("Applying redactions and verifying removed text...");

    try {
      const redactedBytes = await engineBridge.redactAreas(sourceBytes, areas);

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
        return;
      }

      const verified = await verifyRedactionAreasClear(redactedBytes, areas);

      if (!isCurrentDocument(sourceOpenToken, sourceBytes)) {
        return;
      }

      if (!verified) {
        setRedactionPhase("error");
        setRedactionMessage("Verification failed — text may remain. The document was NOT modified.");
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
      setRedactionMessage("Redacted and verified — the removed text no longer exists in the file.");
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
  }, [document.bytes, engineBridge, getOpenToken, isCurrentDocument, pendingRedactions, replaceBytes]);

  const applyBates = useCallback(
    async (options: PdfBatesStampOptions) => {
      setBatesState({ applying: true, message: "Applying Bates numbers..." });
      const applied = await batesStamp(options);
      setBatesState({
        applying: false,
        message: applied
          ? "Bates numbers applied."
          : "Bates numbers could not be applied. Check the format and try again.",
      });

      return applied;
    },
    [batesStamp],
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
        return await scanSensitivePatterns(scanDocument);
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
        message: "PDF/A export runs in the desktop app.",
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
          const facts = await readFilingFacts(part.bytes, {
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
    setActiveLegalTool(null);
    setActiveOrganizeTool("passwords");
  }, []);

  const fitToPageWidth = useCallback(() => {
    if (!document.bytes) {
      return;
    }

    setFitZoom(document.zoom);
  }, [document.bytes, document.zoom, setFitZoom]);

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
        case "file:preferences":
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
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("raiopdf-menu", (event) => {
        handleNativeMenuCommand(event.payload);
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
  }, [handleNativeMenuCommand]);

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

  const workspace = activeLegalTool === "prepare-for-filing" ? (
    <PrepareForFilingWorkspace
      document={document}
      pack={FLORIDA_PACK}
      report={filingReport}
      loadingReport={filingReportLoading}
      progress={filingProgress}
      result={filingResult}
      pdfAAvailable={engineBridge.available}
      onPrepare={prepareFilingCopy}
    />
  ) : activeLegalTool === "combine-exhibits" ? (
    <BinderWorkspace
      document={document}
      onBuildBinder={buildBinder}
      onOpenRequested={openFile}
      onCancel={closeWorkspace}
    />
  ) : activeOrganizeTool && activeOrganizeTool !== "passwords" ? (
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
  ) : null;

  return (
    <>
      <AppShell
        document={document}
        pdfDocument={pdfDocument}
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
        activeLegalTool={activeLegalTool}
        activeOrganizeTool={activeOrganizeTool}
        onLegalToolSelected={selectLegalTool}
        onOrganizeToolSelected={selectOrganizeTool}
        onMakeSearchable={makeSearchable}
        redaction={redactionPanel}
        bates={batesState}
        scanner={scannerState}
        scrubMetadata={scrubMetadataPanel}
        pendingRedactions={pendingRedactions}
        modeBar={modeBar}
        editing={editingForShell}
        onRedactionAreaCreated={addPendingRedaction}
        onRedactionAreaRemoved={removePendingRedaction}
        onConfirmRedactions={confirmRedactions}
        onCancelRedactions={cancelRedactions}
        onApplyBates={applyBates}
        onRunScanner={runScanner}
        onMarkScannerHit={markScannerHit}
        onScrubMetadata={scrubDocumentMetadata}
      />
      {settingsOpen ? (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
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

async function readFilingFacts(
  bytes: Uint8Array,
  options: {
    fileBytes: number;
    searchableText?: boolean;
    pdfaCompliant?: boolean;
    pdfDocument?: PDFDocumentProxy | null;
  },
): Promise<DocumentFacts> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageOccupiedRegions = await readOccupiedRegions(bytes, options.pdfDocument ?? null);
  const pages: PageFacts[] = pdf.getPages().map((page, pageIndex) => {
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
): Promise<Map<number, RectInches[]>> {
  let loadedDocument: PDFDocumentProxy | null = null;
  const pdfDocument = currentPdfDocument ?? await loadPdfDocument(bytes);

  if (!currentPdfDocument) {
    loadedDocument = pdfDocument;
  }

  try {
    const boxes = await extractTextBoxes(pdfDocument);

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

function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
