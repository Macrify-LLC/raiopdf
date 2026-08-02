// @vitest-environment jsdom
//
// "Litigation load file (DAT)" checkbox: unchecked by default, threads
// includeLoadFiles through onRun, and the completion card surfaces
// progress.result.loadFileDat when the build wrote one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionSetWorkspace,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./ProductionSetWorkspace";

const idleProgress: ProductionSetProgress = { running: false, message: null, result: null };

describe("ProductionSetWorkspace load file (DAT)", () => {
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
  } = {}) {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={{ name: "source.pdf", path: "/cases/source.pdf" }}
          currentPageCount={5}
          progress={options.progress ?? idleProgress}
          onAddFile={async () => null}
          onRun={options.onRun ?? (async () => undefined)}
        />,
      );
    });
  }

  function loadFileCheckbox(): HTMLInputElement {
    const label = Array.from(window.document.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes("Litigation load file (DAT)"),
    );
    const input = label?.querySelector("input[type='checkbox']");
    if (!input) {
      throw new Error("Litigation load file (DAT) checkbox not found");
    }
    return input as HTMLInputElement;
  }

  function outputDirInput(): HTMLInputElement {
    return window.document.querySelector("input[placeholder='Choose an empty folder...']") as HTMLInputElement;
  }

  function prefixInput(): HTMLInputElement {
    return window.document.querySelector("input[placeholder='e.g. SMITH']") as HTMLInputElement;
  }

  function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
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

  function buttonByText(text: string): HTMLButtonElement {
    const button = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(`Button not found containing: ${text}`);
    }
    return button;
  }

  it("renders unchecked by default and sends includeLoadFiles: false unless checked", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    expect(loadFileCheckbox().checked).toBe(false);

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({ includeLoadFiles: false });
  });

  it("threads includeLoadFiles: true through onRun once checked", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    click(loadFileCheckbox());
    expect(loadFileCheckbox().checked).toBe(true);

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun.mock.calls[0]?.[0]).toMatchObject({ includeLoadFiles: true });
  });

  it("shows the load file location on the completion card when the build wrote one", () => {
    render({
      progress: {
        running: false,
        message: null,
        result: {
          packageRoot: "/tmp/production-package",
          indexLocation: "/tmp/production-package/production-index.pdf",
          nextNumber: 4,
          fileCount: 1,
          duplicateCount: 0,
          loadFileDat: "production.dat",
          withheldCount: 0,
          redactedCount: 0,
          privilegeLogLocation: null,
        },
      },
    });

    expect(container?.textContent).toContain("Load file");
    expect(container?.textContent).toContain("production.dat");
  });

  it("omits the load file row on the completion card when none was written", () => {
    render({
      progress: {
        running: false,
        message: null,
        result: {
          packageRoot: "/tmp/production-package",
          indexLocation: "/tmp/production-package/production-index.pdf",
          nextNumber: 4,
          fileCount: 1,
          duplicateCount: 0,
          loadFileDat: null,
          withheldCount: 0,
          redactedCount: 0,
          privilegeLogLocation: null,
        },
      },
    });

    expect(container?.textContent).not.toContain("Load file");
  });
});
