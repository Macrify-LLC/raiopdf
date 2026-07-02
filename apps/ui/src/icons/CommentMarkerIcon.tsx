import { ICON_VIEWBOX, ICON_STROKE_WIDTH, type IconProps } from "./types";

/**
 * The small annotation-pin glyph rendered on top of document pages to mark
 * a comment's anchor point. Distinct component from `CommentIcon` (the
 * tool-panel group glyph) because the two are styled differently at their
 * call sites -- this one sits inside a solid marker badge on the canvas.
 */
export function CommentMarkerIcon({ size = 20, ...props }: IconProps) {
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
      <path d="M3.5 4.5h13v8.5h-7L6 16.5v-3.5H3.5v-8.5Z" />
    </svg>
  );
}
