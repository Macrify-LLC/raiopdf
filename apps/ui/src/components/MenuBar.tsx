import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./MenuBar.css";

/**
 * The title-bar menu bar -- File / Edit / View / Help. The window is
 * frameless (`decorations: false`), so the native Tauri menu registered in
 * `build_native_menu` (apps/shell/src-tauri/src/lib.rs) never renders on
 * Windows; this is the in-UI stand-in. It mirrors the native menu's
 * structure/labels/grouping exactly and dispatches the SAME menu-event
 * command strings App's `handleNativeMenuCommand` already handles for the
 * native-menu/Tauri-event path -- one shared dispatch function, two entry
 * points (native menu event on macOS later, this bar on every platform now).
 *
 * "Exit" is the one command the native menu intercepts in Rust before it
 * ever reaches the frontend (`on_menu_event` calls `app.exit(0)` directly
 * for `MENU_EXIT`), so there is no frontend case for it to share. Here it
 * routes to `onExit`, which the caller wires to the same window-close path
 * the title bar's own close button already uses.
 */

export const MENU_BAR_EXIT_COMMAND = "file:exit";

interface MenuItemDef {
  readonly type: "item";
  readonly label: string;
  readonly command: string;
  readonly disabled?: boolean;
}

interface MenuSeparatorDef {
  readonly type: "separator";
}

type MenuEntryDef = MenuItemDef | MenuSeparatorDef;

interface MenuDef {
  readonly id: string;
  readonly label: string;
  readonly items: readonly MenuEntryDef[];
}

function item(label: string, command: string, disabled = false): MenuItemDef {
  return { type: "item", label, command, disabled };
}

const separator: MenuSeparatorDef = { type: "separator" };

export interface MenuBarProps {
  /** Gates every File-menu action that operates on the open document. */
  hasDocument: boolean;
  /**
   * Gates Edit > Undo -- AppShell derives this (open document + a pending
   * edit), and every undo door consumes the same value.
   */
  canUndo: boolean;
  /**
   * Whether Microsoft Word was detected on this PC. The Word-dependent items
   * (PDF -> editable Word export) drive an installed copy of Word, so they are
   * disabled when it is absent. Defaults `true` so non-desktop / not-yet-probed
   * callers don't gray them prematurely -- App passes the real probe result.
   */
  wordAvailable?: boolean;
  /** Shared dispatch -- the same function the Tauri `raiopdf-menu` listener calls. */
  onCommand: (command: string) => void;
  /** Only reachable from this bar (see module doc) -- native Exit bypasses the frontend entirely. */
  onExit: () => void;
}

export function MenuBar({ hasDocument, canUndo, wordAvailable = true, onCommand, onExit }: MenuBarProps) {
  const desktopRuntime = isTauriRuntime();
  // "Export to editable Word" runs an installed copy of Microsoft Word (COM
  // automation) -- it can't work without it. When Word is absent we disable the
  // item and say why *in the label*, because disabled menu items don't surface
  // a hover tooltip. When Word is present it stays gated on an open document,
  // and carries an "experimental" note (Word's PDF reflow is approximate).
  const exportWordItem: MenuItemDef = wordAvailable
    ? item("Export Editable Word (.docx, experimental)...", "file:export-docx", !hasDocument)
    : item("Export Editable Word (.docx) — requires Microsoft Word", "file:export-docx", true);
  // Import runs Word to convert a .docx to PDF and opens the result as a new
  // document, so it needs Word but not an already-open document -- unlike the
  // other File items it's enabled with nothing open.
  const importWordItem: MenuItemDef = wordAvailable
    ? item("Import Word Document (.docx, experimental)...", "file:import-docx", false)
    : item("Import Word Document (.docx) — requires Microsoft Word", "file:import-docx", true);
  const menus: readonly MenuDef[] = [
    {
      id: "file",
      label: "File",
      items: [
        item("Open...", "file:open"),
        ...(desktopRuntime
          ? [item("Open in New Window...", "file:open-new-window")]
          : []),
        importWordItem,
        item("Save", "file:save", !hasDocument),
        item("Save As...", "file:save-as", !hasDocument),
        separator,
        item("Export PDF/A (archival format)...", "file:export-pdfa", !hasDocument),
        exportWordItem,
        item("Print...", "file:print", !hasDocument),
        item("Create Protected Copy...", "file:protect", !hasDocument),
        item("Document Properties", "file:properties", !hasDocument),
        separator,
        item("Export Diagnostics...", "file:export-diagnostics"),
        separator,
        item("Settings...", "file:preferences"),
        item("Open Raio to AI...", "file:open-raio-to-ai"),
        separator,
        item("About Macrify...", "file:about-macrify"),
        separator,
        item("Exit", MENU_BAR_EXIT_COMMAND),
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [item("Undo", "edit:undo", !canUndo)],
    },
    {
      id: "view",
      label: "View",
      items: [
        item("Zoom In", "view:zoom-in", !hasDocument),
        item("Zoom Out", "view:zoom-out", !hasDocument),
        item("Fit", "view:fit", !hasDocument),
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [item("RaioPDF Help", "help:open")],
    },
  ];

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [activeItemIndex, setActiveItemIndex] = useState(0);

  const openMenu = menus.find((menu) => menu.id === openMenuId) ?? null;

  function enabledItemIndexes(entries: readonly MenuEntryDef[]): number[] {
    const indexes: number[] = [];
    entries.forEach((entry, index) => {
      if (entry.type === "item" && !entry.disabled) {
        indexes.push(index);
      }
    });
    return indexes;
  }

  function openMenuAt(index: number) {
    const menu = menus[index];

    if (!menu) {
      return;
    }

    const firstEnabled = enabledItemIndexes(menu.items)[0] ?? 0;
    setFocusedIndex(index);
    setOpenMenuId(menu.id);
    setActiveItemIndex(firstEnabled);
  }

  function closeMenu(refocusTrigger: boolean) {
    setOpenMenuId(null);

    if (refocusTrigger) {
      triggerRefs.current[focusedIndex]?.focus();
    }
  }

  function moveTriggerFocus(direction: 1 | -1) {
    const nextIndex = (focusedIndex + direction + menus.length) % menus.length;

    if (openMenuId) {
      openMenuAt(nextIndex);
    } else {
      setFocusedIndex(nextIndex);
      triggerRefs.current[nextIndex]?.focus();
    }
  }

  function moveActiveItem(entries: readonly MenuEntryDef[], direction: 1 | -1) {
    const indexes = enabledItemIndexes(entries);

    if (indexes.length === 0) {
      return;
    }

    const currentPosition = indexes.indexOf(activeItemIndex);
    const nextPosition =
      currentPosition === -1
        ? direction === 1
          ? 0
          : indexes.length - 1
        : (currentPosition + direction + indexes.length) % indexes.length;

    setActiveItemIndex(indexes[nextPosition]!);
  }

  function activate(entry: MenuEntryDef | undefined) {
    if (!entry || entry.type !== "item" || entry.disabled) {
      return;
    }

    closeMenu(true);

    if (entry.command === MENU_BAR_EXIT_COMMAND) {
      onExit();
    } else {
      onCommand(entry.command);
    }
  }

  function handleTriggerClick(index: number) {
    const menu = menus[index];

    if (!menu) {
      return;
    }

    if (openMenuId === menu.id) {
      closeMenu(true);
    } else {
      openMenuAt(index);
    }
  }

  function handleTriggerMouseEnter(index: number) {
    const menu = menus[index];

    if (!menu || openMenuId === null || openMenuId === menu.id) {
      return;
    }

    openMenuAt(index);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveTriggerFocus(1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveTriggerFocus(-1);
        break;
      case "ArrowDown":
      case "Enter":
      case " ":
        event.preventDefault();
        openMenuAt(index);
        break;
      case "Escape":
        if (openMenuId) {
          event.preventDefault();
          closeMenu(true);
        }
        break;
      default:
        break;
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!openMenu) {
      return;
    }

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveActiveItem(openMenu.items, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActiveItem(openMenu.items, -1);
        break;
      case "ArrowRight":
        event.preventDefault();
        moveTriggerFocus(1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveTriggerFocus(-1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(openMenu.items[activeItemIndex]);
        break;
      case "Tab":
        closeMenu(false);
        break;
      default:
        break;
    }
  }

  function handleBlur(event: ReactFocusEvent<HTMLDivElement>) {
    if (!containerRef.current?.contains(event.relatedTarget as Node | null)) {
      closeMenu(false);
    }
  }

  // Focus lands in the open dropdown itself (not a specific item) -- same
  // pattern as ContextMenu, which this dropdown otherwise matches visually.
  // Arrow keys move a `data-active` highlight; Enter activates it.
  useLayoutEffect(() => {
    if (openMenuId) {
      menuRef.current?.focus();
    }
  }, [openMenuId]);

  useEffect(() => {
    if (!openMenuId) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeMenu(false);
      }
    }

    function handleWindowBlur() {
      closeMenu(false);
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
    // `closeMenu` reads `focusedIndex` via closure but only when re-focusing
    // a trigger on close -- re-running this effect just to satisfy a
    // dependency array isn't needed since it only needs to (re)bind once
    // per open/close cycle. No react-hooks lint plugin is configured in
    // this repo (see eslint.config.js), so no disable directive is needed.
  }, [openMenuId]);

  return (
    <div
      ref={containerRef}
      className="menu-bar"
      role="menubar"
      aria-label="Application menu"
      aria-orientation="horizontal"
      onBlur={handleBlur}
    >
      {menus.map((menu, index) => (
        <div className="menu-bar__group" key={menu.id}>
          <button
            ref={(element) => {
              triggerRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            className="menu-bar__trigger"
            aria-haspopup="menu"
            aria-expanded={openMenuId === menu.id}
            tabIndex={focusedIndex === index ? 0 : -1}
            onClick={() => handleTriggerClick(index)}
            onMouseEnter={() => handleTriggerMouseEnter(index)}
            onKeyDown={(event) => handleTriggerKeyDown(event, index)}
          >
            {menu.label}
          </button>
          {openMenuId === menu.id ? (
            <div
              ref={menuRef}
              className="menu-bar__menu"
              role="menu"
              aria-label={menu.label}
              tabIndex={-1}
              onKeyDown={handleMenuKeyDown}
            >
              {menu.items.map((entry, entryIndex) =>
                entry.type === "separator" ? (
                  // Separators have no identity of their own, and this list
                  // is static per menu (never reordered/filtered), so the
                  // position-derived key is stable.
                  <div key={`separator-${entryIndex}`} role="separator" className="menu-bar__separator" />
                ) : (
                  <button
                    key={entry.command}
                    type="button"
                    role="menuitem"
                    className="menu-bar__item"
                    data-active={activeItemIndex === entryIndex ? "true" : undefined}
                    disabled={entry.disabled}
                    onMouseEnter={() => setActiveItemIndex(entryIndex)}
                    onClick={() => activate(entry)}
                  >
                    {entry.label}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
