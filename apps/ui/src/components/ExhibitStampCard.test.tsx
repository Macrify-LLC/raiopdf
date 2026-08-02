// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingState } from "../hooks/useEditing";
import {
  allocateIdentifier,
  listExhibitStampTemplates,
  resetExhibitStampCacheForTests,
} from "../lib/exhibitStamps";
import { ExhibitStampCard } from "./ExhibitStampCard";
import { resetDialogStackForTests } from "./FloatingDialog";

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
    resetDialogStackForTests();
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

  it("opens the designer from New design... and from a card's Edit design...", async () => {
    await render();

    await clickByText("New design...");
    expect(dialogTitle()).toBe("New exhibit stamp");

    await clickByLabel(`Close New exhibit stamp`);
    expect(document.querySelector("[role='dialog']")).toBeNull();

    await clickByText("Edit design...");
    expect(dialogTitle()).toBe("Edit exhibit stamp");
    expect(
      container?.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')?.value,
    ).toBe("Plaintiff's Exhibit");
  });

  it("re-derives the Next field when a design's numbering style changes", async () => {
    await render();

    await allocateIdentifier(PLAINTIFF);

    // Editing the design from numbers to letters must not leave the mounted
    // card's Next draft showing the old digit representation.
    await clickByText("Edit design...", 0);
    const numbering = container?.querySelector(
      'select[aria-label="Stamp numbering"]',
    ) as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )?.set;
      setter?.call(numbering, "letters");
      numbering.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await clickByText("Save Design", 0);

    const after = container?.querySelector(
      'input[aria-label="Next exhibit for Plaintiff\'s Exhibit"]',
    ) as HTMLInputElement;
    expect(after.value).toBe("B");
  });

  it("duplicates a design with a fresh, independent counter", async () => {
    await render();

    // Advance the original's counter so the duplicate's independence is
    // actually being tested, not just its initial value.
    await allocateIdentifier(PLAINTIFF);
    await allocateIdentifier(PLAINTIFF);

    await clickByText("Duplicate", 0);

    const names = [...(container?.querySelectorAll(".exhibit-stamp-card__name") ?? [])].map(
      (element) => element.textContent,
    );
    expect(names).toContain("Plaintiff's Exhibit copy");

    resetExhibitStampCacheForTests();
    const duplicate = listExhibitStampTemplates().find(
      (template) => template.name === "Plaintiff's Exhibit copy",
    );
    expect(duplicate?.nextIndex).toBe(0);

    const original = listExhibitStampTemplates().find((template) => template.id === PLAINTIFF);
    expect(original?.nextIndex).toBe(2);
  });

  it("asks for confirmation before deleting, and disarms the deleted template if it was armed", async () => {
    const disarmExhibitStamp = vi.fn();
    await render({
      armedExhibitStamp: {
        templateId: PLAINTIFF,
        label: "Plaintiff's Exhibit 1",
        lines: ["Plaintiff's Exhibit", "1"],
        sequence: { schemaVersion: 1, identifierStyle: "numbers", prefix: "Plaintiff's Exhibit", layout: "stacked", index: 0 },
        template: listExhibitStampTemplates().find((template) => template.id === PLAINTIFF)!,
      },
      disarmExhibitStamp,
    });

    vi.spyOn(window, "confirm").mockReturnValue(false);
    await clickByLabel("Delete Plaintiff's Exhibit");
    expect(disarmExhibitStamp).not.toHaveBeenCalled();
    expect(listExhibitStampTemplates().map((template) => template.id)).toContain(PLAINTIFF);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await clickByLabel("Delete Plaintiff's Exhibit");
    expect(disarmExhibitStamp).toHaveBeenCalledOnce();
    expect(listExhibitStampTemplates().map((template) => template.id)).not.toContain(PLAINTIFF);
  });

  it("reorders designs and persists the new order", async () => {
    await render();

    expect(cardNames()).toEqual(["Plaintiff's Exhibit", "Defendant's Exhibit", "Exhibit"]);

    await clickByLabel("Move Plaintiff's Exhibit down");

    expect(cardNames()).toEqual(["Defendant's Exhibit", "Plaintiff's Exhibit", "Exhibit"]);

    resetExhibitStampCacheForTests();
    expect(listExhibitStampTemplates().map((template) => template.name)).toEqual([
      "Defendant's Exhibit",
      "Plaintiff's Exhibit",
      "Exhibit",
    ]);
  });

  function cardNames(): (string | null)[] {
    return [...(container?.querySelectorAll(".exhibit-stamp-card__name") ?? [])].map(
      (element) => element.textContent,
    );
  }

  function dialogTitle(): string | null | undefined {
    return document.querySelector("[role='dialog'] h2")?.textContent;
  }

  async function clickByLabel(ariaLabel: string): Promise<void> {
    const element = document.querySelector<HTMLElement>(`[aria-label="${ariaLabel}"]`);

    if (!element) {
      throw new Error(`expected an element labeled "${ariaLabel}"`);
    }

    await act(async () => {
      element.click();
    });
    await settle();
  }

  async function clickByText(text: string, occurrence = 0): Promise<void> {
    const candidates = [...document.querySelectorAll<HTMLElement>("button")].filter(
      (button) => button.textContent?.trim() === text,
    );
    const element = candidates[occurrence];

    if (!element) {
      throw new Error(`expected a button with text "${text}" (occurrence ${occurrence})`);
    }

    await act(async () => {
      element.click();
    });
    await settle();
  }

  /** Some actions (delete's confirm prompt, duplicate/reorder's store commit)
   *  chain several promises deep before their state update lands -- one tick
   *  isn't always enough, so this settles a handful under `act` before the
   *  caller reads the DOM. */
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

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
