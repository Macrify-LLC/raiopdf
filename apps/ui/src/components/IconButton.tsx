import type { ReactNode } from "react";
import "./IconButton.css";

export interface IconButtonProps {
  /** Icon element, e.g. `<OpenIcon />`. IconButton owns sizing via CSS. */
  icon: ReactNode;
  /** Accessible name. Also shown as a native tooltip via `title`. */
  label: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean;
  /** Reflects an active tool/mode -- e.g. the current cursor mode. */
  active?: boolean;
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  active = false,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className="icon-button"
      data-active={active ? "true" : undefined}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
