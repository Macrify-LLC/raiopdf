import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function UndoIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M7 4 3.5 7.5 7 11" />
      <path d="M3.5 7.5h8a5 5 0 0 1 0 10H8" />
    </svg>
  );
}
