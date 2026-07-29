import type { MouseEventHandler } from "react";
import "./DismissButton.css";

export interface DismissButtonProps {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  className?: string | undefined;
  compact?: boolean | undefined;
}

export function DismissButton({
  label,
  onClick,
  className,
  compact = false,
}: DismissButtonProps) {
  return (
    <button
      type="button"
      className={["dismiss-button", className].filter(Boolean).join(" ")}
      data-size={compact ? "compact" : undefined}
      aria-label={label}
      onClick={onClick}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}
