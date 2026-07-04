import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { DocumentSearchMatch } from "../hooks/useDocumentSearch";
import type { PageScrollIntent } from "../hooks/useDocument";
import type { EditingState } from "../hooks/useEditing";
import { TextLayer, type PDFDocumentProxy } from "../lib/pdfjs";
import {
  computeMountedRange,
  computePageLayout,
  findPageAtOffset,
  mostVisiblePage,
  unionRange,
  PAGE_GAP,
  PAGE_LIST_PADDING,
  type MountedRange,
  type PageDims,
  type PageLayout,
} from "../lib/pageLayout";
import { clamp } from "../lib/viewportGeometry";
import { PageView, type PendingRedactionOverlay } from "./PageView";
import "./PageList.css";

/** Matches the old fit-width margin: clientWidth - 48. */
const FIT_WIDTH_MARGIN = 48;

const DEFAULT_PAGE_DIMS: PageDims = { width: 612, height: 792 };

interface PageSizesState {
  doc: PDFDocumentProxy;
  dims: readonly PageDims[];
  measured: boolean;
}

interface WheelZoomAnchor {
  pageIndex: number;
  clientX: number;
  clientY: number;
  localX: number;
  localY: number;
  zoom: number;
}

export interface PageListProps {
  pdfDocument: PDFDocumentProxy;
  currentPage: number;
  zoom: number;
  fitWidth?: boolean;
  scrollIntent?: PageScrollIntent | null;
  /** Extra top inset inside the scroller (e.g. when a mode bar overlays it). */
  topInset?: number;
  onVisiblePageChange?: ((page: number) => void) | undefined;
  onZoomIn?: (() => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onFitZoomResolved?: ((zoom: number) => void) | undefined;
  onPageSizeChange?: ((size: { width: number; height: number }) => void) | undefined;
  onRenderError?: ((message: string) => void) | undefined;
  redactionMode?: boolean;
  pendingRedactions?: readonly PendingRedactionOverlay[];
  onRedactionAreaCreated?: ((area: PdfRedactionArea) => void) | undefined;
  onRedactionAreaRemoved?: ((id: string) => void) | undefined;
  editing?: EditingState | undefined;
  searchResults?: readonly DocumentSearchMatch[];
  activeSearchResultId?: string | null;
  /**
   * Streamed (range-transport) mode [R2-1]: skip the full `getPage`
   * measurement sweep — on a range transport that alone pulls most of the
   * file. Layout keeps the first-page estimate for every page and refines
   * per-page dims opportunistically as PageViews actually render. Mixed-size
   * docs may show minor scrollbar drift until visited; accepted for v1.
   */
  lazyPageMeasurement?: boolean;
}

/**
 * The continuous-scroll viewer. Every page is laid out in one vertical
 * column at its viewport-derived size; only the visible range plus a
 * memory-capped overscan buffer mounts a real PageView (canvas + text layer
 * + overlays) — the rest are lightweight placeholder boxes.
 *
 * `currentPage` is DERIVED state here: scrolling reports the most-visible
 * page upward via `onVisiblePageChange`, while explicit navigation arrives
 * as a `scrollIntent` and is translated into a scroll position.
 */
export function PageList({
  pdfDocument,
  currentPage,
  zoom,
  fitWidth = false,
  scrollIntent = null,
  topInset = 0,
  onVisiblePageChange,
  onZoomIn,
  onZoomOut,
  onFitZoomResolved,
  onPageSizeChange,
  onRenderError,
  redactionMode = false,
  pendingRedactions = [],
  onRedactionAreaCreated,
  onRedactionAreaRemoved,
  editing,
  searchResults = [],
  activeSearchResultId = null,
  lazyPageMeasurement = false,
}: PageListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageElsRef = useRef(new Map<number, HTMLDivElement>());
  const wheelZoomAnchorRef = useRef<WheelZoomAnchor | null>(null);
  const lastAppliedScrollRef = useRef<{ nonce: number; measured: boolean } | null>(null);
  const previousRangeRef = useRef<MountedRange>({ start: 0, end: -1 });
  const [pageSizes, setPageSizes] = useState<PageSizesState | null>(null);
  const [viewRect, setViewRect] = useState({ scrollTop: 0, height: 0, width: 0 });
  // While a text-selection drag is live, mounted pages are frozen (only
  // ever extended) so the selection anchor's DOM never unmounts mid-drag.
  const [selectionDragActive, setSelectionDragActive] = useState(false);
  const textSelectable = Boolean(editing && editing.tool === "select" && !redactionMode);

  const sizes = pageSizes?.doc === pdfDocument ? pageSizes : null;

  // Measure base (scale-1, rotation-aware) page sizes. The first page lands
  // immediately as an estimate for every page so layout exists right away;
  // the full pass then commits once. The cache is keyed to the document
  // proxy, and every rotation/reorder/document swap produces a NEW proxy —
  // so those all invalidate it by construction. Zoom never touches the
  // cache; it multiplies at layout time.
  useEffect(() => {
    let disposed = false;

    void (async () => {
      const pageCount = pdfDocument.numPages;
      let firstDims = DEFAULT_PAGE_DIMS;

      try {
        const firstPage = await pdfDocument.getPage(1);
        const firstViewport = firstPage.getViewport({ scale: 1 });
        firstDims = { width: firstViewport.width, height: firstViewport.height };
      } catch {
        // Keep the letter-size estimate; per-page measurement below and the
        // PageView render path surface real failures.
      }

      if (disposed) {
        return;
      }

      setPageSizes({
        doc: pdfDocument,
        dims: Array.from({ length: pageCount }, () => firstDims),
        measured: false,
      });

      // Streamed mode never runs the full sweep [R2-1] — the estimate layout
      // stands, refined per page by handleBaseDimsMeasured as pages render.
      if (lazyPageMeasurement) {
        return;
      }

      const dims: PageDims[] = new Array<PageDims>(pageCount);

      for (let index = 0; index < pageCount; index += 1) {
        try {
          const page = await pdfDocument.getPage(index + 1);
          const viewport = page.getViewport({ scale: 1 });
          dims[index] = { width: viewport.width, height: viewport.height };
        } catch {
          dims[index] = firstDims;
        }

        if (disposed) {
          return;
        }
      }

      setPageSizes({ doc: pdfDocument, dims, measured: true });
    })();

    return () => {
      disposed = true;
    };
  }, [lazyPageMeasurement, pdfDocument]);

  // Streamed-mode refinement: a rendered PageView reports its real base
  // dims; commit them into the size cache when they differ from the current
  // entry so the layout converges page-by-page without extra fetches.
  const handleBaseDimsMeasured = useCallback(
    (pageIndex: number, dims: PageDims) => {
      setPageSizes((current) => {
        if (!current || current.doc !== pdfDocument) {
          return current;
        }

        const existing = current.dims[pageIndex];

        if (
          !existing ||
          (Math.abs(existing.width - dims.width) < 0.5 &&
            Math.abs(existing.height - dims.height) < 0.5)
        ) {
          return current;
        }

        const nextDims = [...current.dims];
        nextDims[pageIndex] = dims;
        return { ...current, dims: nextDims };
      });
    },
    [pdfDocument],
  );

  // Release pdf.js's shared text-layer caches when the document goes away.
  // (Static cleanup; safe no-op while any text layer is still rendering.)
  useEffect(() => {
    return () => {
      TextLayer.cleanup();
    };
  }, [pdfDocument]);

  const layout: PageLayout | null = useMemo(
    () => (sizes ? computePageLayout(sizes.dims, zoom, sizes.measured, topInset) : null),
    [sizes, topInset, zoom],
  );

  const syncViewRect = useCallback(() => {
    const scroller = scrollerRef.current;

    if (!scroller) {
      return;
    }

    setViewRect((current) => {
      const next = {
        scrollTop: scroller.scrollTop,
        height: scroller.clientHeight,
        width: scroller.clientWidth,
      };

      return current.scrollTop === next.scrollTop &&
        current.height === next.height &&
        current.width === next.width
        ? current
        : next;
    });
  }, []);

  useEffect(() => {
    syncViewRect();

    if (typeof ResizeObserver === "undefined" || !scrollerRef.current) {
      return;
    }

    const observer = new ResizeObserver(syncViewRect);
    observer.observe(scrollerRef.current);

    return () => observer.disconnect();
  }, [syncViewRect]);

  // Scroll intents: every explicit navigation lands here as {page, nonce}.
  // Re-applies once if the intent arrived while sizes were still estimates
  // (the measured layout can shift the target page's offset).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;

    if (!scroller || !layout || layout.items.length === 0) {
      return;
    }

    const applied = lastAppliedScrollRef.current;
    let targetPage: number | null = null;

    if (applied === null) {
      // Fresh mount (initial open, or a workspace closed and the viewer
      // remounted): restore the reader's page. Any intent already pending
      // at mount is treated as consumed — `currentPage` tracks it anyway,
      // and a stale pre-mount intent must not override scrolling the
      // reader did since it was issued.
      targetPage = currentPage;
    } else if (scrollIntent && applied.nonce !== scrollIntent.nonce) {
      targetPage = scrollIntent.page;
    } else if (!applied.measured && layout.measured) {
      // Sizes flipped from first-page estimates to measured values right
      // after a scroll was applied — reanchor the same page at its final
      // offset.
      targetPage = currentPage;
    }

    if (targetPage === null) {
      return;
    }

    lastAppliedScrollRef.current = {
      nonce: scrollIntent?.nonce ?? -1,
      measured: layout.measured,
    };

    const index = clamp(Math.round(targetPage) - 1, 0, layout.items.length - 1);
    scroller.scrollTop = Math.max(0, layout.items[index]!.top - PAGE_GAP / 2 - topInset);
    syncViewRect();
  }, [currentPage, layout, scrollIntent, syncViewRect, topInset]);

  // Derived current page. viewRect is the reactive trigger, but the DOM is
  // the source of truth: a scroll intent applied in a layout effect must
  // never be "corrected" back to the old page by a one-frame-stale state
  // snapshot.
  useEffect(() => {
    const scroller = scrollerRef.current;

    if (!scroller || !layout || layout.items.length === 0) {
      return;
    }

    const height = scroller.clientHeight || viewRect.height;
    const visible = mostVisiblePage(layout.items, scroller.scrollTop, height) + 1;

    if (visible !== currentPage) {
      onVisiblePageChange?.(visible);
    }
  }, [currentPage, layout, onVisiblePageChange, viewRect]);

  // Report the derived current page's size (inches) for the status bar.
  useEffect(() => {
    if (!layout) {
      return;
    }

    const dims = layout.baseDims[currentPage - 1];

    if (dims) {
      onPageSizeChange?.({ width: dims.width / 72, height: dims.height / 72 });
    }
  }, [currentPage, layout, onPageSizeChange]);

  // Fit-width: derive zoom from the widest page so no page overflows.
  useEffect(() => {
    if (!fitWidth || !layout || layout.maxBaseWidth <= 0 || viewRect.width <= 0) {
      return;
    }

    const available = Math.max(viewRect.width - FIT_WIDTH_MARGIN, 1);
    onFitZoomResolved?.(available / layout.maxBaseWidth);
  }, [fitWidth, layout, onFitZoomResolved, viewRect.width]);

  // Ctrl+wheel zoom, anchored to the point under the cursor within the
  // hovered page (falls back to the layout when hovering a gap).
  useEffect(() => {
    const scroller = scrollerRef.current;

    if (!scroller || !layout) {
      return;
    }

    function handleWheel(event: globalThis.WheelEvent) {
      if (!event.ctrlKey || event.deltaY === 0 || !scroller || !layout) {
        return;
      }

      event.preventDefault();

      const scrollerBounds = scroller.getBoundingClientRect();
      const contentY = scroller.scrollTop + (event.clientY - scrollerBounds.top);
      const pageIndex = findPageAtOffset(layout.items, contentY);
      const pageEl = pageElsRef.current.get(pageIndex);

      if (pageEl) {
        const pageBounds = pageEl.getBoundingClientRect();
        const anchor: WheelZoomAnchor = {
          pageIndex,
          clientX: event.clientX,
          clientY: event.clientY,
          localX: clamp(event.clientX - pageBounds.left, 0, pageBounds.width),
          localY: clamp(event.clientY - pageBounds.top, 0, pageBounds.height),
          zoom,
        };
        wheelZoomAnchorRef.current = anchor;

        if (typeof window.requestAnimationFrame === "function") {
          // If the zoom is already at its limit no zoom change arrives to
          // consume the anchor — drop it so a later keyboard zoom can't
          // apply a stale correction.
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              if (wheelZoomAnchorRef.current === anchor) {
                wheelZoomAnchorRef.current = null;
              }
            });
          });
        }
      }

      if (event.deltaY < 0) {
        onZoomIn?.();
      } else {
        onZoomOut?.();
      }
    }

    scroller.addEventListener("wheel", handleWheel, { passive: false });

    return () => scroller.removeEventListener("wheel", handleWheel);
  }, [layout, onZoomIn, onZoomOut, zoom]);

  // Apply the wheel-zoom anchor after the zoomed layout commits: keep the
  // document point that was under the cursor exactly under the cursor.
  useLayoutEffect(() => {
    const anchor = wheelZoomAnchorRef.current;
    const scroller = scrollerRef.current;

    if (!anchor || !scroller || anchor.zoom === zoom) {
      return;
    }

    wheelZoomAnchorRef.current = null;
    const pageEl = pageElsRef.current.get(anchor.pageIndex);

    if (!pageEl) {
      return;
    }

    const zoomRatio = zoom / anchor.zoom;
    const bounds = pageEl.getBoundingClientRect();
    scroller.scrollLeft += bounds.left + anchor.localX * zoomRatio - anchor.clientX;
    scroller.scrollTop += bounds.top + anchor.localY * zoomRatio - anchor.clientY;
    syncViewRect();
  }, [syncViewRect, zoom]);

  // Freeze (never shrink) the mounted range while a text-selection drag is
  // active so the selection's anchor node cannot unmount mid-drag.
  useEffect(() => {
    if (!selectionDragActive) {
      return;
    }

    function endSelectionDrag() {
      setSelectionDragActive(false);
    }

    window.addEventListener("pointerup", endSelectionDrag);
    window.addEventListener("pointercancel", endSelectionDrag);

    return () => {
      window.removeEventListener("pointerup", endSelectionDrag);
      window.removeEventListener("pointercancel", endSelectionDrag);
    };
  }, [selectionDragActive]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!textSelectable || event.button !== 0) {
      return;
    }

    const target = event.target as Element | null;

    if (target?.closest?.(".page-view__text-layer")) {
      setSelectionDragActive(true);
    }
  }

  const mountedRange: MountedRange = useMemo(() => {
    if (!layout || layout.items.length === 0) {
      return { start: 0, end: -1 };
    }

    return computeMountedRange(layout.items, viewRect.scrollTop, viewRect.height);
  }, [layout, viewRect.height, viewRect.scrollTop]);

  const effectiveRange = selectionDragActive
    ? unionRange(previousRangeRef.current, mountedRange)
    : mountedRange;
  previousRangeRef.current = effectiveRange;

  if (!layout) {
    return <div ref={scrollerRef} className="page-list" data-testid="page-list" />;
  }

  const contentWidth = Math.max(
    layout.maxWidth + PAGE_LIST_PADDING * 2,
    viewRect.width,
  );

  return (
    <div
      ref={scrollerRef}
      className="page-list"
      data-testid="page-list"
      data-redaction-mode={redactionMode ? "true" : undefined}
      onScroll={syncViewRect}
      onPointerDown={handlePointerDown}
    >
      <div
        className="page-list__content"
        style={{ height: `${layout.totalHeight}px`, width: `${contentWidth}px` }}
      >
        {layout.items.map((item, index) => {
          const mounted = index >= effectiveRange.start && index <= effectiveRange.end;
          const left = Math.max(PAGE_LIST_PADDING, (contentWidth - item.width) / 2);

          return (
            <div
              key={index}
              ref={(element) => {
                if (element) {
                  pageElsRef.current.set(index, element);
                } else {
                  pageElsRef.current.delete(index);
                }
              }}
              className="page-list__page"
              data-mounted={mounted ? "true" : undefined}
              style={{
                top: `${item.top}px`,
                left: `${left}px`,
                width: `${item.width}px`,
                height: `${item.height}px`,
              }}
            >
              {mounted ? (
                <PageView
                  pdfDocument={pdfDocument}
                  pageIndex={index}
                  zoom={zoom}
                  textSelectable={textSelectable}
                  redactionMode={redactionMode}
                  pendingRedactions={pendingRedactions}
                  onRedactionAreaCreated={onRedactionAreaCreated}
                  onRedactionAreaRemoved={onRedactionAreaRemoved}
                  editing={editing}
                  searchResults={searchResults}
                  activeSearchResultId={activeSearchResultId}
                  onRenderError={onRenderError}
                  onBaseDimsMeasured={lazyPageMeasurement ? handleBaseDimsMeasured : undefined}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
