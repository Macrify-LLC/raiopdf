import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import type { PdfBatesStampOptions, PdfRedactionArea } from "@raiopdf/engine-api";
import { AppShell } from "./components/AppShell";
import { BinderWorkspace } from "./components/BinderWorkspace";
import {
  OrganizeWorkspace,
  type OrganizeFlowId,
} from "./components/OrganizeWorkspace";
import {
  isEngineBridgeUnavailableError,
  useEngineBridge,
} from "./hooks/useEngineBridge";
import { useDocument } from "./hooks/useDocument";
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
    scrubMetadata,
    save: saveDocument,
    markSaved,
  } = useDocument();
  const engineBridge = useEngineBridge();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [selectedPageIndexes, setSelectedPageIndexes] = useState<Set<number>>(
    () => new Set(),
  );
  const [ocrState, setOcrState] = useState<OcrUiState>({
    phase: "idle",
    message: null,
  });
  const [activeLegalTool, setActiveLegalTool] = useState<LegalToolId | null>(
    "prepare-for-filing",
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
  const [scrubState, setScrubState] = useState<{
    scrubbing: boolean;
    message: string | null;
    removedFields: readonly string[];
  }>({
    scrubbing: false,
    message: null,
    removedFields: [],
  });
  const ocrRunRef = useRef(0);
  const ocrActiveRef = useRef(false);
  const redactionIdRef = useRef(0);
  const documentBytesRef = useRef<Uint8Array | null>(null);
  const scannerRunRef = useRef(0);

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
  }, []);

  const clearDocumentBoundLegalState = useCallback(() => {
    scannerRunRef.current += 1;
    setPendingRedactions([]);
    setScannerState({ scanning: false, message: null, hits: [] });
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

    if (!engineBridge.available) {
      setOcrState({
        phase: "error",
        message: "OCR runs in the desktop app.",
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

  const save = useCallback(() => {
    void saveDocument()
      .then(async (saved) => {
        if (!saved) {
          return;
        }

        const written = await filePort.saveFile(
          saved.bytes,
          saved.fileName,
          saved.filePath,
        );

        if (written) {
          markSaved({
            fileName: written.name,
            filePath: written.path,
          });
        }
      })
      .catch(() => {
        setError("This PDF could not be saved. Try reopening the document and saving again.");
      });
  }, [markSaved, saveDocument, setError]);

  const selectLegalTool = useCallback((toolId: LegalToolId) => {
    setActiveLegalTool(toolId);

    if (toolId === "combine-exhibits") {
      setActiveOrganizeTool(null);
    }
  }, []);

  const selectOrganizeTool = useCallback((toolId: OrganizeToolId) => {
    setActiveOrganizeTool(toolId);
    setActiveLegalTool(null);
  }, []);

  const closeWorkspace = useCallback(() => {
    setActiveOrganizeTool(null);

    if (activeLegalTool === "combine-exhibits") {
      setActiveLegalTool("prepare-for-filing");
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
  const redactionModeBar = activeLegalTool === "redact" ? (
    <RedactionModeBar
      pendingCount={pendingRedactions.length}
      searchOpen={redactionSearchOpen}
      searchText={redactionSearchText}
      applying={redactionPhase === "applying"}
      onSearchOpen={() => setRedactionSearchOpen(true)}
      onSearchTextChange={setRedactionSearchText}
      onSearchSubmit={searchTextForRedaction}
      onApply={requestApplyRedactions}
      onExit={() => setActiveLegalTool("prepare-for-filing")}
    />
  ) : null;

  const workspace = activeLegalTool === "combine-exhibits" ? (
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
    <AppShell
      document={document}
      pdfDocument={pdfDocument}
      selectedPageIndexes={selectedPageIndexes}
      onOpenRequested={openFile}
      onFileDropped={openDroppedFile}
      onSave={save}
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
      ocrAvailable={engineBridge.available}
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
      redactionModeBar={redactionModeBar}
      onRedactionAreaCreated={addPendingRedaction}
      onRedactionAreaRemoved={removePendingRedaction}
      onConfirmRedactions={confirmRedactions}
      onCancelRedactions={cancelRedactions}
      onApplyBates={applyBates}
      onRunScanner={runScanner}
      onMarkScannerHit={markScannerHit}
      onScrubMetadata={scrubDocumentMetadata}
    />
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

function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}
