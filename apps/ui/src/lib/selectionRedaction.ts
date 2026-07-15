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
const MIN_INLINE_MERGE_GAP_PX = 4;
const INLINE_MERGE_GAP_HEIGHT_FRACTION = 0.75;
const SAME_LINE_CENTER_TOLERANCE_HEIGHT_FRACTION = 0.75;
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
 * Converts one `Range.getClientRects()` result into pending redaction areas.
 * Browsers report fragments per inline/text-layer box (and may report the
 * same fully-selected box twice), so overlapping or nearby fragments on the
 * same visual line are normalized into one rectangle before conversion.
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
  const horizontalPadPx = padPt * viewport.scale;
  const verticalPadPx = verticalPadPt * viewport.scale;
  const areas: PdfRedactionArea[] = [];

  const normalizedRects = mergeVisualLineRects(
    rects.flatMap((rect) => {
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

      return width < minSidePx || height < minSidePx
        ? []
        : [{ left, top, width, height }];
    }),
  );

  for (const rect of normalizedRects) {
    // Pad in visual/viewport space, where horizontal and vertical retain
    // their meaning on 90/270-degree pages, then clamp the padded box to the
    // page before converting. Padding after conversion would swap these axes
    // on rotated pages and could reach into a neighboring visual line.
    const left = clamp(rect.left - horizontalPadPx, 0, frame.width);
    const right = clamp(rect.left + rect.width + horizontalPadPx, 0, frame.width);
    const top = clamp(rect.top - verticalPadPx, 0, frame.height);
    const bottom = clamp(rect.top + rect.height + verticalPadPx, 0, frame.height);
    const pdfRect = viewportRectToPdfRect(
      { left, top, width: right - left, height: bottom - top },
      viewport,
    );

    areas.push({
      pageIndex,
      x: Math.max(0, pdfRect.x),
      y: Math.max(0, pdfRect.y),
      w: Math.max(1, pdfRect.w),
      h: Math.max(1, pdfRect.h),
    });
  }

  return areas;
}

function mergeVisualLineRects(rects: readonly ViewportRect[]): ViewportRect[] {
  const merged: ViewportRect[] = [];
  const sorted = [...rects].sort((left, right) => (
    left.top - right.top || left.left - right.left
  ));

  for (const rect of sorted) {
    const lineIndex = merged.findIndex((candidate) => sameVisualLine(candidate, rect));

    if (lineIndex === -1) {
      merged.push(rect);
      continue;
    }

    merged[lineIndex] = unionViewportRects(merged[lineIndex]!, rect);
  }

  return merged.sort((left, right) => left.top - right.top || left.left - right.left);
}

function sameVisualLine(left: ViewportRect, right: ViewportRect): boolean {
  const leftCenter = left.top + left.height / 2;
  const rightCenter = right.top + right.height / 2;
  const maxHeight = Math.max(left.height, right.height);

  // Inline boxes from different fonts can share a baseline while exposing
  // noticeably different tops and heights in Chromium. Comparing their
  // vertical centers against the larger line box is stable across those font
  // metrics, while adjacent text lines remain farther than this tolerance.
  if (
    Math.abs(leftCenter - rightCenter)
    > maxHeight * SAME_LINE_CENTER_TOLERANCE_HEIGHT_FRACTION
  ) {
    return false;
  }

  const horizontalGap = Math.max(
    left.left - (right.left + right.width),
    right.left - (left.left + left.width),
    0,
  );
  const mergeGap = Math.max(
    MIN_INLINE_MERGE_GAP_PX,
    Math.min(left.height, right.height) * INLINE_MERGE_GAP_HEIGHT_FRACTION,
  );

  return horizontalGap <= mergeGap;
}

function unionViewportRects(left: ViewportRect, right: ViewportRect): ViewportRect {
  const x = Math.min(left.left, right.left);
  const y = Math.min(left.top, right.top);
  const maxX = Math.max(left.left + left.width, right.left + right.width);
  const maxY = Math.max(left.top + left.height, right.top + right.height);

  return {
    left: x,
    top: y,
    width: maxX - x,
    height: maxY - y,
  };
}
