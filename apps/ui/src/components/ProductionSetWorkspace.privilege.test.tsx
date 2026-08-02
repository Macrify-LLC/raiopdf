// @vitest-environment jsdom
//
// Per-file status select (Produce / Produce with redactions / Withhold),
// the privilege-asserted/description fields it reveals, the required-field
// build gate for a withheld row, the draft-privilege-log warning line, and
// the completion card's withheld/redacted summary.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionSetWorkspace,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./ProductionSetWorkspace";

const idleProgress: ProductionSetProgress = { running: false, message: null, result: null };

describe("ProductionSetWorkspace withhold / produce-redacted (draft privilege log)", () => {
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

  function selectValue(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    act(() => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
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

  it("defaults every row to Produce, with no privilege fields and no warning line", () => {
    render();

    expect(statusSelect().value).toBe("produce");
    expect(fieldByLabel("Privilege asserted")).toBeNull();
    expect(container?.textContent).not.toContain("A draft privilege log will be written");
  });

  it("reveals Privilege asserted and Description once a row is set to Withhold, and shows the warning line", () => {
    render();

    selectValue(statusSelect(), "withhold");

    expect(fieldByLabel("Privilege asserted")).not.toBeNull();
    expect(fieldByLabel("Description")).not.toBeNull();
    expect(container?.textContent).toContain("A draft privilege log will be written");
    expect(container?.textContent).toContain("NOT ready to serve");
  });

  it("discards privilege text and its overflow weight when a row reverts to Produce", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    selectValue(statusSelect(), "withhold");
    typeInto(fieldByLabel("Privilege asserted") as HTMLInputElement, "Attorney-client privilege");
    typeInto(fieldByLabel("Description") as HTMLInputElement, "Counsel email");

    // Back to Produce: the sensitive text must not linger unseen or be
    // forwarded to the build.
    selectValue(statusSelect(), "produce");
    expect(fieldByLabel("Privilege asserted")).toBeNull();

    selectValue(statusSelect(), "withhold");
    expect((fieldByLabel("Privilege asserted") as HTMLInputElement).value).toBe("");
    selectValue(statusSelect(), "produce");

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");
    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const files = onRun.mock.calls[0]?.[0]?.files ?? [];
    expect(files[0]?.privilegeAsserted).toBe("");
    expect(files[0]?.basis).toBe("");
  });

  it("reveals the same fields for Produce with redactions", () => {
    render();

    selectValue(statusSelect(), "produce-redacted");

    expect(fieldByLabel("Privilege asserted")).not.toBeNull();
    expect(fieldByLabel("Description")).not.toBeNull();
    expect(container?.textContent).toContain("A draft privilege log will be written");
  });

  it("gates Build Production on a missing privilege basis for a withheld row", () => {
    render();

    selectValue(statusSelect(), "withhold");
    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    expect(buttonByText("Build Production").disabled).toBe(true);

    const privilegeInput = fieldByLabel("Privilege asserted");
    if (!privilegeInput) {
      throw new Error("Privilege asserted input not found");
    }
    typeInto(privilegeInput, "Attorney-client privilege");

    expect(buttonByText("Build Production").disabled).toBe(false);
  });

  it("threads status, privilegeAsserted, basis, and includeFilenameInPrivilegeLog through onRun", async () => {
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({ onRun });

    selectValue(statusSelect(), "withhold");
    const privilegeInput = fieldByLabel("Privilege asserted")!;
    typeInto(privilegeInput, "Attorney-client privilege");
    const descriptionInput = fieldByLabel("Description")!;
    typeInto(descriptionInput, "Internal legal memo");

    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "SMITH");

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    const input = onRun.mock.calls[0]?.[0];
    expect(input?.files[0]).toMatchObject({
      status: "withhold",
      privilegeAsserted: "Attorney-client privilege",
      basis: "Internal legal memo",
    });
    expect(input?.includeFilenameInPrivilegeLog).toBe(true);
  });

  it("shows the withheld/redacted summary and privilege log location on the completion card", () => {
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
          withheldCount: 1,
          redactedCount: 2,
          privilegeLogLocation: "draft-privilege-log.csv",
        },
      },
    });

    expect(container?.textContent).toContain("1 withheld");
    expect(container?.textContent).toContain("2 with redactions");
    expect(container?.textContent).toContain("draft privilege log written");
    expect(container?.textContent).toContain("Privilege log");
    expect(container?.textContent).toContain("draft-privilege-log.csv");
  });

  it("omits the privilege log row and summary on the completion card when nothing was withheld or redacted", () => {
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

    expect(container?.textContent).not.toContain("Privilege log");
    expect(container?.textContent).not.toContain("draft privilege log written");
  });
});
