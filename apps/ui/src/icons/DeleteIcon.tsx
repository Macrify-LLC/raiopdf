import type { IconProps } from "./types";
import { ICON_STROKE_WIDTH, ICON_VIEWBOX } from "./types";

export function DeleteIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M4 6h12" />
      <path d="M8 6V4.5h4V6" />
      <path d="M6.5 6.5 7 16h6l.5-9.5" />
      <path d="M9 9v4" />
      <path d="M11 9v4" />
    </svg>
  );
}
