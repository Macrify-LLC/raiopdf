// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuBar, MENU_BAR_EXIT_COMMAND } from "./MenuBar";

describe("MenuBar", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    root = null;
    container = null;
  });

  it("renders the File/Edit/View/Help menubar with roving tabindex on the triggers", () => {
    render({ hasDocument: true, canUndo: true });

    const menubar = document.querySelector("[role='menubar']");
    expect(menubar?.getAttribute("aria-label")).toBe("Application menu");

    const triggers = ["File", "Edit", "View", "Help"].map(getTrigger);
    expect(triggers[0]?.tabIndex).toBe(0);
    expect(triggers.slice(1).every((trigger) => trigger.tabIndex === -1)).toBe(true);
  });

  it("opens a menu on click and dispatches the shared command for the clicked item", () => {
    const onCommand = vi.fn();
    render({ hasDocument: true, canUndo: true, onCommand });

    click(getTrigger("File"));
    expect(getTrigger("File").getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[role='menu']")?.getAttribute("aria-label")).toBe("File");

    click(getMenuItem("Open..."));

    expect(onCommand).toHaveBeenCalledWith("file:open");
    // Selecting an item closes the dropdown and returns focus to its trigger.
    expect(getTrigger("File").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(getTrigger("File"));
  });

  it("dispatches the desktop-only Open in New Window command", () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const onCommand = vi.fn();
    render({ hasDocument: false, canUndo: false, onCommand });

    click(getTrigger("File"));
    click(getMenuItem("Open in New Window..."));

    expect(onCommand).toHaveBeenCalledWith("file:open-new-window");
  });

  it("disables document-scoped File items when there is no open document, and leaves app-level items enabled", () => {
    const onCommand = vi.fn();
    render({ hasDocument: false, canUndo: false, onCommand });

    click(getTrigger("File"));

    for (const label of ["Save", "Save As...", "Export PDF/A (archival format)...", "Export Editable Word (.docx, experimental)...", "Print...", "Protect (passwords)...", "Document Properties"]) {
      expect(getMenuItem(label).disabled).toBe(true);
    }

    for (const label of ["Open...", "Export Diagnostics...", "Preferences...", "Open Raio to AI...", "About Macrify...", "Exit"]) {
      expect(getMenuItem(label).disabled).toBe(false);
    }

    click(getMenuItem("Save"));
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("disables Export to Word with an in-label reason when Microsoft Word is absent", () => {
    const onCommand = vi.fn();
    render({ hasDocument: true, canUndo: false, wordAvailable: false, onCommand });

    click(getTrigger("File"));

    // The gray-out reason lives in the label because disabled menu items don't
    // surface hover tooltips.
    const exportWord = getMenuItem("Export Editable Word (.docx) — requires Microsoft Word");
    expect(exportWord.disabled).toBe(true);

    click(exportWord);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("enables Export to Word (with an experimental note) when Word is present and a document is open", () => {
    const onCommand = vi.fn();
    render({ hasDocument: true, canUndo: false, wordAvailable: true, onCommand });

    click(getTrigger("File"));

    const exportWord = getMenuItem("Export Editable Word (.docx, experimental)...");
    expect(exportWord.disabled).toBe(false);

    click(exportWord);
    expect(onCommand).toHaveBeenCalledWith("file:export-docx");
  });

  it("enables Import Word Document with no document open (it starts fresh) when Word is present", () => {
    const onCommand = vi.fn();
    render({ hasDocument: false, canUndo: false, wordAvailable: true, onCommand });

    click(getTrigger("File"));

    const importWord = getMenuItem("Import Word Document (.docx, experimental)...");
    expect(importWord.disabled).toBe(false);

    click(importWord);
    expect(onCommand).toHaveBeenCalledWith("file:import-docx");
  });

  it("disables Import Word Document with an in-label reason when Microsoft Word is absent", () => {
    const onCommand = vi.fn();
    render({ hasDocument: true, canUndo: false, wordAvailable: false, onCommand });

    click(getTrigger("File"));

    const importWord = getMenuItem("Import Word Document (.docx) — requires Microsoft Word");
    expect(importWord.disabled).toBe(true);

    click(importWord);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("enables View document actions only once a document is open", () => {
    render({ hasDocument: false, canUndo: false });

    click(getTrigger("View"));
    for (const label of ["Zoom In", "Zoom Out", "Fit"]) {
      expect(getMenuItem(label).disabled).toBe(true);
    }
  });

  it("gates Edit > Undo on both an open document and a pending edit to undo", () => {
    render({ hasDocument: false, canUndo: false });

    // The menu stays open across the prop changes below -- re-clicking an
    // already-open trigger would toggle it closed, so open it once and let
    // each rerender flow fresh `disabled` values into the same dropdown.
    click(getTrigger("Edit"));
    expect(getMenuItem("Undo").disabled).toBe(true);

    rerender({ hasDocument: true, canUndo: false });
    expect(getMenuItem("Undo").disabled).toBe(true);

    rerender({ hasDocument: true, canUndo: true });
    expect(getMenuItem("Undo").disabled).toBe(false);
  });

  it("routes Exit to onExit, not the shared onCommand -- the native menu never emits it to the frontend", () => {
    const onCommand = vi.fn();
    const onExit = vi.fn();
    render({ hasDocument: true, canUndo: true, onCommand, onExit });

    click(getTrigger("File"));
    click(getMenuItem("Exit"));

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onCommand).not.toHaveBeenCalledWith(MENU_BAR_EXIT_COMMAND);
  });

  it("supports arrow-key navigation across triggers and Escape to close", () => {
    render({ hasDocument: true, canUndo: true });

    getTrigger("File").focus();
    keydown(getTrigger("File"), "ArrowRight");

    expect(getTrigger("Edit").tabIndex).toBe(0);
    expect(getTrigger("File").tabIndex).toBe(-1);
    expect(document.activeElement).toBe(getTrigger("Edit"));

    keydown(getTrigger("Edit"), "ArrowDown");
    const menu = document.querySelector("[role='menu']");
    expect(menu?.getAttribute("aria-label")).toBe("Edit");
    expect(document.activeElement).toBe(menu);

    keydown(menu as Element, "Escape");
    expect(document.querySelector("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(getTrigger("Edit"));
  });

  it("opens the focused menu on ArrowDown/Enter and activates the highlighted item", () => {
    const onCommand = vi.fn();
    render({ hasDocument: true, canUndo: true, onCommand });

    getTrigger("File").focus();
    keydown(getTrigger("File"), "ArrowDown");

    const menu = document.querySelector("[role='menu']");
    expect(menu).not.toBeNull();

    keydown(menu as Element, "Enter");

    expect(onCommand).toHaveBeenCalledWith("file:open");
    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  interface RenderProps {
    hasDocument: boolean;
    canUndo: boolean;
    wordAvailable?: boolean;
    onCommand?: (command: string) => void;
    onExit?: () => void;
  }

  function render(props: RenderProps) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<Harness {...props} />);
    });
  }

  function rerender(props: RenderProps) {
    act(() => {
      root?.render(<Harness {...props} />);
    });
  }

  function Harness({ hasDocument, canUndo, wordAvailable = true, onCommand, onExit }: RenderProps) {
    return (
      <MenuBar
        hasDocument={hasDocument}
        canUndo={canUndo}
        wordAvailable={wordAvailable}
        onCommand={onCommand ?? (() => undefined)}
        onExit={onExit ?? (() => undefined)}
      />
    );
  }

  function getTrigger(label: string): HTMLButtonElement {
    const trigger = Array.from(document.querySelectorAll("[role='menuitem'][aria-haspopup='menu']")).find(
      (element): element is HTMLButtonElement => element.textContent?.trim() === label,
    );

    if (!trigger) {
      throw new Error(`Menu trigger not found: ${label}`);
    }

    return trigger;
  }

  function getMenuItem(label: string): HTMLButtonElement {
    const item = Array.from(document.querySelectorAll("[role='menu'] [role='menuitem']")).find(
      (element): element is HTMLButtonElement => element.textContent?.trim() === label,
    );

    if (!item) {
      throw new Error(`Menu item not found: ${label}`);
    }

    return item;
  }

  function click(element: Element) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function keydown(element: Element, key: string) {
    act(() => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }
});
