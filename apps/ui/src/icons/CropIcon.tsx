import { ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconProps } from "./types";

export function CropIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M6 3.5v10.5h10.5" />
      <path d="M3.5 6H14v10.5" />
      <path d="M8.5 8.5H14V14" />
    </svg>
  );
}
