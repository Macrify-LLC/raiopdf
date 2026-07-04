// @vitest-environment jsdom
//
// Covers item 18 (Workstream D): Rotate, Page Numbers, Watermark, and
// Compress moved from FloatingDialog popups into an inline accordion-style
// expansion under their own ToolRow. This file only exercises ToolPanel's
// own rendering contract (it is a controlled/props-driven component); the
// App.tsx toggle-off-on-reselect and collapse-on-success behavior lives one
// level up and is covered by the Playwright smoke suite instead.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolPanel, type SidecarStatus, type ToolPanelProps } from "./ToolPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToolPanel inline tool expansions", () => {
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

  it("renders no inline expansion when no organize/edit-dialog tool is active", () => {
    render(<Harness />);

    expect(document.querySelector(".tool-row__expansion")).toBeNull();
    expect(queryButton("Rotate Left")).toBeNull();
    expect(queryButton("Apply Page Numbers")).toBeNull();
    expect(queryButton("Compress PDF")).toBeNull();
  });

  it("expands Rotate inline with left/right actions and moves its help into the expansion", () => {
    const onRotateLeft = vi.fn();
    const onRotateRight = vi.fn();
    const onOrganizeToolSelected = vi.fn();

    render(
      <Harness
        activeOrganizeTool="rotate"
        onRotateLeft={onRotateLeft}
        onRotateRight={onRotateRight}
        onOrganizeToolSelected={onOrganizeToolSelected}
      />,
    );

    const expansion = document.querySelector(".tool-row__expansion");
    expect(expansion).not.toBeNull();
    expect(expansion?.textContent).toContain("Rotates the selected pages.");

    click(getButton("Rotate Right"));
    expect(onRotateRight).toHaveBeenCalledTimes(1);

    click(getButton("Rotate Left"));
    expect(onRotateLeft).toHaveBeenCalledTimes(1);

    // The "?" for Rotate now lives only inside the expansion, not a second
    // copy on the outer ToolRow.
    expect(document.querySelectorAll('[aria-label="Help: Rotate Pages"]').length).toBe(1);

    // Escape anywhere inside the expansion re-fires the same select handler
    // that opened it -- App.tsx's toggle-off-on-reselect logic turns that
    // into a collapse.
    escapeWithin(getButton("Rotate Right"));
    expect(onOrganizeToolSelected).toHaveBeenCalledWith("rotate");
  });

  it("still renders the outer help affordance for organize tools that stayed dialog-based", () => {
    render(<Harness />);

    // Repair wasn't moved inline (item 18 keeps it a dialog), so its ToolRow
    // help button is untouched.
    expect(document.querySelector('[aria-label="Help: Repair..."]')).not.toBeNull();
  });

  it("expands Page Numbers inline and submits the parsed defaults", async () => {
    const onApplyPageNumbers = vi.fn().mockResolvedValue(true);

    render(
      <Harness
        activeEditDialogTool="page-numbers"
        pageCount={3}
        onApplyPageNumbers={onApplyPageNumbers}
      />,
    );

    expect(document.querySelector(".tool-row__expansion")).not.toBeNull();
    expect(document.querySelectorAll('[aria-label="Help: Page Numbers"]').length).toBe(1);

    const rangeInput = document.querySelector<HTMLInputElement>("#page-number-range");
    expect(rangeInput?.value).toBe("1-3");

    await submitForm(getButton("Apply Page Numbers"));

    expect(onApplyPageNumbers).toHaveBeenCalledWith({
      startAt: 1,
      pageIndexes: [0, 1, 2],
      format: "number",
      placement: { edge: "footer", align: "center" },
      fontSizePt: 11,
    });
  });

  it("expands Watermark inline and submits the parsed defaults", async () => {
    const onApplyWatermark = vi.fn().mockResolvedValue(true);

    render(
      <Harness
        activeEditDialogTool="watermark"
        pageCount={2}
        onApplyWatermark={onApplyWatermark}
      />,
    );

    expect(document.querySelectorAll('[aria-label="Help: Watermark"]').length).toBe(1);

    await submitForm(getButton("Apply Watermark"));

    expect(onApplyWatermark).toHaveBeenCalledWith({
      text: "DRAFT",
      pageIndexes: [0, 1],
      orientation: "diagonal",
      opacity: 0.18,
    });
  });

  it("expands Compress inline and shows the busy state while running", () => {
    render(
      <Harness
        activeOrganizeTool="compress"
        sidecarStatus={{
          running: true,
          message: "Compressing in the desktop engine...",
          removed: [],
          beforeBytes: null,
          afterBytes: null,
        }}
      />,
    );

    expect(document.querySelectorAll('[aria-label="Help: Compress"]').length).toBe(1);
    expect(document.querySelector('[role="img"][aria-label="Compressing PDF"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Compressing in the desktop engine...");
    // Busy means no double-submit -- the trigger button is disabled while running.
    expect(getButton("Compress PDF").disabled).toBe(true);
  });

  it("calls onCompress with the form defaults when idle", () => {
    const onCompress = vi.fn().mockResolvedValue(true);

    render(<Harness activeOrganizeTool="compress" onCompress={onCompress} />);

    click(getButton("Compress PDF"));
    expect(onCompress).toHaveBeenCalledWith({ quality: 5, grayscale: false });
  });

  it("shows the before/after size note once Compress finishes", () => {
    render(
      <Harness
        activeOrganizeTool="compress"
        sidecarStatus={{
          running: false,
          message: "Compression complete.",
          removed: [],
          beforeBytes: 2048,
          afterBytes: 1024,
        }}
      />,
    );

    expect(document.body.textContent).toContain("2 KB to 1 KB");
    expect(document.body.textContent).toContain("Compression complete.");
  });

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
  }
});

const idleSidecarStatus: SidecarStatus = {
  running: false,
  message: null,
  removed: [],
  beforeBytes: null,
  afterBytes: null,
};

function Harness(overrides: Partial<ToolPanelProps>) {
  const props: ToolPanelProps = {
    hasDocument: true,
    pageCount: 1,
    ocrState: { phase: "idle", message: null },
    ocrAvailable: true,
    ocrStarting: false,
    activeEditTool: "select",
    activeEditDialogTool: null,
    activeLegalTool: null,
    activeOrganizeTool: null,
    onEditToolSelected: () => undefined,
    onEditDialogToolSelected: () => undefined,
    onLegalToolSelected: () => undefined,
    onOrganizeToolSelected: () => undefined,
    onMakeSearchable: () => undefined,
    onForceOcr: () => undefined,
    redaction: { phase: "idle", message: null, pendingCount: 0, available: true },
    scanner: { scanning: false, message: null, hits: [] },
    pendingEdits: [],
    onRemovePendingEdit: () => undefined,
    onConfirmRedactions: () => undefined,
    onCancelRedactions: () => undefined,
    onRunScanner: () => undefined,
    onMarkScannerHit: () => undefined,
    onHelpRequested: () => undefined,
    onRotateLeft: () => undefined,
    onRotateRight: () => undefined,
    sidecarStatus: idleSidecarStatus,
    onApplyPageNumbers: async () => true,
    onApplyWatermark: async () => true,
    compressAvailable: true,
    onCompress: async () => true,
    ...overrides,
  };

  return <ToolPanel {...props} />;
}

function getButton(name: string): HTMLButtonElement {
  const button = queryButton(name);

  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }

  return button;
}

function queryButton(name: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll("button")).find(
      (element): element is HTMLButtonElement => element.textContent?.trim() === name,
    ) ?? null
  );
}

function click(button: HTMLButtonElement) {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// Dispatches a native `submit` event directly on the owning form rather than
// clicking the submit button. A button click routes through the browser's
// (and jsdom's) implicit constraint-validation gate first -- which is not
// what these tests are after, and would spuriously fail on unrelated
// pre-existing field constraints (e.g. Watermark's opacity `step="0.05"`
// input defaulting to 0.18, a harmless step mismatch nobody hits by hand).
async function submitForm(button: HTMLButtonElement) {
  const form = button.closest("form");

  if (!form) {
    throw new Error("Expected the submit button to be inside a form");
  }

  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function escapeWithin(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}
