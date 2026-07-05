// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBar, type CommandBarProps } from "./CommandBar";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("CommandBar page input", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    host?.remove();
    root = null;
    host = null;
  });

  it("jumps to a typed page on Enter", () => {
    const onGoToPage = vi.fn();
    const input = renderCommandBar({ onGoToPage });

    change(input, "7");
    keyDown(input, "Enter");

    expect(onGoToPage).toHaveBeenCalledWith(7);
    expect(input.value).toBe("7");
  });

  it("does not jump when committing the current page", () => {
    const onGoToPage = vi.fn();
    const input = renderCommandBar({ onGoToPage, currentPage: 4 });

    change(input, "04");
    blur(input);

    expect(onGoToPage).not.toHaveBeenCalled();
    expect(input.value).toBe("4");
  });

  it("clamps typed pages to the document range", () => {
    const onGoToPage = vi.fn();
    const input = renderCommandBar({ onGoToPage, pageCount: 9 });

    change(input, "99");
    blur(input);

    expect(onGoToPage).toHaveBeenCalledWith(9);
    expect(input.value).toBe("9");
  });

  it("reverts empty input without jumping", () => {
    const onGoToPage = vi.fn();
    const input = renderCommandBar({ onGoToPage, currentPage: 4 });

    change(input, "");
    keyDown(input, "Enter");

    expect(onGoToPage).not.toHaveBeenCalled();
    expect(input.value).toBe("4");
  });

  it("reverts on Escape without jumping", () => {
    const onGoToPage = vi.fn();
    const input = renderCommandBar({ onGoToPage, currentPage: 4 });

    change(input, "8");
    keyDown(input, "Escape");
    blur(input);

    expect(onGoToPage).not.toHaveBeenCalled();
    expect(input.value).toBe("4");
  });

  function renderCommandBar(overrides: Partial<CommandBarProps> = {}): HTMLInputElement {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <CommandBar
          hasDocument
          currentPage={2}
          pageCount={10}
          onOpen={() => undefined}
          onSave={() => undefined}
          onPrint={() => undefined}
          onPreviousPage={() => undefined}
          onNextPage={() => undefined}
          onZoomOut={() => undefined}
          onZoomIn={() => undefined}
          {...overrides}
        />,
      );
    });

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Go to page"]');

    if (!input) {
      throw new Error("Page input was not rendered.");
    }

    return input;
  }
});

function change(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keyDown(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function blur(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}
