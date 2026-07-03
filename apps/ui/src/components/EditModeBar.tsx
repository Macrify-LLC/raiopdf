import { useEffect, useRef } from "react";
import type { EditToolId } from "../lib/edits";
import type { EditingState } from "../hooks/useEditing";
import "./LegalModeBar.css";

const TOOL_LABELS: Record<Exclude<EditToolId, "select">, string> = {
  highlight: "Highlight mode",
  textBox: "Text box mode",
  image: "Image mode",
  comment: "Comment mode",
  draw: "Draw mode",
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

function getToolHint(editing: EditingState): string {
  switch (editing.tool) {
    case "highlight":
      return "Drag over text to highlight. Click a pending highlight to remove it.";
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
    case "sign":
      return editing.armedSignature
        ? "Click the page to place the signature."
        : "Draw or pick a signature in the card, then click the page.";
    default:
      return "";
  }
}
