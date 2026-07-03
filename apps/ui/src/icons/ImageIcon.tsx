import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function ImageIcon({ size = 20, ...props }: IconProps) {
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
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <circle cx="7.5" cy="8.5" r="1.25" />
      <path d="m3.5 14.5 4-4 3 3 2.5-2.5 3.5 3.5" strokeLinecap="round" />
    </svg>
  );
}
