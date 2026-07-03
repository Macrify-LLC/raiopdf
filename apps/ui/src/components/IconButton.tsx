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
}

export function IconButton({
  icon,
  label,
  tooltip,
  onClick,
  disabled = false,
  active,
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
      {icon}
    </button>
  );
}
