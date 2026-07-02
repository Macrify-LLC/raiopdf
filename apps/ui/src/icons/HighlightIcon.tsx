import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function HighlightIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="m12.5 3.5 4 4-8 8h-4v-4l8-8Z" />
      <path d="M3.5 17.5h13" />
    </svg>
  );
}
