import type { IconProps } from "./types";

/**
 * The Macrify "M block" mark -- a cropped, hand-simplified redraw of the
 * canonical mark at `D:\Macrify\assets\macrify\M-mark.svg` (four stepped,
 * rounded-square layers plus the white M glyph). Full color, not a
 * currentColor stroke icon -- this is a fixed brand mark, not a UI glyph, so
 * it keeps its own viewBox and literal fills rather than the shared 20px
 * icon grid.
 */
export function MacrifyMarkIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * 322) / 318}
      viewBox="0 0 318 322"
      aria-hidden="true"
      {...props}
    >
      <rect x="3.84" y="0.17" width="312.85" height="312.85" rx="43.45" fill="#004aad" />
      <rect x="3.84" y="0.17" width="297.05" height="313.29" rx="43.45" fill="#38b6ff" />
      <rect x="3.84" y="0.17" width="286.80" height="312.56" rx="43.45" fill="#0081cc" />
      <rect x="3.84" y="0.17" width="273.36" height="313.93" rx="43.45" fill="#00357a" />
      <path
        fill="#ffffff"
        transform="translate(-10.312135, 320.81426)"
        d="M 85.6875 -164.296875 L 134.65625 -86.328125 L 80.53125 -1.28125 L 11.8125 -109.3125 L 11.8125 -164.296875 Z M 234.3125 -164.296875 L 234.3125 0 L 141.09375 0 L 141.09375 -96 L 184.484375 -164.296875 Z M 11.8125 -80.96875 L 13.75 -80.96875 L 65.078125 0 L 11.8125 0 Z M 11.8125 -80.96875 "
      />
    </svg>
  );
}
