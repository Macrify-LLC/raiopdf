import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditingState } from "../hooks/useEditing";
import { exhibitLabelLines, formatExhibitIdentifier } from "../lib/exhibitLabels";
import {
  deleteExhibitStampTemplate,
  listExhibitStampTemplates,
  moveExhibitStampTemplate,
  resetCounter,
  saveExhibitStampTemplate,
  setNextIdentifier,
  type ExhibitStampTemplateV1,
} from "../lib/exhibitStamps";
import { confirmWithUser } from "../lib/nativeConfirm";
import { ExhibitStampDesigner } from "./ExhibitStampDesigner";
import { StampPreview } from "./StampPreview";
import "./ExhibitStampCard.css";

/** Screen pixels per PDF point in the gallery's previews. */
const GALLERY_PREVIEW_SCALE = 1;

export interface ExhibitStampCardProps {
  editing: EditingState;
}

/** Which flavor of the designer dialog is open, and (for edit) which
 *  template it's editing. `null` means the dialog is closed. */
type DesignerState =
  | { mode: "create" }
  | { mode: "edit"; template: ExhibitStampTemplateV1 }
  | null;

/**
 * The exhibit-stamp gallery: pick the sticker to place, see the number it will
 * use next, correct that number, or design a new sticker.
 *
 * Every card previews its NEXT label rather than a generic sample, because the
 * number is the thing a user needs to check before stamping a filing. Picking
 * a card only arms the tool — the counter moves when a stamp lands on a page.
 */
export function ExhibitStampCard({ editing }: ExhibitStampCardProps) {
  const [templates, setTemplates] = useState<readonly ExhibitStampTemplateV1[]>(
    listExhibitStampTemplates,
  );
  const [designer, setDesigner] = useState<DesignerState>(null);

  const reload = useCallback(() => {
    setTemplates(listExhibitStampTemplates());
    editing.refreshArmedExhibitStamp();
  }, [editing]);

  // A renumber moves the design's counter, so the "Next" fields have to be
  // re-read once its dialog closes — the gallery holds a snapshot of the
  // stored templates, not a live view of them.
  const renumberOpen = Boolean(editing.exhibitStampRenumberRequest);
  const renumberWasOpen = useRef(renumberOpen);
  useEffect(() => {
    if (renumberWasOpen.current && !renumberOpen) {
      reload();
    }

    renumberWasOpen.current = renumberOpen;
  }, [reload, renumberOpen]);

  const handleDuplicate = useCallback(
    (template: ExhibitStampTemplateV1) => {
      const now = Date.now();
      const duplicate: ExhibitStampTemplateV1 = {
        ...template,
        id: `stamp-${now}-${Math.random().toString(36).slice(2, 8)}`,
        name: `${template.name} copy`,
        // A duplicate is a new design, not a continuation of the original's
        // count -- it starts fresh the same way any newly created stamp does.
        nextIndex: 0,
        createdAt: now,
        updatedAt: now,
      };

      void saveExhibitStampTemplate(duplicate).then((result) => {
        if (!result.ok) {
          editing.setMessage(result.error);
          return;
        }

        editing.setMessage(null);
        reload();
      });
    },
    [editing, reload],
  );

  const handleMove = useCallback(
    (templateId: string, direction: "up" | "down") => {
      void moveExhibitStampTemplate(templateId, direction).then((result) => {
        if (!result.ok) {
          editing.setMessage(result.error);
          return;
        }

        reload();
      });
    },
    [editing, reload],
  );

  return (
    <div className="exhibit-stamp-card">
      <p className="exhibit-stamp-card__intro">
        Pick a stamp, then click the page. The number moves on after each one.
      </p>

      <ul className="exhibit-stamp-card__grid">
        {templates.map((template, index) => (
          <ExhibitStampTemplateCard
            // Keyed by the counter too, so an edited or reset number resyncs
            // the "Next" field instead of leaving the old text in it.
            // identifierStyle is part of the key: switching numbers↔letters
            // must remount the card so its draft "Next" text re-derives from
            // the new representation instead of showing the old one.
            key={`${template.id}:${template.nextIndex}:${template.identifierStyle}`}
            template={template}
            armed={editing.armedExhibitStamp?.templateId === template.id}
            canMoveUp={index > 0}
            canMoveDown={index < templates.length - 1}
            placedCount={editing.countPlacedExhibitStamps(template.id)}
            onArm={() => editing.armExhibitStamp(template.id)}
            onRenumber={() => editing.requestExhibitStampRenumber(template.id)}
            onCounterChanged={reload}
            onMessage={editing.setMessage}
            onEdit={() => setDesigner({ mode: "edit", template })}
            onDuplicate={() => handleDuplicate(template)}
            onMove={(direction) => handleMove(template.id, direction)}
            onDeleted={() => {
              if (editing.armedExhibitStamp?.templateId === template.id) {
                editing.disarmExhibitStamp();
              }

              reload();
            }}
          />
        ))}
      </ul>

      <button
        type="button"
        className="exhibit-stamp-card__new"
        onClick={() => setDesigner({ mode: "create" })}
      >
        New design...
      </button>

      <p className="exhibit-stamp-card__note">
        Your stamps and their numbering stay on this computer.
      </p>

      {designer ? (
        <ExhibitStampDesigner
          mode={designer.mode}
          template={designer.mode === "edit" ? designer.template : null}
          onCancel={() => setDesigner(null)}
          onMessage={editing.setMessage}
          onSaved={(templateId, isNew) => {
            setDesigner(null);
            reload();

            // Arm a freshly created design so the click that made it can be
            // followed straight by the click that places it. An edit doesn't
            // re-arm -- `reload()` above already refreshes the armed preview
            // if the edited template happened to be the one in hand, and
            // switching tools out from under an unrelated armed stamp would
            // be a surprise, not a convenience.
            if (isNew) {
              editing.armExhibitStamp(templateId);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ExhibitStampTemplateCard({
  template,
  armed,
  canMoveUp,
  canMoveDown,
  placedCount,
  onArm,
  onRenumber,
  onCounterChanged,
  onMessage,
  onEdit,
  onDuplicate,
  onMove,
  onDeleted,
}: {
  template: ExhibitStampTemplateV1;
  armed: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Stamps of this design placed in the open document. */
  placedCount: number;
  onArm: () => void;
  onRenumber: () => void;
  onCounterChanged: () => void;
  onMessage: (message: string | null) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onMove: (direction: "up" | "down") => void;
  onDeleted: () => void;
}) {
  const nextIdentifier = formatExhibitIdentifier(template.identifierStyle, template.nextIndex);
  const [draftIdentifier, setDraftIdentifier] = useState(nextIdentifier);
  const lines = useMemo(
    () =>
      exhibitLabelLines(
        template.prefix,
        template.identifierStyle,
        template.nextIndex,
        template.layout,
        template.suffix,
      ),
    [template],
  );

  function commitIdentifier() {
    if (draftIdentifier === nextIdentifier) {
      return;
    }

    void setNextIdentifier(template.id, draftIdentifier).then((result) => {
      if (!result.ok) {
        onMessage(result.error);
        setDraftIdentifier(nextIdentifier);
        return;
      }

      onMessage(null);
      onCounterChanged();
    });
  }

  return (
    <li className="exhibit-stamp-card__item">
      <button
        type="button"
        className="exhibit-stamp-card__pick"
        data-armed={armed ? "true" : undefined}
        aria-pressed={armed}
        aria-label={`Use ${template.name}, next ${nextIdentifier || "unnumbered"}`}
        onClick={onArm}
      >
        <span
          className="exhibit-stamp-card__preview"
          style={{
            width: `${template.widthPt * GALLERY_PREVIEW_SCALE}px`,
            height: `${template.heightPt * GALLERY_PREVIEW_SCALE}px`,
          }}
        >
          <StampPreview
            scale={GALLERY_PREVIEW_SCALE}
            stamp={{
              lines,
              widthPt: template.widthPt,
              heightPt: template.heightPt,
              fontSizePt: template.fontSizePt,
              fontFamily: template.fontFamily,
              bold: template.bold,
              italic: template.italic,
              color: template.textColor,
              fillColor: template.fillColor,
              borderColor: template.borderColor,
              borderWidthPt: template.borderWidthPt,
              cornerRadiusPt: template.cornerRadiusPt,
            }}
          />
        </span>
        <span className="exhibit-stamp-card__name">{template.name}</span>
      </button>

      <div className="exhibit-stamp-card__counter">
        <label className="exhibit-stamp-card__counter-field">
          <span>Next</span>
          <input
            type="text"
            aria-label={`Next exhibit for ${template.name}`}
            value={draftIdentifier}
            disabled={template.identifierStyle === "none"}
            onChange={(event) => setDraftIdentifier(event.currentTarget.value)}
            onBlur={commitIdentifier}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="exhibit-stamp-card__secondary"
          aria-label={`Start ${template.name} over at the first exhibit`}
          onClick={() => {
            void resetCounter(template.id).then((result) => {
              if (!result.ok) {
                onMessage(result.error);
                return;
              }

              setDraftIdentifier(formatExhibitIdentifier(template.identifierStyle, 0));
              onCounterChanged();
            });
          }}
        >
          Start over
        </button>
      </div>

      <div className="exhibit-stamp-card__actions">
        {/* Renumbering rewrites stickers already on the page, so it only shows
            up once there are some, and never renumbers an unnumbered design. */}
        <button
          type="button"
          className="exhibit-stamp-card__secondary"
          aria-label={`Renumber placed ${template.name} stamps`}
          disabled={placedCount === 0 || template.identifierStyle === "none"}
          title={placedCount === 0
            ? "Stamp a page first — this renumbers the stamps already placed."
            : `Renumber all ${placedCount} placed ${template.name} stamps in reading order.`}
          onClick={onRenumber}
        >
          Renumber placed stamps...
        </button>
        <button type="button" className="exhibit-stamp-card__secondary" onClick={onEdit}>
          Edit design...
        </button>
        <button type="button" className="exhibit-stamp-card__secondary" onClick={onDuplicate}>
          Duplicate
        </button>
        <button
          type="button"
          className="exhibit-stamp-card__secondary"
          aria-label={`Move ${template.name} up`}
          disabled={!canMoveUp}
          onClick={() => onMove("up")}
        >
          ▲
        </button>
        <button
          type="button"
          className="exhibit-stamp-card__secondary"
          aria-label={`Move ${template.name} down`}
          disabled={!canMoveDown}
          onClick={() => onMove("down")}
        >
          ▼
        </button>
        <button
          type="button"
          className="exhibit-stamp-card__secondary"
          aria-label={`Delete ${template.name}`}
          onClick={() => {
            void confirmWithUser(
              `Delete "${template.name}"? This can't be undone.`,
            ).then((confirmed) => {
              if (!confirmed) {
                return;
              }

              void deleteExhibitStampTemplate(template.id).then((result) => {
                if (!result.ok) {
                  onMessage(result.error);
                  return;
                }

                onDeleted();
              });
            });
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
