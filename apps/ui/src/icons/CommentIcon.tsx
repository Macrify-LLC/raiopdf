import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function CommentIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M3.5 4.5h13v8.5h-7L6 16.5v-3.5H3.5v-8.5Z" />
    </svg>
  );
}
