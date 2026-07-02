import type { ReactNode } from "react";
import "./ToolRow.css";

export interface ToolRowProps {
  icon: ReactNode;
  label: string;
  selected?: boolean;
  onSelect?: (() => void) | undefined;
}

export function ToolRow({ icon, label, selected = false, onSelect }: ToolRowProps) {
  return (
    <button
      type="button"
      className="tool-row"
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="tool-row__icon">{icon}</span>
      {label}
    </button>
  );
}
