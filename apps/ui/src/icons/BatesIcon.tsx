import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/** Bates numbering -- evenly spaced stamp ticks along a baseline. */
export function BatesIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M4 15V5M8 15V5M12 15V5M16 15V5M4 17.5h12" />
    </svg>
  );
}
