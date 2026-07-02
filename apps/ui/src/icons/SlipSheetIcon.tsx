import { ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconProps } from "./types";

export function SlipSheetIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M6 3.5h6l3 3v10H6z" />
      <path d="M12 3.5v3h3" />
      <path d="M8 10h4M8 12.5h3" />
    </svg>
  );
}
