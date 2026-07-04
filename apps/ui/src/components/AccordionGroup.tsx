import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  // Grow-in only on a genuine closed-to-open transition -- never on initial
  // mount (a group that starts open shouldn't animate just for existing),
  // matching the honesty rule applied to the tool-row expansions this
  // mirrors. useLayoutEffect so the flag (and its CSS "from" state) lands
  // before paint -- no one-frame flash of the fully-open panel first.
  const previousOpenRef = useRef(isOpen);
  const [justOpened, setJustOpened] = useState(false);

  useLayoutEffect(() => {
    if (isOpen && !previousOpenRef.current) {
      // Under reduced motion the grow animation never runs, so
      // onAnimationEnd would never clear the flag and the panel would stay
      // overflow-clipped forever. Skip the animated state entirely there.
      const reducedMotion = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!reducedMotion) {
        setJustOpened(true);
      }
    }
    previousOpenRef.current = isOpen;
  }, [isOpen]);

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
        data-grow={justOpened ? "true" : undefined}
        onAnimationEnd={() => setJustOpened(false)}
        hidden={!isOpen}
      >
        {children}
      </div>
    </section>
  );
}
