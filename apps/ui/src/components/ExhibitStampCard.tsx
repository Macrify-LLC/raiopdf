import { useCallback, useMemo, useState } from "react";
import type { PdfEditColor } from "@raiopdf/engine-api";
import type { EditingState } from "../hooks/useEditing";
import {
  DEFAULT_TEXT_COLOR,
  INK_TEXT_COLOR_OPTIONS,
  SHAPE_FILL_COLOR_OPTIONS,
  pdfEditColorToHex,
} from "../lib/editStyles";
import {
  exhibitLabelLines,
  formatExhibitIdentifier,
  type ExhibitIdentifierStyle,
} from "../lib/exhibitLabels";
import {
  DEFAULT_STAMP_BORDER_WIDTH_PT,
  DEFAULT_STAMP_CORNER_RADIUS_PT,
  DEFAULT_STAMP_FONT_SIZE_PT,
  DEFAULT_STAMP_HEIGHT_PT,
  DEFAULT_STAMP_WIDTH_PT,
  deleteExhibitStampTemplate,
  listExhibitStampTemplates,
  resetCounter,
  saveExhibitStampTemplate,
  setNextIdentifier,
  type ExhibitStampTemplateV1,
} from "../lib/exhibitStamps";
import { StampPreview } from "./StampPreview";
import "./ExhibitStampCard.css";

/** Screen pixels per PDF point in the gallery's previews. */
const GALLERY_PREVIEW_SCALE = 1;

export interface ExhibitStampCardProps {
  editing: EditingState;
}

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
  const [designOpen, setDesignOpen] = useState(false);

  const reload = useCallback(() => {
    setTemplates(listExhibitStampTemplates());
    editing.refreshArmedExhibitStamp();
  }, [editing]);

  return (
    <div className="exhibit-stamp-card">
      <p className="exhibit-stamp-card__intro">
        Pick a stamp, then click the page. The number moves on after each one.
      </p>

      <ul className="exhibit-stamp-card__grid">
        {templates.map((template) => (
          <ExhibitStampTemplateCard
            // Keyed by the counter too, so an edited or reset number resyncs
            // the "Next" field instead of leaving the old text in it.
            key={`${template.id}:${template.nextIndex}`}
            template={template}
            armed={editing.armedExhibitStamp?.templateId === template.id}
            onArm={() => editing.armExhibitStamp(template.id)}
            onCounterChanged={reload}
            onMessage={editing.setMessage}
            onDeleted={() => {
              if (editing.armedExhibitStamp?.templateId === template.id) {
                editing.disarmExhibitStamp();
              }

              reload();
            }}
          />
        ))}
      </ul>

      {designOpen ? (
        <NewStampDesign
          onCancel={() => setDesignOpen(false)}
          onMessage={editing.setMessage}
          onCreated={(templateId) => {
            setDesignOpen(false);
            setTemplates(listExhibitStampTemplates());
            editing.armExhibitStamp(templateId);
          }}
        />
      ) : (
        <button
          type="button"
          className="exhibit-stamp-card__new"
          onClick={() => setDesignOpen(true)}
        >
          New design...
        </button>
      )}

      <p className="exhibit-stamp-card__note">
        Your stamps and their numbering stay on this computer.
      </p>
    </div>
  );
}

function ExhibitStampTemplateCard({
  template,
  armed,
  onArm,
  onCounterChanged,
  onMessage,
  onDeleted,
}: {
  template: ExhibitStampTemplateV1;
  armed: boolean;
  onArm: () => void;
  onCounterChanged: () => void;
  onMessage: (message: string | null) => void;
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
        <button
          type="button"
          className="exhibit-stamp-card__secondary"
          aria-label={`Delete ${template.name}`}
          onClick={() => {
            void deleteExhibitStampTemplate(template.id).then((result) => {
              if (!result.ok) {
                onMessage(result.error);
                return;
              }

              onDeleted();
            });
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/**
 * The deliberately small "new design" form: a name, how it numbers, and two
 * colors. Sizes, fonts, and per-corner styling are left to the full designer;
 * a starter stamp that reads right is worth more here than every knob.
 */
function NewStampDesign({
  onCancel,
  onCreated,
  onMessage,
}: {
  onCancel: () => void;
  onCreated: (templateId: string) => void;
  onMessage: (message: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [identifierStyle, setIdentifierStyle] = useState<ExhibitIdentifierStyle>("numbers");
  const [textColor, setTextColor] = useState<PdfEditColor>(DEFAULT_TEXT_COLOR);
  const [fillColor, setFillColor] = useState<PdfEditColor | null>({ r: 1, g: 1, b: 1 });
  const trimmedName = name.trim();
  const resolvedPrefix = prefix.trim() || trimmedName;

  function create() {
    if (!trimmedName) {
      onMessage("Give the stamp a name first.");
      return;
    }

    const now = Date.now();
    const template: ExhibitStampTemplateV1 = {
      version: 1,
      id: `stamp-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      prefix: resolvedPrefix,
      identifierStyle,
      nextIndex: 0,
      layout: "stacked",
      widthPt: DEFAULT_STAMP_WIDTH_PT,
      heightPt: DEFAULT_STAMP_HEIGHT_PT,
      fontFamily: "helvetica",
      bold: true,
      italic: false,
      fontSizePt: DEFAULT_STAMP_FONT_SIZE_PT,
      textColor,
      fillColor,
      // The border tracks the ink so a one-color pick still reads as one
      // design; picking them apart is the full designer's job.
      borderColor: textColor,
      borderWidthPt: DEFAULT_STAMP_BORDER_WIDTH_PT,
      cornerRadiusPt: DEFAULT_STAMP_CORNER_RADIUS_PT,
      createdAt: now,
      updatedAt: now,
    };

    void saveExhibitStampTemplate(template).then((result) => {
      if (!result.ok) {
        onMessage(result.error);
        return;
      }

      onMessage(null);
      onCreated(result.value.id);
    });
  }

  return (
    <div className="exhibit-stamp-card__design">
      <p className="exhibit-stamp-card__design-title">New stamp</p>
      <label className="exhibit-stamp-card__field">
        <span>Name</span>
        <input
          type="text"
          aria-label="Stamp name"
          placeholder="Defendant's Exhibit"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="exhibit-stamp-card__field">
        <span>Wording</span>
        <input
          type="text"
          aria-label="Stamp wording"
          placeholder={trimmedName || "Text before the number"}
          value={prefix}
          onChange={(event) => setPrefix(event.currentTarget.value)}
        />
      </label>
      <label className="exhibit-stamp-card__field">
        <span>Numbering</span>
        <select
          aria-label="Stamp numbering"
          value={identifierStyle}
          onChange={(event) =>
            setIdentifierStyle(event.currentTarget.value as ExhibitIdentifierStyle)
          }
        >
          <option value="numbers">1, 2, 3</option>
          <option value="letters">A, B, C</option>
          <option value="none">No number</option>
        </select>
      </label>
      <ColorRow
        label="Ink"
        options={INK_TEXT_COLOR_OPTIONS}
        selected={textColor}
        onSelect={setTextColor}
      />
      <ColorRow
        label="Background"
        options={[{ id: "white", label: "White", color: { r: 1, g: 1, b: 1 } }, ...SHAPE_FILL_COLOR_OPTIONS]}
        selected={fillColor}
        onSelect={setFillColor}
        onNone={() => setFillColor(null)}
      />
      <div className="exhibit-stamp-card__design-actions">
        <button type="button" className="exhibit-stamp-card__secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="exhibit-stamp-card__primary"
          disabled={!trimmedName}
          onClick={create}
        >
          Create Stamp
        </button>
      </div>
    </div>
  );
}

function ColorRow({
  label,
  options,
  selected,
  onSelect,
  onNone,
}: {
  label: string;
  options: readonly { id: string; label: string; color: PdfEditColor }[];
  selected: PdfEditColor | null;
  onSelect: (color: PdfEditColor) => void;
  onNone?: (() => void) | undefined;
}) {
  const selectedHex = selected ? pdfEditColorToHex(selected) : null;

  return (
    <div className="exhibit-stamp-card__field">
      <span>{label}</span>
      <span className="exhibit-stamp-card__swatches">
        {onNone ? (
          <button
            type="button"
            className="exhibit-stamp-card__secondary"
            aria-label={`${label}: none`}
            aria-pressed={selected === null}
            onClick={onNone}
          >
            None
          </button>
        ) : null}
        {options.map((option) => {
          const hex = pdfEditColorToHex(option.color);

          return (
            <button
              key={option.id}
              type="button"
              className="exhibit-stamp-card__swatch"
              style={{ background: hex }}
              aria-label={`${label}: ${option.label}`}
              aria-pressed={hex === selectedHex}
              title={option.label}
              onClick={() => onSelect(option.color)}
            />
          );
        })}
      </span>
    </div>
  );
}
