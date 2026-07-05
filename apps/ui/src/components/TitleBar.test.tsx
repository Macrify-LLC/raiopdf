// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar, type TitleBarProps } from "./TitleBar";

describe("TitleBar tab context menu", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

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

  it("renders Move to New Window for a movable tab and dispatches the tab id", () => {
    const onTabMoveToNewWindowRequested = vi.fn();
    render({
      onTabMoveToNewWindowRequested,
      tabs: [
        { id: "tab-1", fileName: "alpha.pdf", active: true, canMoveToNewWindow: true },
      ],
    });

    contextMenu(getTab("alpha.pdf"));

    const item = getMenuItem("Move to New Window");
    expect(item.disabled).toBe(false);

    click(item);
    expect(onTabMoveToNewWindowRequested).toHaveBeenCalledWith("tab-1");
  });

  it("disables Move to New Window when the tab has no saved source", () => {
    const onTabMoveToNewWindowRequested = vi.fn();
    render({
      onTabMoveToNewWindowRequested,
      tabs: [
        {
          id: "tab-1",
          fileName: "unsaved.pdf",
          active: true,
          dirty: true,
          canMoveToNewWindow: false,
        },
      ],
    });

    contextMenu(getTab("unsaved.pdf"));

    const item = getMenuItem("Move to New Window");
    expect(item.disabled).toBe(true);

    click(item);
    expect(onTabMoveToNewWindowRequested).not.toHaveBeenCalled();
  });

  it("omits the tab context menu outside the desktop runtime", () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    render({
      tabs: [
        { id: "tab-1", fileName: "alpha.pdf", active: true, canMoveToNewWindow: true },
      ],
    });

    contextMenu(getTab("alpha.pdf"));

    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  function render(overrides: Partial<TitleBarProps>) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <TitleBar
          tabs={[]}
          onTabSelected={() => undefined}
          onTabCloseRequested={() => undefined}
          onTabMoveToNewWindowRequested={() => undefined}
          hasDocument={false}
          canUndo={false}
          onMenuCommand={() => undefined}
          onOpenAbout={() => undefined}
          {...overrides}
        />,
      );
    });
  }
});

function getTab(name: string): HTMLElement {
  const tab = [...document.querySelectorAll<HTMLElement>(".title-bar__tab")]
    .find((element) => element.textContent?.includes(name));
  if (!tab) {
    throw new Error(`Missing tab ${name}`);
  }
  return tab;
}

function getMenuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
    .find((element) => element.textContent === label);
  if (!item) {
    throw new Error(`Missing menu item ${label}`);
  }
  return item;
}

function contextMenu(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    }));
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
