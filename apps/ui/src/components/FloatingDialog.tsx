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
  width?: "sm" | "md" | "lg" | undefined;
  draggable?: boolean | undefined;
}

export function FloatingDialog({
  title,
  eyebrow,
  children,
  onClose,
  onHelp,
  width = "md",
  draggable = true,
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
        onClose();
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
  }, [onClose, stackId]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggable || event.button !== 0) {
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
    <div className="floating-dialog-layer" role="presentation">
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
            {onHelp ? (
              <IconButton
                icon={<HelpIcon size={15} />}
                label={`Help: ${title}`}
                tooltip={`Help: ${title}`}
                onClick={onHelp}
              />
            ) : null}
            <button
              type="button"
              className="floating-dialog__close"
              aria-label={`Close ${title}`}
              onClick={onClose}
            >
              x
            </button>
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
