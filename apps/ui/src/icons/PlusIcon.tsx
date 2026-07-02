import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function PlusIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M10 5v10M5 10h10" />
    </svg>
  );
}
