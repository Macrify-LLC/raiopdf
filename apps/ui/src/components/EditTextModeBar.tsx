import type { FormEvent, KeyboardEvent } from "react";
import type { TextEditState } from "../hooks/useTextEdit";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "../icons";
import { Switch } from "./Switch";
import "./LegalModeBar.css";

const WHOLE_WORD_LABEL_ID = "edit-text-mode-bar-whole-word-label";

export function EditTextModeBar({
  textEdit,
  onExit,
}: {
  textEdit: TextEditState;
  onExit: () => void;
}) {
  const busy = textEdit.phase === "staging" || textEdit.phase === "applying" || textEdit.selectionResolving;
  const hasSelectedOperation = textEdit.pendingOps.some((operation) => operation.target);
  const canQueue = Boolean(textEdit.find.trim()) && !busy && !textEdit.gate.blocked && !hasSelectedOperation;
  const canQueueSelection = !busy && !textEdit.gate.blocked && textEdit.pendingOps.length === 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    textEdit.queueReplaceAll();
  }

  function handleFindKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        textEdit.goToPrevious();
      } else {
        textEdit.goToNext();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onExit();
    }
  }

  return (
    <form
      className="legal-mode-bar edit-text-mode-bar"
      role="toolbar"
      aria-label="Edit document text"
      onSubmit={submit}
    >
      {/* Find + Replace read as one connected control (shared border, a
          hairline divider between the two fields) rather than two
          unrelated search boxes -- the pairing that makes this read as
          "find/replace," not "two random inputs." */}
      <div className="edit-text-mode-bar__fields">
        <label className="edit-text-mode-bar__field">
          <SearchIcon size={13} />
          <input
            type="search"
            placeholder="Find exact text"
            aria-label="Find text"
            value={textEdit.find}
            disabled={busy}
            onChange={(event) => textEdit.setFind(event.currentTarget.value)}
            onKeyDown={handleFindKeyDown}
          />
        </label>
        <label className="edit-text-mode-bar__field">
          <input
            type="text"
            placeholder="Replace with"
            aria-label="Replace with"
            value={textEdit.replace}
            disabled={busy}
            onFocus={textEdit.captureSelectedText}
            onPointerDown={textEdit.captureSelectedText}
            onChange={(event) => textEdit.setReplace(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="edit-text-mode-bar__whole-word">
        <Switch
          checked={textEdit.wholeWord}
          disabled={busy}
          onChange={textEdit.setWholeWord}
          aria-labelledby={WHOLE_WORD_LABEL_ID}
        />
        <span id={WHOLE_WORD_LABEL_ID} className="legal-mode-bar__hint">
          Whole word
        </span>
      </div>
      <span className="edit-text-mode-bar__match-chip" aria-live="polite">
        {textEdit.selectedReplacementText
          ? "Selection captured"
          : textEdit.matchLabel || `${textEdit.pendingOps.length} queued`}
      </span>
      {/* Previous/next grouped as one stepper so a narrow window wraps them
          together instead of splitting the pair across two lines in the
          wrong order. */}
      <div className="edit-text-mode-bar__nav">
        <button
          type="button"
          className="legal-mode-bar__button"
          aria-label="Previous edit-text match"
          disabled={busy || textEdit.matches.length === 0}
          onClick={textEdit.goToPrevious}
        >
          <ChevronLeftIcon size={13} />
        </button>
        <button
          type="button"
          className="legal-mode-bar__button"
          aria-label="Next edit-text match"
          disabled={busy || textEdit.matches.length === 0}
          onClick={textEdit.goToNext}
        >
          <ChevronRightIcon size={13} />
        </button>
      </div>
      <div className="edit-text-mode-bar__actions">
        <button
          type="button"
          className="legal-mode-bar__button"
          disabled={!canQueueSelection}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            void textEdit.queueSelectedReplacement();
          }}
        >
          Replace selection
        </button>
        <button type="submit" className="legal-mode-bar__danger-button" disabled={!canQueue}>
          Replace all
        </button>
        <button type="button" className="legal-mode-bar__button" onClick={onExit}>
          Exit
        </button>
      </div>
    </form>
  );
}
