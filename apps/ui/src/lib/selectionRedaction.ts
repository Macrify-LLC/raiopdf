import type { PdfRedactionArea } from "@raiopdf/engine-api";
import { clamp, viewportRectToPdfRect, type PageViewport, type ViewportRect } from "./viewportGeometry";

/**
 * A DOMRect-shaped rectangle (CSS px, top-left origin) — the same shape
 * `Range.getClientRects()` entries and `Element.getBoundingClientRect()`
 * return. Typed structurally (not `DOMRect`) so this module stays DOM-free
 * and callers/tests can pass plain objects.
 */
export type RectLike = ViewportRect;

export interface RedactionAreasFromClientRectsOptions {
  /** Horizontal pad, in PDF points, added on each side. Default 1.5pt. */
  padPt?: number;
  /**
   * Client rects with either side smaller than this (CSS px) are dropped as
   * noise — an empty/collapsed range can still report a near-zero-size rect.
   * Default 2px.
   */
  minSidePx?: number;
}

const DEFAULT_PAD_PT = 1.5;
const DEFAULT_MIN_SIDE_PX = 2;
// Vertical padding is kept a fraction of the horizontal pad. Unlike
// `textItemToRedactionArea` (pageTextCache.ts), which pads generously
// because it derives a box from a text-item BASELINE and has to guess at
// ascender/descender extent, a browser selection client rect is already the
// rendered line box — it needs little vertical slack. Padding it as much as
// the horizontal side risks the box rasterizing into the line above or
// below, which `collectRedactionAreaTexts` would then treat as touched (see
// plan note #3 in the design doc for this feature).
const VERTICAL_PAD_FRACTION = 1 / 3;

/**
 * Converts one `Range.getClientRects()` result (one rect per visual line of
 * a text selection) into pending redaction areas, one per surviving rect.
 *
 * Pure and DOM-free: `rects` and `frame` are plain rect-like objects (the
 * caller reads them from the DOM), `viewport` is a pdf.js `PageViewport`.
 * Reuses the exact viewport-to-PDF conversion the draw-a-box redaction path
 * already uses (`viewportRectToPdfRect`), so rotation/zoom behave
 * identically for both input methods.
 */
export function redactionAreasFromClientRects(
  rects: readonly RectLike[],
  frame: RectLike,
  viewport: PageViewport,
  pageIndex: number,
  opts: RedactionAreasFromClientRectsOptions = {},
): PdfRedactionArea[] {
  const padPt = opts.padPt ?? DEFAULT_PAD_PT;
  const minSidePx = opts.minSidePx ?? DEFAULT_MIN_SIDE_PX;
  const verticalPadPt = padPt * VERTICAL_PAD_FRACTION;
  const areas: PdfRedactionArea[] = [];

  for (const rect of rects) {
    // Frame-relative, then clamped to the page frame on both corners (same
    // clamp `getViewportPoint` in PageView.tsx uses for box-draw points) —
    // a selection can run into a scrollable margin or a neighboring page's
    // gap, which must never produce an area outside this page.
    const left = clamp(rect.left - frame.left, 0, frame.width);
    const right = clamp(rect.left - frame.left + rect.width, 0, frame.width);
    const top = clamp(rect.top - frame.top, 0, frame.height);
    const bottom = clamp(rect.top - frame.top + rect.height, 0, frame.height);
    const width = right - left;
    const height = bottom - top;

    if (width < minSidePx || height < minSidePx) {
      continue;
    }

    const frameRect: ViewportRect = { left, top, width, height };
    const pdfRect = viewportRectToPdfRect(frameRect, viewport);

    areas.push({
      pageIndex,
      x: Math.max(0, pdfRect.x - padPt),
      y: Math.max(0, pdfRect.y - verticalPadPt),
      w: Math.max(1, pdfRect.w + padPt * 2),
      h: Math.max(1, pdfRect.h + verticalPadPt * 2),
    });
  }

  return areas;
}
