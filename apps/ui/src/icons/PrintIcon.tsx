import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function PrintIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M5.5 7V2.5h9V7M5.5 14.5h-2v-7.5h13v7.5h-2" />
      <path d="M5.5 12.5h9v5h-9v-5Z" />
    </svg>
  );
}
