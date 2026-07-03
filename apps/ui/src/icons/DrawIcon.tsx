import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function DrawIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M13.5 3.5 16.5 6.5 8 15l-4 1 1-4 8.5-8.5Z" />
      <path d="M3.5 17.5c2 -1.2 3.5 0.6 5.5 0" strokeLinecap="round" />
    </svg>
  );
}
