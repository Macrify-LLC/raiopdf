import type { ReactNode } from "react";
import "./IconButton.css";

export interface IconButtonProps {
  /** Icon element, e.g. `<OpenIcon />`. IconButton owns sizing via CSS. */
  icon: ReactNode;
  /** Accessible name. */
  label: string;
  /** Optional hover help. The accessible name remains `label`. */
  tooltip?: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean;
  /**
   * Reflects an active tool/mode -- e.g. the current cursor mode.
   * Leave undefined for plain action buttons so they are not exposed
   * to assistive tech as toggle buttons.
   */
  active?: boolean;
  /**
   * A short name (e.g. "Highlight") that gracefully reveals to the right of
   * the icon while this button is `active` -- the Emil-style command bar
   * tool expansion. The icon itself never moves; only the button widens.
   * Purely decorative -- the accessible name stays `label` -- so it's
   * always rendered (not just while active) to let the width/opacity
   * transition play in both directions, and marked `aria-hidden`.
   * Omitted entirely for plain action buttons (Open/Save/Print/zoom/etc.),
   * which stay fixed 30x30 icon squares.
   */
  expandLabel?: string;
}

export function IconButton({
  icon,
  label,
  tooltip,
  onClick,
  disabled = false,
  active,
  expandLabel,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className="icon-button"
      data-active={active ? "true" : undefined}
      aria-label={label}
      aria-pressed={active}
      title={tooltip ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="icon-button__icon">{icon}</span>
      {expandLabel ? (
        <span className="icon-button__expand-label" aria-hidden="true">
          {expandLabel}
        </span>
      ) : null}
    </button>
  );
}
