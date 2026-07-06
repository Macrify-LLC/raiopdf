import type {
  PdfEdit,
  PdfEditColor,
  PdfEditImageFormat,
  PdfEditPoint,
  PdfRaioAnnotationEdit,
  PdfRaioAnnotationImport,
  PdfEditRect,
  PdfShapeKind,
  PdfFormFieldValue,
  PdfTextBoxAlign,
  PdfTextBoxFontFamily,
} from "@raiopdf/engine-api";
import {
  DEFAULT_CALLOUT_STROKE_COLOR,
  DEFAULT_CALLOUT_STROKE_WIDTH_PT,
  DEFAULT_SHAPE_STROKE_COLOR,
  DEFAULT_SHAPE_STROKE_WIDTH_PT,
  DEFAULT_TEXT_COLOR,
} from "./editStyles";
import { clamp } from "./viewportGeometry";

/**
 * Pending-edit model: every add-content item lives in UI state as an overlay
 * until Save, when the whole list becomes one `applyEdits` engine call.
 * Geometry is stored in PDF user-space points (bottom-left origin) so it
 * survives zoom changes and maps 1:1 onto the engine contract.
 */

export type EditToolId =
  | "select"
  | "highlight"
  | "underline"
  | "strikethrough"
  | "textBox"
  | "callout"
  | "image"
  | "comment"
  | "draw"
  | "shapeRect"
  | "shapeEllipse"
  | "shapeLine"
  | "shapeArrow"
  | "sign";

export type TextMarkupToolId = "highlight" | "underline" | "strikethrough";
export type ShapeToolId = "shapeRect" | "shapeEllipse" | "shapeLine" | "shapeArrow";
export type PendingShapeKind = PdfShapeKind;
export type PendingEditStatus = "draft" | "applied";

interface PendingEditBase {
  id: string;
  pageIndex: number;
  status?: PendingEditStatus;
  /**
   * User-applied lock, distinct from `status`. A pinned floating annotation is
   * locked in place and click-through so it stops intercepting clicks meant for
   * the text underneath — see the pin affordances in EditLayer. Imported
   * annotations come back interactive (unpinned) even though their `status` is
   * `applied`; pinning is only ever the user's explicit action.
   */
  pinned?: boolean;
  annotId?: string;
  annotSource?: "raio";
  sourceBaseline?: string;
}

export interface PendingHighlight extends PendingEditBase {
  kind: "highlight";
  rects: readonly PdfEditRect[];
  color?: PdfEditColor;
  opacity?: number;
}

export interface PendingTextMarkup extends PendingEditBase {
  kind: "underline" | "strikethrough";
  rects: readonly PdfEditRect[];
  color?: PdfEditColor;
  thicknessPt?: number;
}

export interface PendingTextBox extends PendingEditBase {
  kind: "textBox";
  rect: PdfEditRect;
  text: string;
  fontSizePt: number;
  color?: PdfEditColor;
  backgroundColor?: PdfEditColor | null;
  backgroundOpacity?: number;
  fontFamily?: PdfTextBoxFontFamily;
  bold?: boolean;
  italic?: boolean;
  align?: PdfTextBoxAlign;
}

export interface PendingCallout extends PendingEditBase {
  kind: "callout";
  rect: PdfEditRect;
  tip: PdfEditPoint;
  text: string;
  fontSizePt: number;
  color?: PdfEditColor;
  fontFamily?: PdfTextBoxFontFamily;
  bold?: boolean;
  italic?: boolean;
  align?: PdfTextBoxAlign;
  strokeColor?: PdfEditColor;
  strokeWidthPt?: number;
  arrowhead?: boolean;
  boxBorder?: boolean;
  boxFill?: PdfEditColor | null;
}

export interface PendingStamp extends PendingEditBase {
  kind: "image" | "signature";
  rect: PdfEditRect;
  bytes: Uint8Array;
  format: PdfEditImageFormat;
  /** Data URL used to render the overlay preview. */
  dataUrl: string;
  /** Natural width / height, for aspect-locked resize. */
  aspectRatio: number;
}

export interface PendingComment extends PendingEditBase {
  kind: "comment";
  at: PdfEditPoint;
  text: string;
}

export interface PendingInk extends PendingEditBase {
  kind: "ink";
  strokes: ReadonlyArray<readonly PdfEditPoint[]>;
  strokeWidthPt?: number;
  color?: PdfEditColor;
}

export type PendingShape =
  | (PendingEditBase & {
      kind: "shape";
      shape: "rect" | "ellipse";
      rect: PdfEditRect;
      strokeWidthPt?: number;
      strokeColor?: PdfEditColor;
      fillColor?: PdfEditColor | null;
    })
  | (PendingEditBase & {
      kind: "shape";
      shape: "line" | "arrow";
      from: PdfEditPoint;
      to: PdfEditPoint;
      strokeWidthPt?: number;
      strokeColor?: PdfEditColor;
    });

export type PendingEdit =
  | PendingHighlight
  | PendingTextMarkup
  | PendingTextBox
  | PendingCallout
  | PendingStamp
  | PendingComment
  | PendingInk
  | PendingShape;

export interface AnnotationSavePlan {
  appendEdits: PdfEdit[];
  updateEdits: readonly { annotId: string; edit: PdfRaioAnnotationEdit }[];
  deleteAnnotIds: readonly string[];
  hasSignatureEdit: boolean;
}

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
  const edits: PdfEdit[] = pending.map(toPdfEdit);

  if (Object.keys(formValues).length > 0) {
    edits.push({ type: "formValues", values: formValues });
  }

  return edits;
}

export function toPdfEdit(edit: PendingEdit): PdfEdit {
  switch (edit.kind) {
    case "highlight":
      return {
        type: "highlight",
        ...(edit.annotId ? { annotId: edit.annotId } : {}),
        pageIndex: edit.pageIndex,
        rects: edit.rects,
        ...(edit.color ? { color: edit.color } : {}),
        ...(edit.opacity !== undefined ? { opacity: edit.opacity } : {}),
      };
    case "underline":
    case "strikethrough":
      return {
        type: edit.kind,
        ...(edit.annotId ? { annotId: edit.annotId } : {}),
        pageIndex: edit.pageIndex,
        rects: edit.rects,
        ...(edit.color && !editColorsEqual(edit.color, DEFAULT_TEXT_COLOR)
          ? { color: edit.color }
          : {}),
        ...(edit.thicknessPt !== undefined ? { thicknessPt: edit.thicknessPt } : {}),
      };
    case "textBox":
      return {
        type: "textBox",
        ...(edit.annotId ? { annotId: edit.annotId } : {}),
        pageIndex: edit.pageIndex,
        rect: edit.rect,
        text: edit.text,
        fontSizePt: edit.fontSizePt,
        ...(edit.color ? { color: edit.color } : {}),
        ...(edit.backgroundColor ? { backgroundColor: edit.backgroundColor } : {}),
        ...(edit.backgroundOpacity !== undefined
          ? { backgroundOpacity: edit.backgroundOpacity }
          : {}),
        ...(edit.fontFamily && edit.fontFamily !== "helvetica"
          ? { fontFamily: edit.fontFamily }
          : {}),
        ...(edit.bold ? { bold: edit.bold } : {}),
        ...(edit.italic ? { italic: edit.italic } : {}),
        ...(edit.align && edit.align !== "left" ? { align: edit.align } : {}),
      };
    case "callout": {
      const strokeWidthPt = edit.strokeWidthPt ?? DEFAULT_CALLOUT_STROKE_WIDTH_PT;

      return {
        type: "callout",
        pageIndex: edit.pageIndex,
        rect: edit.rect,
        tip: edit.tip,
        text: edit.text,
        fontSizePt: edit.fontSizePt,
        ...(edit.color ? { color: edit.color } : {}),
        ...(edit.fontFamily && edit.fontFamily !== "helvetica"
          ? { fontFamily: edit.fontFamily }
          : {}),
        ...(edit.bold ? { bold: edit.bold } : {}),
        ...(edit.italic ? { italic: edit.italic } : {}),
        ...(edit.align && edit.align !== "left" ? { align: edit.align } : {}),
        ...(edit.strokeColor && !editColorsEqual(edit.strokeColor, DEFAULT_CALLOUT_STROKE_COLOR)
          ? { strokeColor: edit.strokeColor }
          : {}),
        ...(strokeWidthPt !== DEFAULT_CALLOUT_STROKE_WIDTH_PT ? { strokeWidthPt } : {}),
        ...(edit.arrowhead === false ? { arrowhead: false } : {}),
        ...(edit.boxBorder === false ? { boxBorder: false } : {}),
        ...(edit.boxFill ? { boxFill: edit.boxFill } : {}),
      };
    }
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
        ...(edit.annotId ? { annotId: edit.annotId } : {}),
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
    case "shape": {
      const strokeWidthPt = edit.strokeWidthPt ?? DEFAULT_SHAPE_STROKE_WIDTH_PT;
      const common = {
        type: "shape" as const,
        pageIndex: edit.pageIndex,
        shape: edit.shape,
        ...(strokeWidthPt !== DEFAULT_SHAPE_STROKE_WIDTH_PT ? { strokeWidthPt } : {}),
        ...(edit.strokeColor && !editColorsEqual(edit.strokeColor, DEFAULT_SHAPE_STROKE_COLOR)
          ? { strokeColor: edit.strokeColor }
          : {}),
      };

      if (!isLineShape(edit)) {
        return {
          ...common,
          shape: edit.shape,
          rect: edit.rect,
          ...(edit.fillColor ? { fillColor: edit.fillColor } : {}),
        };
      }

      return {
        ...common,
        shape: edit.shape,
        from: edit.from,
        to: edit.to,
      };
    }
  }
}

export function pendingEditsFromRaioAnnotations(
  annotations: readonly PdfRaioAnnotationImport[],
): PendingEdit[] {
  return annotations.map((annotation) => {
    const pending = pendingEditFromRaioAnnotation(annotation);

    return {
      ...pending,
      sourceBaseline: JSON.stringify(toPdfEdit(pending)),
    };
  });
}

export function buildAnnotationSavePlan(
  pending: readonly PendingEdit[],
  importedAnnotIds: ReadonlySet<string>,
): AnnotationSavePlan {
  const appendEdits: PdfEdit[] = [];
  const updateEdits: { annotId: string; edit: PdfRaioAnnotationEdit }[] = [];
  const currentAnnotIds = new Set<string>();
  let hasSignatureEdit = false;

  for (const edit of pending) {
    const pdfEdit = toPdfEdit(edit);

    if (edit.kind === "signature") {
      hasSignatureEdit = true;
    }

    if (!edit.annotId) {
      appendEdits.push(pdfEdit);
      continue;
    }

    currentAnnotIds.add(edit.annotId);

    if (!isRaioAnnotationPdfEdit(pdfEdit)) {
      appendEdits.push(pdfEdit);
      continue;
    }

    const baseline = edit.sourceBaseline;

    if (baseline && JSON.stringify(pdfEdit) === baseline) {
      continue;
    }

    updateEdits.push({ annotId: edit.annotId, edit: pdfEdit });
  }

  const deleteAnnotIds = [...importedAnnotIds].filter((annotId) => !currentAnnotIds.has(annotId));

  return {
    appendEdits,
    updateEdits,
    deleteAnnotIds,
    hasSignatureEdit,
  };
}

export function annotationSavePlanHasChanges(plan: AnnotationSavePlan): boolean {
  return plan.appendEdits.length > 0 ||
    plan.updateEdits.length > 0 ||
    plan.deleteAnnotIds.length > 0;
}

function pendingEditFromRaioAnnotation(annotation: PdfRaioAnnotationImport): PendingEdit {
  const common = {
    id: `annot-${annotation.annotId}`,
    annotId: annotation.annotId,
    annotSource: "raio" as const,
    pageIndex: annotation.pageIndex,
    status: "applied" as const,
  };
  const edit = annotation.edit;

  switch (edit.type) {
    case "highlight":
      return {
        ...common,
        kind: "highlight",
        rects: edit.rects,
        ...(edit.color ? { color: edit.color } : {}),
        ...(edit.opacity !== undefined ? { opacity: edit.opacity } : {}),
      };
    case "underline":
    case "strikethrough":
      return {
        ...common,
        kind: edit.type,
        rects: edit.rects,
        ...(edit.color ? { color: edit.color } : {}),
        ...(edit.thicknessPt !== undefined ? { thicknessPt: edit.thicknessPt } : {}),
      };
    case "textBox":
      return {
        ...common,
        kind: "textBox",
        rect: edit.rect,
        text: edit.text,
        fontSizePt: edit.fontSizePt ?? DEFAULT_TEXT_BOX_FONT_SIZE,
        ...(edit.color ? { color: edit.color } : {}),
        ...(edit.backgroundColor !== undefined ? { backgroundColor: edit.backgroundColor } : {}),
        ...(edit.backgroundOpacity !== undefined
          ? { backgroundOpacity: edit.backgroundOpacity }
          : {}),
        ...(edit.fontFamily ? { fontFamily: edit.fontFamily } : {}),
        ...(edit.bold !== undefined ? { bold: edit.bold } : {}),
        ...(edit.italic !== undefined ? { italic: edit.italic } : {}),
        ...(edit.align ? { align: edit.align } : {}),
      };
    case "comment":
      return {
        ...common,
        kind: "comment",
        at: edit.at,
        text: edit.text,
      };
  }
}

function isRaioAnnotationPdfEdit(edit: PdfEdit): edit is PdfRaioAnnotationEdit {
  return edit.type === "highlight" ||
    edit.type === "underline" ||
    edit.type === "strikethrough" ||
    edit.type === "textBox" ||
    edit.type === "comment";
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
    case "underline":
      return {
        label: "Underline",
        detail: `${edit.rects.length} ${edit.rects.length === 1 ? "line" : "lines"}`,
      };
    case "strikethrough":
      return {
        label: "Strikethrough",
        detail: `${edit.rects.length} ${edit.rects.length === 1 ? "line" : "lines"}`,
      };
    case "textBox":
      return { label: "Text box", detail: excerpt(edit.text) };
    case "callout":
      return { label: "Callout", detail: excerpt(edit.text) };
    case "image":
      return { label: "Image", detail: null };
    case "signature":
      return { label: "Signature", detail: null };
    case "comment":
      return { label: "Comment", detail: excerpt(edit.text) };
    case "ink":
      return { label: "Drawing", detail: null };
    case "shape":
      return { label: shapeLabel(edit.shape), detail: null };
  }
}

export function normalizePdfRectFromPoints(
  from: PdfEditPoint,
  to: PdfEditPoint,
): PdfEditRect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);

  return {
    x,
    y,
    w: Math.max(from.x, to.x) - x,
    h: Math.max(from.y, to.y) - y,
  };
}

export function shapeKindFromTool(tool: ShapeToolId): PendingShapeKind {
  switch (tool) {
    case "shapeRect":
      return "rect";
    case "shapeEllipse":
      return "ellipse";
    case "shapeLine":
      return "line";
    case "shapeArrow":
      return "arrow";
  }
}

function shapeLabel(shape: PendingShapeKind): string {
  switch (shape) {
    case "rect":
      return "Rectangle";
    case "ellipse":
      return "Ellipse";
    case "line":
      return "Line";
    case "arrow":
      return "Arrow";
  }
}

function isLineShape(
  edit: PendingShape,
): edit is Extract<PendingShape, { shape: "line" | "arrow" }> {
  return edit.shape === "line" || edit.shape === "arrow";
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

/** One clustered line of page text, in PDF user-space points. */
interface MarkupLine {
  /** Center along the block (cross-line) axis. */
  blockCenter: number;
  /** Extent along the block axis (the line's thickness band). */
  blockMin: number;
  blockMax: number;
  /** Extent along the inline (reading) axis — the line's actual text run. */
  inlineMin: number;
  inlineMax: number;
}

/**
 * Builds text-hugging markup rects for a drag from `anchor` to `focus`, in
 * reading order: the first line runs from the start caret to end-of-line, any
 * interior lines span their full text width, and the last line runs from
 * line-start to the end caret. This mirrors a native text selection rather
 * than the drag's bounding box, so multi-line markup never bleeds into the
 * whitespace between the two caret columns.
 *
 * This is the deterministic fallback the edit layer uses when the live DOM
 * text selection is unavailable (e.g. a page whose text layer failed to
 * render). When the selection exists, the caller derives rects straight from
 * it so the committed markup matches exactly what the user saw highlighted.
 *
 * Geometry is PDF user-space (bottom-left origin). `sideways` flips the block
 * and inline axes for `/Rotate` 90/270 pages.
 */
export function computeTextMarkupSelectionRects(
  anchor: PdfEditPoint,
  focus: PdfEditPoint,
  textBoxes: readonly PageTextBox[],
  sideways = false,
): PdfEditRect[] {
  const lines = clusterTextLines(textBoxes, sideways);

  if (lines.length === 0) {
    return [];
  }

  const blockOf = (point: PdfEditPoint) => (sideways ? point.x : point.y);
  const inlineOf = (point: PdfEditPoint) => (sideways ? point.y : point.x);
  const anchorBlock = blockOf(anchor);
  const focusBlock = blockOf(focus);
  const blockLow = Math.min(anchorBlock, focusBlock);
  const blockHigh = Math.max(anchorBlock, focusBlock);

  // Lines whose thickness band overlaps the dragged block interval — the
  // lines the caret actually swept across.
  const covered = lines.filter(
    (line) => line.blockMax >= blockLow && line.blockMin <= blockHigh,
  );

  if (covered.length === 0) {
    return [];
  }

  // Reading order top-to-bottom: descending block for upright pages (higher on
  // the page first), ascending for sideways.
  const ordered = [...covered].sort((left, right) =>
    sideways ? left.blockCenter - right.blockCenter : right.blockCenter - left.blockCenter,
  );
  const anchorIsTop = sideways ? anchorBlock <= focusBlock : anchorBlock >= focusBlock;
  const startInline = inlineOf(anchorIsTop ? anchor : focus);
  const endInline = inlineOf(anchorIsTop ? focus : anchor);

  const rects: PdfEditRect[] = [];

  ordered.forEach((line, index) => {
    let spanMin: number;
    let spanMax: number;

    if (ordered.length === 1) {
      spanMin = Math.min(startInline, endInline);
      spanMax = Math.max(startInline, endInline);
    } else if (index === 0) {
      spanMin = startInline;
      spanMax = line.inlineMax;
    } else if (index === ordered.length - 1) {
      spanMin = line.inlineMin;
      spanMax = endInline;
    } else {
      spanMin = line.inlineMin;
      spanMax = line.inlineMax;
    }

    spanMin = clamp(spanMin, line.inlineMin, line.inlineMax);
    spanMax = clamp(spanMax, line.inlineMin, line.inlineMax);

    if (spanMax - spanMin <= 0) {
      return;
    }

    rects.push(
      sideways
        ? {
            x: line.blockMin,
            y: spanMin,
            w: line.blockMax - line.blockMin,
            h: spanMax - spanMin,
          }
        : {
            x: spanMin,
            y: line.blockMin,
            w: spanMax - spanMin,
            h: line.blockMax - line.blockMin,
          },
    );
  });

  return rects;
}

function clusterTextLines(
  textBoxes: readonly PageTextBox[],
  sideways: boolean,
): MarkupLine[] {
  if (textBoxes.length === 0) {
    return [];
  }

  const blockCenter = (box: PageTextBox) => (sideways ? box.x + box.w / 2 : box.y + box.h / 2);
  const thickness = (box: PageTextBox) => (sideways ? box.w : box.h);
  const sorted = [...textBoxes].sort((left, right) => blockCenter(left) - blockCenter(right));
  const clusters: PageTextBox[][] = [];

  for (const box of sorted) {
    const lastCluster = clusters.at(-1);
    const lastBox = lastCluster?.at(-1);
    const tolerance = lastBox
      ? Math.max(thickness(box), thickness(lastBox), 4) * 0.6
      : 0;

    if (lastCluster && lastBox && Math.abs(blockCenter(box) - blockCenter(lastBox)) <= tolerance) {
      lastCluster.push(box);
    } else {
      clusters.push([box]);
    }
  }

  return clusters.map((cluster) => {
    const blockMin = Math.min(...cluster.map((box) => (sideways ? box.x : box.y)));
    const blockMax = Math.max(...cluster.map((box) => (sideways ? box.x + box.w : box.y + box.h)));
    const inlineMin = Math.min(...cluster.map((box) => (sideways ? box.y : box.x)));
    const inlineMax = Math.max(...cluster.map((box) => (sideways ? box.y + box.h : box.x + box.w)));

    return { blockCenter: (blockMin + blockMax) / 2, blockMin, blockMax, inlineMin, inlineMax };
  });
}

function editColorsEqual(left: PdfEditColor, right: PdfEditColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
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
