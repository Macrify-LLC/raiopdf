import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/** The "Copy" glyph for the connect-config Copy buttons -- two overlapping sheets. */
export function CopyIcon({ size = 20, ...props }: IconProps) {
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
      <rect x="7.5" y="7.5" width="8" height="10" rx="1.5" />
      <path d="M4.5 12.5v-8a1 1 0 0 1 1-1h8" />
    </svg>
  );
}
