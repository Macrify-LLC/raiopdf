import { useId, type ReactNode } from "react";
import { ExperimentalFeatureLock } from "./ExperimentalFeatureLock";
import { HelpIcon } from "../icons";
import { IconButton } from "./IconButton";
import "./ToolRow.css";

export interface ToolRowProps {
  icon: ReactNode;
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  experimental?: boolean;
  locked?: boolean;
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
  experimental = false,
  locked = false,
  preserveTextSelection = false,
  onSelect,
  onHelp,
}: ToolRowProps) {
  const lockId = useId();
  const descriptionId = `experimental-feature-locked-description-${lockId}`;

  return (
    <div
      className="tool-row experimental-feature-lock"
      data-selected={selected ? "true" : undefined} data-locked={locked ? "true" : undefined}
    >
      <button
        type="button"
        className="tool-row__select"
        aria-current={selected ? "true" : undefined}
        title={locked ? undefined : description ?? label}
        aria-describedby={locked ? descriptionId : undefined}
        aria-disabled={locked || undefined}
        disabled={disabled}
        onMouseDown={preserveTextSelection ? (event) => event.preventDefault() : undefined}
        onClick={onSelect}
      >
        <span className="tool-row__icon">{icon}</span>
        <span className="tool-row__label">{label}</span>
        {experimental ? <span className="tool-row__badge">Experimental</span> : null}
      </button>
      {locked ? <ExperimentalFeatureLock descriptionId={descriptionId} /> : null}
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
