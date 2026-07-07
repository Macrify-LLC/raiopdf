import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./ContextMenu.css";

/** Matches the exit keyframe duration in ContextMenu.css. Asymmetric with
 * the (slightly longer) entrance -- release should always read faster than
 * arrival. */
const EXIT_DURATION_MS = 90;

function exitDurationMs(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return EXIT_DURATION_MS;
  }

  // Reduced motion: skip the wait entirely rather than holding the menu on
  // screen for a transition that will never visibly play.
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : EXIT_DURATION_MS;
}

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  /** Cursor position (viewport coordinates) to anchor the menu at. */
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}

/**
 * First context-menu infrastructure in the app -- minimal on purpose. A
 * single flat list of items, positioned at the cursor and clamped to the
 * viewport, closing on outside click/Escape/scroll. Not an app-wide menu
 * system: callers own when to render it and what items to pass.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(() => {
    const firstEnabled = items.findIndex((item) => !item.disabled);
    return firstEnabled === -1 ? 0 : firstEnabled;
  });
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  // Quick exit: play the closing animation, THEN tell the caller to unmount
  // us -- a menu that just vanishes reads as broken next to its own
  // entrance. `closeRequestedRef` (not state) guards against double-firing
  // an outside click racing Escape -- it needs to be correct the instant
  // either handler runs, not after a re-render.
  const [closing, setClosing] = useState(false);
  const closeRequestedRef = useRef(false);
  const closeTimeoutRef = useRef<number | null>(null);

  function requestClose() {
    if (closeRequestedRef.current) {
      return;
    }

    closeRequestedRef.current = true;
    setClosing(true);
    closeTimeoutRef.current = window.setTimeout(onClose, exitDurationMs());
  }

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const menu = menuRef.current;

    if (!menu) {
      return;
    }

    const bounds = menu.getBoundingClientRect();
    const left = Math.min(x, Math.max(8, window.innerWidth - bounds.width - 8));
    const top = Math.min(y, Math.max(8, window.innerHeight - bounds.height - 8));
    setPosition({ left, top, ready: true });
    menu.focus();
  }, [x, y]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        requestClose();
      }
    }

    // Scroll and blur both mean the anchor is no longer valid (scrolled
    // away, or the window lost focus entirely) -- close immediately rather
    // than animating a dismissal at a position that's already stale.
    function handleScroll() {
      onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("blur", onClose);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  function enabledIndexes(): number[] {
    const indexes: number[] = [];
    items.forEach((item, index) => {
      if (!item.disabled) {
        indexes.push(index);
      }
    });
    return indexes;
  }

  function moveActive(direction: 1 | -1) {
    const indexes = enabledIndexes();

    if (indexes.length === 0) {
      return;
    }

    const currentPosition = indexes.indexOf(activeIndex);
    const nextPosition =
      currentPosition === -1
        ? direction === 1
          ? 0
          : indexes.length - 1
        : (currentPosition + direction + indexes.length) % indexes.length;

    setActiveIndex(indexes[nextPosition]!);
  }

  function activate(index: number) {
    const item = items[index];

    if (!item || item.disabled) {
      return;
    }

    // The action fires immediately -- only the menu's own visual dismissal
    // is deferred for the exit animation.
    requestClose();
    item.onSelect();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(activeIndex);
    }
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      data-ready={position.ready ? "true" : undefined}
      data-closing={closing ? "true" : undefined}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      // The menu can render inside an interactive layer (e.g. EditLayer with a
      // shape/callout tool active) whose own pointerdown handler would start a
      // placement and capture the pointer, swallowing the item click. Absorb
      // the pointerdown here so selecting an item never falls through to the
      // content behind the menu. Outside-click dismissal is unaffected — it
      // runs on a window-level capture listener, before this bubble handler.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="context-menu__item"
          data-active={index === activeIndex ? "true" : undefined}
          data-danger={item.danger ? "true" : undefined}
          disabled={item.disabled}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => activate(index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
