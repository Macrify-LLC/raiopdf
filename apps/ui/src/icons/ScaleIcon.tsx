import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/** Scales of justice -- the Legal tool group's header glyph. */
export function ScaleIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M10 3v14M5 5.5h10M5.5 5.5 3 10.5a2.5 2.5 0 0 0 5 0L5.5 5.5ZM14.5 5.5 12 10.5a2.5 2.5 0 0 0 5 0l-2.5-5ZM7 17h6" />
    </svg>
  );
}
