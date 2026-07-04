import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { DocumentSearchMatch } from "../hooks/useDocumentSearch";
import type { EditingState } from "../hooks/useEditing";
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "../lib/pdfjs";
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
import { FormLayer } from "./FormLayer";
import { LoadingSun } from "./LoadingSun";

export interface PendingRedactionOverlay {
  id: string;
  area: PdfRedactionArea;
}

export interface PageViewProps {
  pdfDocument: PDFDocumentProxy;
  pageIndex: number;
  zoom: number;
  /** True when the Select tool owns the pointer (text selection wins). */
  textSelectable: boolean;
  redactionMode?: boolean;
  pendingRedactions?: readonly PendingRedactionOverlay[];
  onRedactionAreaCreated?: ((area: PdfRedactionArea) => void) | undefined;
  onRedactionAreaRemoved?: ((id: string) => void) | undefined;
  editing?: EditingState | undefined;
  searchResults?: readonly DocumentSearchMatch[];
  activeSearchResultId?: string | null;
  onRenderError?: ((message: string) => void) | undefined;
  /**
   * Reports this page's base (scale-1, rotation-aware) dimensions once the
   * page proxy loads. Streamed mode uses this to refine the first-page size
   * estimate opportunistically as pages actually render, instead of running
   * the full `getPage` measurement sweep [R2-1].
   */
  onBaseDimsMeasured?: ((pageIndex: number, dims: { width: number; height: number }) => void) | undefined;
}

/**
 * One mounted page of the continuous-scroll viewer: the pdf.js canvas, the
 * selectable text layer, and every per-page overlay (form fields, redaction
 * rectangles, pending edits, search highlights). All overlays position
 * against THIS page's viewport and carry this page's index — nothing here
 * reads a global "current page".
 *
 * Z-order (bottom to top): canvas < text layer < form fields < redaction
 * overlays < edit layer < search highlights (see PageList.css).
 */
export function PageView({
  pdfDocument,
  pageIndex,
  zoom,
  textSelectable,
  redactionMode = false,
  pendingRedactions = [],
  onRedactionAreaCreated,
  onRedactionAreaRemoved,
  editing,
  searchResults = [],
  activeSearchResultId = null,
  onRenderError,
  onBaseDimsMeasured,
}: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // Serializes pdf.js renders on the shared canvas: a new render never
  // starts until the previous task has been canceled AND settled.
  const renderChainRef = useRef<Promise<void>>(Promise.resolve());
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [pagePending, setPagePending] = useState(true);
  const [renderPending, setRenderPending] = useState(false);
  const [draftRect, setDraftRect] = useState<ViewportRect | null>(null);
  const dragStartRef = useRef<ViewportPoint | null>(null);
  // Rotation feedback: remembers the last rotation this PageView instance
  // actually displayed. A rotate mutation swaps the whole pdfDocument (a new
  // engine handle round-trips through the sidecar), so every already-mounted
  // page re-fetches -- this ref is what tells THIS page apart from the
  // others: "I was showing content, and my orientation just changed under
  // me." A freshly-mounted instance (scrolled into view) has no prior
  // rotation to compare against, so it never gets the settle treatment --
  // only a real orientation change on an already-visible page does.
  const previousRotationRef = useRef<number | null>(null);
  const [rotationSettling, setRotationSettling] = useState(false);
  const viewport = useMemo(
    () => page?.getViewport({ scale: zoom }) ?? null,
    [page, zoom],
  );

  useEffect(() => {
    let cancelled = false;

    setPage(null);
    setPagePending(true);

    void pdfDocument
      .getPage(pageIndex + 1)
      .then((loadedPage) => {
        if (!cancelled) {
          const previousRotation = previousRotationRef.current;

          if (previousRotation !== null && previousRotation !== loadedPage.rotate) {
            setRotationSettling(true);
          }

          previousRotationRef.current = loadedPage.rotate;
          setPage(loadedPage);
          setPagePending(false);

          const baseViewport = loadedPage.getViewport({ scale: 1 });
          onBaseDimsMeasured?.(pageIndex, {
            width: baseViewport.width,
            height: baseViewport.height,
          });
        }
      })
      .catch((pageError: unknown) => {
        if (!cancelled && !isCancelledRenderError(pageError)) {
          setPagePending(false);
          onRenderError?.("This page could not be displayed.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onBaseDimsMeasured, onRenderError, pageIndex, pdfDocument]);

  // Canvas raster lifecycle. Guardrails: (1) the canvas is never reused for
  // a new render until the previous render task is canceled or settled;
  // (2) on release (unmount) its dimensions reset to 0x0 so the backing
  // bitmap is freed immediately and can never flash stale content.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !page || !viewport) {
      return;
    }

    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;

    const run = renderChainRef.current
      .then(() => {
        if (cancelled) {
          return;
        }

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        renderTask = page.render({ canvas, viewport });
        setRenderPending(true);

        return renderTask.promise.catch((renderError: unknown) => {
          if (!cancelled && !isCancelledRenderError(renderError)) {
            console.error(renderError);
            onRenderError?.("This page could not be displayed.");
          }
        });
      })
      .then(() => {
        if (!cancelled) {
          setRenderPending(false);
          // The new (correctly rotated) canvas has just painted -- release
          // the settle transform now, so the container eases from its
          // perturbed "still turning" look into rest exactly as the veil
          // lifts and the result appears.
          setRotationSettling(false);
        }
      });

    renderChainRef.current = run.catch(() => {});

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [onRenderError, page, viewport]);

  // Release the canvas backing store once the last render task settles.
  useEffect(() => {
    const canvas = canvasRef.current;

    return () => {
      void renderChainRef.current.then(() => {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      });
    };
  }, []);

  // pdf.js v6 TextLayer lifecycle: cancel() the streaming render, clear the
  // container DOM, and release the page/viewport refs on unmount and on any
  // zoom/page change. (There is no instance destroy(); the static
  // TextLayer.cleanup() runs at the PageList level on document swap.)
  useEffect(() => {
    const container = textLayerRef.current;

    if (!container || !page || !viewport) {
      return;
    }

    container.replaceChildren();
    let textLayer: InstanceType<typeof TextLayer> | null = new TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport,
    });

    void textLayer.render().catch(() => {
      // Cancellation and text-extraction failures both leave the page
      // usable (just not selectable); the canvas is the source of truth.
    });

    return () => {
      textLayer?.cancel();
      textLayer = null;
      container.replaceChildren();
    };
  }, [page, viewport]);

  useEffect(() => {
    setDraftRect(null);
    dragStartRef.current = null;
  }, [redactionMode, zoom]);

  function getViewportPoint(event: PointerEvent<HTMLDivElement>): ViewportPoint | null {
    const frame = frameRef.current;

    if (!frame) {
      return null;
    }

    const bounds = frame.getBoundingClientRect();

    return {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height),
    };
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!redactionMode || !viewport) {
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

    // The redaction area carries THIS page's index — never a global
    // "current page" that may have drifted while scrolling.
    onRedactionAreaCreated?.({
      pageIndex,
      ...viewportRectToPdfRect(rect, viewport),
    });
  }

  const frameStyle = viewport
    ? ({ "--scale-factor": String(viewport.scale) } as CSSProperties)
    : undefined;

  return (
    <div
      ref={frameRef}
      className="page-view"
      style={frameStyle}
      data-redaction-mode={redactionMode ? "true" : undefined}
      data-text-select={textSelectable ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragStartRef.current = null;
        setDraftRect(null);
      }}
    >
      <div
        className="page-view__content"
        data-rotate-settling={rotationSettling ? "true" : undefined}
      >
        <canvas
          ref={canvasRef}
          className="page-view__canvas"
          aria-label={`Page ${pageIndex + 1}`}
          data-testid="pdf-page-canvas"
        />
        <div ref={textLayerRef} className="textLayer page-view__text-layer" />
      </div>
      {pagePending || renderPending ? (
        <div className="page-view__render-pending" role="status" aria-live="polite">
          <LoadingSun size={18} label="Rendering page" />
          Rendering page
        </div>
      ) : null}
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
          .filter((overlay) => overlay.area.pageIndex === pageIndex)
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
          pageIndex={pageIndex}
          editing={editing}
        />
      ) : null}
      {viewport
        ? searchResults
          .filter((result) => result.area.pageIndex === pageIndex)
          .map((result) => (
            <SearchHighlight
              key={result.id}
              result={result}
              active={result.id === activeSearchResultId}
              viewport={viewport}
            />
          ))
        : null}
      {draftRect ? (
        <span className="page-view__redaction-draft" style={toOverlayStyle(draftRect)} />
      ) : null}
    </div>
  );
}

function SearchHighlight({
  result,
  active,
  viewport,
}: {
  result: DocumentSearchMatch;
  active: boolean;
  viewport: PageViewport;
}) {
  const highlightRef = useRef<HTMLSpanElement>(null);
  const rect = pdfRectToViewportRect(result.area, viewport);

  // Second half of the two-step offscreen-highlight jump: the scroll intent
  // brings the page into the mounted range, then this effect fires on mount
  // (or on activation) and centers the actual match.
  useEffect(() => {
    if (!active) {
      return;
    }

    highlightRef.current?.scrollIntoView({
      block: "center",
      inline: "center",
    });
  }, [active]);

  return (
    <span
      ref={highlightRef}
      className="page-view__search-highlight"
      data-active={active ? "true" : undefined}
      data-testid="search-highlight"
      style={toOverlayStyle(rect)}
      aria-hidden="true"
    />
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
    <span className="page-view__redaction-overlay" style={toOverlayStyle(rect)}>
      <button
        type="button"
        className="page-view__redaction-remove"
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
