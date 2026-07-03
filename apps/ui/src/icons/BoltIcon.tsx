import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

const BOLT_PATH = "M11.5 2 5 11h4l-1.5 7L14 9h-4l1.5-7Z";

export interface BoltIconProps extends IconProps {
  /**
   * The bolt survives as the Prepare for Filing tool glyph. The filled variant
   * is retained for legacy/icon-only call sites; brand surfaces use SunMarkIcon.
   */
  variant?: "filled" | "outline";
}

export function BoltIcon({
  size = 20,
  variant = "filled",
  ...props
}: BoltIconProps) {
  if (variant === "outline") {
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
        <path d={BOLT_PATH} />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d={BOLT_PATH} />
    </svg>
  );
}
