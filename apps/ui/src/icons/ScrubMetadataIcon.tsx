import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function ScrubMetadataIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M15.5 8.5v-4h-11v11h4" />
      <path d="m9.5 9.5 7 2.5-3 1-1 3-3-6.5Z" />
    </svg>
  );
}
