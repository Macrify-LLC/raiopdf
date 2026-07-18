import type { ReactNode } from "react";
import { HelpIcon } from "../icons";
import { IconButton } from "./IconButton";
import "./ToolRow.css";

export interface ToolRowProps {
  icon: ReactNode;
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  /**
   * Keep a live page-text selection alive through the click: the browser
   * collapses a selection on mousedown outside it, which would race the
   * select handler's selection-into-markup conversion (see setTool in
   * useEditing). Set on the text-markup tool rows.
   */
  preserveTextSelection?: boolean;
  onSelect?: (() => void) | undefined;
  onHelp?: (() => void) | undefined;
}

export function ToolRow({
  icon,
  label,
  description,
  selected = false,
  disabled = false,
  preserveTextSelection = false,
  onSelect,
  onHelp,
}: ToolRowProps) {
  return (
    <div
      className="tool-row"
      data-selected={selected ? "true" : undefined}
    >
      <button
        type="button"
        className="tool-row__select"
        aria-current={selected ? "true" : undefined}
        title={description ?? label}
        disabled={disabled}
        onMouseDown={preserveTextSelection ? (event) => event.preventDefault() : undefined}
        onClick={onSelect}
      >
        <span className="tool-row__icon">{icon}</span>
        <span className="tool-row__label">{label}</span>
      </button>
      {onHelp ? (
        <IconButton
          icon={<HelpIcon size={14} />}
          label={`Help: ${label}`}
          tooltip={`Help: ${label}`}
          onClick={onHelp}
        />
      ) : null}
    </div>
  );
}
