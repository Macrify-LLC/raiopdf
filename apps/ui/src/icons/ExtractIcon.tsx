import { ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconProps } from "./types";

export function ExtractIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M5 3.5h8l2 2v11H5z" />
      <path d="M13 3.5v2h2" />
      <path d="M9.5 8v6M7 11.5l2.5 2.5 2.5-2.5" />
    </svg>
  );
}
