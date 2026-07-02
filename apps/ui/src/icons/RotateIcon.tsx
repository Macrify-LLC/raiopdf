import type { IconProps } from "./types";
import { ICON_STROKE_WIDTH, ICON_VIEWBOX } from "./types";

export function RotateIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M15.5 7.5A6 6 0 1 0 16 12" />
      <path d="M15.5 3.5v4h-4" />
    </svg>
  );
}
