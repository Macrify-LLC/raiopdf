import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function CombineExhibitsIcon({ size = 20, ...props }: IconProps) {
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
      <rect x="3" y="4" width="9" height="12" rx="1" />
      <path d="M12 7h4.5v9H7.5" />
      <path d="M5.5 7.5h4M5.5 10h4" />
    </svg>
  );
}
