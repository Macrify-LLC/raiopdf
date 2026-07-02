import { ICON_VIEWBOX, type IconProps } from "./types";

/**
 * The state-tick glyph -- status-bar "Searchable" chip, preflight checks.
 * Drawn heavier (2px) than the standard 1.5px icon stroke because a thin
 * checkmark disappears at 12-13px render sizes.
 */
export function CheckIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 10.5 8 14.5 16 5.5" />
    </svg>
  );
}
