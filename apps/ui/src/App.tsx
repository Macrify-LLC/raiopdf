import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { AppShell } from "./components/AppShell";
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
  const ocrRunRef = useRef(0);
  const ocrActiveRef = useRef(false);

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
      setSelectedPageIndexes(new Set());
      void openDocumentFile(file).then((opened) => {
        if (opened) {
          setSelectedPageIndexes(new Set([0]));
        }
      });
    },
    [openDocumentFile],
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
      onThumbnailClick={handleThumbnailClick}
      onRotateSelected={rotateSelected}
      onDeleteSelected={deleteSelected}
      onMoveSelectedUp={() => moveSelected(-1)}
      onMoveSelectedDown={() => moveSelected(1)}
      ocrState={ocrState}
      ocrAvailable={engineBridge.available}
      ocrStarting={engineBridge.starting}
      onMakeSearchable={makeSearchable}
    />
  );
}
