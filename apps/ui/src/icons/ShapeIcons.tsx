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
