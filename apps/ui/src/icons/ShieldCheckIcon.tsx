import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

export interface ShieldCheckIconProps extends IconProps {
  /**
   * The Sanitize tool row shows the shield with its checkmark; the
   * status bar's permanent local-processing trust line reuses the bare
   * shield without it, matching the reference mockup.
   */
  checked?: boolean;
}

export function ShieldCheckIcon({
  size = 20,
  checked = true,
  ...props
}: ShieldCheckIconProps) {
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
      <path d="M10 2.5 4 5v5c0 4 2.7 6.5 6 7.5 3.3-1 6-3.5 6-7.5V5l-6-2.5Z" />
      {checked ? <path d="m7.5 10 1.8 1.8L13 8.2" strokeLinecap="round" /> : null}
    </svg>
  );
}
