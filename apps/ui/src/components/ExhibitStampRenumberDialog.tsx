import { useState } from "react";
import type { EditingState } from "../hooks/useEditing";
import {
  formatExhibitIdentifier,
  formatExhibitLabel,
  MAX_EXHIBIT_INDEX,
  parseIdentifier,
} from "../lib/exhibitLabels";
import { findExhibitStampTemplate, type ExhibitStampTemplateV1 } from "../lib/exhibitStamps";
import { FloatingDialog } from "./FloatingDialog";
// Reuses the gallery's button primitives so the confirmation reads as part of
// the same tool rather than a second button language.
import "./ExhibitStampCard.css";
import "./ExhibitStampRenumberDialog.css";

export interface ExhibitStampRenumberDialogProps {
  editing: EditingState;
  /**
   * True for a streamed (very large) document, where stamps already saved in
   * the file aren't loaded as editable objects — so a renumber can only reach
   * the ones placed in this session. Said out loud rather than silently
   * renumbering a subset.
   */
  documentStreamed?: boolean | undefined;
}

/**
 * Confirms renumbering every placed stamp of one design before it happens.
 *
 * Renumbering is the one stamp action that rewrites work already on the page,
 * so it asks first and shows the exact range it will produce. The starting
 * identifier is editable because a set often doesn't begin at 1 — continuing
 * someone else's numbering, or a second volume of exhibits.
 */
export function ExhibitStampRenumberDialog({
  editing,
  documentStreamed = false,
}: ExhibitStampRenumberDialogProps) {
  const request = editing.exhibitStampRenumberRequest;
  const template = request ? findExhibitStampTemplate(request.templateId) : null;

  if (!request || !template) {
    return null;
  }

  return (
    <RenumberConfirmation
      // A second request for another design is a different question, so the
      // typed start is re-derived rather than carried over.
      key={template.id}
      editing={editing}
      template={template}
      count={request.count}
      documentStreamed={documentStreamed}
    />
  );
}

function RenumberConfirmation({
  editing,
  template,
  count,
  documentStreamed,
}: {
  editing: EditingState;
  template: ExhibitStampTemplateV1;
  count: number;
  documentStreamed: boolean;
}) {
  const identifierStyle = template.identifierStyle;
  const [startText, setStartText] = useState(() =>
    formatExhibitIdentifier(identifierStyle, 0),
  );
  const [error, setError] = useState<string | null>(null);
  const [renumbering, setRenumbering] = useState(false);
  const startIndex = parseIdentifier(startText);
  const labelAt = (index: number) =>
    formatExhibitLabel(template.prefix, identifierStyle, index, template.suffix);
  const stampCount = `${count} ${count === 1 ? "stamp" : "stamps"}`;

  function handleRenumber() {
    if (startIndex === null) {
      setError("Enter a number (12) or a letter (AB) to start from.");
      return;
    }

    if (startIndex + count - 1 > MAX_EXHIBIT_INDEX) {
      setError("That start leaves more exhibits than this stamp can number.");
      return;
    }

    setError(null);
    setRenumbering(true);

    void editing.renumberExhibitStamps(template.id, startIndex).then((result) => {
      setRenumbering(false);

      if (!result) {
        editing.setMessage("Those stamps are no longer on the page.");
        editing.cancelExhibitStampRenumber();
        return;
      }

      const renumbered = `Renumbered ${result.count} ${
        result.count === 1 ? "stamp" : "stamps"
      } from ${labelAt(startIndex)}.`;

      // A counter that could not be written is worth saying out loud — the
      // stamps on the page are right, but the next placement may not continue
      // from where this set ended.
      editing.setMessage(
        result.counterError ? `${renumbered} ${result.counterError}` : renumbered,
      );
      editing.cancelExhibitStampRenumber();
    });
  }

  return (
    <FloatingDialog
      title="Renumber exhibit stamps"
      eyebrow="Edit"
      width="sm"
      onClose={editing.cancelExhibitStampRenumber}
    >
      <div className="exhibit-stamp-renumber">
        <p className="exhibit-stamp-renumber__question">
          {startIndex === null
            ? `Renumber ${stampCount}?`
            : `Renumber ${stampCount} as ${labelAt(startIndex)}${
              count > 1 ? `…${labelAt(startIndex + count - 1)}` : ""
            }?`}
        </p>
        <p className="exhibit-stamp-renumber__note">
          Every {template.name} stamp in this document is renumbered top to bottom,
          page by page. This can&apos;t be undone.
        </p>

        <label className="exhibit-stamp-card__counter-field">
          <span>Start at</span>
          <input
            type="text"
            aria-label="Start renumbering at"
            value={startText}
            autoFocus
            disabled={renumbering || identifierStyle === "none"}
            onChange={(event) => {
              setStartText(event.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleRenumber();
              }
            }}
          />
        </label>

        {documentStreamed ? (
          <p className="exhibit-stamp-renumber__note">
            Stamps saved in this large document can&apos;t be renumbered yet — only the
            ones you placed since opening it.
          </p>
        ) : null}

        {error ? (
          <p className="exhibit-stamp-renumber__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="exhibit-stamp-card__actions">
          <button
            type="button"
            className="exhibit-stamp-card__primary"
            disabled={renumbering}
            onClick={handleRenumber}
          >
            {renumbering ? "Renumbering..." : "Renumber"}
          </button>
          <button
            type="button"
            className="exhibit-stamp-card__secondary"
            disabled={renumbering}
            onClick={editing.cancelExhibitStampRenumber}
          >
            Cancel
          </button>
        </div>
      </div>
    </FloatingDialog>
  );
}
