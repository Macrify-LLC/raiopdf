import { useEffect, useMemo, useState } from "react";
import type { PdfEditColor, PdfTextBoxFontFamily } from "@raiopdf/engine-api";
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_FAMILY,
  INK_TEXT_COLOR_OPTIONS,
  SHAPE_FILL_COLOR_OPTIONS,
  pdfEditColorToHex,
  type EditColorOption,
} from "../lib/editStyles";
import {
  exhibitLabelLines,
  formatExhibitIdentifier,
  type ExhibitIdentifierStyle,
  type ExhibitLabelLayout,
} from "../lib/exhibitLabels";
import {
  DEFAULT_STAMP_BORDER_WIDTH_PT,
  DEFAULT_STAMP_CORNER_RADIUS_PT,
  DEFAULT_STAMP_FONT_SIZE_PT,
  DEFAULT_STAMP_HEIGHT_PT,
  DEFAULT_STAMP_WIDTH_PT,
  saveExhibitStampTemplate,
  type ExhibitStampTemplateV1,
} from "../lib/exhibitStamps";
import { MIN_STAMP_FONT_SIZE_PT } from "../lib/stampPreview";
import { FloatingDialog } from "./FloatingDialog";
import { StampPreview } from "./StampPreview";
// Reuses the gallery's button/swatch primitives (`__secondary`, `__primary`,
// `__swatches`, `__swatch`) so the designer's chrome matches the card it
// opens from instead of inventing a second button language.
import "./ExhibitStampCard.css";
import "./ExhibitStampDesigner.css";

/** PDF points are always 1/72in; every size knob is authored in points but
 *  shown to the user in inches, since "0.5 to 4 inches" reads far better than
 *  "36 to 288 points" on a sticker nobody measures with a ruler. */
const PT_PER_INCH = 72;
const MIN_STAMP_DIMENSION_IN = 0.5;
const MAX_STAMP_DIMENSION_IN = 4;
const MIN_STAMP_FONT_SIZE_PT_UI = MIN_STAMP_FONT_SIZE_PT;
const MAX_STAMP_FONT_SIZE_PT = 96;
const MAX_STAMP_BORDER_WIDTH_PT = 12;
/** Deliberate copy of `STAMP_MAX_BORDER_WIDTH_FRACTION` in engine-local and
 *  in `lib/stampPreview.ts` -- see those files for why this stays a literal
 *  copy instead of an import. */
const STAMP_MAX_BORDER_WIDTH_FRACTION = 0.25;
/** Screen pixels per PDF point in the designer's live preview -- bigger than
 *  the gallery's 1:1 so fine detail (border, rounding) reads clearly. */
const DESIGNER_PREVIEW_SCALE = 2;
/**
 * Widest the preview may render, in screen pixels. Wide/custom designs shrink
 * by ONE uniform factor (never a width-only CSS squeeze) so the preview keeps
 * the saved design's true proportions — font, border, and radius scale with it.
 */
const DESIGNER_PREVIEW_MAX_WIDTH_PX = 240;

function designerPreviewScale(widthPt: number): number {
  if (widthPt <= 0) {
    return DESIGNER_PREVIEW_SCALE;
  }

  return Math.min(DESIGNER_PREVIEW_SCALE, DESIGNER_PREVIEW_MAX_WIDTH_PX / widthPt);
}

interface StampSizePreset {
  id: string;
  label: string;
  widthPt: number;
  heightPt: number;
}

/** Matches the tool's original starter size, plus two common alternates. */
const STAMP_SIZE_PRESETS: readonly StampSizePreset[] = [
  {
    id: "classic",
    label: "Classic sticker",
    widthPt: DEFAULT_STAMP_WIDTH_PT,
    heightPt: DEFAULT_STAMP_HEIGHT_PT,
  },
  { id: "compact", label: "Compact", widthPt: 1.2 * PT_PER_INCH, heightPt: 0.75 * PT_PER_INCH },
  { id: "wide", label: "Wide", widthPt: 2 * PT_PER_INCH, heightPt: 1 * PT_PER_INCH },
];

export interface ExhibitStampDesignerProps {
  /** `edit` pre-fills every knob from `template` and preserves its identity
   *  (id, counter, created date) on save; `create` starts from scratch. */
  mode: "create" | "edit";
  /** Required when `mode` is `"edit"`. */
  template: ExhibitStampTemplateV1 | null;
  onCancel: () => void;
  onMessage: (message: string | null) => void;
  /** `isNew` tells the caller whether it's safe to arm the saved template --
   *  a fresh design is worth arming immediately, but resaving an edit
   *  shouldn't yank the tool away from whatever was already armed. */
  onSaved: (templateId: string, isNew: boolean) => void;
}

/**
 * The full stamp designer: every knob the template store supports, with a
 * live preview through the same `StampPreview` the gallery and the placed
 * overlay use, so nothing here can drift from what actually prints.
 *
 * Editing an existing design never touches its live counter -- the store's
 * `saveExhibitStampTemplate` preserves `nextIndex` from the existing record,
 * and this form never presents it as an editable field. Placed stamps are
 * also unaffected: they carry their own resolved appearance at placement
 * time, not a reference to the template.
 */
export function ExhibitStampDesigner({
  mode,
  template,
  onCancel,
  onMessage,
  onSaved,
}: ExhibitStampDesignerProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [prefix, setPrefix] = useState(template?.prefix ?? "");
  const [suffix, setSuffix] = useState(template?.suffix ?? "");
  const [identifierStyle, setIdentifierStyle] = useState<ExhibitIdentifierStyle>(
    template?.identifierStyle ?? "numbers",
  );
  const [layout, setLayout] = useState<ExhibitLabelLayout>(template?.layout ?? "stacked");
  const [widthPt, setWidthPt] = useState(template?.widthPt ?? DEFAULT_STAMP_WIDTH_PT);
  const [heightPt, setHeightPt] = useState(template?.heightPt ?? DEFAULT_STAMP_HEIGHT_PT);
  const [fontFamily, setFontFamily] = useState<PdfTextBoxFontFamily>(
    template?.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
  );
  const [bold, setBold] = useState(template?.bold ?? true);
  const [italic, setItalic] = useState(template?.italic ?? false);
  const [fontSizePt, setFontSizePt] = useState(template?.fontSizePt ?? DEFAULT_STAMP_FONT_SIZE_PT);
  const [textColor, setTextColor] = useState<PdfEditColor>(template?.textColor ?? DEFAULT_TEXT_COLOR);
  const [fillColor, setFillColor] = useState<PdfEditColor | null>(
    template ? template.fillColor : { r: 1, g: 1, b: 1 },
  );
  const [borderColor, setBorderColor] = useState<PdfEditColor | null>(
    template ? template.borderColor : DEFAULT_TEXT_COLOR,
  );
  const [borderWidthPt, setBorderWidthPt] = useState(
    template?.borderWidthPt ?? DEFAULT_STAMP_BORDER_WIDTH_PT,
  );
  const [cornerRadiusPt, setCornerRadiusPt] = useState(
    template?.cornerRadiusPt ?? DEFAULT_STAMP_CORNER_RADIUS_PT,
  );
  const [saving, setSaving] = useState(false);

  const trimmedName = name.trim();
  const resolvedPrefix = prefix.trim() || trimmedName;
  const trimmedSuffix = suffix.trim();

  // Mirrors `resolveStampBorderWidthPt` in engine-local: no border color means
  // no border at all, and a requested width beyond a quarter of the short
  // side gets clamped so it never eats the label.
  const effectiveBorderWidthPt = useMemo(() => {
    if (borderColor === null) {
      return 0;
    }

    return clampToRange(borderWidthPt, 0, Math.min(widthPt, heightPt) * STAMP_MAX_BORDER_WIDTH_FRACTION);
  }, [borderColor, borderWidthPt, widthPt, heightPt]);

  // Mirrors `computeStampLayout` / `computeStampPreviewLayout`'s corner clamp:
  // never more than half of whatever's left after the border is inset.
  const maxCornerRadiusPt = useMemo(
    () =>
      Math.max(
        0,
        Math.min(widthPt - effectiveBorderWidthPt, heightPt - effectiveBorderWidthPt) / 2,
      ),
    [widthPt, heightPt, effectiveBorderWidthPt],
  );

  // Keeps the stored value honest whenever a size or border change shrinks
  // the ceiling out from under it (e.g. switching from Classic to Compact
  // after dialing in a large radius) -- the preview already clamps visually,
  // but the field should show what will actually be saved, not a stale
  // number that only looks fine until the next render.
  useEffect(() => {
    setCornerRadiusPt((current) => Math.min(current, maxCornerRadiusPt));
  }, [maxCornerRadiusPt]);

  // A brand-new template hasn't allocated anything yet, so its preview shows
  // the first exhibit; an edited one previews its own live counter, same as
  // the gallery card does -- editing the design must never imply editing the
  // count.
  const previewIndex = mode === "edit" && template ? template.nextIndex : 0;
  const previewScale = designerPreviewScale(widthPt);

  const previewLines = useMemo(
    () =>
      exhibitLabelLines(
        resolvedPrefix,
        identifierStyle,
        previewIndex,
        layout,
        trimmedSuffix || undefined,
      ),
    [resolvedPrefix, identifierStyle, previewIndex, layout, trimmedSuffix],
  );
  const previewIdentifier = formatExhibitIdentifier(identifierStyle, previewIndex);
  const matchingPreset = STAMP_SIZE_PRESETS.find(
    (preset) => preset.widthPt === widthPt && preset.heightPt === heightPt,
  );

  function handleSave() {
    if (!trimmedName) {
      onMessage("Give the stamp a name first.");
      return;
    }

    const isNew = mode === "create";
    const now = Date.now();
    const id = isNew ? `stamp-${now}-${Math.random().toString(36).slice(2, 8)}` : template!.id;
    const next: ExhibitStampTemplateV1 = {
      version: 1,
      id,
      name: trimmedName,
      prefix: resolvedPrefix,
      ...(trimmedSuffix ? { suffix: trimmedSuffix } : {}),
      identifierStyle,
      // The store overwrites this with the live counter for an existing id
      // (`saveExhibitStampTemplate` preserves `nextIndex` from the current
      // record); it's only ever actually used for a brand-new template.
      nextIndex: template?.nextIndex ?? 0,
      layout,
      widthPt,
      heightPt,
      fontFamily,
      bold,
      italic,
      fontSizePt,
      textColor,
      fillColor,
      borderColor,
      borderWidthPt,
      cornerRadiusPt,
      createdAt: template?.createdAt ?? now,
      updatedAt: now,
    };

    setSaving(true);
    void saveExhibitStampTemplate(next).then((result) => {
      setSaving(false);

      if (!result.ok) {
        onMessage(result.error);
        return;
      }

      onMessage(null);
      onSaved(result.value.id, isNew);
    });
  }

  return (
    <FloatingDialog
      title={mode === "create" ? "New exhibit stamp" : "Edit exhibit stamp"}
      eyebrow="Design"
      width="lg"
      onClose={onCancel}
    >
      <div className="exhibit-stamp-designer">
        <div className="exhibit-stamp-designer__preview">
          <span
            className="exhibit-stamp-designer__preview-box"
            style={{
              width: `${widthPt * previewScale}px`,
              height: `${heightPt * previewScale}px`,
            }}
          >
            <StampPreview
              scale={previewScale}
              stamp={{
                lines: previewLines,
                widthPt,
                heightPt,
                fontSizePt,
                fontFamily,
                bold,
                italic,
                color: textColor,
                fillColor,
                borderColor,
                borderWidthPt,
                cornerRadiusPt,
              }}
            />
          </span>
          <p className="exhibit-stamp-designer__preview-caption">
            Next placement: {previewIdentifier || "unnumbered"}
          </p>
        </div>

        <div className="exhibit-stamp-designer__form">
          <label className="exhibit-stamp-designer__field">
            <span>Name</span>
            <input
              type="text"
              aria-label="Stamp name"
              placeholder="Defendant's Exhibit"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="exhibit-stamp-designer__field">
            <span>Wording</span>
            <input
              type="text"
              aria-label="Stamp wording"
              placeholder={trimmedName || "Text before the number"}
              value={prefix}
              onChange={(event) => setPrefix(event.currentTarget.value)}
            />
          </label>
          <label className="exhibit-stamp-designer__field">
            <span>After the number</span>
            <input
              type="text"
              aria-label="Text after the exhibit number"
              placeholder="Optional"
              value={suffix}
              onChange={(event) => setSuffix(event.currentTarget.value)}
            />
          </label>
          <label className="exhibit-stamp-designer__field">
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

          <span className="exhibit-stamp-designer__field">
            <span>Layout</span>
            <span className="exhibit-stamp-designer__toggle-group" aria-label="Stamp layout">
              {(["stacked", "inline"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="exhibit-stamp-designer__toggle"
                  aria-label={option === "stacked" ? "Stacked layout" : "Inline layout"}
                  aria-pressed={layout === option}
                  onClick={() => setLayout(option)}
                >
                  {option === "stacked" ? "Stacked" : "Inline"}
                </button>
              ))}
            </span>
          </span>

          <span className="exhibit-stamp-designer__field">
            <span>Size</span>
            <span className="exhibit-stamp-designer__toggle-group" aria-label="Sticker size preset">
              {STAMP_SIZE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="exhibit-stamp-designer__toggle"
                  aria-label={`${preset.label} size`}
                  aria-pressed={matchingPreset?.id === preset.id}
                  onClick={() => {
                    setWidthPt(preset.widthPt);
                    setHeightPt(preset.heightPt);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </span>
          </span>
          <span className="exhibit-stamp-designer__field">
            <span>Custom size (in)</span>
            <span className="exhibit-stamp-designer__size-inputs">
              <input
                type="number"
                aria-label="Sticker width in inches"
                min={MIN_STAMP_DIMENSION_IN}
                max={MAX_STAMP_DIMENSION_IN}
                step="0.1"
                value={ptToInches(widthPt)}
                onChange={(event) =>
                  setWidthPt(inchesToClampedPt(event.currentTarget.value, widthPt))
                }
              />
              <span aria-hidden="true">×</span>
              <input
                type="number"
                aria-label="Sticker height in inches"
                min={MIN_STAMP_DIMENSION_IN}
                max={MAX_STAMP_DIMENSION_IN}
                step="0.1"
                value={ptToInches(heightPt)}
                onChange={(event) =>
                  setHeightPt(inchesToClampedPt(event.currentTarget.value, heightPt))
                }
              />
            </span>
          </span>

          <label className="exhibit-stamp-designer__field">
            <span>Font</span>
            <select
              aria-label="Stamp font family"
              value={fontFamily}
              onChange={(event) => setFontFamily(event.currentTarget.value as PdfTextBoxFontFamily)}
            >
              <option value="helvetica">Helvetica</option>
              <option value="times">Times</option>
              <option value="courier">Courier</option>
            </select>
          </label>
          <span className="exhibit-stamp-designer__field">
            <span>Style</span>
            <span className="exhibit-stamp-designer__toggle-group" aria-label="Font style">
              <button
                type="button"
                className="exhibit-stamp-designer__toggle"
                aria-label="Bold text"
                aria-pressed={bold}
                onClick={() => setBold((current) => !current)}
              >
                B
              </button>
              <button
                type="button"
                className="exhibit-stamp-designer__toggle"
                aria-label="Italic text"
                aria-pressed={italic}
                onClick={() => setItalic((current) => !current)}
              >
                I
              </button>
            </span>
          </span>
          <label className="exhibit-stamp-designer__field">
            <span>Font size (pt)</span>
            <input
              type="number"
              aria-label="Font size in points"
              min={MIN_STAMP_FONT_SIZE_PT_UI}
              max={MAX_STAMP_FONT_SIZE_PT}
              step="0.5"
              value={fontSizePt}
              onChange={(event) =>
                setFontSizePt(
                  clampToRange(
                    Number(event.currentTarget.value),
                    MIN_STAMP_FONT_SIZE_PT_UI,
                    MAX_STAMP_FONT_SIZE_PT,
                  ),
                )
              }
            />
          </label>

          <ColorRow label="Ink" options={INK_TEXT_COLOR_OPTIONS} selected={textColor} onSelect={setTextColor} />
          <ColorRow
            label="Background"
            options={[{ id: "white", label: "White", color: { r: 1, g: 1, b: 1 } }, ...SHAPE_FILL_COLOR_OPTIONS]}
            selected={fillColor}
            onSelect={setFillColor}
            onNone={() => setFillColor(null)}
          />
          <ColorRow
            label="Border"
            options={INK_TEXT_COLOR_OPTIONS}
            selected={borderColor}
            onSelect={setBorderColor}
            onNone={() => setBorderColor(null)}
          />
          <label className="exhibit-stamp-designer__field">
            <span>Border width (pt)</span>
            <input
              type="number"
              aria-label="Border width in points"
              min={0}
              max={MAX_STAMP_BORDER_WIDTH_PT}
              step="0.5"
              disabled={borderColor === null}
              value={borderWidthPt}
              onChange={(event) =>
                setBorderWidthPt(
                  clampToRange(Number(event.currentTarget.value), 0, MAX_STAMP_BORDER_WIDTH_PT),
                )
              }
            />
          </label>
          <label className="exhibit-stamp-designer__field">
            <span>Corner rounding (pt)</span>
            <input
              type="number"
              aria-label="Corner rounding in points"
              min={0}
              max={maxCornerRadiusPt}
              step="0.5"
              value={cornerRadiusPt}
              onChange={(event) =>
                setCornerRadiusPt(clampToRange(Number(event.currentTarget.value), 0, maxCornerRadiusPt))
              }
            />
          </label>
        </div>
      </div>

      <div className="exhibit-stamp-designer__actions">
        <button type="button" className="exhibit-stamp-card__secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="exhibit-stamp-card__primary"
          disabled={!trimmedName || saving}
          onClick={handleSave}
        >
          {mode === "create" ? "Create Stamp" : "Save Design"}
        </button>
      </div>
    </FloatingDialog>
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
  options: readonly EditColorOption[];
  selected: PdfEditColor | null;
  onSelect: (color: PdfEditColor) => void;
  onNone?: (() => void) | undefined;
}) {
  const selectedHex = selected ? pdfEditColorToHex(selected) : null;

  return (
    <div className="exhibit-stamp-designer__field">
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

function ptToInches(pt: number): number {
  return Math.round((pt / PT_PER_INCH) * 100) / 100;
}

function inchesToClampedPt(rawInches: string, fallbackPt: number): number {
  const inches = Number(rawInches);

  if (!Number.isFinite(inches)) {
    return fallbackPt;
  }

  return clampToRange(inches, MIN_STAMP_DIMENSION_IN, MAX_STAMP_DIMENSION_IN) * PT_PER_INCH;
}

function clampToRange(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return low;
  }

  return Math.min(Math.max(value, low), Math.max(low, high));
}
