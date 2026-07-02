import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { AppShell } from "./components/AppShell";
import { useDocument } from "./hooks/useDocument";
import {
  getPdfLoadErrorMessage,
  loadPdfDocument,
  type PDFDocumentProxy,
} from "./lib/pdfjs";

const ZOOM_STEP = 0.25;

export function App() {
  const {
    document,
    openFile: openDocumentFile,
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
  } = useDocument();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [selectedPageIndexes, setSelectedPageIndexes] = useState<Set<number>>(
    () => new Set(),
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

    void pdfDocument
      .getPage(1)
      .then((page) => page.getTextContent())
      .then((textContent) => {
        if (disposed) {
          return;
        }

        const hasTextLayer = textContent.items.some((item) => {
          return "str" in item && item.str.trim().length > 0;
        });
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

  const openFile = useCallback(
    (file: File) => {
      setSelectedPageIndexes(new Set());
      void openDocumentFile(file).then((opened) => {
        if (opened) {
          setSelectedPageIndexes(new Set([0]));
        }
      });
    },
    [openDocumentFile],
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
    void saveDocument().then((saved) => {
      if (!saved) {
        return;
      }

      const blob = new Blob([saved.bytes.slice().buffer], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = saved.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }, [saveDocument]);

  return (
    <AppShell
      document={document}
      pdfDocument={pdfDocument}
      selectedPageIndexes={selectedPageIndexes}
      onOpenFile={openFile}
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
    />
  );
}
