import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import {
  clipMarkupRectsToDragBand,
  computeTextMarkupSelectionRects,
  DEFAULT_TEXT_BOX_FONT_SIZE,
  TEXT_BOX_FONT_SIZES,
  TEXT_BOX_LINE_HEIGHT,
  COMMENT_ICON_SIZE_PT,
  type PageTextBox,
  type PendingCallout,
  type PendingComment,
  type PendingEdit,
  type PendingShape,
  type PendingStamp,
  type PendingTextBox,
  type ShapeToolId,
  type TextMarkupToolId,
  normalizePdfRectFromPoints,
  shapeKindFromTool,
} from "../lib/edits";
import {
  type PdfEditColor,
  type PdfTextBoxAlign,
  type PdfTextBoxFontFamily,
} from "@raiopdf/engine-api";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  DEFAULT_INK_COLOR,
  DEFAULT_INK_STROKE_WIDTH_PT,
  DEFAULT_CALLOUT_STROKE_COLOR,
  DEFAULT_CALLOUT_STROKE_WIDTH_PT,
  DEFAULT_SHAPE_STROKE_COLOR,
  DEFAULT_SHAPE_STROKE_WIDTH_PT,
  DEFAULT_TEXT_MARKUP_COLOR,
  DEFAULT_TEXT_MARKUP_THICKNESS_PT,
  DEFAULT_TEXT_BOX_BACKGROUND_OPACITY,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_FAMILY,
  pdfEditColorToHex,
} from "../lib/editStyles";
import { newEditId, type ArmedStamp, type EditingState } from "../hooks/useEditing";
import { isTextEntryTarget } from "../lib/domGuards";
import type { PDFPageProxy } from "../lib/pdfjs";
import {
  clamp,
  pdfRectContainsPoint,
  pdfRectToViewportRect,
  pointsToViewportRect,
  toOverlayStyle,
  viewportPointToPdfPoint,
  viewportRectToPdfRect,
  type PageViewport,
  type PdfSpacePoint,
  type PdfSpaceRect,
  type ViewportPoint,
  type ViewportRect,
} from "../lib/viewportGeometry";
import { computeTextBoxPreviewLines } from "../lib/textBoxPreview";
import { CommentMarkerIcon } from "../icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { hasOpenDialogStackEntry } from "./FloatingDialog";
import "./EditLayer.css";

/** Rapid re-clicks inside this window never place a second item. */
const PLACEMENT_GUARD_MS = 350;
const MIN_ITEM_SIZE_PX = 12;
const MIN_SHAPE_DRAG_PX = 3;
const ARROW_HEAD_MIN_PT = 8;
const ARROW_HEAD_MAX_PT = 32;
const DEFAULT_TEXT_BOX_WIDTH_PT = 180;
const TEXT_BOX_PADDING_PT = 4;

interface TextDraft {
  kind: "textBox" | "callout";
  /** Pending-edit id when re-editing an existing box; null for a new draft. */
  editId: string | null;
  rect: ViewportRect;
  tip?: ViewportPoint;
  text: string;
  fontSizePt: number;
  color?: PdfEditColor;
  backgroundColor?: PdfEditColor | null;
  backgroundOpacity?: number;
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

interface CommentDraft {
  editId: string | null;
  at: PdfSpacePoint;
  text: string;
}

interface ShapeDraft {
  tool: ShapeToolId;
  start: ViewportPoint;
  end: ViewportPoint;
}

interface CalloutPlacementDraft {
  box: ViewportRect;
  tipPreview: ViewportPoint | null;
}

type ResizeCorner = "nw" | "ne" | "sw" | "se";
type TextBoxStyleUpdate = Partial<
  Pick<PendingTextBox, "fontFamily" | "bold" | "italic" | "align">
>;

type ItemDrag =
  | {
      id: string;
      kind: "rect";
      mode: "move" | "resize";
      corner: ResizeCorner | null;
      startClientX: number;
      startClientY: number;
      startRect: ViewportRect;
      aspectRatio: number | null;
      moved: boolean;
    }
  | {
      id: string;
      kind: "line";
      mode: "move";
      corner: null;
      startClientX: number;
      startClientY: number;
      startFrom: ViewportPoint;
      startTo: ViewportPoint;
      moved: boolean;
    };

type DragPreview =
  | { id: string; kind: "rect"; rect: ViewportRect }
  | { id: string; kind: "line"; from: ViewportPoint; to: ViewportPoint };

interface StampGhost {
  id: string;
  kind: "image" | "signature";
  rect: ViewportRect;
  dataUrl: string;
}

export interface EditLayerProps {
  page: PDFPageProxy;
  viewport: PageViewport;
  pageIndex: number;
  editing: EditingState;
}

/**
 * The add-content overlay: renders every pending edit for the current page
 * and owns the placement interactions for the active edit tool. All geometry
 * round-trips through the shared viewport<->PDF-point mapping, so placement
 * is rotation- and zoom-correct by construction.
 */
export function EditLayer({ page, viewport, pageIndex, editing }: EditLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [textBoxes, setTextBoxes] = useState<readonly PageTextBox[]>([]);
  const [textLayerError, setTextLayerError] = useState<string | null>(null);
  const [drawDraft, setDrawDraft] = useState<readonly ViewportPoint[] | null>(null);
  const [shapeDraft, setShapeDraft] = useState<ShapeDraft | null>(null);
  const [calloutPlacementDraft, setCalloutPlacementDraft] =
    useState<CalloutPlacementDraft | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [stampGhost, setStampGhost] = useState<StampGhost | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const dragStartRef = useRef<ViewportPoint | null>(null);
  const drawPointsRef = useRef<ViewportPoint[]>([]);
  const itemDragRef = useRef<ItemDrag | null>(null);
  const placementGuardRef = useRef(0);
  const {
    tool,
    pendingEdits,
    addEdit,
    updateEdit,
    removeEdit,
    // Selection is shared editing state (not per-layer) because one
    // EditLayer mounts per visible page in the continuous-scroll viewer.
    selectedEditId: selectedId,
    setSelectedEditId: setSelectedId,
  } = editing;
  const scale = viewport.scale;
  const sideways = viewport.rotation % 180 !== 0;
  const pageEdits = useMemo(
    () => pendingEdits.filter((edit) => edit.pageIndex === pageIndex),
    [pageIndex, pendingEdits],
  );
  // The double-click markup-removal handler lives in a window listener whose
  // effect does not re-subscribe on every edit; this ref keeps it reading the
  // current page edits instead of a stale snapshot.
  const pageEditsRef = useRef(pageEdits);
  pageEditsRef.current = pageEdits;

  // Loaded eagerly per page so the first text-markup drag never races the
  // async text-layer read.
  useEffect(() => {
    let disposed = false;

    setTextBoxes([]);
    setTextLayerError(null);

    void page
      .getTextContent()
      .then((textContent) => {
        if (!disposed) {
          const boxes = extractPageTextBoxes(textContent.items);
          setTextBoxes(boxes);
          setTextLayerError(
            boxes.length === 0
              ? "This page has no text layer, so text markup is unavailable here."
              : null,
          );
        }
      })
      .catch(() => {
        if (!disposed) {
          setTextBoxes([]);
          setTextLayerError("Text could not be read on this page, so text markup is unavailable here.");
        }
      });

    return () => {
      disposed = true;
    };
  }, [page]);

  useEffect(() => {
    setDrawDraft(null);
    setShapeDraft(null);
    setCalloutPlacementDraft(null);
    setTextDraft(null);
    setCommentDraft(null);
    setDragPreview(null);
    setStampGhost(null);
    setContextMenu(null);
    dragStartRef.current = null;
    drawPointsRef.current = [];
    itemDragRef.current = null;
    // The double-place guard protects within a tool; switching tools (or
    // pages) is an explicit act, so the next placement starts fresh.
    placementGuardRef.current = 0;
  }, [tool, pageIndex, viewport]);

  const guardPlacement = useCallback(() => {
    const now = Date.now();

    if (now < placementGuardRef.current) {
      return false;
    }

    placementGuardRef.current = now + PLACEMENT_GUARD_MS;
    return true;
  }, []);

  const placementSuppressed = useCallback(() => Date.now() < placementGuardRef.current, []);

  const suppressPlacement = useCallback(() => {
    placementGuardRef.current = Date.now() + PLACEMENT_GUARD_MS;
  }, []);

  // Delete/Backspace removes the currently selected placed item (stamp,
  // image, text box). Ignored while typing into a field (the text-box/
  // comment drafts have their own textareas, which this already covers) or
  // while a dialog is open on top of the canvas. One EditLayer mounts per
  // visible page, so only the layer whose page owns the selected item acts.
  const selectedIdOnThisPage = useMemo(
    () => (selectedId && pageEdits.some((edit) => edit.id === selectedId) ? selectedId : null),
    [pageEdits, selectedId],
  );

  useEffect(() => {
    if (!selectedIdOnThisPage) {
      return;
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      if (!selectedIdOnThisPage || isTextEntryTarget(event.target) || hasOpenDialogStackEntry()) {
        return;
      }

      // Pinned items are locked: unpin first (they can't be selected while
      // pinned, but guard anyway so the pin contract holds everywhere).
      const selected = pageEditsRef.current.find((edit) => edit.id === selectedIdOnThisPage);

      if (selected?.pinned === true) {
        return;
      }

      event.preventDefault();
      removeEdit(selectedIdOnThisPage);
      setSelectedId(null);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [removeEdit, selectedIdOnThisPage, setSelectedId]);

  const getClientLayerPoint = useCallback(
    (
      clientX: number,
      clientY: number,
      options: { requireInside?: boolean } = {},
    ): ViewportPoint | null => {
      const layer = layerRef.current;

      if (!layer) {
        return null;
      }

      const bounds = layer.getBoundingClientRect();

      if (
        options.requireInside &&
        (clientX < bounds.left ||
          clientX > bounds.right ||
          clientY < bounds.top ||
          clientY > bounds.bottom)
      ) {
        return null;
      }

      return {
        x: clamp(clientX - bounds.left, 0, bounds.width),
        y: clamp(clientY - bounds.top, 0, bounds.height),
      };
    },
    [],
  );

  const getLayerPoint = useCallback(
    (event: ReactPointerEvent): ViewportPoint | null => {
      return getClientLayerPoint(event.clientX, event.clientY);
    },
    [getClientLayerPoint],
  );

  const addTextMarkup = useCallback(
    (textMarkupTool: TextMarkupToolId, rects: readonly PdfSpaceRect[]) => {
      editing.setMessage(null);

      if (textMarkupTool === "highlight") {
        addEdit({
          kind: "highlight",
          id: newEditId(),
          pageIndex,
          rects,
          ...editing.highlightStyle,
        });
      } else {
        addEdit({
          kind: textMarkupTool,
          id: newEditId(),
          pageIndex,
          rects,
          ...editing.textMarkupStyles[textMarkupTool],
        });
      }
    },
    [addEdit, editing, pageIndex],
  );

  useEffect(() => {
    if (!isTextMarkupTool(tool)) {
      return;
    }

    const activeTextMarkupTool = tool;

    function handlePointerDown(event: PointerEvent) {
      if (event.button !== 0) {
        return;
      }

      const point = getClientLayerPoint(event.clientX, event.clientY, { requireInside: true });

      if (!point) {
        return;
      }

      dragStartRef.current = point;
    }

    function handlePointerUp(event: PointerEvent) {
      const start = dragStartRef.current;

      if (!start) {
        return;
      }

      dragStartRef.current = null;
      const end = getClientLayerPoint(event.clientX, event.clientY);

      // A drag creates markup; a bare click (no movement) does not — removal
      // is the deliberate double-click below, so a stray click never deletes.
      // Gating on the drag distance also means the word-selection a
      // double-click leaves behind can't be mistaken for a fresh highlight.
      if (end) {
        const band = pointsToViewportRect(start, end);

        if (band.width < 3 && band.height < 3) {
          window.getSelection()?.removeAllRanges();
          return;
        }
      }

      // Prefer the live text selection so the committed markup matches exactly
      // the reading-order selection the user saw while dragging, instead of a
      // bounding box that swallows the whitespace between the two columns.
      const layer = layerRef.current;
      let rects: PdfSpaceRect[] = layer ? markupRectsFromSelection(layer, viewport) : [];

      if (rects.length === 0) {
        // No usable selection (e.g. a page whose text layer failed to load):
        // fall back to reading-order geometry from the drag endpoints.
        if (!end) {
          window.getSelection()?.removeAllRanges();
          return;
        }

        rects = computeTextMarkupSelectionRects(
          viewportPointToPdfPoint(start, viewport),
          viewportPointToPdfPoint(end, viewport),
          textBoxes,
          sideways,
        );
      }

      // Bound the result to the drag's line span. Dragging into whitespace lets
      // the browser's text selection run greedily to the end of the page; this
      // keeps only the lines the drag actually crossed (full reading-order width
      // preserved — the clip is on the cross-line axis only).
      if (end) {
        rects = clipMarkupRectsToDragBand(
          rects,
          viewportRectToPdfRect(pointsToViewportRect(start, end), viewport),
          sideways,
        );
      }

      if (rects.length === 0) {
        editing.setMessage(
          `No text under that drag — ${textMarkupPlural(activeTextMarkupTool)} attach to text lines.`,
        );
        window.getSelection()?.removeAllRanges();
        return;
      }

      addTextMarkup(activeTextMarkupTool, rects);
      window.getSelection()?.removeAllRanges();
    }

    // Double-click an existing markup to remove it — deliberate, so reading
    // over a page never deletes a highlight by accident.
    function handleDoubleClick(event: MouseEvent) {
      const point = getClientLayerPoint(event.clientX, event.clientY, { requireInside: true });

      if (!point) {
        return;
      }

      const pdfPoint = viewportPointToPdfPoint(point, viewport);
      const hit = textMarkupAtPoint(pageEditsRef.current, pdfPoint, activeTextMarkupTool);

      if (hit) {
        removeEdit(hit.id);
        editing.setMessage(null);
        window.getSelection()?.removeAllRanges();
      }
    }

    function handlePointerCancel() {
      dragStartRef.current = null;
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    window.addEventListener("dblclick", handleDoubleClick, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      window.removeEventListener("dblclick", handleDoubleClick, true);
    };
  }, [
    addTextMarkup,
    editing,
    getClientLayerPoint,
    removeEdit,
    sideways,
    textBoxes,
    tool,
    viewport,
  ]);

  const commitTextDraft = useCallback(() => {
    setTextDraft((draft) => {
      if (!draft) {
        return null;
      }

      const text = draft.text.replace(/\r\n/g, "\n");

      if (!text.trim()) {
        return null;
      }

      const lineCount = text.split("\n").length;
      const neededHeight =
        (lineCount * draft.fontSizePt * TEXT_BOX_LINE_HEIGHT + TEXT_BOX_PADDING_PT) * scale;
      const fitted: ViewportRect = {
        ...draft.rect,
        height: Math.max(draft.rect.height, neededHeight),
      };
      const rect = viewportRectToPdfRect(fitted, viewport);

      if (draft.kind === "callout") {
        if (!draft.tip) {
          return null;
        }

        if (draft.editId) {
          // Re-editing an existing callout: update text/box in place and leave
          // the leader's `tip` (and stroke/arrowhead/fill) untouched via spread,
          // so the callout keeps pointing at the same target.
          updateEdit(draft.editId, (edit) =>
            edit.kind === "callout"
              ? {
                  ...edit,
                  rect,
                  text,
                  fontSizePt: draft.fontSizePt,
                  ...(draft.color ? { color: draft.color } : {}),
                  fontFamily: draft.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
                  bold: Boolean(draft.bold),
                  italic: Boolean(draft.italic),
                  align: draft.align ?? DEFAULT_TEXT_ALIGN,
                }
              : edit,
          );
        } else {
          addEdit({
            kind: "callout",
            id: newEditId(),
            pageIndex,
            rect,
            tip: viewportPointToPdfPoint(draft.tip, viewport),
            text,
            fontSizePt: draft.fontSizePt,
            ...(draft.color ? { color: draft.color } : {}),
            fontFamily: draft.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
            bold: Boolean(draft.bold),
            italic: Boolean(draft.italic),
            align: draft.align ?? DEFAULT_TEXT_ALIGN,
            strokeWidthPt: draft.strokeWidthPt ?? DEFAULT_CALLOUT_STROKE_WIDTH_PT,
            ...(draft.strokeColor ? { strokeColor: draft.strokeColor } : {}),
            arrowhead: draft.arrowhead ?? true,
            boxBorder: draft.boxBorder ?? true,
            ...(draft.boxFill ? { boxFill: draft.boxFill } : {}),
          });
        }
      } else if (draft.editId) {
        updateEdit(draft.editId, (edit) =>
          edit.kind === "textBox"
            ? {
                ...edit,
                rect,
                text,
                fontSizePt: draft.fontSizePt,
                ...(draft.color ? { color: draft.color } : {}),
                ...(draft.backgroundColor ? { backgroundColor: draft.backgroundColor } : {}),
                ...(draft.backgroundOpacity !== undefined
                  ? { backgroundOpacity: draft.backgroundOpacity }
                  : {}),
                fontFamily: draft.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
                bold: Boolean(draft.bold),
                italic: Boolean(draft.italic),
                align: draft.align ?? DEFAULT_TEXT_ALIGN,
              }
            : edit,
        );
      } else {
        addEdit({
          kind: "textBox",
          id: newEditId(),
          pageIndex,
          rect,
          text,
          fontSizePt: draft.fontSizePt,
          ...(draft.color ? { color: draft.color } : {}),
          ...(draft.backgroundColor ? { backgroundColor: draft.backgroundColor } : {}),
          ...(draft.backgroundOpacity !== undefined
            ? { backgroundOpacity: draft.backgroundOpacity }
            : {}),
          fontFamily: draft.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
          bold: Boolean(draft.bold),
          italic: Boolean(draft.italic),
          align: draft.align ?? DEFAULT_TEXT_ALIGN,
        });
      }

      return null;
    });
    suppressPlacement();
  }, [addEdit, pageIndex, scale, suppressPlacement, updateEdit, viewport]);

  const commitCommentDraft = useCallback(() => {
    setCommentDraft((draft) => {
      if (!draft) {
        return null;
      }

      const text = draft.text.trim();

      if (!text) {
        return null;
      }

      if (draft.editId) {
        updateEdit(draft.editId, (edit) =>
          edit.kind === "comment" ? { ...edit, text } : edit,
        );
      } else {
        addEdit({
          kind: "comment",
          id: newEditId(),
          pageIndex,
          at: draft.at,
          text,
        });
      }

      return null;
    });
    suppressPlacement();
  }, [addEdit, pageIndex, suppressPlacement, updateEdit]);

  const closeDraftsForOutsideClick = useCallback(() => {
    let closed = false;

    if (textDraft) {
      commitTextDraft();
      closed = true;
    }

    if (commentDraft) {
      commitCommentDraft();
      closed = true;
    }

    return closed;
  }, [commentDraft, commitCommentDraft, commitTextDraft, textDraft]);

  function handleLayerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const point = getLayerPoint(event);

    if (!point) {
      return;
    }

    if ((tool === "textBox" || tool === "callout" || tool === "comment") && placementSuppressed()) {
      return;
    }

    // An open inline editor absorbs the click: commit it, never also place.
    if (closeDraftsForOutsideClick()) {
      return;
    }

    setSelectedId(null);

    if (tool === "callout" && calloutPlacementDraft) {
      if (!guardPlacement()) {
        return;
      }

      setTextDraft({
        kind: "callout",
        editId: null,
        rect: calloutPlacementDraft.box,
        tip: point,
        text: "",
        fontSizePt: DEFAULT_TEXT_BOX_FONT_SIZE,
        ...(editing.calloutStyle.color ? { color: editing.calloutStyle.color } : {}),
        fontFamily: editing.calloutStyle.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
        bold: Boolean(editing.calloutStyle.bold),
        italic: Boolean(editing.calloutStyle.italic),
        align: editing.calloutStyle.align ?? DEFAULT_TEXT_ALIGN,
        strokeWidthPt: editing.calloutStyle.strokeWidthPt,
        ...(editing.calloutStyle.strokeColor
          ? { strokeColor: editing.calloutStyle.strokeColor }
          : {}),
        arrowhead: true,
        boxBorder: true,
      });
      setCalloutPlacementDraft(null);
      editing.setMessage(null);
      return;
    }

    if (tool === "draw") {
      drawPointsRef.current = [point];
      setDrawDraft([point]);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (isShapeTool(tool)) {
      dragStartRef.current = point;
      setShapeDraft({ tool, start: point, end: point });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === "callout") {
      dragStartRef.current = point;
      setCalloutPlacementDraft({
        box: { left: point.x, top: point.y, width: 0, height: 0 },
        tipPreview: null,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === "textBox") {
      if (!guardPlacement()) {
        return;
      }

      const width = DEFAULT_TEXT_BOX_WIDTH_PT * scale;
      const height =
        (DEFAULT_TEXT_BOX_FONT_SIZE * TEXT_BOX_LINE_HEIGHT + TEXT_BOX_PADDING_PT) * scale;
      setTextDraft({
        kind: "textBox",
        editId: null,
        rect: {
          left: clamp(point.x, 0, Math.max(0, viewport.width - width)),
          top: clamp(point.y, 0, Math.max(0, viewport.height - height)),
          width,
          height,
        },
        text: "",
        fontSizePt: DEFAULT_TEXT_BOX_FONT_SIZE,
        ...(editing.textBoxStyle.color ? { color: editing.textBoxStyle.color } : {}),
        ...(editing.textBoxStyle.backgroundColor
          ? { backgroundColor: editing.textBoxStyle.backgroundColor }
          : {}),
        backgroundOpacity:
          editing.textBoxStyle.backgroundOpacity ?? DEFAULT_TEXT_BOX_BACKGROUND_OPACITY,
        fontFamily: editing.textBoxStyle.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
        bold: Boolean(editing.textBoxStyle.bold),
        italic: Boolean(editing.textBoxStyle.italic),
        align: editing.textBoxStyle.align ?? DEFAULT_TEXT_ALIGN,
      });
      return;
    }

    if (tool === "comment") {
      if (!guardPlacement()) {
        return;
      }

      setCommentDraft({
        editId: null,
        at: viewportPointToPdfPoint(point, viewport),
        text: "",
      });
      return;
    }

    if (tool === "image" || tool === "sign") {
      const armed = tool === "image" ? editing.armedImage : editing.armedSignature;

      if (!armed) {
        if (tool === "sign") {
          editing.setSignatureCardOpen(true);
        } else {
          editing.setMessage("Choose an image first, then click the page to place it.");
        }

        return;
      }

      if (!guardPlacement()) {
        return;
      }

      const rect = stampGhost?.kind === tool
        ? stampGhost.rect
        : stampPlacementRect(point, armed, viewport, scale);
      const id = newEditId();

      addEdit({
        kind: tool === "image" ? "image" : "signature",
        id,
        pageIndex,
        rect: viewportRectToPdfRect(rect, viewport),
        bytes: armed.bytes,
        format: armed.format,
        dataUrl: armed.dataUrl,
        aspectRatio: armed.width / armed.height,
      });
      setStampGhost(null);

      if (tool === "image") {
        editing.disarmImage();
        editing.setMessage("Image placed. Choose another image to place more.");
        setSelectedId(id);
      } else {
        editing.disarmSignature();
        editing.setTool("select");
        setSelectedId(id);
        editing.setMessage("Signature placed.");
      }
    }
  }

  function handleLayerPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = getLayerPoint(event);

    if (!point) {
      return;
    }

    if (tool === "draw" && drawPointsRef.current.length > 0) {
      const lastPoint = drawPointsRef.current.at(-1);

      if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) >= 2) {
        drawPointsRef.current = [...drawPointsRef.current, point];
        setDrawDraft(drawPointsRef.current);
      }
      return;
    }

    if (isShapeTool(tool) && dragStartRef.current) {
      setShapeDraft({ tool, start: dragStartRef.current, end: point });
      return;
    }

    if (tool === "callout") {
      if (dragStartRef.current) {
        setCalloutPlacementDraft({
          box: pointsToViewportRect(dragStartRef.current, point),
          tipPreview: null,
        });
        return;
      }

      setCalloutPlacementDraft((current) =>
        current ? { ...current, tipPreview: point } : current,
      );
      return;
    }

    if (tool === "image" || tool === "sign") {
      const armed = tool === "image" ? editing.armedImage : editing.armedSignature;

      setStampGhost(
        armed
          ? {
              id: `${tool}-ghost`,
              kind: tool === "image" ? "image" : "signature",
              rect: stampPlacementRect(point, armed, viewport, scale),
              dataUrl: armed.dataUrl,
            }
          : null,
      );
    }
  }

  function handleLayerPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const point = getLayerPoint(event);

    if (tool === "draw" && drawPointsRef.current.length > 0) {
      const points = drawPointsRef.current;
      drawPointsRef.current = [];
      setDrawDraft(null);

      if (points.length < 2) {
        return;
      }

      addEdit({
        kind: "ink",
        id: newEditId(),
        pageIndex,
        strokes: [points.map((strokePoint) => viewportPointToPdfPoint(strokePoint, viewport))],
        strokeWidthPt: editing.inkStyle.strokeWidthPt,
        ...(editing.inkStyle.color ? { color: editing.inkStyle.color } : {}),
      });
      return;
    }

    if (isShapeTool(tool) && dragStartRef.current) {
      const shapeTool = tool;
      const start = dragStartRef.current;
      dragStartRef.current = null;
      setShapeDraft(null);

      if (!point) {
        return;
      }

      if (Math.hypot(point.x - start.x, point.y - start.y) < MIN_SHAPE_DRAG_PX) {
        removeShapeAtPoint(point, shapeKindFromTool(shapeTool));
        return;
      }

      const from = viewportPointToPdfPoint(start, viewport);
      const to = viewportPointToPdfPoint(point, viewport);
      const style = editing.shapeStyles[shapeTool];
      const common = {
        kind: "shape" as const,
        id: newEditId(),
        pageIndex,
        strokeWidthPt: style.strokeWidthPt,
        ...(style.strokeColor ? { strokeColor: style.strokeColor } : {}),
      };
      const shape = shapeKindFromTool(shapeTool);

      if (shape === "rect" || shape === "ellipse") {
        const rect = normalizePdfRectFromPoints(from, to);

        if (rect.w <= 0 || rect.h <= 0) {
          return;
        }

        addEdit({
          ...common,
          shape,
          rect,
          ...(style.fillColor ? { fillColor: style.fillColor } : {}),
        });
        return;
      }

      addEdit({
        ...common,
        shape,
        from,
        to,
      });
      return;
    }

    if (tool === "callout" && dragStartRef.current) {
      const start = dragStartRef.current;
      dragStartRef.current = null;

      if (!point) {
        setCalloutPlacementDraft(null);
        return;
      }

      const box = pointsToViewportRect(start, point);

      if (box.width < MIN_ITEM_SIZE_PX || box.height < MIN_ITEM_SIZE_PX) {
        setCalloutPlacementDraft(null);
        return;
      }

      setCalloutPlacementDraft({ box, tipPreview: null });
      editing.setMessage("Click the page point this callout should point to.");
    }
  }

  function handleLayerPointerCancel() {
    dragStartRef.current = null;
    drawPointsRef.current = [];
    setDrawDraft(null);
    setShapeDraft(null);
    setCalloutPlacementDraft(null);
  }

  function removeShapeAtPoint(point: ViewportPoint, shape: PendingShape["shape"]) {
    const pdfPoint = viewportPointToPdfPoint(point, viewport);

    for (let index = pageEdits.length - 1; index >= 0; index -= 1) {
      const edit = pageEdits[index];

      if (edit?.kind === "shape" && edit.shape === shape && shapeHitTest(edit, pdfPoint)) {
        removeEdit(edit.id);
        return;
      }
    }
  }

  function beginItemDrag(
    event: ReactPointerEvent<HTMLElement | SVGElement>,
    edit: PendingTextBox | PendingStamp | PendingShape | PendingCallout,
    mode: "move" | "resize",
    corner: ResizeCorner | null = null,
  ) {
    if (event.button !== 0) {
      return;
    }

    // A pinned item is locked in place — CSS makes its body click-through, but
    // guard here too so it can never be dragged even if a handler still fires.
    if (edit.pinned === true) {
      return;
    }

    event.stopPropagation();

    if (closeDraftsForOutsideClick()) {
      return;
    }

    if (edit.kind === "shape" && isLinePendingShape(edit)) {
      itemDragRef.current = {
        id: edit.id,
        kind: "line",
        mode: "move",
        corner: null,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startFrom: pdfPointToViewport(edit.from, viewport),
        startTo: pdfPointToViewport(edit.to, viewport),
        moved: false,
      };
    } else {
      const rect = edit.rect;

      itemDragRef.current = {
        id: edit.id,
        kind: "rect",
        mode,
        corner,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect: pdfRectToViewportRect(rect, viewport),
        aspectRatio:
          edit.kind === "image" || edit.kind === "signature" ? edit.aspectRatio : null,
        moved: false,
      };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleItemPointerMove(event: ReactPointerEvent<HTMLElement | SVGElement>) {
    const drag = itemDragRef.current;

    if (!drag) {
      return;
    }

    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;

    if (!drag.moved && Math.hypot(dx, dy) < 3) {
      return;
    }

    drag.moved = true;
    if (drag.kind === "line") {
      const line = moveLine(drag.startFrom, drag.startTo, dx, dy, viewport);
      setDragPreview({ id: drag.id, kind: "line", ...line });
      return;
    }

    const rect =
      drag.mode === "move"
        ? moveRect(drag.startRect, dx, dy, viewport)
        : resizeRect(drag.startRect, drag.corner ?? "se", dx, dy, drag.aspectRatio, viewport);
    setDragPreview({ id: drag.id, kind: "rect", rect });
  }

  function handleItemPointerUp(event: ReactPointerEvent<HTMLElement | SVGElement>) {
    const drag = itemDragRef.current;
    itemDragRef.current = null;

    if (!drag) {
      return;
    }

    event.stopPropagation();
    setDragPreview(null);

    if (!drag.moved) {
      setSelectedId(drag.id);
      return;
    }

    if (drag.kind === "line") {
      const line = moveLine(
        drag.startFrom,
        drag.startTo,
        event.clientX - drag.startClientX,
        event.clientY - drag.startClientY,
        viewport,
      );
      const from = viewportPointToPdfPoint(line.from, viewport);
      const to = viewportPointToPdfPoint(line.to, viewport);
      updateEdit(drag.id, (edit) =>
        edit.kind === "shape" && isLinePendingShape(edit) ? { ...edit, from, to } : edit,
      );
    } else {
      const rect =
        drag.mode === "move"
          ? moveRect(
              drag.startRect,
              event.clientX - drag.startClientX,
              event.clientY - drag.startClientY,
              viewport,
            )
          : resizeRect(
              drag.startRect,
              drag.corner ?? "se",
              event.clientX - drag.startClientX,
              event.clientY - drag.startClientY,
              drag.aspectRatio,
              viewport,
            );
      const pdfRect = viewportRectToPdfRect(rect, viewport);
      // A callout drag moves only its box; its `tip` stays put so the leader
      // re-anchors to the same target point.
      updateEdit(drag.id, (edit) =>
        edit.kind === "textBox" ||
        edit.kind === "image" ||
        edit.kind === "signature" ||
        edit.kind === "callout" ||
        (edit.kind === "shape" && !isLinePendingShape(edit))
          ? { ...edit, rect: pdfRect }
          : edit,
      );
    }
    setSelectedId(drag.id);
    suppressPlacement();
  }

  function openTextBoxForEditing(edit: PendingTextBox) {
    setSelectedId(null);
    setTextDraft({
      kind: "textBox",
      editId: edit.id,
      rect: pdfRectToViewportRect(edit.rect, viewport),
      text: edit.text,
      fontSizePt: edit.fontSizePt,
      ...(edit.color ? { color: edit.color } : {}),
      ...(edit.backgroundColor ? { backgroundColor: edit.backgroundColor } : {}),
      ...(edit.backgroundOpacity !== undefined ? { backgroundOpacity: edit.backgroundOpacity } : {}),
      fontFamily: edit.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
      bold: Boolean(edit.bold),
      italic: Boolean(edit.italic),
      align: edit.align ?? DEFAULT_TEXT_ALIGN,
    });
    suppressPlacement();
  }

  function openCalloutForEditing(edit: PendingCallout) {
    setSelectedId(null);
    setTextDraft({
      kind: "callout",
      editId: edit.id,
      rect: pdfRectToViewportRect(edit.rect, viewport),
      tip: pdfPointToViewport(edit.tip, viewport),
      text: edit.text,
      fontSizePt: edit.fontSizePt,
      ...(edit.color ? { color: edit.color } : {}),
      fontFamily: edit.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
      bold: Boolean(edit.bold),
      italic: Boolean(edit.italic),
      align: edit.align ?? DEFAULT_TEXT_ALIGN,
      strokeWidthPt: edit.strokeWidthPt ?? DEFAULT_CALLOUT_STROKE_WIDTH_PT,
      ...(edit.strokeColor ? { strokeColor: edit.strokeColor } : {}),
      arrowhead: edit.arrowhead ?? true,
      boxBorder: edit.boxBorder ?? true,
      ...(edit.boxFill ? { boxFill: edit.boxFill } : {}),
    });
    suppressPlacement();
  }

  function openCommentForEditing(edit: PendingComment) {
    setCommentDraft({ editId: edit.id, at: edit.at, text: edit.text });
    suppressPlacement();
  }

  // Pinning locks an item (click-through, no drag/delete) — a user action kept
  // separate from `status` so imported (applied) annotations stay interactive.
  // Pinning also drops the item out of the selection, otherwise its chrome
  // would linger and Delete could still target it.
  const setPinned = useCallback(
    (id: string, pinned: boolean) => {
      updateEdit(id, (edit) => ({ ...edit, pinned }));

      if (pinned && selectedId === id) {
        setSelectedId(null);
      }
    },
    [selectedId, setSelectedId, updateEdit],
  );

  // Unified right-click menu. A window-level capture listener is the only way to
  // see every right-click: in Select mode the layer is pointer-events:none
  // except interactive items, and markups + the selectable text layer sit
  // beneath it, so element-level onContextMenu can't reach them. The handler is
  // reassigned each render (fresh pageEdits/closures); the listener subscribes
  // once. Pinned items are click-through, so they're skipped in the geometric
  // hit-test — a right-click over a pinned annotation falls through to the
  // markup or text selection underneath (unpin via the badge's left-click).
  const contextMenuHandlerRef = useRef<(event: MouseEvent) => void>(() => {});
  contextMenuHandlerRef.current = (event: MouseEvent) => {
    // Stay out of the way of an open inline editor (so its native paste menu
    // works and Delete/Pin can't mutate the box being typed into) and while a
    // dialog owns the canvas. A right-click inside a text field is never ours.
    if (
      textDraft ||
      commentDraft ||
      isTextEntryTarget(event.target) ||
      hasOpenDialogStackEntry()
    ) {
      return;
    }

    const point = getClientLayerPoint(event.clientX, event.clientY, { requireInside: true });

    if (!point) {
      return;
    }

    const pdfPoint = viewportPointToPdfPoint(point, viewport);
    const edits = pageEditsRef.current;
    let items: ContextMenuItem[] | null = null;
    let selectId: string | null = null;

    // 1. Topmost UNPINNED floating item / shape under the cursor.
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];

      if (!edit || edit.pinned === true || !editHitTest(edit, pdfPoint)) {
        continue;
      }

      items = buildEditContextMenu(edit, {
        removeEdit,
        setPinned,
        openTextBoxForEditing,
        openCalloutForEditing,
        openCommentForEditing,
      });
      selectId = edit.kind === "comment" ? null : edit.id;
      break;
    }

    // 2. Existing markup under the cursor.
    if (!items) {
      const markup = textMarkupAtPoint(edits, pdfPoint);

      if (markup) {
        items = [
          {
            label: `Remove ${textMarkupLabel(markup.kind).toLowerCase()}`,
            danger: true,
            onSelect: () => removeEdit(markup.id),
          },
        ];
      }
    }

    // 3. Any active text selection on this page → copy it, or mark it up
    // without switching tools. `selectedText` is captured now because clicking
    // a menu item collapses the selection before the action runs.
    if (!items) {
      const layer = layerRef.current;
      const selectionRects = layer ? markupRectsFromSelection(layer, viewport) : [];

      if (selectionRects.length > 0) {
        const selectedText = window.getSelection()?.toString() ?? "";
        const markupFromSelection = (kind: TextMarkupToolId) => () => {
          addTextMarkup(kind, selectionRects);
          window.getSelection()?.removeAllRanges();
        };

        items = [
          {
            label: "Copy",
            onSelect: () => {
              if (selectedText) {
                void navigator.clipboard?.writeText(selectedText).catch(() => undefined);
              }
            },
          },
          { label: "Highlight", onSelect: markupFromSelection("highlight") },
          { label: "Underline", onSelect: markupFromSelection("underline") },
          { label: "Strike through", onSelect: markupFromSelection("strikethrough") },
        ];
      }
    }

    if (!items || items.length === 0) {
      return; // Nothing to offer — leave the platform default alone.
    }

    event.preventDefault();
    event.stopPropagation();

    if (selectId) {
      setSelectedId(selectId);
    }

    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  useEffect(() => {
    function handleContextMenu(event: MouseEvent) {
      contextMenuHandlerRef.current(event);
    }

    window.addEventListener("contextmenu", handleContextMenu, true);
    return () => window.removeEventListener("contextmenu", handleContextMenu, true);
  }, []);

  const interactive = tool !== "select";
  const inkEdits = pageEdits.filter((edit) => edit.kind === "ink");
  const shapeEdits = pageEdits.filter((edit): edit is PendingShape => edit.kind === "shape");

  return (
    <div
      ref={layerRef}
      className="edit-layer"
      data-tool={tool}
      data-interactive={interactive ? "true" : undefined}
      onPointerDown={interactive ? handleLayerPointerDown : undefined}
      onPointerMove={interactive ? handleLayerPointerMove : undefined}
      onPointerUp={interactive ? handleLayerPointerUp : undefined}
      onPointerCancel={interactive ? handleLayerPointerCancel : undefined}
    >
      {pageEdits.map((edit) => {
        if (isPendingTextMarkup(edit)) {
          return (
            <TextMarkupOverlay key={edit.id} edit={edit} viewport={viewport} scale={scale} />
          );
        }

        if (edit.kind === "textBox") {
          if (textDraft?.editId === edit.id) {
            return null;
          }

          return (
            <TextBoxOverlay
              key={edit.id}
              edit={edit}
              viewport={viewport}
              scale={scale}
              selected={selectedId === edit.id}
              previewRect={
                dragPreview?.id === edit.id && dragPreview.kind === "rect"
                  ? dragPreview.rect
                  : null
              }
              onPointerDown={(event) => beginItemDrag(event, edit, "move")}
              onPointerMove={handleItemPointerMove}
              onPointerUp={handleItemPointerUp}
              onResizeStart={(event, corner) => beginItemDrag(event, edit, "resize", corner)}
              onEditRequested={() => openTextBoxForEditing(edit)}
              onFontSizeChange={(fontSizePt) =>
                updateEdit(edit.id, (current) =>
                  current.kind === "textBox" ? { ...current, fontSizePt } : current,
                )
              }
              onTextStyleChange={(style) =>
                updateEdit(edit.id, (current) =>
                  current.kind === "textBox" ? { ...current, ...style } : current,
                )
              }
              onRemove={() => removeEdit(edit.id)}
              onTogglePin={() => setPinned(edit.id, edit.pinned !== true)}
            />
          );
        }

        if (edit.kind === "callout") {
          // While this callout's inline editor is open, the draft renders the
          // box + leader; hide the placed overlay so they don't double up.
          if (textDraft?.editId === edit.id) {
            return null;
          }

          return (
            <CalloutOverlay
              key={edit.id}
              edit={edit}
              viewport={viewport}
              scale={scale}
              selected={selectedId === edit.id}
              previewRect={
                dragPreview?.id === edit.id && dragPreview.kind === "rect"
                  ? dragPreview.rect
                  : null
              }
              onPointerDown={(event) => beginItemDrag(event, edit, "move")}
              onPointerMove={handleItemPointerMove}
              onPointerUp={handleItemPointerUp}
              onResizeStart={(event, corner) => beginItemDrag(event, edit, "resize", corner)}
              onEditRequested={() => openCalloutForEditing(edit)}
              onRemove={() => removeEdit(edit.id)}
              onTogglePin={() => setPinned(edit.id, edit.pinned !== true)}
            />
          );
        }

        if (edit.kind === "image" || edit.kind === "signature") {
          return (
            <StampOverlay
              key={edit.id}
              edit={edit}
              viewport={viewport}
              selected={selectedId === edit.id}
              previewRect={
                dragPreview?.id === edit.id && dragPreview.kind === "rect"
                  ? dragPreview.rect
                  : null
              }
              onPointerDown={(event) => beginItemDrag(event, edit, "move")}
              onPointerMove={handleItemPointerMove}
              onPointerUp={handleItemPointerUp}
              onResizeStart={(event, corner) => beginItemDrag(event, edit, "resize", corner)}
              onRemove={() => removeEdit(edit.id)}
              onTogglePin={() => setPinned(edit.id, edit.pinned !== true)}
            />
          );
        }

        if (edit.kind === "comment") {
          return (
            <CommentPin
              key={edit.id}
              edit={edit}
              viewport={viewport}
              onOpen={() => openCommentForEditing(edit)}
            />
          );
        }

        return null;
      })}

      {inkEdits.length > 0 || drawDraft ? (
        <svg
          className="edit-layer__ink"
          width={viewport.width}
          height={viewport.height}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          aria-hidden="true"
        >
          {inkEdits.map((edit) =>
            edit.kind === "ink"
              ? edit.strokes.map((stroke, strokeIndex) => (
                  <polyline
                    key={`${edit.id}-${strokeIndex}`}
                    points={stroke
                      .map((strokePoint) => {
                        const [x, y] = viewport.convertToViewportPoint(
                          strokePoint.x,
                          strokePoint.y,
                        );
                        return `${x},${y}`;
                      })
                      .join(" ")}
                    fill="none"
                    stroke={pdfEditColorToHex(edit.color ?? DEFAULT_INK_COLOR)}
                    strokeWidth={(edit.strokeWidthPt ?? DEFAULT_INK_STROKE_WIDTH_PT) * scale}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))
              : null,
          )}
          {drawDraft ? (
            <polyline
              points={drawDraft.map((strokePoint) => `${strokePoint.x},${strokePoint.y}`).join(" ")}
              fill="none"
              stroke={pdfEditColorToHex(editing.inkStyle.color ?? DEFAULT_INK_COLOR)}
              strokeWidth={editing.inkStyle.strokeWidthPt * scale}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </svg>
      ) : null}

      {shapeEdits.length > 0 || shapeDraft ? (
        <ShapeSvgOverlay
          shapes={shapeEdits}
          draft={shapeDraft}
          viewport={viewport}
          scale={scale}
          activeTool={tool}
          editing={editing}
          selectedId={selectedId}
          dragPreview={dragPreview}
          onBeginDrag={(event, edit) => beginItemDrag(event, edit, "move")}
          onPointerMove={handleItemPointerMove}
          onPointerUp={handleItemPointerUp}
          onRemove={removeEdit}
        />
      ) : null}

      {calloutPlacementDraft ? (
        <CalloutPlacementPreview
          draft={calloutPlacementDraft}
          scale={scale}
          editing={editing}
        />
      ) : null}

      {stampGhost ? <StampGhostOverlay ghost={stampGhost} /> : null}

      {isTextMarkupTool(tool) && textLayerError ? (
        <p className="edit-layer__message" role="status">
          {textLayerError}
        </p>
      ) : null}

      {textDraft ? (
        <>
          {textDraft.kind === "callout" && textDraft.tip ? (
            <CalloutLeaderSvg
              rect={textDraft.rect}
              tip={textDraft.tip}
              strokeColor={textDraft.strokeColor ?? DEFAULT_CALLOUT_STROKE_COLOR}
              strokeWidthPt={textDraft.strokeWidthPt ?? DEFAULT_CALLOUT_STROKE_WIDTH_PT}
              scale={scale}
              arrowhead={textDraft.arrowhead ?? true}
              width={viewport.width}
              height={viewport.height}
            />
          ) : null}
          <TextBoxDraftEditor
            draft={textDraft}
            scale={scale}
            onTextChange={(text) => setTextDraft((current) => (current ? { ...current, text } : null))}
            onFontSizeChange={(fontSizePt) =>
              setTextDraft((current) => (current ? { ...current, fontSizePt } : null))
            }
            onTextStyleChange={(style) =>
              setTextDraft((current) => (current ? { ...current, ...style } : null))
            }
            onCommit={commitTextDraft}
            onCancel={() => {
              setTextDraft(null);
              suppressPlacement();
            }}
          />
        </>
      ) : null}

      {commentDraft ? (
        <CommentPopover
          draft={commentDraft}
          viewport={viewport}
          onTextChange={(text) =>
            setCommentDraft((current) => (current ? { ...current, text } : null))
          }
          onCommit={commitCommentDraft}
          onCancel={() => {
            setCommentDraft(null);
            suppressPlacement();
          }}
          onDelete={
            commentDraft.editId
              ? () => {
                  removeEdit(commentDraft.editId!);
                  setCommentDraft(null);
                  suppressPlacement();
                }
              : null
          }
        />
      ) : null}

      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Topmost text markup whose rects contain the point, optionally restricted to
 * one kind. Shared by the double-click removal and the right-click menu.
 */
function textMarkupAtPoint(
  edits: readonly PendingEdit[],
  point: PdfSpacePoint,
  kind?: TextMarkupToolId,
): Extract<PendingEdit, { kind: TextMarkupToolId }> | null {
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];

    if (
      edit &&
      isPendingTextMarkup(edit) &&
      (kind === undefined || edit.kind === kind) &&
      edit.rects.some((rect) => pdfRectContainsPoint(rect, point))
    ) {
      return edit;
    }
  }

  return null;
}

/**
 * Hit-tests one pending edit against a PDF-space point: floating boxes and
 * shapes by geometry, a comment by its icon rect. Markup and ink are not
 * hit-tested here (markup has its own path; ink has no menu).
 */
function editHitTest(edit: PendingEdit, point: PdfSpacePoint): boolean {
  switch (edit.kind) {
    case "textBox":
    case "callout":
    case "image":
    case "signature":
      return pdfRectContainsPoint(edit.rect, point);
    case "comment":
      return pdfRectContainsPoint(
        { x: edit.at.x, y: edit.at.y, w: COMMENT_ICON_SIZE_PT, h: COMMENT_ICON_SIZE_PT },
        point,
      );
    case "shape":
      return shapeHitTest(edit, point);
    default:
      return false;
  }
}

/**
 * The right-click menu for an unpinned floating item or shape. Pinned items are
 * excluded upstream (they're click-through), so everything reaching here is
 * unpinned: Pin + Delete for all, plus Edit text / Open note for the kinds that
 * have an inline editor. Comments aren't in the pin model — Open + Delete only.
 */
function buildEditContextMenu(
  edit: PendingEdit,
  actions: {
    removeEdit: (id: string) => void;
    setPinned: (id: string, pinned: boolean) => void;
    openTextBoxForEditing: (edit: PendingTextBox) => void;
    openCalloutForEditing: (edit: PendingCallout) => void;
    openCommentForEditing: (edit: PendingComment) => void;
  },
): ContextMenuItem[] {
  if (edit.kind === "comment") {
    return [
      { label: "Open note", onSelect: () => actions.openCommentForEditing(edit) },
      { label: "Delete", danger: true, onSelect: () => actions.removeEdit(edit.id) },
    ];
  }

  const items: ContextMenuItem[] = [];

  if (edit.kind === "textBox") {
    items.push({ label: "Edit text", onSelect: () => actions.openTextBoxForEditing(edit) });
  }

  if (edit.kind === "callout") {
    items.push({ label: "Edit text", onSelect: () => actions.openCalloutForEditing(edit) });
  }

  items.push({ label: "Pin", onSelect: () => actions.setPinned(edit.id, true) });
  items.push({ label: "Delete", danger: true, onSelect: () => actions.removeEdit(edit.id) });

  return items;
}

// Text markup renders as page-anchored decoration only; removal is the
// window-level double-click handler on the active markup tool (the layer is
// pointer-events:none in markup mode so the browser drives text selection).
function TextMarkupOverlay({
  edit,
  viewport,
  scale,
}: {
  edit: Extract<PendingEdit, { kind: TextMarkupToolId }>;
  viewport: PageViewport;
  scale: number;
}) {
  if (edit.kind !== "highlight") {
    const color = pdfEditColorToHex(edit.color ?? DEFAULT_TEXT_MARKUP_COLOR);
    const strokeWidth = (edit.thicknessPt ?? DEFAULT_TEXT_MARKUP_THICKNESS_PT) * scale;

    return (
      <svg
        className="edit-layer__text-markup-lines"
        width={viewport.width}
        height={viewport.height}
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        aria-hidden="true"
      >
        {edit.rects.map((rect, rectIndex) => {
          const lineY = edit.kind === "underline" ? rect.y : rect.y + rect.h * 0.5;
          const [startX, startY] = viewport.convertToViewportPoint(rect.x, lineY);
          const [endX, endY] = viewport.convertToViewportPoint(rect.x + rect.w, lineY);

          return (
            <line
              key={`${edit.id}-${rectIndex}`}
              x1={startX}
              y1={startY}
              x2={endX}
              y2={endY}
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
            />
          );
        })}
      </svg>
    );
  }

  return (
    <>
      {edit.rects.map((rect, rectIndex) => (
        <span
          key={`${edit.id}-${rectIndex}`}
          className="edit-layer__highlight"
          style={highlightStyle(
            pdfRectToViewportRect(rect, viewport),
            edit.color ?? DEFAULT_HIGHLIGHT_COLOR,
            edit.opacity ?? DEFAULT_HIGHLIGHT_OPACITY,
          )}
        />
      ))}
    </>
  );
}

function ShapeSvgOverlay({
  shapes,
  draft,
  viewport,
  scale,
  activeTool,
  editing,
  selectedId,
  dragPreview,
  onBeginDrag,
  onPointerMove,
  onPointerUp,
  onRemove,
}: {
  shapes: readonly PendingShape[];
  draft: ShapeDraft | null;
  viewport: PageViewport;
  scale: number;
  activeTool: string;
  editing: EditingState;
  selectedId: string | null;
  dragPreview: DragPreview | null;
  onBeginDrag: (event: ReactPointerEvent<SVGElement>, edit: PendingShape) => void;
  onPointerMove: (event: ReactPointerEvent<SVGElement>) => void;
  onPointerUp: (event: ReactPointerEvent<SVGElement>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <svg
      className="edit-layer__shapes"
      width={viewport.width}
      height={viewport.height}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      aria-hidden="true"
    >
      {shapes.map((shape) => (
        <ShapeElement
          key={shape.id}
          shape={shape}
          viewport={viewport}
          scale={scale}
          selected={selectedId === shape.id}
          preview={dragPreview?.id === shape.id ? dragPreview : null}
          removable={
            shape.pinned !== true &&
            isShapeTool(activeTool) &&
            shapeKindFromTool(activeTool) === shape.shape
          }
          onPointerDown={(event) => onBeginDrag(event, shape)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onRemove={() => onRemove(shape.id)}
        />
      ))}
      {draft ? <ShapeDraftElement draft={draft} scale={scale} editing={editing} /> : null}
    </svg>
  );
}

function ShapeElement({
  shape,
  viewport,
  scale,
  selected,
  preview,
  removable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemove,
}: {
  shape: PendingShape;
  viewport: PageViewport;
  scale: number;
  selected: boolean;
  preview: DragPreview | null;
  removable: boolean;
  onPointerDown: (event: ReactPointerEvent<SVGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGElement>) => void;
  onPointerUp: (event: ReactPointerEvent<SVGElement>) => void;
  onRemove: () => void;
}) {
  const displayShape = shapeWithPreview(shape, preview, viewport);
  const stroke = pdfEditColorToHex(shape.strokeColor ?? DEFAULT_SHAPE_STROKE_COLOR);
  const strokeWidth = (shape.strokeWidthPt ?? DEFAULT_SHAPE_STROKE_WIDTH_PT) * scale;
  const commonProps = {
    stroke,
    strokeWidth,
    className: [
      "edit-layer__shape-item",
      removable ? "edit-layer__shape-hit" : "",
      selected ? "edit-layer__shape-selected" : "",
    ].filter(Boolean).join(" "),
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClick: removable
      ? (event: ReactMouseEvent<SVGElement>) => {
          event.stopPropagation();
          onRemove();
        }
      : undefined,
  };

  if (displayShape.shape === "rect" || displayShape.shape === "ellipse") {
    const rect = pdfRectToViewportRect(displayShape.rect, viewport);
    const fill = displayShape.fillColor ? pdfEditColorToHex(displayShape.fillColor) : "none";

    if (displayShape.shape === "ellipse") {
      return (
        <ellipse
          {...commonProps}
          cx={rect.left + rect.width / 2}
          cy={rect.top + rect.height / 2}
          rx={rect.width / 2}
          ry={rect.height / 2}
          fill={fill}
        />
      );
    }

    return (
      <rect
        {...commonProps}
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        fill={fill}
      />
    );
  }

  if (!isLinePendingShape(displayShape)) {
    return null;
  }

  const from = pdfPointToViewport(displayShape.from, viewport);
  const to = pdfPointToViewport(displayShape.to, viewport);

  return (
    <g {...commonProps} fill="none">
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
      {displayShape.shape === "arrow" ? (
        <polygon
          points={arrowHeadPoints(
            from,
            to,
            displayShape.strokeWidthPt ?? DEFAULT_SHAPE_STROKE_WIDTH_PT,
            scale,
          )}
          fill={stroke}
          stroke={stroke}
          strokeWidth={0}
        />
      ) : null}
      <line
        className="edit-layer__shape-hit-line"
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
      />
    </g>
  );
}

function shapeWithPreview(
  shape: PendingShape,
  preview: DragPreview | null,
  viewport: PageViewport,
): PendingShape {
  if (!preview) {
    return shape;
  }

  if (preview.kind === "rect" && !isLinePendingShape(shape)) {
    return { ...shape, rect: viewportRectToPdfRect(preview.rect, viewport) };
  }

  if (preview.kind === "line" && isLinePendingShape(shape)) {
    return {
      ...shape,
      from: viewportPointToPdfPoint(preview.from, viewport),
      to: viewportPointToPdfPoint(preview.to, viewport),
    };
  }

  return shape;
}

function ShapeDraftElement({
  draft,
  scale,
  editing,
}: {
  draft: ShapeDraft;
  scale: number;
  editing: EditingState;
}) {
  const style = editing.shapeStyles[draft.tool];
  const shape = shapeKindFromTool(draft.tool);
  const stroke = pdfEditColorToHex(style.strokeColor ?? DEFAULT_SHAPE_STROKE_COLOR);
  const strokeWidth = style.strokeWidthPt * scale;

  if (shape === "rect" || shape === "ellipse") {
    const rect = pointsToViewportRect(draft.start, draft.end);
    const fill = style.fillColor ? pdfEditColorToHex(style.fillColor) : "none";

    if (shape === "ellipse") {
      return (
        <ellipse
          className="edit-layer__shape-draft"
          cx={rect.left + rect.width / 2}
          cy={rect.top + rect.height / 2}
          rx={rect.width / 2}
          ry={rect.height / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }

    return (
      <rect
        className="edit-layer__shape-draft"
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  }

  return (
    <g className="edit-layer__shape-draft" fill="none">
      <line
        x1={draft.start.x}
        y1={draft.start.y}
        x2={draft.end.x}
        y2={draft.end.y}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      {shape === "arrow" ? (
        <polygon
          points={arrowHeadPoints(draft.start, draft.end, style.strokeWidthPt, scale)}
          fill={stroke}
          stroke={stroke}
          strokeWidth={0}
        />
      ) : null}
    </g>
  );
}

function isPendingTextMarkup(
  edit: PendingEdit,
): edit is Extract<PendingEdit, { kind: TextMarkupToolId }> {
  return isTextMarkupTool(edit.kind);
}

function isTextMarkupTool(tool: string): tool is TextMarkupToolId {
  return tool === "highlight" || tool === "underline" || tool === "strikethrough";
}

function isShapeTool(tool: string): tool is ShapeToolId {
  return (
    tool === "shapeRect" ||
    tool === "shapeEllipse" ||
    tool === "shapeLine" ||
    tool === "shapeArrow"
  );
}

function isLinePendingShape(
  shape: PendingShape,
): shape is Extract<PendingShape, { shape: "line" | "arrow" }> {
  return shape.shape === "line" || shape.shape === "arrow";
}

function shapeHitTest(shape: PendingShape, point: PdfSpacePoint): boolean {
  if (shape.shape === "rect") {
    return pdfRectContainsPoint(shape.rect, point);
  }

  if (shape.shape === "ellipse") {
    const rx = shape.rect.w / 2;
    const ry = shape.rect.h / 2;
    const cx = shape.rect.x + rx;
    const cy = shape.rect.y + ry;

    return ((point.x - cx) ** 2) / rx ** 2 + ((point.y - cy) ** 2) / ry ** 2 <= 1;
  }

  if (!isLinePendingShape(shape)) {
    return false;
  }

  const tolerance = Math.max(6, (shape.strokeWidthPt ?? DEFAULT_SHAPE_STROKE_WIDTH_PT) * 2);

  return distanceToSegment(point, shape.from, shape.to) <= tolerance;
}

function distanceToSegment(
  point: PdfSpacePoint,
  from: PdfSpacePoint,
  to: PdfSpacePoint,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx ** 2 + dy ** 2;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - from.x, point.y - from.y);
  }

  const t = clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared, 0, 1);
  const x = from.x + t * dx;
  const y = from.y + t * dy;

  return Math.hypot(point.x - x, point.y - y);
}

function pdfPointToViewport(point: PdfSpacePoint, viewport: PageViewport): ViewportPoint {
  const [x, y] = viewport.convertToViewportPoint(point.x, point.y);

  return { x, y };
}

function arrowHeadPoints(
  from: ViewportPoint,
  to: ViewportPoint,
  strokeWidthPt: number,
  scale: number,
): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.min(ARROW_HEAD_MAX_PT, Math.max(ARROW_HEAD_MIN_PT, strokeWidthPt * 7)) * scale;
  const halfWidth = length * 0.45;
  const baseCenter = {
    x: to.x - Math.cos(angle) * length,
    y: to.y - Math.sin(angle) * length,
  };
  const normal = {
    x: -Math.sin(angle),
    y: Math.cos(angle),
  };
  const left = {
    x: baseCenter.x + normal.x * halfWidth,
    y: baseCenter.y + normal.y * halfWidth,
  };
  const right = {
    x: baseCenter.x - normal.x * halfWidth,
    y: baseCenter.y - normal.y * halfWidth,
  };

  return `${to.x},${to.y} ${left.x},${left.y} ${right.x},${right.y}`;
}

function textMarkupLabel(tool: TextMarkupToolId): string {
  switch (tool) {
    case "highlight":
      return "Highlight";
    case "underline":
      return "Underline";
    case "strikethrough":
      return "Strikethrough";
  }
}

function textMarkupPlural(tool: TextMarkupToolId): string {
  return tool === "highlight" ? "highlights" : `${textMarkupLabel(tool).toLowerCase()}s`;
}

function CalloutOverlay({
  edit,
  viewport,
  scale,
  selected,
  previewRect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResizeStart,
  onEditRequested,
  onRemove,
  onTogglePin,
}: {
  edit: PendingCallout;
  viewport: PageViewport;
  scale: number;
  selected: boolean;
  previewRect: ViewportRect | null;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, corner: ResizeCorner) => void;
  onEditRequested: () => void;
  onRemove: () => void;
  onTogglePin: () => void;
}) {
  // The box follows the drag preview; the tip stays put, so the leader
  // re-anchors to the same target while the box moves.
  const rect = previewRect ?? pdfRectToViewportRect(edit.rect, viewport);
  const tip = pdfPointToViewport(edit.tip, viewport);
  const strokeColor = edit.strokeColor ?? DEFAULT_CALLOUT_STROKE_COLOR;
  const strokeWidthPt = edit.strokeWidthPt ?? DEFAULT_CALLOUT_STROKE_WIDTH_PT;
  const pinned = edit.pinned === true;
  const font = useTextBoxPreviewFont(
    edit.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
    Boolean(edit.bold),
    Boolean(edit.italic),
  );
  const lines = useMemo(
    () =>
      computeTextBoxPreviewLines({
        text: edit.text,
        boxWidthPt: rect.width / scale,
        fontSizePt: edit.fontSizePt,
        font,
      }),
    [edit.fontSizePt, edit.text, font, rect.width, scale],
  );

  return (
    <>
      <CalloutLeaderSvg
        rect={rect}
        tip={tip}
        strokeColor={strokeColor}
        strokeWidthPt={strokeWidthPt}
        scale={scale}
        arrowhead={edit.arrowhead ?? true}
        width={viewport.width}
        height={viewport.height}
      />
      <div
        className="edit-layer__item edit-layer__callout-box"
        data-selected={selected ? "true" : undefined}
        data-status={edit.status}
      data-pinned={pinned ? "true" : undefined}
        style={{
          ...toOverlayStyle(rect),
          ...(edit.boxFill ? { backgroundColor: pdfEditColorToHex(edit.boxFill) } : {}),
          borderColor: pdfEditColorToHex(strokeColor),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onEditRequested();
        }}
      >
        <span
          className="edit-layer__text-content"
          style={textContentStyle(edit, scale, edit.color ?? DEFAULT_TEXT_COLOR)}
        >
          {lines.map((line, lineIndex) => (
            <span key={lineIndex} className="edit-layer__text-line">
              {line}
            </span>
          ))}
        </span>
        <PinControls
          pinned={pinned}
          onTogglePin={onTogglePin}
          onRemove={onRemove}
        />
        {selected && !pinned ? <ResizeHandles onResizeStart={onResizeStart} /> : null}
      </div>
    </>
  );
}

function CalloutPlacementPreview({
  draft,
  scale,
  editing,
}: {
  draft: CalloutPlacementDraft;
  scale: number;
  editing: EditingState;
}) {
  const strokeColor = editing.calloutStyle.strokeColor ?? DEFAULT_CALLOUT_STROKE_COLOR;
  const strokeWidthPt = editing.calloutStyle.strokeWidthPt;

  return (
    <>
      {draft.tipPreview ? (
        <CalloutLeaderSvg
          rect={draft.box}
          tip={draft.tipPreview}
          strokeColor={strokeColor}
          strokeWidthPt={strokeWidthPt}
          scale={scale}
          arrowhead
          width={Math.max(draft.box.left + draft.box.width, draft.tipPreview.x)}
          height={Math.max(draft.box.top + draft.box.height, draft.tipPreview.y)}
        />
      ) : null}
      <span
        className="edit-layer__callout-placement"
        style={{
          ...toOverlayStyle(draft.box),
          borderColor: pdfEditColorToHex(strokeColor),
        }}
      />
    </>
  );
}

function CalloutLeaderSvg({
  rect,
  tip,
  strokeColor,
  strokeWidthPt,
  scale,
  arrowhead,
  width,
  height,
}: {
  rect: ViewportRect;
  tip: ViewportPoint;
  strokeColor: PdfEditColor;
  strokeWidthPt: number;
  scale: number;
  arrowhead: boolean;
  width: number;
  height: number;
}) {
  const anchor = computeCalloutLeaderAnchor(rect, tip);
  const stroke = pdfEditColorToHex(strokeColor);
  const strokeWidth = strokeWidthPt * scale;

  return (
    <svg
      className="edit-layer__callout-leader"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <line
        x1={anchor.x}
        y1={anchor.y}
        x2={tip.x}
        y2={tip.y}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      {arrowhead ? (
        <polygon
          points={arrowHeadPoints(anchor, tip, strokeWidthPt, scale)}
          fill={stroke}
          stroke={stroke}
          strokeWidth={0}
        />
      ) : null}
    </svg>
  );
}

function computeCalloutLeaderAnchor(rect: ViewportRect, tip: ViewportPoint): ViewportPoint {
  const minX = rect.left;
  const maxX = rect.left + rect.width;
  const minY = rect.top;
  const maxY = rect.top + rect.height;
  const clampedX = clamp(tip.x, minX, maxX);
  const clampedY = clamp(tip.y, minY, maxY);

  if (tip.x < minX || tip.x > maxX || tip.y < minY || tip.y > maxY) {
    return { x: clampedX, y: clampedY };
  }

  const distances = [
    { edge: "left", value: tip.x - minX },
    { edge: "right", value: maxX - tip.x },
    { edge: "top", value: tip.y - minY },
    { edge: "bottom", value: maxY - tip.y },
  ] as const;
  const nearest = distances.reduce((best, candidate) =>
    candidate.value < best.value ? candidate : best,
  );

  switch (nearest.edge) {
    case "left":
      return { x: minX, y: tip.y };
    case "right":
      return { x: maxX, y: tip.y };
    case "top":
      return { x: tip.x, y: minY };
    case "bottom":
      return { x: tip.x, y: maxY };
  }
}

function TextBoxOverlay({
  edit,
  viewport,
  scale,
  selected,
  previewRect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResizeStart,
  onEditRequested,
  onFontSizeChange,
  onTextStyleChange,
  onRemove,
  onTogglePin,
}: {
  edit: PendingTextBox;
  viewport: PageViewport;
  scale: number;
  selected: boolean;
  previewRect: ViewportRect | null;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, corner: ResizeCorner) => void;
  onEditRequested: () => void;
  onFontSizeChange: (fontSizePt: number) => void;
  onTextStyleChange: (style: TextBoxStyleUpdate) => void;
  onRemove: () => void;
  onTogglePin: () => void;
}) {
  const rect = previewRect ?? pdfRectToViewportRect(edit.rect, viewport);
  const pinned = edit.pinned === true;
  const font = useTextBoxPreviewFont(
    edit.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
    Boolean(edit.bold),
    Boolean(edit.italic),
  );
  const lines = useMemo(
    () =>
      computeTextBoxPreviewLines({
        text: edit.text,
        boxWidthPt: rect.width / scale,
        fontSizePt: edit.fontSizePt,
        font,
      }),
    [edit.fontSizePt, edit.text, font, rect.width, scale],
  );

  return (
    <div
      className="edit-layer__item edit-layer__text-box"
      data-selected={selected ? "true" : undefined}
      data-status={edit.status}
      data-pinned={pinned ? "true" : undefined}
      style={{
        ...toOverlayStyle(rect),
        ...textBoxBackgroundStyle(edit),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEditRequested();
      }}
    >
      <span
        className="edit-layer__text-content"
        style={textContentStyle(edit, scale, edit.color ?? DEFAULT_TEXT_COLOR)}
      >
        {lines.map((line, lineIndex) => (
          <span key={lineIndex} className="edit-layer__text-line">
            {line}
          </span>
        ))}
      </span>
      {selected && !pinned ? (
        <ItemChrome
          fontSizePt={edit.fontSizePt}
          onFontSizeChange={onFontSizeChange}
          fontFamily={edit.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY}
          bold={Boolean(edit.bold)}
          italic={Boolean(edit.italic)}
          align={edit.align ?? DEFAULT_TEXT_ALIGN}
          onTextStyleChange={onTextStyleChange}
        />
      ) : null}
      <PinControls
        pinned={pinned}
        onTogglePin={onTogglePin}
        onRemove={onRemove}
      />
      {selected && !pinned ? <ResizeHandles onResizeStart={onResizeStart} /> : null}
    </div>
  );
}

function StampOverlay({
  edit,
  viewport,
  selected,
  previewRect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResizeStart,
  onRemove,
  onTogglePin,
}: {
  edit: PendingStamp;
  viewport: PageViewport;
  selected: boolean;
  previewRect: ViewportRect | null;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, corner: ResizeCorner) => void;
  onRemove: () => void;
  onTogglePin: () => void;
}) {
  const rect = previewRect ?? pdfRectToViewportRect(edit.rect, viewport);
  const pinned = edit.pinned === true;

  return (
    <div
      className="edit-layer__item edit-layer__stamp"
      data-selected={selected ? "true" : undefined}
      data-status={edit.status}
      data-pinned={pinned ? "true" : undefined}
      style={toOverlayStyle(rect)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <img
        className="edit-layer__stamp-image"
        src={edit.dataUrl}
        alt={edit.kind === "signature" ? "Pending signature" : "Pending image"}
        draggable={false}
      />
      <PinControls
        pinned={pinned}
        onTogglePin={onTogglePin}
        onRemove={onRemove}
      />
      {selected && !pinned ? <ResizeHandles onResizeStart={onResizeStart} /> : null}
    </div>
  );
}

function StampGhostOverlay({ ghost }: { ghost: StampGhost }) {
  return (
    <div className="edit-layer__stamp-ghost" style={toOverlayStyle(ghost.rect)}>
      <img
        className="edit-layer__stamp-image"
        src={ghost.dataUrl}
        alt=""
        draggable={false}
      />
    </div>
  );
}

function CommentPin({
  edit,
  viewport,
  onOpen,
}: {
  edit: PendingComment;
  viewport: PageViewport;
  onOpen: () => void;
}) {
  const rect = pdfRectToViewportRect(
    {
      x: edit.at.x,
      y: edit.at.y,
      w: COMMENT_ICON_SIZE_PT,
      h: COMMENT_ICON_SIZE_PT,
    },
    viewport,
  );
  const size = Math.max(14, Math.min(rect.width, rect.height));

  return (
    <button
      type="button"
      className="edit-layer__comment-pin"
      style={toOverlayStyle(rect)}
      aria-label={`Comment: ${edit.text}`}
      title={edit.text}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <CommentMarkerIcon size={size} />
    </button>
  );
}

// The text-styling toolbar for a selected, unpinned text box. Pin and remove
// affordances live in PinControls (shown on every floating item so its pinned
// state reads at a glance).
function ItemChrome({
  fontSizePt,
  onFontSizeChange,
  fontFamily,
  bold,
  italic,
  align,
  onTextStyleChange,
}: {
  fontSizePt: number;
  onFontSizeChange: (fontSizePt: number) => void;
  fontFamily: PdfTextBoxFontFamily;
  bold: boolean;
  italic: boolean;
  align: PdfTextBoxAlign;
  onTextStyleChange: (style: TextBoxStyleUpdate) => void;
}) {
  return (
    <span className="edit-layer__item-chrome" onPointerDown={(event) => event.stopPropagation()}>
      <select
        className="edit-layer__font-size"
        aria-label="Font size"
        value={fontSizePt}
        onChange={(event) => onFontSizeChange(Number(event.target.value))}
      >
        {TEXT_BOX_FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size} pt
          </option>
        ))}
      </select>
      <TextBoxStyleControls
        fontFamily={fontFamily}
        bold={bold}
        italic={italic}
        align={align}
        onChange={onTextStyleChange}
      />
    </span>
  );
}

/**
 * The pin badge (and, when unpinned, the remove X) shown on every floating
 * annotation. A pinned item's body is click-through so it never intercepts
 * clicks meant for the text underneath; the badge stays clickable so it can be
 * unpinned. Removal is deliberately gated behind unpinning — the X only
 * appears once the item is unpinned.
 */
function PinControls({
  pinned,
  onTogglePin,
  onRemove,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="edit-layer__pin-controls" onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="edit-layer__pin-badge"
        data-pinned={pinned ? "true" : undefined}
        aria-label={pinned ? "Unpin annotation" : "Pin annotation"}
        aria-pressed={pinned}
        title={
          pinned
            ? "Pinned — locked in place and click-through. Click to unpin."
            : "Pin so it stays put and stops catching clicks."
        }
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin();
        }}
      >
        <PinGlyph filled={pinned} />
      </button>
      {pinned ? null : (
        <button
          type="button"
          className="edit-layer__pin-remove"
          aria-label="Remove annotation"
          title="Remove"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={11} height={11} aria-hidden="true" focusable="false">
      <path
        d="M8 1.5c-2.35 0-4.25 1.9-4.25 4.25 0 3.2 4.25 8.75 4.25 8.75s4.25-5.55 4.25-8.75C12.25 3.4 10.35 1.5 8 1.5z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
      <circle cx="8" cy="5.75" r="1.6" fill={filled ? "var(--panel, #fff)" : "currentColor"} />
    </svg>
  );
}

function TextBoxStyleControls({
  fontFamily,
  bold,
  italic,
  align,
  onChange,
}: {
  fontFamily: PdfTextBoxFontFamily;
  bold: boolean;
  italic: boolean;
  align: PdfTextBoxAlign;
  onChange: (style: TextBoxStyleUpdate) => void;
}) {
  return (
    <>
      <select
        className="edit-layer__font-family"
        aria-label="Font family"
        value={fontFamily}
        onChange={(event) =>
          onChange({ fontFamily: event.currentTarget.value as PdfTextBoxFontFamily })
        }
      >
        <option value="helvetica">Helvetica</option>
        <option value="times">Times</option>
        <option value="courier">Courier</option>
      </select>
      <span className="edit-layer__text-toggle-group" aria-label="Text style">
        <button
          type="button"
          className="edit-layer__text-toggle"
          aria-label="Bold"
          aria-pressed={bold}
          onClick={() => onChange({ bold: !bold })}
        >
          B
        </button>
        <button
          type="button"
          className="edit-layer__text-toggle"
          aria-label="Italic"
          aria-pressed={italic}
          onClick={() => onChange({ italic: !italic })}
        >
          I
        </button>
      </span>
      <span className="edit-layer__align-group" aria-label="Text alignment">
        {(["left", "center", "right"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="edit-layer__align-button"
            aria-label={`Align ${option}`}
            aria-pressed={align === option}
            onClick={() => onChange({ align: option })}
          >
            {option === "left" ? "L" : option === "center" ? "C" : "R"}
          </button>
        ))}
      </span>
    </>
  );
}

function ResizeHandles({
  onResizeStart,
}: {
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, corner: ResizeCorner) => void;
}) {
  const corners: ResizeCorner[] = ["nw", "ne", "sw", "se"];

  return (
    <>
      {corners.map((corner) => (
        <span
          key={corner}
          className="edit-layer__resize-handle"
          data-corner={corner}
          onPointerDown={(event) => onResizeStart(event, corner)}
        />
      ))}
    </>
  );
}

export function TextBoxDraftEditor({
  draft,
  scale,
  onTextChange,
  onFontSizeChange,
  onTextStyleChange,
  onCommit,
  onCancel,
}: {
  draft: TextDraft;
  scale: number;
  onTextChange: (text: string) => void;
  onFontSizeChange: (fontSizePt: number) => void;
  onTextStyleChange: (style: TextBoxStyleUpdate) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const color = draft.color ?? DEFAULT_TEXT_COLOR;
  const font = useTextBoxPreviewFont(
    draft.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
    Boolean(draft.bold),
    Boolean(draft.italic),
  );
  const lines = useMemo(
    () =>
      computeTextBoxPreviewLines({
        text: draft.text,
        boxWidthPt: draft.rect.width / scale,
        fontSizePt: draft.fontSizePt,
        font,
      }),
    [draft.fontSizePt, draft.rect.width, draft.text, font, scale],
  );
  const contentStyle = textContentStyle(draft, scale, color);
  const inputStyle: CSSProperties = {
    ...contentStyle,
    color: "transparent",
    caretColor: pdfEditColorToHex(color),
  };

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onCommit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <div
      className={`edit-layer__item edit-layer__text-draft${
        draft.kind === "callout" ? " edit-layer__callout-box" : ""
      }`}
      style={{
        ...toOverlayStyle(draft.rect),
        ...(draft.kind === "textBox" ? textBoxBackgroundStyle(draft) : {}),
        ...(draft.kind === "callout" && draft.boxFill
          ? { backgroundColor: pdfEditColorToHex(draft.boxFill) }
          : {}),
        ...(draft.kind === "callout"
          ? { borderColor: pdfEditColorToHex(draft.strokeColor ?? DEFAULT_CALLOUT_STROKE_COLOR) }
          : {}),
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="edit-layer__item-chrome" data-draft="true">
        <select
          className="edit-layer__font-size"
          aria-label="Font size"
          value={draft.fontSizePt}
          onChange={(event) => onFontSizeChange(Number(event.target.value))}
        >
          {TEXT_BOX_FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} pt
            </option>
          ))}
        </select>
        <TextBoxStyleControls
          fontFamily={draft.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY}
          bold={Boolean(draft.bold)}
          italic={Boolean(draft.italic)}
          align={draft.align ?? DEFAULT_TEXT_ALIGN}
          onChange={onTextStyleChange}
        />
        <span className="edit-layer__chrome-hint">Enter commits · Esc cancels</span>
      </span>
      <span
        className="edit-layer__text-content edit-layer__text-draft-preview"
        style={contentStyle}
        aria-hidden="true"
      >
        {lines.map((line, lineIndex) => (
          <span key={lineIndex} className="edit-layer__text-line">
            {line}
          </span>
        ))}
      </span>
      <textarea
        className="edit-layer__text-input"
        style={inputStyle}
        aria-label="Text box content"
        value={draft.text}
        autoFocus
        spellCheck={false}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}

function CommentPopover({
  draft,
  viewport,
  onTextChange,
  onCommit,
  onCancel,
  onDelete,
}: {
  draft: CommentDraft;
  viewport: PageViewport;
  onTextChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
}) {
  const [anchorX, anchorY] = viewport.convertToViewportPoint(draft.at.x, draft.at.y);
  const width = 248;
  const left = clamp(anchorX + 12, 0, Math.max(0, viewport.width - width));
  const top = clamp(anchorY - 8, 0, Math.max(0, viewport.height - 148));

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onCommit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <div
      className="edit-layer__comment-popover"
      role="dialog"
      aria-label="Comment note"
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        className="edit-layer__comment-input"
        aria-label="Comment text"
        placeholder="Type the note..."
        value={draft.text}
        autoFocus
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="edit-layer__comment-actions">
        <button
          type="button"
          className="edit-layer__comment-save"
          disabled={!draft.text.trim()}
          onClick={onCommit}
        >
          Save Note
        </button>
        <button type="button" className="edit-layer__comment-cancel" onClick={onCancel}>
          Cancel
        </button>
        {onDelete ? (
          <button
            type="button"
            className="edit-layer__comment-delete"
            onClick={onDelete}
          >
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}

function highlightStyle(
  rect: ViewportRect,
  color: PdfEditColor,
  opacity: number,
): CSSProperties {
  return {
    ...toOverlayStyle(rect),
    backgroundColor: pdfEditColorToHex(color),
    opacity,
  };
}

function textBoxBackgroundStyle(
  textBox: Pick<PendingTextBox | TextDraft, "backgroundColor" | "backgroundOpacity">,
): CSSProperties {
  if (!textBox.backgroundColor) {
    return {};
  }

  return {
    backgroundColor: pdfEditColorToRgba(
      textBox.backgroundColor,
      textBox.backgroundOpacity ?? DEFAULT_TEXT_BOX_BACKGROUND_OPACITY,
    ),
  };
}

function pdfEditColorToRgba(color: PdfEditColor, alpha: number): string {
  return `rgba(${Math.round(clamp(color.r, 0, 1) * 255)}, ${Math.round(
    clamp(color.g, 0, 1) * 255,
  )}, ${Math.round(clamp(color.b, 0, 1) * 255)}, ${clamp(alpha, 0, 1)})`;
}

function textContentStyle(
  textStyle: Pick<
    PendingTextBox | TextDraft,
    "fontSizePt" | "fontFamily" | "bold" | "italic" | "align"
  >,
  scale: number,
  color: PdfEditColor,
): CSSProperties {
  return {
    fontFamily: cssTextBoxFontFamily(textStyle.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY),
    fontSize: `${textStyle.fontSizePt * scale}px`,
    fontWeight: textStyle.bold ? 700 : 400,
    fontStyle: textStyle.italic ? "italic" : "normal",
    lineHeight: TEXT_BOX_LINE_HEIGHT,
    textAlign: textStyle.align ?? DEFAULT_TEXT_ALIGN,
    color: pdfEditColorToHex(color),
  };
}

function cssTextBoxFontFamily(fontFamily: PdfTextBoxFontFamily): string {
  switch (fontFamily) {
    case "times":
      return '"Times New Roman", Times, serif';
    case "courier":
      return '"Courier New", Courier, monospace';
    case "helvetica":
      return "Helvetica, Arial, sans-serif";
  }
}

function useTextBoxPreviewFont(
  fontFamily: PdfTextBoxFontFamily,
  bold: boolean,
  italic: boolean,
): PDFFont | null {
  const [font, setFont] = useState<PDFFont | null>(null);
  const key = textBoxFontKey(fontFamily, bold, italic);

  useEffect(() => {
    let disposed = false;

    setFont(null);
    void loadTextBoxPreviewFont(key).then((loadedFont) => {
      if (!disposed) {
        setFont(loadedFont);
      }
    });

    return () => {
      disposed = true;
    };
  }, [key]);

  return font;
}

type TextBoxPreviewFontKey =
  `${PdfTextBoxFontFamily}:${"regular" | "bold" | "italic" | "boldItalic"}`;

const TEXT_BOX_PREVIEW_STANDARD_FONTS: Record<TextBoxPreviewFontKey, StandardFonts> = {
  "helvetica:regular": StandardFonts.Helvetica,
  "helvetica:bold": StandardFonts.HelveticaBold,
  "helvetica:italic": StandardFonts.HelveticaOblique,
  "helvetica:boldItalic": StandardFonts.HelveticaBoldOblique,
  "times:regular": StandardFonts.TimesRoman,
  "times:bold": StandardFonts.TimesRomanBold,
  "times:italic": StandardFonts.TimesRomanItalic,
  "times:boldItalic": StandardFonts.TimesRomanBoldItalic,
  "courier:regular": StandardFonts.Courier,
  "courier:bold": StandardFonts.CourierBold,
  "courier:italic": StandardFonts.CourierOblique,
  "courier:boldItalic": StandardFonts.CourierBoldOblique,
};
const textBoxPreviewFontCache = new Map<TextBoxPreviewFontKey, Promise<PDFFont>>();

function textBoxFontKey(
  fontFamily: PdfTextBoxFontFamily,
  bold: boolean,
  italic: boolean,
): TextBoxPreviewFontKey {
  if (bold && italic) {
    return `${fontFamily}:boldItalic`;
  }

  if (bold) {
    return `${fontFamily}:bold`;
  }

  if (italic) {
    return `${fontFamily}:italic`;
  }

  return `${fontFamily}:regular`;
}

function loadTextBoxPreviewFont(key: TextBoxPreviewFontKey): Promise<PDFFont> {
  let font = textBoxPreviewFontCache.get(key);

  if (!font) {
    font = PDFDocument.create().then((pdf) => pdf.embedFont(TEXT_BOX_PREVIEW_STANDARD_FONTS[key]));
    textBoxPreviewFontCache.set(key, font);
  }

  return font;
}

function moveRect(
  start: ViewportRect,
  dx: number,
  dy: number,
  viewport: PageViewport,
): ViewportRect {
  return {
    left: clamp(start.left + dx, 0, Math.max(0, viewport.width - start.width)),
    top: clamp(start.top + dy, 0, Math.max(0, viewport.height - start.height)),
    width: start.width,
    height: start.height,
  };
}

function moveLine(
  startFrom: ViewportPoint,
  startTo: ViewportPoint,
  dx: number,
  dy: number,
  viewport: PageViewport,
): { from: ViewportPoint; to: ViewportPoint } {
  const minX = Math.min(startFrom.x, startTo.x);
  const maxX = Math.max(startFrom.x, startTo.x);
  const minY = Math.min(startFrom.y, startTo.y);
  const maxY = Math.max(startFrom.y, startTo.y);
  const clampedDx = clamp(dx, -minX, viewport.width - maxX);
  const clampedDy = clamp(dy, -minY, viewport.height - maxY);

  return {
    from: { x: startFrom.x + clampedDx, y: startFrom.y + clampedDy },
    to: { x: startTo.x + clampedDx, y: startTo.y + clampedDy },
  };
}

function stampPlacementRect(
  point: ViewportPoint,
  stamp: ArmedStamp,
  viewport: PageViewport,
  scale: number,
): ViewportRect {
  const visualPageWidthPt = viewport.width / scale;
  const widthPt = clamp(stamp.width * 0.75, 24, visualPageWidthPt * 0.4);
  const heightPt = widthPt * (stamp.height / stamp.width);
  const width = widthPt * scale;
  const height = heightPt * scale;

  return {
    left: clamp(point.x - width / 2, 0, Math.max(0, viewport.width - width)),
    top: clamp(point.y - height / 2, 0, Math.max(0, viewport.height - height)),
    width,
    height,
  };
}

function resizeRect(
  start: ViewportRect,
  corner: ResizeCorner,
  dx: number,
  dy: number,
  aspectRatio: number | null,
  viewport: PageViewport,
): ViewportRect {
  let left = start.left;
  let top = start.top;
  let right = start.left + start.width;
  let bottom = start.top + start.height;

  if (corner.includes("w")) {
    left += dx;
  } else {
    right += dx;
  }

  if (corner.includes("n")) {
    top += dy;
  } else {
    bottom += dy;
  }

  let width = Math.max(MIN_ITEM_SIZE_PX, right - left);
  let height = Math.max(MIN_ITEM_SIZE_PX, bottom - top);

  if (aspectRatio) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      height = width / aspectRatio;
    } else {
      width = height * aspectRatio;
    }
  }

  const anchoredLeft = corner.includes("w") ? start.left + start.width - width : start.left;
  const anchoredTop = corner.includes("n") ? start.top + start.height - height : start.top;

  return {
    left: clamp(anchoredLeft, 0, Math.max(0, viewport.width - width)),
    top: clamp(anchoredTop, 0, Math.max(0, viewport.height - height)),
    width: Math.min(width, viewport.width),
    height: Math.min(height, viewport.height),
  };
}

/**
 * Turns the live DOM text selection into per-line PDF rects for this page's
 * layer. Reading `Selection.getClientRects()` means the committed markup hugs
 * exactly the reading-order run the browser highlighted while dragging — first
 * line from the caret to line end, interior lines full width, last line to the
 * end caret — with page rotation handled by the viewport corner-mapping.
 * Client rects are clipped to this layer, so a selection dragged across a page
 * boundary only contributes the portion that lands on this page.
 */
function markupRectsFromSelection(
  layer: HTMLElement,
  viewport: PageViewport,
): PdfSpaceRect[] {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return [];
  }

  const bounds = layer.getBoundingClientRect();
  const clientRects: DOMRect[] = [];

  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    for (const rect of Array.from(selection.getRangeAt(rangeIndex).getClientRects())) {
      const overlapsPage =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > bounds.left &&
        rect.left < bounds.right &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom;

      if (overlapsPage) {
        clientRects.push(rect);
      }
    }
  }

  if (clientRects.length === 0) {
    return [];
  }

  return mergeClientRectsIntoLines(clientRects)
    .map((rect) => {
      const left = clamp(rect.left - bounds.left, 0, bounds.width);
      const top = clamp(rect.top - bounds.top, 0, bounds.height);
      const right = clamp(rect.right - bounds.left, 0, bounds.width);
      const bottom = clamp(rect.bottom - bounds.top, 0, bounds.height);

      return viewportRectToPdfRect(
        { left, top, width: right - left, height: bottom - top },
        viewport,
      );
    })
    .filter((rect) => rect.w > 0 && rect.h > 0);
}

/** Unions the per-span client rects of a selection into one rect per line. */
function mergeClientRectsIntoLines(
  rects: readonly DOMRect[],
): { left: number; top: number; right: number; bottom: number }[] {
  const sorted = [...rects].sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: { left: number; top: number; right: number; bottom: number }[] = [];

  for (const rect of sorted) {
    const line = lines.find((candidate) => {
      const overlap = Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top);
      return overlap > Math.min(candidate.bottom - candidate.top, rect.height) * 0.5;
    });

    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }

  return lines;
}

type TextContentItemLike = {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
};

/**
 * Maps pdf.js text runs to PDF user-space boxes. Runs are corner-mapped
 * through their text matrix, so rotated pages (where displayed-horizontal
 * lines run vertically in user space) produce correct boxes.
 */
function extractPageTextBoxes(items: readonly unknown[]): PageTextBox[] {
  const boxes: PageTextBox[] = [];

  for (const rawItem of items) {
    const item = rawItem as TextContentItemLike;

    if (typeof item.str !== "string" || !item.str.trim()) {
      continue;
    }

    if (!Array.isArray(item.transform) || item.transform.length < 6) {
      continue;
    }

    const [a, b, c, d, e, f] = item.transform.map(Number);
    const width = Number(item.width);
    const height = Math.max(Number(item.height) || 0, Math.hypot(c ?? 0, d ?? 0), 6);

    if (
      [a, b, c, d, e, f].some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(width) ||
      width <= 0
    ) {
      continue;
    }

    const runNorm = Math.hypot(a!, b!) || 1;
    const upNorm = Math.hypot(c!, d!) || 1;
    const runX = (a! / runNorm) * width;
    const runY = (b! / runNorm) * width;
    const upX = (c! / upNorm) * height;
    const upY = (d! / upNorm) * height;
    const descentX = -upX * 0.25;
    const descentY = -upY * 0.25;
    const corners = [
      [e! + descentX, f! + descentY],
      [e! + runX + descentX, f! + runY + descentY],
      [e! + upX, f! + upY],
      [e! + runX + upX, f! + runY + upY],
    ];
    const xs = corners.map(([x]) => x!);
    const ys = corners.map(([, y]) => y!);
    const x = Math.min(...xs);
    const y = Math.min(...ys);

    boxes.push({
      x,
      y,
      w: Math.max(1, Math.max(...xs) - x),
      h: Math.max(1, Math.max(...ys) - y),
    });
  }

  return boxes;
}
