import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function ChevronLeftIcon({ size = 20, ...props }: IconProps) {
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
      <path d="m12 4-6 6 6 6" />
    </svg>
  );
}
