// @vitest-environment jsdom
//
// The "Withheld documents:" slip-sheet/omit choice: it only appears once a
// row is Withhold, defaults to the slip-sheet radio, threads
// `withheldHandling` through to `onRun`, and the completion card mentions
// "N slip sheets" when the result reports any.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionSetWorkspace,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./ProductionSetWorkspace";

const idleProgress: ProductionSetProgress = { running: false, message: null, result: null };

describe("ProductionSetWorkspace withheld handling (slip sheets)", () => {
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

  function statusSelect(): HTMLSelectElement {
    const label = Array.from(window.document.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes("Status"),
    );
    const select = label?.querySelector("select");
    if (!select) {
      throw new Error("Status select not found");
    }
    return select as HTMLSelectElement;
  }

  function fieldByLabel(text: string): HTMLInputElement | null {
    const label = Array.from(window.document.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    return (label?.querySelector("input") as HTMLInputElement | null) ?? null;
  }

  function radioByLabel(text: string): HTMLInputElement {
    const label = Array.from(window.document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    const input = label?.querySelector('input[type="radio"]');
    if (!input) {
      throw new Error(`Radio not found for label: ${text}`);
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

  function withholdFirstFile() {
    act(() => {
      statusSelect().value = "withhold";
      statusSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    const privilegeInput = fieldByLabel("Privilege asserted");
    if (privilegeInput) {
      typeInto(privilegeInput, "Attorney-client privilege");
    }
  }

  it("does not show the withheld-handling choice while every file is Produce", () => {
    render();
    expect(container?.textContent).not.toContain("Withheld documents:");
  });

  it("shows the choice once a row is set to Withhold, defaulting to the slip-sheet radio", () => {
    render();
    withholdFirstFile();

    expect(container?.textContent).toContain("Withheld documents:");
    expect(container?.textContent).toContain("Bates-numbered slip sheet in the production (default)");
    expect(container?.textContent).toContain("Leave out entirely");
    expect(radioByLabel("Bates-numbered slip sheet in the production (default)").checked).toBe(true);
    expect(radioByLabel("Leave out entirely").checked).toBe(false);
  });

  it("hides the choice again once the row reverts to Produce", () => {
    render();
    withholdFirstFile();
    expect(container?.textContent).toContain("Withheld documents:");

    act(() => {
      statusSelect().value = "produce";
      statusSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container?.textContent).not.toContain("Withheld documents:");
  });

  it("threads withheldHandling: \"slip-sheet\" through to onRun by default", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });
    withholdFirstFile();
    typeInto(outputDirInput(), "/cases/out");
    typeInto(prefixInput(), "SLIP");

    const buildButton = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Build Production"),
    );
    await act(async () => {
      buildButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]?.withheldHandling).toBe("slip-sheet");
  });

  it("threads withheldHandling: \"omit\" through to onRun once the radio is switched", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });
    withholdFirstFile();

    act(() => {
      radioByLabel("Leave out entirely").click();
    });
    typeInto(outputDirInput(), "/cases/out");
    typeInto(prefixInput(), "OMIT");

    const buildButton = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Build Production"),
    );
    await act(async () => {
      buildButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]?.withheldHandling).toBe("omit");
  });

  it("even without any withheld row, onRun still carries the default withheldHandling", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });
    typeInto(outputDirInput(), "/cases/out");
    typeInto(prefixInput(), "PLAIN");

    const buildButton = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Build Production"),
    );
    await act(async () => {
      buildButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]?.withheldHandling).toBe("slip-sheet");
  });

  it("mentions the slip sheet count on the completion card when the result reports any", () => {
    render({
      progress: {
        running: false,
        message: null,
        result: {
          packageRoot: "/cases/out",
          indexLocation: "production-index.pdf",
          nextNumber: 3,
          fileCount: 2,
          continuation: null,
          duplicateCount: 0,
          loadFileDat: null,
          withheldCount: 1,
          redactedCount: 0,
          privilegeLogLocation: "draft-privilege-log.csv",
          slipSheetCount: 1,
        },
      },
    });

    expect(container?.textContent).toContain("1 slip sheet");
  });

  it("says nothing about slip sheets on the completion card when the result reports none", () => {
    render({
      progress: {
        running: false,
        message: null,
        result: {
          packageRoot: "/cases/out",
          indexLocation: "production-index.pdf",
          nextNumber: 3,
          fileCount: 2,
          continuation: null,
          duplicateCount: 0,
          loadFileDat: null,
          withheldCount: 0,
          redactedCount: 0,
          privilegeLogLocation: null,
          slipSheetCount: 0,
        },
      },
    });

    expect(container?.textContent).not.toContain("slip sheet");
  });
});
