import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/** "Make Searchable (OCR)" -- a search glyph with the OCR scan mark inside. */
export function OcrSearchIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.5 13.5 3.5 3.5M6.5 9h5M9 6.5v5" />
    </svg>
  );
}
