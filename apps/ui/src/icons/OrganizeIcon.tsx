import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function OrganizeIcon({ size = 20, ...props }: IconProps) {
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
      <rect x="3" y="3" width="6.5" height="8" rx="1" />
      <rect x="11" y="6" width="6" height="8" rx="1" />
    </svg>
  );
}
