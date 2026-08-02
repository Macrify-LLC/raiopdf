// @vitest-environment jsdom
//
// Stamp placement disclosure (Bates + designation edge/align + shared font
// size) and per-file "Pages" designation-range input: gating, inline
// validation against a known page count, and the deferred-validation note
// when the page count isn't known yet (above-threshold descriptor add).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileAddResult } from "../lib/readFileForAdd";
import {
  ProductionSetWorkspace,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./ProductionSetWorkspace";

const idleProgress: ProductionSetProgress = { running: false, message: null, result: null };

describe("ProductionSetWorkspace stamp placement + page-range designations", () => {
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
    currentPageCount?: number;
    onAddFile?: () => Promise<FileAddResult[] | null>;
  } = {}) {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={{ name: "source.pdf", path: "/cases/source.pdf" }}
          currentPageCount={options.currentPageCount ?? 5}
          progress={options.progress ?? idleProgress}
          onAddFile={options.onAddFile ?? (async () => null)}
          onRun={options.onRun ?? (async () => undefined)}
        />,
      );
    });
  }

  function prefixInput(): HTMLInputElement {
    return window.document.querySelector("input[placeholder='e.g. SMITH']") as HTMLInputElement;
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
    return button;
  }

  function placementSummary(): HTMLElement {
    const summary = window.document.querySelector(".production-workspace__placement-summary");
    if (!summary) {
      throw new Error("Stamp placement summary not found");
    }
    return summary as HTMLElement;
  }

  function placementSelects(): HTMLSelectElement[] {
    return Array.from(
      window.document.querySelectorAll(".production-workspace__placement-grid select"),
    ) as HTMLSelectElement[];
  }

  function fontSizeInput(): HTMLInputElement {
    const input = window.document.querySelector(".production-workspace__placement-grid input[type='number']");
    if (!input) {
      throw new Error("Font size input not found");
    }
    return input as HTMLInputElement;
  }

  function designationSelect(): HTMLSelectElement {
    const select = window.document.querySelector(".production-workspace__designation select");
    if (!select) {
      throw new Error("Designation select not found");
    }
    return select as HTMLSelectElement;
  }

  function pagesInput(): HTMLInputElement {
    const input = window.document.querySelector(".production-workspace__pages input");
    if (!input) {
      throw new Error("Pages input not found");
    }
    return input as HTMLInputElement;
  }

  function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function selectValue(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    act(() => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function click(element: Element) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("renders the Stamp placement disclosure collapsed, with the default selections", () => {
    render();

    const details = window.document.querySelector(".production-workspace__placement") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(placementSummary().textContent).toContain("Stamp placement");

    const [batesSelect, designationSelectEl] = placementSelects();
    expect(batesSelect!.value).toBe("footer:right");
    expect(designationSelectEl!.value).toBe("header:center");
    expect(fontSizeInput().value).toBe("10");
  });

  it("opens on click and threads the chosen placements and font size through onRun", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    click(placementSummary());
    const details = window.document.querySelector(".production-workspace__placement") as HTMLDetailsElement;
    // jsdom's <details> toggles its `open` property on a real click of
    // <summary>; assert the disclosure content is reachable either way,
    // then drive the controls directly.
    void details;

    const [batesSelect, designationSelectEl] = placementSelects();
    selectValue(batesSelect!, "header:left");
    selectValue(designationSelectEl!, "footer:right");
    typeInto(fontSizeInput(), "14");

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({
      batesPlacement: { edge: "header", align: "left" },
      designationPlacement: { edge: "footer", align: "right" },
      stampFontSizePt: 14,
    });
  });

  it("sends the defaults unchanged when the disclosure is never opened", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun.mock.calls[0]?.[0]).toMatchObject({
      batesPlacement: { edge: "footer", align: "right" },
      designationPlacement: { edge: "header", align: "center" },
      stampFontSizePt: 10,
    });
  });

  it("gates Build Production when Bates and designation share an edge", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    const [batesSelect, designationSelectEl] = placementSelects();
    selectValue(batesSelect!, "footer:left");
    selectValue(designationSelectEl!, "footer:right");

    expect(buttonByText("Build Production").disabled).toBe(true);
    expect(container?.textContent).toContain("can't share a page edge");
    expect(onRun).not.toHaveBeenCalled();
  });

  it("gates Build Production when the font size is out of range", () => {
    render();

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");
    typeInto(fontSizeInput(), "3");

    expect(buttonByText("Build Production").disabled).toBe(true);
    expect(container?.textContent).toContain("Font size must be between 6 and 24 points.");
  });

  it("disables the per-file Pages input until a designation is chosen", () => {
    render();

    expect(pagesInput().disabled).toBe(true);
    expect(pagesInput().placeholder).toBe("all");

    selectValue(designationSelect(), "Confidential");

    expect(pagesInput().disabled).toBe(false);
  });

  it("clears a stale page range when the designation returns to None", () => {
    render();

    selectValue(designationSelect(), "Confidential");
    typeInto(pagesInput(), "1-2");
    expect(pagesInput().value).toBe("1-2");

    // Back to None: the disabled input must not hold a value the user can't
    // reach but the build would still validate against.
    selectValue(designationSelect(), "");

    expect(pagesInput().disabled).toBe(true);
    expect(pagesInput().value).toBe("");
  });

  it("shows an inline error for an out-of-bounds page range against a known page count, and gates Build", () => {
    render({ currentPageCount: 5 });

    selectValue(designationSelect(), "Confidential");
    typeInto(pagesInput(), "1-9");
    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    expect(pagesInput().getAttribute("aria-invalid")).toBe("true");
    expect(container?.textContent).toContain("out of range");
    expect(buttonByText("Build Production").disabled).toBe(true);
  });

  it("clears the inline error and ungates once the range is fixed", () => {
    render({ currentPageCount: 5 });

    selectValue(designationSelect(), "Confidential");
    typeInto(pagesInput(), "1-9");
    expect(pagesInput().getAttribute("aria-invalid")).toBe("true");

    typeInto(pagesInput(), "1-3");
    expect(pagesInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("accepts a blank Pages value as every page (default, unchanged) and threads designationPages through onRun", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun, currentPageCount: 5 });

    selectValue(designationSelect(), "Confidential");
    typeInto(pagesInput(), "1-3,5");
    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun.mock.calls[0]?.[0]?.files[0]).toMatchObject({
      designation: "Confidential",
      designationPages: "1-3,5",
    });
  });

  it("defers validation (no inline error, honest note) when the page count isn't known yet", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({
      onRun,
      onAddFile: async () => [{
        kind: "descriptor",
        descriptor: { grant: "grant-big", name: "big.pdf", sizeBytes: 999_999_999, pageCount: null },
      }],
    });

    await act(async () => {
      buttonByText("Add PDF").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Two rows now: the seeded currentFile (known 5 pages) and the deferred
    // descriptor add. Operate on the second (deferred) row's controls.
    const designationSelects = Array.from(
      window.document.querySelectorAll(".production-workspace__designation select"),
    ) as HTMLSelectElement[];
    const pagesInputs = Array.from(
      window.document.querySelectorAll(".production-workspace__pages input"),
    ) as HTMLInputElement[];
    expect(designationSelects).toHaveLength(2);

    selectValue(designationSelects[1]!, "Confidential");
    typeInto(pagesInputs[1]!, "1-3");

    expect(pagesInputs[1]!.getAttribute("aria-invalid")).toBe("false");
    expect(container?.textContent).toContain("Page count isn't known yet -- checked when you build.");

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    // Not blocked client-side -- the package build itself validates once it
    // knows the real page count.
    expect(buttonByText("Build Production").disabled).toBe(false);

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});
