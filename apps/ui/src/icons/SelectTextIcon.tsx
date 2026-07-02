import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function SelectTextIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 4.5h12M10 4.5v11M7.5 15.5h5" />
    </svg>
  );
}
