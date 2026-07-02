import type { ReactNode } from "react";
import "./ToolRow.css";

export interface ToolRowProps {
  icon: ReactNode;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: (() => void) | undefined;
}

export function ToolRow({
  icon,
  label,
  selected = false,
  disabled = false,
  onSelect,
}: ToolRowProps) {
  return (
    <button
      type="button"
      className="tool-row"
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="tool-row__icon">{icon}</span>
      {label}
    </button>
  );
}
