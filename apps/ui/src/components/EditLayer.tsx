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
import {
  computeHighlightLineRects,
  DEFAULT_TEXT_BOX_FONT_SIZE,
  TEXT_BOX_FONT_SIZES,
  TEXT_BOX_LINE_HEIGHT,
  COMMENT_ICON_SIZE_PT,
  INK_STROKE_WIDTH_PT,
  type PageTextBox,
  type PendingComment,
  type PendingEdit,
  type PendingStamp,
  type PendingTextBox,
} from "../lib/edits";
import { newEditId, type EditingState } from "../hooks/useEditing";
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
  type ViewportPoint,
  type ViewportRect,
} from "../lib/viewportGeometry";
import { CommentMarkerIcon } from "../icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { hasOpenDialogStackEntry } from "./FloatingDialog";
import "./EditLayer.css";

/** Rapid re-clicks inside this window never place a second item. */
const PLACEMENT_GUARD_MS = 350;
const MIN_ITEM_SIZE_PX = 12;
const DEFAULT_TEXT_BOX_WIDTH_PT = 180;
const TEXT_BOX_PADDING_PT = 4;

interface TextDraft {
  /** Pending-edit id when re-editing an existing box; null for a new draft. */
  editId: string | null;
  rect: ViewportRect;
  text: string;
  fontSizePt: number;
}

interface CommentDraft {
  editId: string | null;
  at: PdfSpacePoint;
  text: string;
}

type ResizeCorner = "nw" | "ne" | "sw" | "se";

interface ItemDrag {
  id: string;
  mode: "move" | "resize";
  corner: ResizeCorner | null;
  startClientX: number;
  startClientY: number;
  startRect: ViewportRect;
  aspectRatio: number | null;
  moved: boolean;
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
  const [highlightDraft, setHighlightDraft] = useState<ViewportRect | null>(null);
  const [textLayerError, setTextLayerError] = useState<string | null>(null);
  const [drawDraft, setDrawDraft] = useState<readonly ViewportPoint[] | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ id: string; rect: ViewportRect } | null>(
    null,
  );
  const [itemContextMenu, setItemContextMenu] = useState<{
    x: number;
    y: number;
    editId: string;
  } | null>(null);
  const dragStartRef = useRef<ViewportPoint | null>(null);
  const drawPointsRef = useRef<ViewportPoint[]>([]);
  const itemDragRef = useRef<ItemDrag | null>(null);
  const placementGuardRef = useRef(0);
  const { tool, pendingEdits, addEdit, updateEdit, removeEdit } = editing;
  const scale = viewport.scale;
  const sideways = viewport.rotation % 180 !== 0;
  const pageEdits = useMemo(
    () => pendingEdits.filter((edit) => edit.pageIndex === pageIndex),
    [pageIndex, pendingEdits],
  );

  // Loaded eagerly per page (not on highlight activation) so the first
  // highlight drag never races the async text-layer read.
  useEffect(() => {
    let disposed = false;

    setTextBoxes([]);
    setTextLayerError(null);

    void page
      .getTextContent()
      .then((textContent) => {
        if (!disposed) {
          setTextBoxes(extractPageTextBoxes(textContent.items));
        }
      })
      .catch(() => {
        if (!disposed) {
          setTextBoxes([]);
          setTextLayerError("Text could not be read on this page, so highlight drag is unavailable here.");
        }
      });

    return () => {
      disposed = true;
    };
  }, [page]);

  useEffect(() => {
    setHighlightDraft(null);
    setDrawDraft(null);
    setTextDraft(null);
    setCommentDraft(null);
    setSelectedId(null);
    setDragPreview(null);
    setItemContextMenu(null);
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

  const suppressPlacement = useCallback(() => {
    placementGuardRef.current = Date.now() + PLACEMENT_GUARD_MS;
  }, []);

  // Delete/Backspace removes the currently selected placed item (stamp,
  // image, text box). Ignored while typing into a field (the text-box/
  // comment drafts have their own textareas, which this already covers) or
  // while a dialog is open on top of the canvas.
  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      if (!selectedId || isTextEntryTarget(event.target) || hasOpenDialogStackEntry()) {
        return;
      }

      event.preventDefault();
      removeEdit(selectedId);
      setSelectedId(null);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [removeEdit, selectedId]);

  const getLayerPoint = useCallback(
    (event: ReactPointerEvent): ViewportPoint | null => {
      const layer = layerRef.current;

      if (!layer) {
        return null;
      }

      const bounds = layer.getBoundingClientRect();

      return {
        x: clamp(event.clientX - bounds.left, 0, bounds.width),
        y: clamp(event.clientY - bounds.top, 0, bounds.height),
      };
    },
    [],
  );

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

      if (draft.editId) {
        updateEdit(draft.editId, (edit) =>
          edit.kind === "textBox"
            ? { ...edit, rect, text, fontSizePt: draft.fontSizePt }
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

    // An open inline editor absorbs the click: commit it, never also place.
    if (closeDraftsForOutsideClick()) {
      return;
    }

    setSelectedId(null);

    if (tool === "highlight") {
      dragStartRef.current = point;
      setHighlightDraft({ left: point.x, top: point.y, width: 0, height: 0 });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === "draw") {
      drawPointsRef.current = [point];
      setDrawDraft([point]);
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
        editId: null,
        rect: {
          left: clamp(point.x, 0, Math.max(0, viewport.width - width)),
          top: clamp(point.y, 0, Math.max(0, viewport.height - height)),
          width,
          height,
        },
        text: "",
        fontSizePt: DEFAULT_TEXT_BOX_FONT_SIZE,
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

      const visualPageWidthPt = viewport.width / scale;
      const widthPt = clamp(armed.width * 0.75, 24, visualPageWidthPt * 0.4);
      const heightPt = widthPt * (armed.height / armed.width);
      const width = widthPt * scale;
      const height = heightPt * scale;
      const rect: ViewportRect = {
        left: clamp(point.x - width / 2, 0, Math.max(0, viewport.width - width)),
        top: clamp(point.y - height / 2, 0, Math.max(0, viewport.height - height)),
        width,
        height,
      };

      addEdit({
        kind: tool === "image" ? "image" : "signature",
        id: newEditId(),
        pageIndex,
        rect: viewportRectToPdfRect(rect, viewport),
        bytes: armed.bytes,
        format: armed.format,
        dataUrl: armed.dataUrl,
        aspectRatio: armed.width / armed.height,
      });

      if (tool === "image") {
        editing.disarmImage();
        editing.setMessage("Image placed. Choose another image to place more.");
      }
    }
  }

  function handleLayerPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = getLayerPoint(event);

    if (!point) {
      return;
    }

    if (tool === "highlight" && dragStartRef.current) {
      setHighlightDraft(pointsToViewportRect(dragStartRef.current, point));
      return;
    }

    if (tool === "draw" && drawPointsRef.current.length > 0) {
      const lastPoint = drawPointsRef.current.at(-1);

      if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) >= 2) {
        drawPointsRef.current = [...drawPointsRef.current, point];
        setDrawDraft(drawPointsRef.current);
      }
    }
  }

  function handleLayerPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const point = getLayerPoint(event);

    if (tool === "highlight" && dragStartRef.current) {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      setHighlightDraft(null);

      if (!point) {
        return;
      }

      const band = pointsToViewportRect(start, point);

      if (band.width < 3 && band.height < 3) {
        removeHighlightAtPoint(point);
        return;
      }

      const rects = computeHighlightLineRects(
        viewportRectToPdfRect(band, viewport),
        textBoxes,
        sideways,
      );

      if (rects.length === 0) {
        editing.setMessage("No text under that drag — highlights attach to text lines.");
        return;
      }

      editing.setMessage(null);
      addEdit({ kind: "highlight", id: newEditId(), pageIndex, rects });
      return;
    }

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
      });
    }
  }

  function handleLayerPointerCancel() {
    dragStartRef.current = null;
    drawPointsRef.current = [];
    setHighlightDraft(null);
    setDrawDraft(null);
  }

  function removeHighlightAtPoint(point: ViewportPoint) {
    const pdfPoint = viewportPointToPdfPoint(point, viewport);
    const hit = pageEdits.find(
      (edit) =>
        edit.kind === "highlight" &&
        edit.rects.some((rect) => pdfRectContainsPoint(rect, pdfPoint)),
    );

    if (hit) {
      removeEdit(hit.id);
    }
  }

  function beginItemDrag(
    event: ReactPointerEvent<HTMLElement>,
    edit: PendingTextBox | PendingStamp,
    mode: "move" | "resize",
    corner: ResizeCorner | null = null,
  ) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();

    if (closeDraftsForOutsideClick()) {
      return;
    }

    itemDragRef.current = {
      id: edit.id,
      mode,
      corner,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: pdfRectToViewportRect(edit.rect, viewport),
      aspectRatio: edit.kind === "textBox" ? null : edit.aspectRatio,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleItemPointerMove(event: ReactPointerEvent<HTMLElement>) {
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
    const rect =
      drag.mode === "move"
        ? moveRect(drag.startRect, dx, dy, viewport)
        : resizeRect(drag.startRect, drag.corner ?? "se", dx, dy, drag.aspectRatio, viewport);
    setDragPreview({ id: drag.id, rect });
  }

  function handleItemPointerUp(event: ReactPointerEvent<HTMLElement>) {
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
    updateEdit(drag.id, (edit) =>
      edit.kind === "textBox" || edit.kind === "image" || edit.kind === "signature"
        ? { ...edit, rect: pdfRect }
        : edit,
    );
    setSelectedId(drag.id);
    suppressPlacement();
  }

  function openTextBoxForEditing(edit: PendingTextBox) {
    setSelectedId(null);
    setTextDraft({
      editId: edit.id,
      rect: pdfRectToViewportRect(edit.rect, viewport),
      text: edit.text,
      fontSizePt: edit.fontSizePt,
    });
    suppressPlacement();
  }

  function openCommentForEditing(edit: PendingComment) {
    setCommentDraft({ editId: edit.id, at: edit.at, text: edit.text });
    suppressPlacement();
  }

  const interactive = tool !== "select";
  const inkEdits = pageEdits.filter((edit) => edit.kind === "ink");

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
        if (edit.kind === "highlight") {
          return (
            <HighlightOverlay
              key={edit.id}
              edit={edit}
              viewport={viewport}
              removable={tool === "highlight"}
            />
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
              previewRect={dragPreview?.id === edit.id ? dragPreview.rect : null}
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
              onRemove={() => removeEdit(edit.id)}
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
              previewRect={dragPreview?.id === edit.id ? dragPreview.rect : null}
              onPointerDown={(event) => beginItemDrag(event, edit, "move")}
              onPointerMove={handleItemPointerMove}
              onPointerUp={handleItemPointerUp}
              onResizeStart={(event, corner) => beginItemDrag(event, edit, "resize", corner)}
              onRemove={() => removeEdit(edit.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedId(edit.id);
                setItemContextMenu({ x: event.clientX, y: event.clientY, editId: edit.id });
              }}
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
                    stroke="var(--edit-ink)"
                    strokeWidth={INK_STROKE_WIDTH_PT * scale}
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
              stroke="var(--edit-ink)"
              strokeWidth={INK_STROKE_WIDTH_PT * scale}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </svg>
      ) : null}

      {highlightDraft ? (
        <span className="edit-layer__highlight-draft" style={toOverlayStyle(highlightDraft)} />
      ) : null}

      {tool === "highlight" && textLayerError ? (
        <p className="edit-layer__message" role="status">
          {textLayerError}
        </p>
      ) : null}

      {textDraft ? (
        <TextBoxDraftEditor
          draft={textDraft}
          scale={scale}
          onTextChange={(text) => setTextDraft((current) => (current ? { ...current, text } : null))}
          onFontSizeChange={(fontSizePt) =>
            setTextDraft((current) => (current ? { ...current, fontSizePt } : null))
          }
          onCommit={commitTextDraft}
          onCancel={() => {
            setTextDraft(null);
            suppressPlacement();
          }}
        />
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

      {itemContextMenu ? (
        <ContextMenu
          x={itemContextMenu.x}
          y={itemContextMenu.y}
          items={buildItemContextMenuItems(itemContextMenu.editId, removeEdit)}
          onClose={() => setItemContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

function buildItemContextMenuItems(
  editId: string,
  removeEdit: (id: string) => void,
): ContextMenuItem[] {
  return [
    {
      label: "Delete",
      danger: true,
      onSelect: () => removeEdit(editId),
    },
  ];
}

function HighlightOverlay({
  edit,
  viewport,
  removable,
}: {
  edit: Extract<PendingEdit, { kind: "highlight" }>;
  viewport: PageViewport;
  removable: boolean;
}) {
  return (
    <>
      {edit.rects.map((rect, rectIndex) => (
        <span
          key={`${edit.id}-${rectIndex}`}
          className="edit-layer__highlight"
          data-removable={removable ? "true" : undefined}
          style={toOverlayStyle(pdfRectToViewportRect(rect, viewport))}
          title={removable ? "Click to remove this highlight" : undefined}
        />
      ))}
    </>
  );
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
  onRemove,
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
  onRemove: () => void;
}) {
  const rect = previewRect ?? pdfRectToViewportRect(edit.rect, viewport);

  return (
    <div
      className="edit-layer__item edit-layer__text-box"
      data-selected={selected ? "true" : undefined}
      style={toOverlayStyle(rect)}
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
        style={textContentStyle(edit.fontSizePt, scale)}
      >
        {edit.text}
      </span>
      {selected ? (
        <ItemChrome
          fontSizePt={edit.fontSizePt}
          onFontSizeChange={onFontSizeChange}
          onRemove={onRemove}
        />
      ) : null}
      {selected ? <ResizeHandles onResizeStart={onResizeStart} /> : null}
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
  onContextMenu,
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
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const rect = previewRect ?? pdfRectToViewportRect(edit.rect, viewport);

  return (
    <div
      className="edit-layer__item edit-layer__stamp"
      data-selected={selected ? "true" : undefined}
      style={toOverlayStyle(rect)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
    >
      <img
        className="edit-layer__stamp-image"
        src={edit.dataUrl}
        alt={edit.kind === "signature" ? "Pending signature" : "Pending image"}
        draggable={false}
      />
      {selected ? <ItemChrome onRemove={onRemove} /> : null}
      {selected ? <ResizeHandles onResizeStart={onResizeStart} /> : null}
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

function ItemChrome({
  fontSizePt,
  onFontSizeChange,
  onRemove,
}: {
  fontSizePt?: number;
  onFontSizeChange?: (fontSizePt: number) => void;
  onRemove: () => void;
}) {
  return (
    <span className="edit-layer__item-chrome" onPointerDown={(event) => event.stopPropagation()}>
      {fontSizePt !== undefined && onFontSizeChange ? (
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
      ) : null}
      <button
        type="button"
        className="edit-layer__item-remove"
        aria-label="Remove pending edit"
        onClick={onRemove}
      >
        ×
      </button>
    </span>
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

function TextBoxDraftEditor({
  draft,
  scale,
  onTextChange,
  onFontSizeChange,
  onCommit,
  onCancel,
}: {
  draft: TextDraft;
  scale: number;
  onTextChange: (text: string) => void;
  onFontSizeChange: (fontSizePt: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
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
      className="edit-layer__item edit-layer__text-draft"
      style={toOverlayStyle(draft.rect)}
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
        <span className="edit-layer__chrome-hint">Enter commits · Esc cancels</span>
      </span>
      <textarea
        className="edit-layer__text-input"
        style={textContentStyle(draft.fontSizePt, scale)}
        aria-label="Text box content"
        value={draft.text}
        autoFocus
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

function textContentStyle(fontSizePt: number, scale: number): CSSProperties {
  return {
    fontSize: `${fontSizePt * scale}px`,
    lineHeight: TEXT_BOX_LINE_HEIGHT,
  };
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
