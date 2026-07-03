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
import { OpenIcon, SunMarkIcon } from "../icons";
import type { EditingState } from "../hooks/useEditing";
import type { PDFDocumentProxy, PDFPageProxy } from "../lib/pdfjs";
import {
  clamp,
  pdfRectToViewportRect,
  pointsToViewportRect,
  toOverlayStyle,
  viewportRectToPdfRect,
  type PageViewport,
  type ViewportPoint,
  type ViewportRect,
} from "../lib/viewportGeometry";
import { EditLayer } from "./EditLayer";
import { FloatingDialog } from "./FloatingDialog";
import { FormLayer } from "./FormLayer";
import { SignatureCard } from "./SignatureCard";
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
  onRenderError?: ((message: string) => void) | undefined;
  workspace?: ReactNode;
  overlay?: ReactNode;
  redactionMode?: boolean;
  modeBar?: ReactNode;
  pendingRedactions?: readonly PendingRedactionOverlay[];
  onRedactionAreaCreated?: ((area: PdfRedactionArea) => void) | undefined;
  onRedactionAreaRemoved?: ((id: string) => void) | undefined;
  editing?: EditingState | undefined;
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
  onRenderError,
  workspace = null,
  overlay = null,
  redactionMode = false,
  modeBar = null,
  pendingRedactions = [],
  onRedactionAreaCreated,
  onRedactionAreaRemoved,
  editing,
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

    setPage(null);

    void pdfDocument
      .getPage(currentPage)
      .then((loadedPage) => {
        if (!cancelled) {
          setPage(loadedPage);
          const viewport = loadedPage.getViewport({ scale: 1 });
          onPageSizeChange?.({
            width: viewport.width / 72,
            height: viewport.height / 72,
          });
        }
      })
      .catch((pageError: unknown) => {
        if (!cancelled && !isCancelledRenderError(pageError)) {
          onRenderError?.("This page could not be displayed.");
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
      if (!isCancelledRenderError(renderError)) {
        console.error(renderError);
        onRenderError?.("This page could not be displayed.");
      }
    });

    return () => {
      renderTask.cancel();
    };
  }, [onRenderError, page, viewport]);

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

    setDraftRect(pointsToViewportRect(start, point));
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

    const rect = pointsToViewportRect(start, point);

    if (rect.width < 4 || rect.height < 4) {
      return;
    }

    const pdfRect = viewportRectToPdfRect(rect, viewport);

    onRedactionAreaCreated?.({
      pageIndex: currentPage - 1,
      ...pdfRect,
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

  const signatureCardOpen = Boolean(
    editing && editing.tool === "sign" && editing.signatureCardOpen,
  );

  return (
    <section
      className="canvas-well"
      aria-label="Document canvas"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      {hasDocument && !workspace && modeBar ? (
        <div className="canvas-well__mode-bar-slot">{modeBar}</div>
      ) : null}
      {hasDocument && !workspace && signatureCardOpen && editing ? (
        <FloatingDialog
          title="Signature"
          eyebrow="Edit"
          width="sm"
          onClose={() => editing.setSignatureCardOpen(false)}
        >
          <SignatureCard editing={editing} />
        </FloatingDialog>
      ) : null}
      {workspace ? (
        workspace
      ) : hasDocument ? (
        <>
          <div ref={stageRef} className="canvas-well__stage">
            {editing?.hasFormFields ? (
              <p className="canvas-well__form-note" role="status">
                This PDF has fillable fields.
              </p>
            ) : null}
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
              {viewport && page && editing?.hasFormFields ? (
                <FormLayer
                  page={page}
                  viewport={viewport}
                  values={editing.formValues}
                  onValueChange={editing.setFormValue}
                />
              ) : null}
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
              {viewport && page && editing && !redactionMode ? (
                <EditLayer
                  page={page}
                  viewport={viewport}
                  pageIndex={currentPage - 1}
                  editing={editing}
                />
              ) : null}
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
          {overlay}
        </>
      ) : (
        <div className="canvas-well__empty">
          <span className="canvas-well__mark">
            <SunMarkIcon size={40} className="canvas-well__mark-icon" />
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

function RedactionOverlay({
  overlay,
  viewport,
  onRemove,
}: {
  overlay: PendingRedactionOverlay;
  viewport: PageViewport;
  onRemove?: ((id: string) => void) | undefined;
}) {
  const rect = pdfRectToViewportRect(overlay.area, viewport);

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

function isCancelledRenderError(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}
