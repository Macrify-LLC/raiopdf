import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { HelpIcon } from "../icons";
import { IconButton } from "./IconButton";
import "./FloatingDialog.css";

const dialogStack: string[] = [];

export interface FloatingDialogProps {
  title: string;
  eyebrow?: string | undefined;
  children: ReactNode;
  onClose: () => void;
  onHelp?: (() => void) | undefined;
  /**
   * Extra header controls for a dialog whose content used to render its own
   * second header (e.g. Prepare for Filing's overflow menu -- item 8 folds
   * that "double chrome" down to one). Rendered before Help/Close so a
   * dialog-specific action reads as part of the same toolbar, not bolted on.
   * Generic on purpose: any dialog can use this, not just Prepare for Filing.
   */
  actions?: ReactNode | undefined;
  width?: "sm" | "md" | "lg" | undefined;
  draggable?: boolean | undefined;
  scrim?: boolean | undefined;
  dismissible?: boolean | undefined;
}

export function FloatingDialog({
  title,
  eyebrow,
  children,
  onClose,
  onHelp,
  actions,
  width = "md",
  draggable = true,
  scrim = false,
  dismissible = true,
}: FloatingDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const stackId = useId();
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    dialog?.focus();

    const unregister = registerDialogStackEntry(stackId);

    function handleKeyDown(event: KeyboardEvent) {
      if (!isTopDialogStackEntry(stackId)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (dismissible) {
          onClose();
        }
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      event.stopImmediatePropagation();
      const focusable = getFocusableElements(dialogRef.current);

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      unregister();
      previouslyFocused?.focus();
    };
  }, [dismissible, onClose, stackId]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggable || event.button !== 0) {
      return;
    }

    // Capturing the pointer on the header retargets the synthesized click to the
    // header itself, so buttons inside it (close/help) would never receive their
    // click. Leave interactive children alone and only drag from inert areas.
    // `[role='menu']` covers a header-hosted dropdown's own padding (e.g. the
    // Prepare for Filing overflow menu passed in via `actions`) so a pointerdown
    // that lands beside its menu items doesn't start dragging the dialog.
    if (
      event.target instanceof Element
      && event.target.closest("button, a, input, select, textarea, [role='button'], [role='menu']")
    ) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    setOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }

  return (
    <div
      className="floating-dialog-layer"
      role="presentation"
      data-scrim={scrim ? "true" : undefined}
    >
      <div
        ref={dialogRef}
        className="floating-dialog"
        data-width={width}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        <header
          className="floating-dialog__header"
          data-draggable={draggable ? "true" : undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div>
            {eyebrow ? <p className="floating-dialog__eyebrow">{eyebrow}</p> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="floating-dialog__actions">
            {actions}
            {onHelp ? (
              <IconButton
                icon={<HelpIcon size={15} />}
                label={`Help: ${title}`}
                tooltip={`Help: ${title}`}
                onClick={onHelp}
              />
            ) : null}
            {dismissible ? (
              <button
                type="button"
                className="floating-dialog__close"
                aria-label={`Close ${title}`}
                onClick={onClose}
              >
                ×
              </button>
            ) : null}
          </div>
        </header>
        <div className="floating-dialog__body">{children}</div>
      </div>
    </div>
  );
}

export function registerDialogStackEntry(dialogId: string): () => void {
  dialogStack.push(dialogId);

  return () => {
    const index = dialogStack.lastIndexOf(dialogId);

    if (index !== -1) {
      dialogStack.splice(index, 1);
    }
  };
}

export function isTopDialogStackEntry(dialogId: string): boolean {
  return dialogStack[dialogStack.length - 1] === dialogId;
}

export function hasOpenDialogStackEntry(): boolean {
  return dialogStack.length > 0;
}

export function resetDialogStackForTests(): void {
  dialogStack.splice(0, dialogStack.length);
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "a[href]",
        "[tabindex]:not([tabindex='-1'])",
      ].join(","),
    ),
  ).filter((element) => element.offsetParent !== null || element === root);
}
