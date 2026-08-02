import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/**
 * The exhibit-stamp tool: a sticker with a peeled corner and two label lines,
 * the shape of a printed exhibit tab.
 */
export function ExhibitStampIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M3.5 4.5h13v7.5l-4 4h-9z" />
      <path d="M16.5 12h-4v4" />
      <path d="M6.5 8h7M6.5 11h3.5" strokeLinecap="round" />
    </svg>
  );
}
