import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/**
 * The "Open Raio to AI" glyph -- a plug feeding a cord out to a connection
 * point. Reads as "bring your own AI plugs in here" without borrowing any
 * of the sparkle/chat-bubble/robot iconography generic AI features default
 * to.
 */
export function PlugIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M7 2.5v4M13 2.5v4" />
      <rect x="5.5" y="6.5" width="9" height="5" rx="2" />
      <path d="M10 11.5v1.5a4 4 0 0 1-4 4H4.5" />
      <circle cx="3.3" cy="17" r="1" />
    </svg>
  );
}
