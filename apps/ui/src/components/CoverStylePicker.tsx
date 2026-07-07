import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PDF_COVER_STYLES, type PdfCoverStyle } from "@raiopdf/engine-api";
import { generateCoverPdf } from "../lib/coverPreview";
import { PdfMiniThumb } from "./PdfMiniThumb";
import "./CoverStylePicker.css";

export interface CoverStylePickerProps {
  value: PdfCoverStyle;
  onChange: (style: PdfCoverStyle) => void;
  sampleLabel?: string | undefined;
  sampleDescription?: string | undefined;
  size?: "sm" | "md" | undefined;
  /** Disables the whole group -- e.g. while a build/insert is in progress. */
  disabled?: boolean | undefined;
}

export function CoverStylePicker({
  value,
  onChange,
  sampleLabel = "Exhibit A",
  sampleDescription = "Deposition transcript of Jane Doe",
  size = "md",
  disabled = false,
}: CoverStylePickerProps) {
  const labelId = useId();
  const tileRefs = useRef<Partial<Record<PdfCoverStyle, HTMLButtonElement | null>>>({});
  const [previews, setPreviews] = useState<Partial<Record<PdfCoverStyle, Uint8Array>>>({});
  const sample = useMemo(
    () => ({ label: sampleLabel, description: sampleDescription }),
    [sampleDescription, sampleLabel],
  );
  // "sm" matches PdfMiniThumb's own default target (44x58) -- the same
  // compact-but-legible size already used for the exhibit-list thumbnails
  // in Combine with Exhibits, and small enough to fit 3 across in the
  // narrowest column that hosts this picker (Binder settings sidebar).
  const thumbSize = size === "sm"
    ? { width: 44, height: 58 }
    : { width: 74, height: 96 };

  useEffect(() => {
    let disposed = false;

    setPreviews({});

    void Promise.all(
      PDF_COVER_STYLES.map(async (style) => [
        style.id,
        await generateCoverPdf({
          label: sample.label,
          description: sample.description,
          style: style.id,
        }),
      ] as const),
    ).then((entries) => {
      if (!disposed) {
        setPreviews(Object.fromEntries(entries));
      }
    });

    return () => {
      disposed = true;
    };
  }, [sample]);

  function selectAt(index: number) {
    const nextStyle = PDF_COVER_STYLES[index];

    if (!nextStyle) {
      return;
    }

    onChange(nextStyle.id);
    // Roving tabindex moves the tab stop to the new tile on the next render,
    // but arrow-key navigation must also move real DOM focus there now --
    // otherwise the focus ring stays on the tile that just lost tabIndex=0
    // while the selected-state ring jumps to the new tile.
    tileRefs.current[nextStyle.id]?.focus();
  }

  function selectRelative(delta: -1 | 1) {
    const currentIndex = PDF_COVER_STYLES.findIndex((style) => style.id === value);
    const nextIndex = (currentIndex + delta + PDF_COVER_STYLES.length) % PDF_COVER_STYLES.length;
    selectAt(nextIndex);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectRelative(1);
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectRelative(-1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      selectAt(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      selectAt(PDF_COVER_STYLES.length - 1);
    }
  }

  return (
    <div className="cover-style-picker" data-size={size}>
      <span id={labelId} className="cover-style-picker__sr">
        Exhibit cover style
      </span>
      <div
        className="cover-style-picker__grid"
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={handleKeyDown}
      >
        {PDF_COVER_STYLES.map((style) => {
          const selected = value === style.id;

          return (
            <button
              key={style.id}
              ref={(node) => {
                tileRefs.current[style.id] = node;
              }}
              type="button"
              className="cover-style-picker__tile"
              role="radio"
              aria-checked={selected}
              aria-label={`${style.label}: ${style.description}`}
              title={style.description}
              data-selected={selected ? "true" : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(style.id)}
            >
              <PdfMiniThumb
                bytes={previews[style.id] ?? null}
                label={`${style.label} cover preview`}
                targetWidth={thumbSize.width}
                targetHeight={thumbSize.height}
              />
              <span className="cover-style-picker__meta">
                <span className="cover-style-picker__radio" aria-hidden="true" />
                <span className="cover-style-picker__label">{style.label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
