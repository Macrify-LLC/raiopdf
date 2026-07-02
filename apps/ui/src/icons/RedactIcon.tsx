import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/**
 * Lines of text with one solid redaction bar. The bar is a deliberate,
 * spec-noted exception to "no fills except the bolt mark and state ticks"
 * -- an outlined block does not read as a redaction, and the reference
 * mockup renders it filled.
 */
export function RedactIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M4 6h12M4 10h5M12 10h4M4 14h8" opacity={0.45} />
      <rect x="9.5" y="8.5" width="3" height="3" fill="currentColor" stroke="none" />
    </svg>
  );
}
