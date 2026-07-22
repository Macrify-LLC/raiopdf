import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
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
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Focus the Replace-with field on every stored capture — keyed on the
  // monotonic prime count (not the text) so capturing identical text twice,
  // e.g. two right-click "Replace text..." invocations, still refocuses.
  useEffect(() => {
    if (textEdit.selectionPrimeCount > 0 && textEdit.selectedReplacementText) {
      replaceInputRef.current?.focus();
    }
  }, [textEdit.selectionPrimeCount, textEdit.selectedReplacementText]);

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

  if (textEdit.isSelectedReplacementMode) {
    const canReviewSelection = Boolean(textEdit.selectedReplacementText) && canQueueSelection;

    return (
      <form
        className="legal-mode-bar edit-text-mode-bar edit-text-mode-bar--selection"
        role="toolbar"
        aria-label="Replace selected text"
        onSubmit={(event) => {
          event.preventDefault();
          if (canReviewSelection) {
            void textEdit.queueSelectedReplacement();
          }
        }}
      >
        <p className="edit-text-mode-bar__selected-label" aria-live="polite">
          Selected text: <span>{textEdit.selectedReplacementText || "Resolving selection…"}</span>
        </p>
        <label className="edit-text-mode-bar__field edit-text-mode-bar__selection-field">
          <input
            ref={replaceInputRef}
            type="text"
            placeholder="Replace with"
            aria-label="Replace selected text with"
            value={textEdit.replace}
            disabled={busy}
            onPointerDown={textEdit.captureSelectedText}
            onChange={(event) => textEdit.setReplace(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onExit();
              }
            }}
          />
        </label>
        <div className="edit-text-mode-bar__actions">
          <button type="submit" className="legal-mode-bar__danger-button" disabled={!canReviewSelection}>
            Review replacement
          </button>
          <button type="button" className="legal-mode-bar__button" onClick={onExit}>
            Exit
          </button>
        </div>
      </form>
    );
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
            ref={replaceInputRef}
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
        {textEdit.matchLabel || `${textEdit.pendingOps.length} queued`}
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
