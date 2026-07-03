import type { PDFPageProxy } from "./pdfjs";

/**
 * Shared canvas <-> PDF-point mapping helpers.
 *
 * These wrap pdf.js viewport conversions so every overlay feature (redaction,
 * highlight, text box, image, comment, draw, sign) uses one rotation- and
 * zoom-aware coordinate path. Geometry on the PDF side is always user-space
 * points with a bottom-left origin — the redaction coordinate contract from
 * `@raiopdf/engine-api`.
 */

export type PageViewport = ReturnType<PDFPageProxy["getViewport"]>;

/** A point in canvas/viewport CSS pixels (top-left origin). */
export interface ViewportPoint {
  x: number;
  y: number;
}

/** A rectangle in canvas/viewport CSS pixels (top-left origin). */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** An axis-aligned rectangle in PDF user-space points (bottom-left origin). */
export interface PdfSpaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A point in PDF user-space points (bottom-left origin). */
export interface PdfSpacePoint {
  x: number;
  y: number;
}

export function viewportPointToPdfPoint(
  point: ViewportPoint,
  viewport: PageViewport,
): PdfSpacePoint {
  const [x, y] = viewport.convertToPdfPoint(point.x, point.y);

  return { x, y };
}

export function pdfPointToViewportPoint(
  point: PdfSpacePoint,
  viewport: PageViewport,
): ViewportPoint {
  const [x, y] = viewport.convertToViewportPoint(point.x, point.y);

  return { x, y };
}

/**
 * Maps a viewport rectangle to its axis-aligned PDF user-space bounding box.
 * Corner-maps through the viewport transform, so page `/Rotate` is handled —
 * on sideways pages the width/height swap naturally.
 */
export function viewportRectToPdfRect(
  rect: ViewportRect,
  viewport: PageViewport,
): PdfSpaceRect {
  const corners = [
    viewport.convertToPdfPoint(rect.left, rect.top),
    viewport.convertToPdfPoint(rect.left + rect.width, rect.top),
    viewport.convertToPdfPoint(rect.left, rect.top + rect.height),
    viewport.convertToPdfPoint(rect.left + rect.width, rect.top + rect.height),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
  };
}

/**
 * Maps a PDF user-space rectangle to its axis-aligned viewport bounding box.
 * Inverse companion of `viewportRectToPdfRect`.
 */
export function pdfRectToViewportRect(
  rect: PdfSpaceRect,
  viewport: PageViewport,
): ViewportRect {
  const corners = [
    viewport.convertToViewportPoint(rect.x, rect.y),
    viewport.convertToViewportPoint(rect.x + rect.w, rect.y),
    viewport.convertToViewportPoint(rect.x, rect.y + rect.h),
    viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);

  return {
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

export function pointsToViewportRect(
  first: ViewportPoint,
  second: ViewportPoint,
): ViewportRect {
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);

  return {
    left,
    top,
    width: Math.abs(first.x - second.x),
    height: Math.abs(first.y - second.y),
  };
}

/** CSS positioning style for an absolutely-positioned viewport rect overlay. */
export function toOverlayStyle(rect: ViewportRect): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function pdfRectsIntersect(left: PdfSpaceRect, right: PdfSpaceRect): boolean {
  return (
    left.x < right.x + right.w &&
    left.x + left.w > right.x &&
    left.y < right.y + right.h &&
    left.y + left.h > right.y
  );
}

export function pdfRectContainsPoint(rect: PdfSpaceRect, point: PdfSpacePoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}
