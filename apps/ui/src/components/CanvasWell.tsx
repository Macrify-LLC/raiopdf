import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import { BoltIcon, OpenIcon } from "../icons";
import type { PDFDocumentProxy, PDFPageProxy } from "../lib/pdfjs";
import "./CanvasWell.css";

export interface PendingRedactionOverlay {
  id: string;
  area: PdfRedactionArea;
}

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
  workspace?: ReactNode;
  redactionMode?: boolean;
  redactionModeBar?: ReactNode;
  pendingRedactions?: readonly PendingRedactionOverlay[];
  onRedactionAreaCreated?: ((area: PdfRedactionArea) => void) | undefined;
  onRedactionAreaRemoved?: ((id: string) => void) | undefined;
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
  workspace = null,
  redactionMode = false,
  redactionModeBar = null,
  pendingRedactions = [],
  onRedactionAreaCreated,
  onRedactionAreaRemoved,
}: CanvasWellProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [draftRect, setDraftRect] = useState<ViewportRect | null>(null);
  const dragStartRef = useRef<ViewportPoint | null>(null);
  const hasDocument = Boolean(pdfDocument);
  const viewport = useMemo(() => page?.getViewport({ scale: zoom }) ?? null, [page, zoom]);

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

    if (!viewport) {
      return;
    }

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
  }, [page, viewport]);

  useEffect(() => {
    setDraftRect(null);
    dragStartRef.current = null;
  }, [currentPage, redactionMode, zoom]);

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

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!redactionMode || !viewport || workspace) {
      return;
    }

    const point = getViewportPoint(event);

    if (!point) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = point;
    setDraftRect({ left: point.x, top: point.y, width: 0, height: 0 });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;

    if (!start || !redactionMode) {
      return;
    }

    const point = getViewportPoint(event);

    if (!point) {
      return;
    }

    setDraftRect(toViewportRect(start, point));
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;

    if (!start || !viewport) {
      return;
    }

    const point = getViewportPoint(event);
    dragStartRef.current = null;
    setDraftRect(null);

    if (!point) {
      return;
    }

    const rect = toViewportRect(start, point);

    if (rect.width < 4 || rect.height < 4) {
      return;
    }

    const [firstX, firstY] = viewport.convertToPdfPoint(rect.left, rect.top);
    const [secondX, secondY] = viewport.convertToPdfPoint(
      rect.left + rect.width,
      rect.top + rect.height,
    );

    onRedactionAreaCreated?.({
      pageIndex: currentPage - 1,
      x: Math.min(firstX, secondX),
      y: Math.min(firstY, secondY),
      w: Math.abs(firstX - secondX),
      h: Math.abs(firstY - secondY),
    });
  }

  function getViewportPoint(event: PointerEvent<HTMLDivElement>): ViewportPoint | null {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    const bounds = canvas.getBoundingClientRect();

    return {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height),
    };
  }

  return (
    <section
      className="canvas-well"
      aria-label="Document canvas"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      {hasDocument && !workspace && redactionModeBar ? (
        <div className="canvas-well__mode-bar-slot">{redactionModeBar}</div>
      ) : null}
      {workspace ? (
        workspace
      ) : hasDocument ? (
        <div ref={stageRef} className="canvas-well__stage">
          <div
            className="canvas-well__page-frame"
            data-redaction-mode={redactionMode ? "true" : undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => {
              dragStartRef.current = null;
              setDraftRect(null);
            }}
          >
            <canvas
              ref={canvasRef}
              className="canvas-well__page"
              aria-label={`Page ${currentPage}`}
              data-testid="pdf-page-canvas"
            />
            {viewport
              ? pendingRedactions
                .filter((overlay) => overlay.area.pageIndex === currentPage - 1)
                .map((overlay) => (
                  <RedactionOverlay
                    key={overlay.id}
                    overlay={overlay}
                    viewport={viewport}
                    onRemove={onRedactionAreaRemoved}
                  />
                ))
              : null}
            {draftRect ? (
              <span
                className="canvas-well__redaction-draft"
                style={toOverlayStyle(draftRect)}
              />
            ) : null}
          </div>
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

interface ViewportPoint {
  x: number;
  y: number;
}

interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function RedactionOverlay({
  overlay,
  viewport,
  onRemove,
}: {
  overlay: PendingRedactionOverlay;
  viewport: ReturnType<PDFPageProxy["getViewport"]>;
  onRemove?: ((id: string) => void) | undefined;
}) {
  const rect = pdfAreaToViewportRect(overlay.area, viewport);

  return (
    <span className="canvas-well__redaction-overlay" style={toOverlayStyle(rect)}>
      <button
        type="button"
        className="canvas-well__redaction-remove"
        aria-label="Remove redaction area"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onRemove?.(overlay.id)}
      >
        ×
      </button>
    </span>
  );
}

function pdfAreaToViewportRect(
  area: PdfRedactionArea,
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
): ViewportRect {
  const points = [
    viewport.convertToViewportPoint(area.x, area.y),
    viewport.convertToViewportPoint(area.x + area.w, area.y),
    viewport.convertToViewportPoint(area.x, area.y + area.h),
    viewport.convertToViewportPoint(area.x + area.w, area.y + area.h),
  ];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);

  return {
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

function toViewportRect(first: ViewportPoint, second: ViewportPoint): ViewportRect {
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);

  return {
    left,
    top,
    width: Math.abs(first.x - second.x),
    height: Math.abs(first.y - second.y),
  };
}

function toOverlayStyle(rect: ViewportRect) {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
