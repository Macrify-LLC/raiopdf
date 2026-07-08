import type { TextEditState } from "../hooks/useTextEdit";
import {
  TEXT_EDIT_ADVISORY,
  TEXT_EDIT_MULTI_WORD_CAUTION,
} from "../lib/textEdit";
import { HelpIcon } from "../icons";
import { IconButton } from "./IconButton";
import { InlineMessage } from "./ToolPanel";

export function EditTextStatusPanel({
  textEdit,
  onHelp,
}: {
  textEdit: TextEditState;
  onHelp: () => void;
}) {
  if (textEdit.gate.blocked && textEdit.gate.message) {
    return <InlineMessage tone="neutral" message={textEdit.gate.message} />;
  }

  return (
    <div className="tool-panel__inline-card">
      <div className="tool-panel__card-header">
        <p className="tool-panel__card-title">Edit document text</p>
        <IconButton icon={<HelpIcon size={14} />} label="Help: Edit document text" onClick={onHelp} />
      </div>
      <p className="tool-panel__card-copy">{TEXT_EDIT_ADVISORY}</p>
      <p className="tool-panel__note">Preview match counts are estimates; the review re-reads your document and shows the exact results.</p>
      {textEdit.selectedReplacementText ? (
        <p className="tool-panel__status-line" role="status">
          Selected for replacement: {textEdit.selectedReplacementText}
        </p>
      ) : null}
      {textEdit.positionalSpaceRisk ? (
        <p className="tool-panel__field-error" role="status">{TEXT_EDIT_MULTI_WORD_CAUTION}</p>
      ) : null}
      {textEdit.gate.notes.map((note) => (
        <p key={note} className="tool-panel__note">{note}</p>
      ))}
      {textEdit.pendingOps.length > 0 ? (
        <>
          <p className="tool-panel__card-title">
            {textEdit.pendingOps.some((operation) => operation.target)
              ? "Selected replacement queued"
              : `${textEdit.pendingOps.length} queued ${textEdit.pendingOps.length === 1 ? "replacement" : "replacements"}`}
          </p>
          <div className="tool-panel__pending-list" role="list" aria-label="Queued text replacements">
            {textEdit.pendingOps.map((operation) => (
              <div key={operation.id} className="tool-panel__pending-row" role="listitem">
                <span className="tool-panel__pending-text">
                  {operation.target ? (
                    <span className="tool-panel__pending-detail">Page {operation.target.pageIndex + 1}</span>
                  ) : null}
                  <span className="tool-panel__pending-label">
                    {operation.find} &rarr; {operation.replace || "(delete)"}
                  </span>
                </span>
                <button
                  type="button"
                  className="tool-panel__pending-remove"
                  aria-label={`Remove queued replacement: ${operation.find} to ${operation.replace || "delete"}`}
                  onClick={() => textEdit.removePendingOp(operation.id)}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="tool-panel__note">Use the canvas bar to queue selected or bulk replacements.</p>
      )}
      {textEdit.message ? (
        <p
          className={textEdit.phase === "error" ? "tool-panel__field-error" : "tool-panel__status-line"}
          role="status"
        >
          {textEdit.message}
        </p>
      ) : null}
      <div className="tool-panel__button-row">
        <button
          type="button"
          className="tool-panel__primary-button"
          disabled={textEdit.pendingOps.length === 0 || textEdit.phase === "staging" || textEdit.phase === "applying"}
          onClick={() => {
            void textEdit.review();
          }}
        >
          Review
        </button>
        <button
          type="button"
          className="tool-panel__secondary-button"
          disabled={textEdit.phase === "staging" || textEdit.phase === "applying"}
          onClick={textEdit.clear}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
