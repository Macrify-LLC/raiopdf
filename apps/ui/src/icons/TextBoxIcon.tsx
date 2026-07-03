import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function TextBoxIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M7 8h6M10 8v5" strokeLinecap="round" />
    </svg>
  );
}
