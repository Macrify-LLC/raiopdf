// @vitest-environment jsdom
//
// Trust-critical Legal-panel behaviors: the sensitive-info scanner's
// no-readable-text guard + batch marking, and Bates prefix gating.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SensitiveHit } from "../lib/legalTools";
import { resetDialogStackForTests } from "./FloatingDialog";
import { BatesPanel, ToolPanel, type ScannerPanelState } from "./ToolPanel";

describe("ToolPanel scanner trust behaviors", () => {
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
    resetDialogStackForTests();
  });

  it("frames the scanner note as jurisdiction-generic with Florida as the example", () => {
    render(<ScannerHarness scanner={idleScanner()} />);

    const note = document.querySelector(".tool-panel__card-header .tool-panel__note");
    expect(note?.textContent).toContain("Your jurisdiction");
    expect(note?.textContent).toContain("in Florida, Fla. R. Jud. Admin. 2.425");
    expect(note?.textContent).not.toContain("2.425 governs");
  });

  it("offers Make Searchable when the scan found no readable text", () => {
    const onMakeSearchable = vi.fn();
    render(
      <ScannerHarness
        scanner={{
          ...idleScanner(),
          message: "This document has no readable text to scan.",
          noReadableText: true,
        }}
        onMakeSearchable={onMakeSearchable}
      />,
    );

    const button = getButtonByText("Make Searchable (OCR)…");
    click(button);

    expect(onMakeSearchable).toHaveBeenCalledTimes(1);
  });

  it("renders no OCR affordance for an ordinary clean scan result", () => {
    render(
      <ScannerHarness
        scanner={{
          ...idleScanner(),
          message: "No obvious sensitive patterns found. Review remains yours.",
        }}
      />,
    );

    expect(findButtonByText("Make Searchable (OCR)…")).toBeUndefined();
  });

  it("marks all unmarked hits in one action and reflects already-marked hits", () => {
    const onMarkAllScannerHits = vi.fn();
    render(
      <ScannerHarness
        scanner={{
          ...idleScanner(),
          message: "3 possible items found.",
          hits: [hit("a"), hit("b"), hit("c")],
          markedHitIds: ["b"],
        }}
        onMarkAllScannerHits={onMarkAllScannerHits}
      />,
    );

    const markAll = getButtonByText("Mark all (2) for redaction");
    expect(markAll.disabled).toBe(false);
    click(markAll);
    expect(onMarkAllScannerHits).toHaveBeenCalledTimes(1);

    const markedButton = getButtonByText("Marked for redaction");
    expect(markedButton.disabled).toBe(true);
    expect(
      Array.from(document.querySelectorAll("button")).filter((button) =>
        button.textContent === "Mark for redaction",
      ),
    ).toHaveLength(2);
  });

  it("disables Mark all once every hit is queued", () => {
    render(
      <ScannerHarness
        scanner={{
          ...idleScanner(),
          message: "2 possible items found.",
          hits: [hit("a"), hit("b")],
          markedHitIds: ["a", "b"],
        }}
      />,
    );

    const markAll = getButtonByText("Mark all (0) for redaction");
    expect(markAll.disabled).toBe(true);
    expect(markAll.title).toBe("Every hit is already marked for redaction.");
  });

  function idleScanner(): ScannerPanelState {
    return {
      scanning: false,
      message: null,
      hits: [],
      noReadableText: false,
      markedHitIds: [],
    };
  }

  function hit(id: string): SensitiveHit {
    return {
      id,
      category: "SSN",
      confidence: "high",
      pageIndex: 0,
      excerpt: "•••-••-6789",
      area: { pageIndex: 0, x: 10, y: 10, w: 60, h: 12 },
    };
  }

  interface ScannerHarnessProps {
    scanner: ScannerPanelState;
    onMakeSearchable?: () => void;
    onMarkAllScannerHits?: () => void;
  }

  function ScannerHarness({ scanner, onMakeSearchable, onMarkAllScannerHits }: ScannerHarnessProps) {
    return (
      <ToolPanel
        hasDocument
        ocrState={{ phase: "idle", message: null }}
        ocrStarting={false}
        activeEditTool="select"
        activeEditDialogTool={null}
        activeLegalTool="scanner-2425"
        activeOrganizeTool={null}
        onEditToolSelected={() => undefined}
        onEditDialogToolSelected={() => undefined}
        onLegalToolSelected={() => undefined}
        onOrganizeToolSelected={() => undefined}
        onMakeSearchable={onMakeSearchable ?? (() => undefined)}
        onForceOcr={() => undefined}
        redaction={{ phase: "idle", message: null, pendingCount: 0, available: true }}
        scanner={scanner}
        pendingEdits={[]}
        onRemovePendingEdit={() => undefined}
        onRunScanner={() => undefined}
        onMarkScannerHit={() => undefined}
        onMarkAllScannerHits={onMarkAllScannerHits}
        onHelpRequested={() => undefined}
        onConnectToAi={() => undefined}
        pageCount={1}
        onRotateLeft={() => undefined}
        onRotateRight={() => undefined}
        sidecarStatus={{ running: false, message: null, removed: [], beforeBytes: null, afterBytes: null }}
        onApplyPageNumbers={() => Promise.resolve(true)}
        onApplyWatermark={() => Promise.resolve(true)}
        compressAvailable
        onCompress={() => Promise.resolve(true)}
        printMarkupAnnotations={true}
        onPrintMarkupAnnotationsChange={() => undefined}
        onFlattenMarkupAnnotations={() => undefined}
        markupAnnotationMessage={null}
      />
    );
  }

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
  }

  function findButtonByText(text: string): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(text),
    ) as HTMLButtonElement | undefined;
  }

  function getButtonByText(text: string): HTMLButtonElement {
    const button = findButtonByText(text);

    if (!button) {
      throw new Error(`Button not found containing: ${text}`);
    }

    return button;
  }

  function click(element: Element) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
});

describe("BatesPanel prefix gating", () => {
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

  it("starts with an empty prefix, a sample placeholder, and a disabled Apply", () => {
    render(<BatesHarness />);

    const prefixInput = document.getElementById("bates-prefix") as HTMLInputElement;
    expect(prefixInput.value).toBe("");
    expect(prefixInput.placeholder).toBe("e.g. SMITH");

    const apply = getButtonByText("Apply Bates Numbers");
    expect(apply.disabled).toBe(true);
    expect(apply.title).toContain("Enter a Bates prefix");
  });

  it("enables Apply once a prefix is typed", () => {
    render(<BatesHarness />);

    typeInto(document.getElementById("bates-prefix") as HTMLInputElement, "SMITH");

    expect(getButtonByText("Apply Bates Numbers").disabled).toBe(false);
    expect(document.querySelector("[aria-label='Bates preview']")?.textContent).toBe("SMITH000001");
  });

  it("enables Apply via the explicit no-prefix opt-in and stamps numbers only", async () => {
    const onApply = vi.fn().mockResolvedValue(true);
    render(<BatesHarness onApply={onApply} />);

    const checkbox = document.querySelector(
      ".tool-panel__check-row input[type='checkbox']",
    ) as HTMLInputElement;
    click(checkbox);

    const prefixInput = document.getElementById("bates-prefix") as HTMLInputElement;
    expect(prefixInput.disabled).toBe(true);
    expect(document.querySelector("[aria-label='Bates preview']")?.textContent).toBe("000001");

    const apply = getButtonByText("Apply Bates Numbers");
    expect(apply.disabled).toBe(false);

    await submit(apply.closest("form")!);

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toMatchObject({ prefix: "" });
  });

  it("keeps a whitespace-only prefix gated", () => {
    render(<BatesHarness />);

    typeInto(document.getElementById("bates-prefix") as HTMLInputElement, "   ");

    expect(getButtonByText("Apply Bates Numbers").disabled).toBe(true);
  });

  function BatesHarness({ onApply }: { onApply?: (options: unknown) => Promise<boolean> }) {
    return (
      <BatesPanel
        state={{ applying: false, message: null }}
        hasDocument
        pageCount={3}
        onApply={(options) => (onApply ? onApply(options) : Promise.resolve(true))}
      />
    );
  }

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
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

  async function submit(form: HTMLFormElement) {
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  function getButtonByText(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(text),
    );

    if (!button) {
      throw new Error(`Button not found containing: ${text}`);
    }

    return button as HTMLButtonElement;
  }

  function click(element: Element) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
});
