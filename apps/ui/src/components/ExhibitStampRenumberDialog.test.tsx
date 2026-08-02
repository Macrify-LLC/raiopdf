// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingState } from "../hooks/useEditing";
import { resetExhibitStampCacheForTests } from "../lib/exhibitStamps";
import { ExhibitStampRenumberDialog } from "./ExhibitStampRenumberDialog";
import { resetDialogStackForTests } from "./FloatingDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAINTIFF = "plaintiffs-exhibit";

describe("ExhibitStampRenumberDialog", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let renumberExhibitStamps: ReturnType<typeof vi.fn>;
  let cancelExhibitStampRenumber: ReturnType<typeof vi.fn>;
  let setMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    resetExhibitStampCacheForTests();
    renumberExhibitStamps = vi.fn(() =>
      Promise.resolve({ count: 3, lastIndex: 2, counterError: null }),
    );
    cancelExhibitStampRenumber = vi.fn();
    setMessage = vi.fn();
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

  it("names the range it will produce and renumbers from the first exhibit", async () => {
    await render();

    expect(question()).toBe(
      "Renumber 3 stamps as Plaintiff's Exhibit 1…Plaintiff's Exhibit 3?",
    );

    await clickText("Renumber");

    expect(renumberExhibitStamps).toHaveBeenCalledWith(PLAINTIFF, 0);
    expect(setMessage).toHaveBeenCalledWith(
      "Renumbered 3 stamps from Plaintiff's Exhibit 1.",
    );
    expect(cancelExhibitStampRenumber).toHaveBeenCalled();
  });

  it("renumbers from the identifier typed into Start at", async () => {
    await render();

    await typeStart("12");

    expect(question()).toBe(
      "Renumber 3 stamps as Plaintiff's Exhibit 12…Plaintiff's Exhibit 14?",
    );

    await clickText("Renumber");

    expect(renumberExhibitStamps).toHaveBeenCalledWith(PLAINTIFF, 11);
  });

  it("refuses a start it cannot read, and renumbers nothing", async () => {
    await render();

    await typeStart("twelve");
    await clickText("Renumber");

    expect(renumberExhibitStamps).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Enter a number",
    );
  });

  it("says which stamps it cannot reach in a streamed document", async () => {
    await render({ documentStreamed: true });

    expect(container?.ownerDocument.body.textContent).toContain(
      "Stamps saved in this large document can't be renumbered yet",
    );
  });

  it("passes a failed counter write along with the renumber it did do", async () => {
    renumberExhibitStamps = vi.fn(() =>
      Promise.resolve({
        count: 3,
        lastIndex: 2,
        counterError: "The exhibit number could not be saved on this computer.",
      }),
    );

    await render();
    await clickText("Renumber");

    expect(setMessage).toHaveBeenCalledWith(
      "Renumbered 3 stamps from Plaintiff's Exhibit 1. " +
        "The exhibit number could not be saved on this computer.",
    );
  });

  function question(): string | null | undefined {
    return document.querySelector(".exhibit-stamp-renumber__question")?.textContent;
  }

  async function typeStart(value: string): Promise<void> {
    const field = document.querySelector<HTMLInputElement>(
      'input[aria-label="Start renumbering at"]',
    );
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      setValue?.call(field, value);
      field!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function clickText(text: string): Promise<void> {
    const button = [...document.querySelectorAll<HTMLElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );

    if (!button) {
      throw new Error(`expected a button labeled "${text}"`);
    }

    await act(async () => {
      button.click();
    });
    // The renumber resolves through a promise chain before the dialog closes.
    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function render(options: { documentStreamed?: boolean } = {}): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const editing = {
      exhibitStampRenumberRequest: { templateId: PLAINTIFF, count: 3 },
      renumberExhibitStamps,
      cancelExhibitStampRenumber,
      setMessage,
    } as unknown as EditingState;

    await act(async () => {
      root?.render(
        <ExhibitStampRenumberDialog
          editing={editing}
          documentStreamed={options.documentStreamed ?? false}
        />,
      );
      await Promise.resolve();
    });
  }
});
