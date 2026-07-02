import { useEffect, useRef, useState, type DragEvent } from "react";
import { BoltIcon, OpenIcon } from "../icons";
import type { PDFDocumentProxy, PDFPageProxy } from "../lib/pdfjs";
import "./CanvasWell.css";

export interface CanvasWellProps {
  onOpenRequested?: (() => void) | undefined;
  onFileDropped?: ((file: File) => void) | undefined;
  pdfDocument?: PDFDocumentProxy | null;
  currentPage?: number;
  zoom?: number;
  fitWidth?: boolean;
  error?: string | null;
  onFitZoomResolved?: ((zoom: number) => void) | undefined;
  onPageSizeChange?: ((size: { width: number; height: number }) => void) | undefined;
}

export function CanvasWell({
  onOpenRequested,
  onFileDropped,
  pdfDocument = null,
  currentPage = 1,
  zoom = 1,
  fitWidth = false,
  error = null,
  onFitZoomResolved,
  onPageSizeChange,
}: CanvasWellProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const hasDocument = Boolean(pdfDocument);

  useEffect(() => {
    let cancelled = false;

    if (!pdfDocument) {
      setPage(null);
      return;
    }

    void pdfDocument.getPage(currentPage).then((loadedPage) => {
      if (!cancelled) {
        setPage(loadedPage);
        const viewport = loadedPage.getViewport({ scale: 1 });
        onPageSizeChange?.({
          width: viewport.width / 72,
          height: viewport.height / 72,
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentPage, onPageSizeChange, pdfDocument]);

  useEffect(() => {
    if (!fitWidth || !page || !stageRef.current) {
      return;
    }

    function resolveFitZoom() {
      if (!stageRef.current || !page) {
        return;
      }

      const viewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(stageRef.current.clientWidth - 48, 1);
      onFitZoomResolved?.(availableWidth / viewport.width);
    }

    resolveFitZoom();
    const observer = new ResizeObserver(resolveFitZoom);
    observer.observe(stageRef.current);

    return () => observer.disconnect();
  }, [fitWidth, onFitZoomResolved, page]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !page) {
      return;
    }

    const viewport = page.getViewport({ scale: zoom });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const renderTask = page.render({ canvas, viewport });
    void renderTask.promise.catch((renderError: unknown) => {
      if (
        renderError instanceof Error &&
        renderError.name !== "RenderingCancelledException"
      ) {
        console.error(renderError);
      }
    });

    return () => {
      renderTask.cancel();
    };
  }, [page, zoom]);

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find(
      (candidate) =>
        candidate.type === "application/pdf" ||
        candidate.name.toLowerCase().endsWith(".pdf"),
    );

    if (file) {
      onFileDropped?.(file);
    }
  }

  return (
    <section
      className="canvas-well"
      aria-label="Document canvas"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      {hasDocument ? (
        <div ref={stageRef} className="canvas-well__stage">
          <canvas
            ref={canvasRef}
            className="canvas-well__page"
            aria-label={`Page ${currentPage}`}
            data-testid="pdf-page-canvas"
          />
          {error ? (
            <p className="canvas-well__message" role="status">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="canvas-well__empty">
          <span className="canvas-well__mark">
            <BoltIcon size={24} className="canvas-well__mark-icon" />
          </span>
          <h2 className="canvas-well__heading">Open a PDF to get started</h2>
          <p className="canvas-well__hint">
            Drag a PDF here, or choose one from this computer.
          </p>
          <button
            type="button"
            className="canvas-well__cta"
            onClick={onOpenRequested}
          >
            <OpenIcon size={16} />
            Open a PDF
          </button>
          {error ? (
            <p className="canvas-well__message" role="status">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
