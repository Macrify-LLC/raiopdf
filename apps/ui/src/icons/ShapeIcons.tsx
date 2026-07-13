import type { IconProps } from "./types";
import { ICON_STROKE_WIDTH, ICON_VIEWBOX } from "./types";

export function RectangleIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="4"
        y="5"
        width="12"
        height="10"
        rx="1"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
    </svg>
  );
}

export function EllipseIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      aria-hidden="true"
    >
      <ellipse
        cx="10"
        cy="10"
        rx="6.5"
        ry="4.75"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
    </svg>
  );
}

export function LineIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 15L16 5"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ArrowLineIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 15L15 4"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
      />
      <path
        d="M10 4H15V9"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A callout: a small text box with a leader line running to the page point it
// annotates. Distinct from ArrowLineIcon (a bare arrow) so the callout and
// arrow tools no longer share a glyph.
export function CalloutIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="3.5"
        width="9.5"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <path
        d="M11 10.5L16 16"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="1.1" fill="currentColor" />
    </svg>
  );
}
