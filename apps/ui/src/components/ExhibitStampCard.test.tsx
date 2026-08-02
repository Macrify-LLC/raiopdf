// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingState } from "../hooks/useEditing";
import {
  listExhibitStampTemplates,
  resetExhibitStampCacheForTests,
} from "../lib/exhibitStamps";
import { ExhibitStampCard } from "./ExhibitStampCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAINTIFF = "plaintiffs-exhibit";

describe("ExhibitStampCard", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let armExhibitStamp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    resetExhibitStampCacheForTests();
    armExhibitStamp = vi.fn(() => true);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it("previews the next label on every stamp and arms the one that is clicked", async () => {
    await render();

    const picks = [...(container?.querySelectorAll(".exhibit-stamp-card__pick") ?? [])];

    expect(picks.map((pick) => pick.getAttribute("aria-label"))).toEqual([
      "Use Plaintiff's Exhibit, next 1",
      "Use Defendant's Exhibit, next A",
      "Use Exhibit, next A",
    ]);
    expect(picks[0]?.textContent).toContain("Plaintiff's Exhibit");

    await act(async () => {
      (picks[0] as HTMLElement).click();
      await Promise.resolve();
    });

    expect(armExhibitStamp).toHaveBeenCalledWith(PLAINTIFF);
    // Picking a stamp reserves nothing — the counter only moves on placement.
    expect(nextIndex()).toBe(0);
  });

  it("points the counter at the exhibit typed into Next", async () => {
    await render();

    const field = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Next exhibit for Plaintiff\'s Exhibit"]',
    );
    expect(field?.value).toBe("1");

    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      setValue?.call(field, "12");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      field!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await flushStore();
    });

    expect(nextIndex()).toBe(11);
  });

  it("refuses an unreadable exhibit and says so", async () => {
    const setMessage = vi.fn();
    await render({ setMessage });

    const field = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Next exhibit for Plaintiff\'s Exhibit"]',
    );
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      setValue?.call(field, "12A");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
      field!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await flushStore();
    });

    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining("Enter a number"));
    expect(nextIndex()).toBe(0);
  });

  /** The store commits through a promise chain and a Web Lock shim. */
  async function flushStore(): Promise<void> {
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve();
    }
  }

  function nextIndex(): number {
    resetExhibitStampCacheForTests();

    return (
      listExhibitStampTemplates().find((template) => template.id === PLAINTIFF)?.nextIndex ?? -1
    );
  }

  async function render(overrides: Partial<EditingState> = {}): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const editing = {
      armedExhibitStamp: null,
      armExhibitStamp,
      refreshArmedExhibitStamp: () => undefined,
      disarmExhibitStamp: () => undefined,
      setMessage: () => undefined,
      ...overrides,
    } as unknown as EditingState;

    await act(async () => {
      root?.render(<ExhibitStampCard editing={editing} />);
      await Promise.resolve();
    });
  }
});
