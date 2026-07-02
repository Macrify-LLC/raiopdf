import type { IconProps } from "./types";
import { ICON_STROKE_WIDTH, ICON_VIEWBOX } from "./types";

export function ArrowUpIcon({ size = 20, ...props }: IconProps) {
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
      <path d="m10 4 5 5" />
      <path d="m10 4-5 5" />
      <path d="M10 4v12" />
    </svg>
  );
}
