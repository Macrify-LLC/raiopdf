// @vitest-environment jsdom
//
// Trust-critical Production Set behaviors: no sample Bates prefix, explicit
// no-prefix opt-in, Browse gating outside the desktop app, and the
// completion card's Open folder reveal.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BATES_PREFIX_GATE_MESSAGE } from "../hooks/useBatesPrefix";
import {
  ProductionSetWorkspace,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./ProductionSetWorkspace";

const idleProgress: ProductionSetProgress = { running: false, message: null, result: null };

describe("ProductionSetWorkspace trust behaviors", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  function render(options: {
    progress?: ProductionSetProgress;
    onRun?: (input: ProductionSetRunInput) => Promise<void>;
    onOpenPackageRoot?: ((path: string) => void) | undefined;
  } = {}) {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={{ name: "source.pdf", path: "/cases/source.pdf" }}
          currentPageCount={3}
          progress={options.progress ?? idleProgress}
          onAddFile={async () => null}
          onRun={options.onRun ?? (async () => undefined)}
          onOpenPackageRoot={options.onOpenPackageRoot}
        />,
      );
    });
  }

  function prefixInput(): HTMLInputElement {
    const input = window.document.querySelector("input[placeholder='e.g. SMITH']");
    if (!input) {
      throw new Error("Prefix input not found");
    }
    return input as HTMLInputElement;
  }

  function outputDirInput(): HTMLInputElement {
    const input = window.document.querySelector("input[placeholder='Choose an empty folder...']");
    if (!input) {
      throw new Error("Package root input not found");
    }
    return input as HTMLInputElement;
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(`Button not found containing: ${text}`);
    }
    return button as HTMLButtonElement;
  }

  function statusLines(): string[] {
    return Array.from(
      window.document.querySelectorAll(".production-workspace__status"),
    ).map((element) => element.textContent ?? "");
  }

  function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;

    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function click(element: Element) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("starts with an empty prefix and a sample placeholder instead of a live default", () => {
    render();

    expect(prefixInput().value).toBe("");
    expect(prefixInput().placeholder).toBe("e.g. SMITH");
  });

  it("keeps Build Production gated until a prefix is typed or no-prefix is chosen", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    typeInto(outputDirInput(), "/tmp/production-package");
    expect(buttonByText("Build Production").disabled).toBe(true);

    // The reason is visible, not just a gray button: title on the disabled
    // button AND a proactive status line in the Bates section.
    expect(buttonByText("Build Production").title).toBe(BATES_PREFIX_GATE_MESSAGE);
    expect(statusLines()).toContain(BATES_PREFIX_GATE_MESSAGE);

    const checkbox = window.document.querySelector(
      ".production-workspace__checkbox-row input[type='checkbox']",
    ) as HTMLInputElement;
    click(checkbox);
    expect(prefixInput().disabled).toBe(true);

    const build = buttonByText("Build Production");
    expect(build.disabled).toBe(false);
    expect(build.title).toBe("");
    expect(statusLines()).not.toContain(BATES_PREFIX_GATE_MESSAGE);

    await act(async () => {
      build.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({ prefix: "" });
  });

  it("enables Build Production once a prefix is typed", () => {
    render();

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    expect(buttonByText("Build Production").disabled).toBe(false);
  });

  it("renders Browse disabled outside the desktop app, with the reason", () => {
    render();

    const browse = buttonByText("Browse…");
    expect(browse.disabled).toBe(true);
    expect(browse.title).toBe("Browsing for a folder only works in the installed RaioPDF app.");
  });

  it("reveals the finished package root from the completion card", () => {
    const onOpenPackageRoot = vi.fn();
    render({
      progress: {
        running: false,
        message: null,
        result: {
          packageRoot: "/tmp/production-package",
          indexLocation: "/tmp/production-package/index.pdf",
          nextNumber: 4,
          fileCount: 1,
        },
      },
      onOpenPackageRoot,
    });

    click(buttonByText("Open folder"));

    expect(onOpenPackageRoot).toHaveBeenCalledWith("/tmp/production-package");
  });
});
