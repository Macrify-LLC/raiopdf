import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
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
}

export function CoverStylePicker({
  value,
  onChange,
  sampleLabel = "Exhibit A",
  sampleDescription = "Deposition transcript of Jane Doe",
  size = "md",
}: CoverStylePickerProps) {
  const labelId = useId();
  const [previews, setPreviews] = useState<Partial<Record<PdfCoverStyle, Uint8Array>>>({});
  const sample = useMemo(
    () => ({ label: sampleLabel, description: sampleDescription }),
    [sampleDescription, sampleLabel],
  );
  const thumbSize = size === "sm"
    ? { width: 52, height: 68 }
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

  function selectRelative(delta: -1 | 1) {
    const currentIndex = PDF_COVER_STYLES.findIndex((style) => style.id === value);
    const nextIndex = (currentIndex + delta + PDF_COVER_STYLES.length) % PDF_COVER_STYLES.length;
    const nextStyle = PDF_COVER_STYLES[nextIndex];

    if (nextStyle) {
      onChange(nextStyle.id);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectRelative(1);
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectRelative(-1);
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
              type="button"
              className="cover-style-picker__tile"
              role="radio"
              aria-checked={selected}
              aria-label={`${style.label}: ${style.description}`}
              data-selected={selected ? "true" : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(style.id)}
            >
              <PdfMiniThumb
                bytes={previews[style.id] ?? null}
                label={`${style.label} cover preview`}
                targetWidth={thumbSize.width}
                targetHeight={thumbSize.height}
              />
              <span className="cover-style-picker__label">{style.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
