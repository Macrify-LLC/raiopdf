import { useState } from "react";
import type { PdfStampSequence } from "@raiopdf/engine-api";
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

  if (!request) {
    return null;
  }

  // The gallery template is looked up fresh every render rather than held
  // onto, because it can be deleted out from under an open confirmation —
  // `fallbackSequence` (captured from a live stamp when the request was
  // raised) carries everything needed to keep going when that happens.
  const template = findExhibitStampTemplate(request.templateId);

  return (
    <RenumberConfirmation
      // A second request for another design is a different question, so the
      // typed start is re-derived rather than carried over.
      key={request.templateId}
      editing={editing}
      templateId={request.templateId}
      template={template}
      fallbackSequence={request.fallbackSequence}
      openedCount={request.count}
      documentStreamed={documentStreamed}
    />
  );
}

function RenumberConfirmation({
  editing,
  templateId,
  template,
  fallbackSequence,
  openedCount,
  documentStreamed,
}: {
  editing: EditingState;
  templateId: string;
  template: ExhibitStampTemplateV1 | null;
  fallbackSequence: PdfStampSequence;
  openedCount: number;
  documentStreamed: boolean;
}) {
  // A deleted design still has everything a stamp needs printed on the stamp
  // itself — the fallback sequence stands in for the missing template so the
  // confirmation (and the renumber it drives) keeps working rather than going
  // silently dead.
  const identifierStyle = template?.identifierStyle ?? fallbackSequence.identifierStyle;
  const prefix = template?.prefix ?? fallbackSequence.prefix;
  const suffix = template?.suffix ?? fallbackSequence.suffix;
  const designName = template?.name ?? prefix;
  const [startText, setStartText] = useState(() =>
    formatExhibitIdentifier(identifierStyle, 0),
  );
  const [error, setError] = useState<string | null>(null);
  const [changedNotice, setChangedNotice] = useState<string | null>(null);
  const [renumbering, setRenumbering] = useState(false);
  // The count shown to the user, refreshed against the live page whenever it
  // no longer matches what a click confirms — the dialog stays open and
  // interactive underneath (no scrim), so what was true at open time may not
  // be true anymore.
  const [count, setCount] = useState(openedCount);
  const startIndex = parseIdentifier(startText);
  const labelAt = (index: number) => formatExhibitLabel(prefix, identifierStyle, index, suffix);
  const stampCount = `${count} ${count === 1 ? "stamp" : "stamps"}`;

  function handleRenumber() {
    if (startIndex === null) {
      setError("Enter a number (12) or a letter (AB) to start from.");
      return;
    }

    const liveCount = editing.countPlacedExhibitStamps(templateId);

    if (liveCount === 0) {
      editing.setMessage("Those stamps are no longer on the page.");
      editing.cancelExhibitStampRenumber();
      return;
    }

    // The set changed since it was last shown (the editor stays interactive
    // behind this dialog): show what's actually there now and make the user
    // confirm again, rather than renumbering a set they never saw.
    if (liveCount !== count) {
      setCount(liveCount);
      setError(null);
      setChangedNotice(`The stamps changed — now renumbering ${liveCount}. Confirm again.`);
      return;
    }

    if (startIndex + liveCount - 1 > MAX_EXHIBIT_INDEX) {
      setError("That start leaves more exhibits than this stamp can number.");
      return;
    }

    setError(null);
    setChangedNotice(null);
    setRenumbering(true);

    void editing.renumberExhibitStamps(templateId, startIndex).then((result) => {
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
          Every {designName} stamp in this document is renumbered top to bottom,
          page by page. This can&apos;t be undone.
        </p>

        {!template ? (
          <p className="exhibit-stamp-renumber__note">
            This design is no longer in your gallery; numbering continues from the
            stamps themselves.
          </p>
        ) : null}

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
              setChangedNotice(null);
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

        {changedNotice ? (
          <p className="exhibit-stamp-renumber__note" role="status">
            {changedNotice}
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
