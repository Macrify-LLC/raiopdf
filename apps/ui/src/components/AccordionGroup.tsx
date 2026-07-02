import type { ReactNode } from "react";
import { ChevronDownIcon } from "../icons";
import "./AccordionGroup.css";

export interface AccordionGroupProps {
  id: string;
  icon: ReactNode;
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  /**
   * The Legal group is a first-class peer of Edit/Organize/Comment, but
   * carries its own header wash so it reads as the flagship group.
   */
  variant?: "default" | "legal";
  children?: ReactNode;
}

export function AccordionGroup({
  id,
  icon,
  label,
  isOpen,
  onToggle,
  variant = "default",
  children,
}: AccordionGroupProps) {
  const headerId = `accordion-header-${id}`;
  const panelId = `accordion-panel-${id}`;

  return (
    <section className="accordion-group" data-variant={variant}>
      <h3 className="accordion-group__heading">
        <button
          type="button"
          id={headerId}
          className="accordion-group__header"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className="accordion-group__icon">{icon}</span>
          {label}
          <ChevronDownIcon
            size={16}
            className="accordion-group__chevron"
            data-open={isOpen ? "true" : undefined}
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        className="accordion-group__panel"
        hidden={!isOpen}
      >
        {children}
      </div>
    </section>
  );
}
