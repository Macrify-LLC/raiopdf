import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export function SignIcon({ size = 20, ...props }: IconProps) {
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
      <path
        d="M4 13c1.5-4.5 3.5-8 4.8-7.6 1.2.4-.6 5.4.4 6 .9.5 2-2.4 3-2.2.9.2.3 2.3 1.2 2.6.7.2 1.6-.7 2.6-.8"
        strokeLinecap="round"
      />
      <path d="M3.5 16.5h13" strokeLinecap="round" />
    </svg>
  );
}
