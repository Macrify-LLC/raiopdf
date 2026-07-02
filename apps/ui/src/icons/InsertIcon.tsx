import { ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconProps } from "./types";

export function InsertIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M5 3.5h6l3 3v10H5z" />
      <path d="M11 3.5v3h3" />
      <path d="M9.5 8.5v5M7 11h5" />
    </svg>
  );
}
