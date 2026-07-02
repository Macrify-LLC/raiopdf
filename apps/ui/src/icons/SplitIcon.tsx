import { ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconProps } from "./types";

export function SplitIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 4h4v12H5zM11 4h4v12h-4z" />
      <path d="M10 6v8" />
    </svg>
  );
}
