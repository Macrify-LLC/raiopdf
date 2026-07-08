import type { TextEditState, TextEditStagedResult } from "../hooks/useTextEdit";
import {
  TEXT_EDIT_WHOLE_DOCUMENT_DISCLOSURE,
  TEXT_EDIT_ZERO_CHANGE_MESSAGE,
  canApplyTextEditReview,
  formatReplaceTextResult,
  warningCopy,
  type TextEditOperationReport,
} from "../lib/textEdit";
import { FloatingDialog } from "./FloatingDialog";
import { LongProcessLoader } from "./LongProcessLoader";
import "./EditTextReviewDialog.css";

export function EditTextReviewDialog({
  textEdit,
}: {
  textEdit: TextEditState;
}) {
  if (textEdit.phase === "staging") {
    return (
      <FloatingDialog
        title="Review text replacements"
        eyebrow="Find & Replace"
        width="lg"
        onClose={textEdit.cancelReview}
      >
        <LongProcessLoader
          phaseLabel="Staging replacement"
          message="Preparing a preview of your changes."
          detail="There is no progress feed for this operation; image-heavy documents can take a few minutes."
        />
      </FloatingDialog>
    );
  }

  if (textEdit.phase === "applying") {
    return (
      <FloatingDialog
        title="Review text replacements"
        eyebrow="Find & Replace"
        width="lg"
        onClose={textEdit.cancelReview}
      >
        <LongProcessLoader
          phaseLabel="Applying replacement"
          message="Opening the edited PDF as a Save As copy."
          detail="The original file path is cleared so Save will prompt for a destination."
        />
      </FloatingDialog>
    );
  }

  if (textEdit.phase !== "review" || !textEdit.staged) {
    return null;
  }

  return (
    <FloatingDialog
      title="Review text replacements"
      eyebrow="Find & Replace"
      width="lg"
      onClose={textEdit.cancelReview}
    >
      <ReviewBody staged={textEdit.staged} onApply={textEdit.apply} onCancel={textEdit.cancelReview} />
    </FloatingDialog>
  );
}

function ReviewBody({
  staged,
  onApply,
  onCancel,
}: {
  staged: TextEditStagedResult;
  onApply: () => void;
  onCancel: () => void;
}) {
  const report = staged.report;
  const canApply = canApplyTextEditReview(report);
  const warnings = [...new Set(staged.warnings.map(warningCopy))];
  const changedPages = report.changedPageIndexes.slice(0, 6);
  const findTerms = report.operations.map((operation) => operation.find).filter((term) => term.trim().length > 0);
  const replaceTerms = report.operations
    .map((operation) => operation.replace)
    .filter((term) => term.trim().length > 0);

  return (
    <div className="edit-text-review">
      <p className="edit-text-review__disclosure">{TEXT_EDIT_WHOLE_DOCUMENT_DISCLOSURE}</p>
      {report.zeroChange ? (
        <p className="tool-panel__field-error" role="status">{TEXT_EDIT_ZERO_CHANGE_MESSAGE}</p>
      ) : (
        <p className="edit-text-review__summary" role="status">{formatReplaceTextResult(report)}</p>
      )}
      {report.advisory ? <p className="edit-text-review__advisory">{report.advisory}</p> : null}
      {warnings.length > 0 ? (
        <div className="edit-text-review__warnings">
          <p className="edit-text-review__warnings-label">Warnings</p>
          <ul aria-label="Replacement warnings">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="edit-text-review__operations" role="list" aria-label="Replacement report">
        {report.operations.map((operation) => (
          <div key={operation.operationId} className="edit-text-review__operation" role="listitem">
            <div className="edit-text-review__operation-terms">
              <span className="edit-text-review__operation-find">{operation.find || "(empty)"}</span>
              <span className="edit-text-review__operation-arrow" aria-hidden="true">&rarr;</span>
              <span className="edit-text-review__operation-replace">{operation.replace || "(delete)"}</span>
            </div>
            <p
              className="edit-text-review__operation-detail"
              data-tone={operation.status === "not-found" ? "not-found" : undefined}
            >
              {operationStatusCopy(operation)}
            </p>
          </div>
        ))}
      </div>
      {changedPages.length > 0 ? (
        <div className="edit-text-review__pages" aria-label="Before and after page previews">
          {changedPages.map((pageIndex) => (
            <div key={pageIndex} className="edit-text-review__page">
              <p className="edit-text-review__page-title">Page {pageIndex + 1}</p>
              <div className="edit-text-review__page-grid">
                <PagePreview
                  variant="before"
                  text={pageText(staged.originalPages, pageIndex)}
                  needles={findTerms}
                />
                <PagePreview
                  variant="after"
                  text={pageText(staged.candidatePages, pageIndex)}
                  needles={replaceTerms}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="edit-text-review__actions">
        <button type="button" className="tool-panel__danger-button" disabled={!canApply} onClick={onApply}>
          Apply
        </button>
        <button type="button" className="tool-panel__secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A text-diff preview, not an image thumbnail -- this layer only has
 * extracted page TEXT for the original and candidate PDFs (see
 * `TextEditStagedResult`), never the original document's bytes, so an
 * honest text excerpt is the most this component can show without a
 * hook/data-flow change (flagged separately, not made here). The matched
 * find/replace term is highlighted with the app's own highlight-tool color
 * so the diff reads at a glance instead of as a wall of text.
 */
function PagePreview({
  variant,
  text,
  needles,
}: {
  variant: "before" | "after";
  text: string;
  needles: readonly string[];
}) {
  return (
    <div className="edit-text-review__snippet" data-variant={variant}>
      <p className="edit-text-review__snippet-label">{variant === "before" ? "Before" : "After"}</p>
      <p className="edit-text-review__snippet-text">
        {text ? <HighlightedExcerpt text={text} needles={needles} /> : "No extractable text."}
      </p>
    </div>
  );
}

function HighlightedExcerpt({ text, needles }: { text: string; needles: readonly string[] }) {
  const segments = highlightSegments(text, needles);

  return (
    <>
      {segments.map((segment, index) =>
        segment.marked ? (
          <mark key={index} className="edit-text-review__mark">{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function highlightSegments(
  text: string,
  needles: readonly string[],
): Array<{ text: string; marked: boolean }> {
  const cleaned = [...new Set(needles.map((needle) => needle.trim()).filter(Boolean))];
  if (cleaned.length === 0 || !text) {
    return [{ text, marked: false }];
  }

  const pattern = new RegExp(`(${cleaned.map(escapeForRegExp).join("|")})`, "g");
  return text
    .split(pattern)
    .filter((segment) => segment.length > 0)
    .map((segment) => ({ text: segment, marked: cleaned.includes(segment) }));
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function operationStatusCopy(operation: TextEditOperationReport): string {
  if (operation.selected) {
    if (operation.status === "changed") {
      return `1 selected replacement staged on page ${formatPages(operation.foundBefore)}.`;
    }

    return `Selected text was found on page ${formatPages(operation.foundBefore)}, but the staged PDF text did not change.`;
  }

  if (operation.status === "not-found") {
    return "Not found in the staged review.";
  }

  if (operation.status === "unchanged") {
    return `Found on pages ${formatPages(operation.foundBefore)}, but nothing changed there.`;
  }

  return `${operation.replacedEstimate} estimated ${operation.replacedEstimate === 1 ? "replacement" : "replacements"}; pages ${formatPages(operation.foundBefore)}.`;
}

function pageText(pages: readonly { pageIndex: number; text: string }[], pageIndex: number): string {
  return pages.find((page) => page.pageIndex === pageIndex)?.text.slice(0, 260).replace(/\s+/g, " ") ?? "";
}

function formatPages(pageIndexes: readonly number[]): string {
  if (pageIndexes.length === 0) {
    return "none";
  }
  return pageIndexes.map((pageIndex) => pageIndex + 1).join(", ");
}
