import type {
  PdfEdit,
  PdfEditColor,
  PdfEditImageFormat,
  PdfEditPoint,
  PdfEditRect,
  PdfFormFieldValue,
} from "@raiopdf/engine-api";
import { pdfRectsIntersect, type PdfSpaceRect } from "./viewportGeometry";

/**
 * Pending-edit model: every add-content item lives in UI state as an overlay
 * until Save, when the whole list becomes one `applyEdits` engine call.
 * Geometry is stored in PDF user-space points (bottom-left origin) so it
 * survives zoom changes and maps 1:1 onto the engine contract.
 */

export type EditToolId =
  | "select"
  | "highlight"
  | "textBox"
  | "image"
  | "comment"
  | "draw"
  | "sign";

export interface PendingHighlight {
  kind: "highlight";
  id: string;
  pageIndex: number;
  rects: readonly PdfEditRect[];
  color?: PdfEditColor;
  opacity?: number;
}

export interface PendingTextBox {
  kind: "textBox";
  id: string;
  pageIndex: number;
  rect: PdfEditRect;
  text: string;
  fontSizePt: number;
  color?: PdfEditColor;
}

export interface PendingStamp {
  kind: "image" | "signature";
  id: string;
  pageIndex: number;
  rect: PdfEditRect;
  bytes: Uint8Array;
  format: PdfEditImageFormat;
  /** Data URL used to render the overlay preview. */
  dataUrl: string;
  /** Natural width / height, for aspect-locked resize. */
  aspectRatio: number;
}

export interface PendingComment {
  kind: "comment";
  id: string;
  pageIndex: number;
  at: PdfEditPoint;
  text: string;
}

export interface PendingInk {
  kind: "ink";
  id: string;
  pageIndex: number;
  strokes: ReadonlyArray<readonly PdfEditPoint[]>;
  strokeWidthPt?: number;
  color?: PdfEditColor;
}

export type PendingEdit =
  | PendingHighlight
  | PendingTextBox
  | PendingStamp
  | PendingComment
  | PendingInk;

export const TEXT_BOX_FONT_SIZES = [10, 11, 12, 13, 14] as const;
export const DEFAULT_TEXT_BOX_FONT_SIZE = 12;
export const TEXT_BOX_LINE_HEIGHT = 1.2;
export const INK_STROKE_WIDTH_PT = 1.5;
export const COMMENT_ICON_SIZE_PT = 20;

/**
 * Builds the engine `PdfEdit[]` for one applyEdits call. Placed overlays go
 * first in placement order; changed form values (document-scoped) join as a
 * single trailing `formValues` edit.
 */
export function toPdfEdits(
  pending: readonly PendingEdit[],
  formValues: Readonly<Record<string, PdfFormFieldValue>> = {},
): PdfEdit[] {
  const edits: PdfEdit[] = pending.map((edit) => {
    switch (edit.kind) {
      case "highlight":
        return {
          type: "highlight",
          pageIndex: edit.pageIndex,
          rects: edit.rects,
          ...(edit.color ? { color: edit.color } : {}),
          ...(edit.opacity !== undefined ? { opacity: edit.opacity } : {}),
        };
      case "textBox":
        return {
          type: "textBox",
          pageIndex: edit.pageIndex,
          rect: edit.rect,
          text: edit.text,
          fontSizePt: edit.fontSizePt,
          ...(edit.color ? { color: edit.color } : {}),
        };
      case "image":
      case "signature":
        return {
          type: edit.kind,
          pageIndex: edit.pageIndex,
          rect: edit.rect,
          bytes: edit.bytes,
          format: edit.format,
        };
      case "comment":
        return {
          type: "comment",
          pageIndex: edit.pageIndex,
          at: edit.at,
          text: edit.text,
        };
      case "ink":
        return {
          type: "ink",
          pageIndex: edit.pageIndex,
          strokes: edit.strokes,
          strokeWidthPt: edit.strokeWidthPt ?? INK_STROKE_WIDTH_PT,
          ...(edit.color ? { color: edit.color } : {}),
        };
    }
  });

  if (Object.keys(formValues).length > 0) {
    edits.push({ type: "formValues", values: formValues });
  }

  return edits;
}

export function describePendingEdit(edit: PendingEdit): {
  label: string;
  detail: string | null;
} {
  switch (edit.kind) {
    case "highlight":
      return {
        label: "Highlight",
        detail: `${edit.rects.length} ${edit.rects.length === 1 ? "line" : "lines"}`,
      };
    case "textBox":
      return { label: "Text box", detail: excerpt(edit.text) };
    case "image":
      return { label: "Image", detail: null };
    case "signature":
      return { label: "Signature", detail: null };
    case "comment":
      return { label: "Comment", detail: excerpt(edit.text) };
    case "ink":
      return { label: "Drawing", detail: null };
  }
}

export function excerpt(text: string, maxLength = 42): string {
  const collapsed = text.replace(/\s+/g, " ").trim();

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

/** A text run on the page, in PDF user-space points. */
export interface PageTextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Turns a drag band into one rectangle per highlighted text line.
 *
 * Text runs intersecting the band cluster by their position along the line
 * axis (`y` for upright pages, `x` for sideways pages); each cluster unions
 * into a single line rect. Returns rects in top-to-bottom reading order.
 */
export function computeHighlightLineRects(
  band: PdfSpaceRect,
  textBoxes: readonly PageTextBox[],
  sideways = false,
): PdfEditRect[] {
  const hits = textBoxes.filter((box) => pdfRectsIntersect(band, box));

  if (hits.length === 0) {
    return [];
  }

  const lineKey = (box: PageTextBox) => (sideways ? box.x + box.w / 2 : box.y + box.h / 2);
  const lineThickness = (box: PageTextBox) => (sideways ? box.w : box.h);
  const sorted = [...hits].sort((left, right) => lineKey(left) - lineKey(right));
  const clusters: PageTextBox[][] = [];

  for (const box of sorted) {
    const lastCluster = clusters.at(-1);
    const lastBox = lastCluster?.at(-1);
    const tolerance = lastBox
      ? Math.max(lineThickness(box), lineThickness(lastBox), 4) * 0.6
      : 0;

    if (lastCluster && lastBox && Math.abs(lineKey(box) - lineKey(lastBox)) <= tolerance) {
      lastCluster.push(box);
    } else {
      clusters.push([box]);
    }
  }

  return clusters
    .map((cluster) => unionBoxes(cluster))
    .sort((left, right) => right.y + right.h - (left.y + left.h));
}

function unionBoxes(boxes: readonly PageTextBox[]): PdfEditRect {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));

  return {
    x,
    y,
    w: Math.max(1, maxX - x),
    h: Math.max(1, maxY - y),
  };
}

/** Decodes a data URL into raw bytes (used for signature images). */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
