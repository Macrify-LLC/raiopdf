import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function SaveIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M3.5 3.5h10l3 3v10h-13v-13Z" />
      <path d="M6.5 3.5v4h6v-4M6.5 16.5v-5h7v5" />
    </svg>
  );
}
