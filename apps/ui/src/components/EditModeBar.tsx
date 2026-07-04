import { useEffect, useRef, type CSSProperties } from "react";
import type { EditToolId, ShapeToolId } from "../lib/edits";
import type { EditingState } from "../hooks/useEditing";
import type { PdfTextBoxAlign, PdfTextBoxFontFamily } from "@raiopdf/engine-api";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  DEFAULT_INK_COLOR,
  DEFAULT_SHAPE_STROKE_COLOR,
  DEFAULT_TEXT_MARKUP_COLOR,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_FAMILY,
  HIGHLIGHT_COLOR_OPTIONS,
  INK_STROKE_WIDTH_OPTIONS,
  INK_TEXT_COLOR_OPTIONS,
  pdfEditColorToHex,
  SHAPE_FILL_COLOR_OPTIONS,
  type EditColorOption,
} from "../lib/editStyles";
import "./LegalModeBar.css";

const TOOL_LABELS: Record<Exclude<EditToolId, "select">, string> = {
  highlight: "Highlight mode",
  underline: "Underline mode",
  strikethrough: "Strikethrough mode",
  textBox: "Text box mode",
  image: "Image mode",
  comment: "Comment mode",
  draw: "Draw mode",
  shapeRect: "Rectangle mode",
  shapeEllipse: "Ellipse mode",
  shapeLine: "Line mode",
  shapeArrow: "Arrow mode",
  sign: "Sign mode",
};

export interface EditModeBarProps {
  editing: EditingState;
}

/**
 * Canvas mode bar for the add-content edit tools — same pattern as the
 * Redact mode bar. Shows the active tool, its next step, the pending count,
 * and the per-tool affordances (image picker, signature card).
 */
export function EditModeBar({ editing }: EditModeBarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const { tool } = editing;
  const autoPickedRef = useRef(false);

  useEffect(() => {
    if (tool !== "image") {
      autoPickedRef.current = false;
      return;
    }

    if (!editing.armedImage && !autoPickedRef.current) {
      autoPickedRef.current = true;
      imageInputRef.current?.click();
    }
  }, [editing.armedImage, tool]);

  if (tool === "select") {
    return null;
  }

  const pendingCount = editing.pendingEdits.length;

  return (
    <div className="legal-mode-bar" role="toolbar" aria-label={TOOL_LABELS[tool]}>
      <span className="legal-mode-bar__status">
        {TOOL_LABELS[tool]} — {pendingCount} pending{" "}
        {pendingCount === 1 ? "edit" : "edits"}
      </span>
      <span className="legal-mode-bar__hint">{editing.message ?? getToolHint(editing)}</span>
      <ToolOptions editing={editing} />
      {tool === "image" ? (
        <>
          <input
            ref={imageInputRef}
            className="legal-mode-bar__file-input"
            type="file"
            accept="image/png,image/jpeg"
            aria-label="Choose image file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";

              if (file) {
                editing.handleImageFile(file);
              }
            }}
          />
          <button
            type="button"
            className="legal-mode-bar__button"
            onClick={() => imageInputRef.current?.click()}
          >
            Choose Image...
          </button>
        </>
      ) : null}
      {tool === "sign" ? (
        <button
          type="button"
          className="legal-mode-bar__button"
          onClick={() => editing.setSignatureCardOpen(true)}
        >
          Signature Card
        </button>
      ) : null}
      <button
        type="button"
        className="legal-mode-bar__button"
        onClick={() => editing.setTool("select")}
      >
        Exit
      </button>
    </div>
  );
}

function ToolOptions({ editing }: { editing: EditingState }) {
  if (editing.tool === "highlight") {
    const selectedColor = editing.highlightStyle.color ?? DEFAULT_HIGHLIGHT_COLOR;
    const opacity = editing.highlightStyle.opacity ?? DEFAULT_HIGHLIGHT_OPACITY;

    return (
      <span className="legal-mode-bar__tool-options" aria-label="Highlight options">
        <ColorSwatches
          labelPrefix="Highlight color"
          options={HIGHLIGHT_COLOR_OPTIONS}
          selectedColor={selectedColor}
          onSelect={(color) => editing.updateHighlightStyle({ color })}
        />
        <label className="legal-mode-bar__range">
          <span className="legal-mode-bar__range-label">Opacity</span>
          <input
            type="range"
            min="0.2"
            max="0.8"
            step="0.05"
            aria-label="Highlight opacity"
            value={opacity}
            onChange={(event) =>
              editing.updateHighlightStyle({ opacity: Number(event.currentTarget.value) })
            }
          />
          <span className="legal-mode-bar__range-value">{Math.round(opacity * 100)}%</span>
        </label>
      </span>
    );
  }

  if (editing.tool === "underline" || editing.tool === "strikethrough") {
    const markupTool = editing.tool;
    const selectedColor =
      editing.textMarkupStyles[markupTool].color ?? DEFAULT_TEXT_MARKUP_COLOR;
    const label = markupTool === "underline" ? "Underline" : "Strikethrough";

    return (
      <span className="legal-mode-bar__tool-options" aria-label={`${label} options`}>
        <ColorSwatches
          labelPrefix={`${label} color`}
          options={INK_TEXT_COLOR_OPTIONS}
          selectedColor={selectedColor}
          onSelect={(color) => editing.updateTextMarkupStyle(markupTool, { color })}
        />
      </span>
    );
  }

  if (editing.tool === "textBox") {
    return (
      <span className="legal-mode-bar__tool-options" aria-label="Text box options">
        <ColorSwatches
          labelPrefix="Text color"
          options={INK_TEXT_COLOR_OPTIONS}
          selectedColor={editing.textBoxStyle.color ?? DEFAULT_TEXT_COLOR}
          onSelect={(color) => editing.updateTextBoxStyle({ color })}
        />
        <select
          className="legal-mode-bar__select"
          aria-label="Text font family"
          value={editing.textBoxStyle.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY}
          onChange={(event) =>
            editing.updateTextBoxStyle({
              fontFamily: event.currentTarget.value as PdfTextBoxFontFamily,
            })
          }
        >
          <option value="helvetica">Helvetica</option>
          <option value="times">Times</option>
          <option value="courier">Courier</option>
        </select>
        <span className="legal-mode-bar__width-group" aria-label="Text style">
          <button
            type="button"
            className="legal-mode-bar__width-button"
            aria-label="Bold text"
            aria-pressed={Boolean(editing.textBoxStyle.bold)}
            onClick={() => editing.updateTextBoxStyle({ bold: !editing.textBoxStyle.bold })}
          >
            B
          </button>
          <button
            type="button"
            className="legal-mode-bar__width-button"
            aria-label="Italic text"
            aria-pressed={Boolean(editing.textBoxStyle.italic)}
            onClick={() =>
              editing.updateTextBoxStyle({ italic: !editing.textBoxStyle.italic })
            }
          >
            I
          </button>
        </span>
        <span className="legal-mode-bar__width-group" aria-label="Text alignment">
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              type="button"
              className="legal-mode-bar__width-button"
              aria-label={`Align text ${align}`}
              aria-pressed={(editing.textBoxStyle.align ?? DEFAULT_TEXT_ALIGN) === align}
              onClick={() => editing.updateTextBoxStyle({ align })}
            >
              {formatAlignLabel(align)}
            </button>
          ))}
        </span>
      </span>
    );
  }

  if (editing.tool === "draw") {
    return (
      <span className="legal-mode-bar__tool-options" aria-label="Draw options">
        <ColorSwatches
          labelPrefix="Draw color"
          options={INK_TEXT_COLOR_OPTIONS}
          selectedColor={editing.inkStyle.color ?? DEFAULT_INK_COLOR}
          onSelect={(color) => editing.updateInkStyle({ color })}
        />
        <span className="legal-mode-bar__width-group" aria-label="Stroke width">
          {INK_STROKE_WIDTH_OPTIONS.map((width) => (
            <button
              key={width}
              type="button"
              className="legal-mode-bar__width-button"
              aria-label={`Set draw stroke width to ${formatStrokeWidth(width)} points`}
              aria-pressed={editing.inkStyle.strokeWidthPt === width}
              onClick={() => editing.updateInkStyle({ strokeWidthPt: width })}
            >
              {formatStrokeWidth(width)}
            </button>
          ))}
        </span>
      </span>
    );
  }

  if (isShapeTool(editing.tool)) {
    const shapeTool = editing.tool;
    const style = editing.shapeStyles[shapeTool];
    const selectedStrokeColor = style.strokeColor ?? DEFAULT_SHAPE_STROKE_COLOR;
    const selectedFillColor = style.fillColor ?? null;
    const fallbackFillColor = SHAPE_FILL_COLOR_OPTIONS[0]!.color;
    const supportsFill = shapeTool === "shapeRect" || shapeTool === "shapeEllipse";

    return (
      <span className="legal-mode-bar__tool-options" aria-label="Shape options">
        <ColorSwatches
          labelPrefix="Shape stroke color"
          options={INK_TEXT_COLOR_OPTIONS}
          selectedColor={selectedStrokeColor}
          onSelect={(strokeColor) => editing.updateShapeStyle(shapeTool, { strokeColor })}
        />
        <span className="legal-mode-bar__width-group" aria-label="Stroke width">
          {INK_STROKE_WIDTH_OPTIONS.map((width) => (
            <button
              key={width}
              type="button"
              className="legal-mode-bar__width-button"
              aria-label={`Set shape stroke width to ${formatStrokeWidth(width)} points`}
              aria-pressed={style.strokeWidthPt === width}
              onClick={() => editing.updateShapeStyle(shapeTool, { strokeWidthPt: width })}
            >
              {formatStrokeWidth(width)}
            </button>
          ))}
        </span>
        {supportsFill ? (
          <>
            <button
              type="button"
              className="legal-mode-bar__width-button"
              aria-label="Set shape fill to none"
              aria-pressed={selectedFillColor === null}
              onClick={() => editing.updateShapeStyle(shapeTool, { fillColor: null })}
            >
              None
            </button>
            <ColorSwatches
              labelPrefix="Shape fill color"
              options={SHAPE_FILL_COLOR_OPTIONS}
              selectedColor={selectedFillColor ?? fallbackFillColor}
              onSelect={(fillColor) => editing.updateShapeStyle(shapeTool, { fillColor })}
            />
          </>
        ) : null}
      </span>
    );
  }

  return null;
}

function ColorSwatches({
  labelPrefix,
  options,
  selectedColor,
  onSelect,
}: {
  labelPrefix: string;
  options: readonly EditColorOption[];
  selectedColor: EditColorOption["color"];
  onSelect: (color: EditColorOption["color"]) => void;
}) {
  const selectedHex = pdfEditColorToHex(selectedColor);

  return (
    <span className="legal-mode-bar__swatches" aria-label={labelPrefix}>
      {options.map((option) => {
        const hex = pdfEditColorToHex(option.color);

        return (
          <button
            key={option.id}
            type="button"
            className="legal-mode-bar__swatch"
            style={{ "--tool-swatch-color": hex } as CSSProperties}
            aria-label={`${labelPrefix}: ${option.label}`}
            aria-pressed={hex === selectedHex}
            title={option.label}
            onClick={() => onSelect(option.color)}
          />
        );
      })}
    </span>
  );
}

function formatStrokeWidth(width: number): string {
  return Number.isInteger(width) ? String(width) : width.toFixed(1);
}

function formatAlignLabel(align: PdfTextBoxAlign): string {
  if (align === "center") {
    return "C";
  }

  if (align === "right") {
    return "R";
  }

  return "L";
}

function getToolHint(editing: EditingState): string {
  switch (editing.tool) {
    case "highlight":
      return "Drag over text to highlight. Click a pending highlight to remove it.";
    case "underline":
      return "Drag over text to underline. Click a pending underline to remove it.";
    case "strikethrough":
      return "Drag over text to strike through. Click a pending strikethrough to remove it.";
    case "textBox":
      return "Click the page to place a text box. Enter commits, Esc cancels.";
    case "image":
      return editing.armedImage
        ? "Click the page to place the image."
        : "Choose a PNG or JPEG, then click the page to place it.";
    case "comment":
      return "Click the page to drop a note pin.";
    case "draw":
      return "Drag to draw freehand ink.";
    case "shapeRect":
      return "Drag to size a rectangle. Click a pending rectangle to remove it.";
    case "shapeEllipse":
      return "Drag to size an ellipse. Click a pending ellipse to remove it.";
    case "shapeLine":
      return "Drag a straight line. Click a pending line to remove it.";
    case "shapeArrow":
      return "Drag an arrow from tail to head. Click a pending arrow to remove it.";
    case "sign":
      return editing.armedSignature
        ? "Click the page to place the signature."
        : "Draw or pick a signature in the card, then click the page.";
    default:
      return "";
  }
}

function isShapeTool(tool: EditToolId): tool is ShapeToolId {
  return (
    tool === "shapeRect" ||
    tool === "shapeEllipse" ||
    tool === "shapeLine" ||
    tool === "shapeArrow"
  );
}
