// @vitest-environment jsdom
//
// Bates continuation ("Continue from prior production…"): prefill from a
// mocked pick, lock/detach, and the "Adjust start…" override-reason gate.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionSetWorkspace,
  type ProductionContinuationPickOutcome,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./ProductionSetWorkspace";
import { writeProductionLastUsed } from "../lib/productionHints";

const idleProgress: ProductionSetProgress = { running: false, message: null, result: null };

const PICKED: ProductionContinuationPickOutcome = {
  status: "picked",
  pick: {
    grant: "grant-prior-package",
    summary: {
      prefix: "SMITH",
      digits: 6,
      nextNumber: 123,
      lastBates: "SMITH000122",
      createdAt: "2026-07-14T10:00:00.000Z",
      fileCount: 4,
    },
  },
};

describe("ProductionSetWorkspace Bates continuation", () => {
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
    window.localStorage.clear();
  });

  function render(options: {
    progress?: ProductionSetProgress;
    onRun?: (input: ProductionSetRunInput) => Promise<void>;
    onContinueFromPriorProduction?: () => Promise<ProductionContinuationPickOutcome>;
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
          onContinueFromPriorProduction={options.onContinueFromPriorProduction}
        />,
      );
    });
  }

  function prefixInput(): HTMLInputElement {
    return window.document.querySelector("input[placeholder='e.g. SMITH']") as HTMLInputElement;
  }

  function startInput(): HTMLInputElement {
    const inputs = Array.from(window.document.querySelectorAll("input[type='number']"));
    const input = inputs[0];
    if (!input) {
      throw new Error("Start input not found");
    }
    return input as HTMLInputElement;
  }

  function digitsInput(): HTMLInputElement {
    const inputs = Array.from(window.document.querySelectorAll("input[type='number']"));
    const input = inputs[1];
    if (!input) {
      throw new Error("Digits input not found");
    }
    return input as HTMLInputElement;
  }

  function outputDirInput(): HTMLInputElement {
    return window.document.querySelector("input[placeholder='Choose an empty folder...']") as HTMLInputElement;
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

  function queryButtonByText(text: string): HTMLButtonElement | null {
    return (
      Array.from(window.document.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(text),
      ) as HTMLButtonElement | undefined
    ) ?? null;
  }

  function statusLines(): string[] {
    return Array.from(
      window.document.querySelectorAll(".production-workspace__status"),
    ).map((element) => element.textContent ?? "");
  }

  function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("hides the affordance when no picker is wired up (browser build)", () => {
    render();
    expect(queryButtonByText("Continue from prior production…")).toBeNull();
  });

  it("prefills prefix/start/digits and locks them after a successful pick", async () => {
    const onContinueFromPriorProduction = vi.fn(async () => PICKED);
    render({ onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));

    expect(onContinueFromPriorProduction).toHaveBeenCalledTimes(1);
    expect(prefixInput().value).toBe("SMITH");
    expect(prefixInput().disabled).toBe(true);
    expect(startInput().value).toBe("123");
    expect(startInput().disabled).toBe(true);
    expect(digitsInput().value).toBe("6");
    expect(digitsInput().disabled).toBe(true);
    expect(statusLines().some((line) => line.includes("Continuing SMITH from SMITH000123"))).toBe(true);
    expect(statusLines().some((line) => line.includes("SMITH000122"))).toBe(true);
  });

  it("keeps the verified start when a stored last-used hint exists for the prior prefix", async () => {
    // A stale local hint for SMITH must not overwrite the package-verified
    // number after the continuation sets the prefix.
    writeProductionLastUsed("SMITH", 400);
    const onContinueFromPriorProduction = vi.fn(async () => PICKED);
    render({ onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));

    expect(startInput().value).toBe("123");
    expect(startInput().disabled).toBe(true);
  });

  it("shows a plain error message on a failed pick without locking any fields", async () => {
    const onContinueFromPriorProduction = vi.fn(async (): Promise<ProductionContinuationPickOutcome> => ({
      status: "error",
      message: "This folder doesn't look like a RaioPDF production package.",
    }));
    render({ onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));

    expect(statusLines()).toContain("This folder doesn't look like a RaioPDF production package.");
    expect(prefixInput().disabled).toBe(false);
  });

  it("does nothing when the folder pick is cancelled", async () => {
    const onContinueFromPriorProduction = vi.fn(async (): Promise<ProductionContinuationPickOutcome> => ({
      status: "cancelled",
    }));
    render({ onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));

    expect(prefixInput().value).toBe("");
    expect(queryButtonByText("Adjust start…")).toBeNull();
  });

  it("detaching clears the continuation and unlocks the fields, keeping the prefilled values", async () => {
    const onContinueFromPriorProduction = vi.fn(async () => PICKED);
    render({ onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));
    expect(prefixInput().disabled).toBe(true);

    await click(window.document.querySelector("[aria-label='Detach from prior production']") as Element);

    expect(prefixInput().disabled).toBe(false);
    expect(prefixInput().value).toBe("SMITH");
    expect(startInput().disabled).toBe(false);
    expect(startInput().value).toBe("123");
    expect(queryButtonByText("Continue from prior production…")).not.toBeNull();
  });

  it("requires a non-empty reason before Adjust start's changes can run", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    const onContinueFromPriorProduction = vi.fn(async () => PICKED);
    render({ onRun, onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));
    typeInto(outputDirInput(), "/tmp/next-package");

    await click(buttonByText("Adjust start…"));
    expect(startInput().disabled).toBe(false);

    typeInto(startInput(), "500");
    // Reason is empty -- Build Production must stay gated even though every
    // other requirement (files, output dir, prefix) is satisfied.
    expect(buttonByText("Build Production").disabled).toBe(true);

    const reasonInput = window.document.querySelector(
      "input[aria-label='Reason for adjusting the Bates continuation']",
    ) as HTMLInputElement;
    typeInto(reasonInput, "Reserving a supplemental range.");
    expect(buttonByText("Build Production").disabled).toBe(false);

    await click(buttonByText("Build Production"));

    expect(onRun).toHaveBeenCalledTimes(1);
    const call = onRun.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      prefix: "SMITH",
      start: 500,
      continueFrom: "grant-prior-package",
      continuationOverrideReason: "Reserving a supplemental range.",
    });
  });

  it("cancelling Adjust start reverts start/digits to the prefilled continuation values", async () => {
    const onContinueFromPriorProduction = vi.fn(async () => PICKED);
    render({ onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));
    await click(buttonByText("Adjust start…"));
    typeInto(startInput(), "999");

    await click(buttonByText("Cancel adjust"));

    expect(startInput().value).toBe("123");
    expect(startInput().disabled).toBe(true);
  });

  it("passes continueFrom (no override reason) on a strict-mode run", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    const onContinueFromPriorProduction = vi.fn(async () => PICKED);
    render({ onRun, onContinueFromPriorProduction });

    await click(buttonByText("Continue from prior production…"));
    typeInto(outputDirInput(), "/tmp/next-package");

    await click(buttonByText("Build Production"));

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({
      continueFrom: "grant-prior-package",
      continuationOverrideReason: undefined,
    });
  });

  it("shows a continuation note on the completion card", () => {
    render({
      progress: {
        running: false,
        message: null,
        result: {
          packageRoot: "/tmp/next-package",
          indexLocation: null,
          nextNumber: 128,
          fileCount: 5,
          continuation: { mode: "strict", priorLastBates: "SMITH000122" },
          duplicateCount: 0,
        },
      },
    });

    expect(
      Array.from(window.document.querySelectorAll(".production-workspace__result-subtitle"))
        .some((element) => element.textContent?.includes("Continued from prior production")),
    ).toBe(true);
    expect(
      Array.from(window.document.querySelectorAll(".production-workspace__result-subtitle"))
        .some((element) => element.textContent?.includes("SMITH000122")),
    ).toBe(true);
  });
});
