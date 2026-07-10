import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/** An envelope glyph for the "Email a report" action on the error surfaces. */
export function MailIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="5" width="14" height="10" rx="1.5" />
      <path d="M3.5 6 10 10.5 16.5 6" />
    </svg>
  );
}
