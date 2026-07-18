// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDialogStackForTests } from "./FloatingDialog";
import { ToolPanel } from "./ToolPanel";

describe("ToolPanel", () => {
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

  it("renders a top-level Connect to AI Agent entry with calm, two-halves copy", () => {
    const onConnectToAi = vi.fn();
    render(<Harness onConnectToAi={onConnectToAi} />);

    const button = getButtonByText("Connect to AI Agent");
    expect(button.textContent).toContain(
      "Let your own AI assistant drive Raio — nothing runs in the app itself.",
    );

    click(button);

    expect(onConnectToAi).toHaveBeenCalledTimes(1);
  });

  it("no longer renders a per-row help icon on collapsed Edit/Organize/Legal tool rows", () => {
    render(<Harness />);

    // These labels cover every collapsed-list group (Edit, Edit-dialog,
    // Organize, Legal) plus the always-visible OCR row -- none should carry
    // a per-row "Help: <label>" icon button any more.
    const declutteredLabels = [
      "Text Box",
      "Highlight",
      "Watermark...",
      "Organize Pages",
      "Rotate Pages",
      "Prepare for Filing",
      "Bates Numbering",
      "Make Searchable (OCR)",
      "Redo searchable text",
    ];

    for (const label of declutteredLabels) {
      expect(
        document.querySelector(`[aria-label='Help: ${label}']`),
        `expected no per-row help icon for "${label}"`,
      ).toBeNull();
    }
  });

  it("does not place redaction confirmation controls in the sidebar", () => {
    render(<Harness activeLegalTool="redact" redaction={{ phase: "confirming", message: null, pendingCount: 2, available: true }} />);

    expect(document.body.textContent).not.toContain("Apply Redactions");
    expect(document.body.textContent).not.toContain("will be permanently removed");
  });

  interface HarnessProps {
    onConnectToAi?: () => void;
    activeLegalTool?: string | null;
    redaction?: {
      phase: "idle" | "confirming" | "applying" | "verified" | "error";
      message: string | null;
      pendingCount: number;
      available: boolean;
    };
  }

  function Harness({ onConnectToAi, activeLegalTool = null, redaction }: HarnessProps) {
    return (
      <ToolPanel
        hasDocument
        ocrState={{ phase: "idle", message: null }}
        ocrStarting={false}
        activeEditTool="select"
        activeEditDialogTool={null}
        activeLegalTool={activeLegalTool}
        activeOrganizeTool={null}
        onEditToolSelected={() => undefined}
        onEditDialogToolSelected={() => undefined}
        onLegalToolSelected={() => undefined}
        onOrganizeToolSelected={() => undefined}
        onMakeSearchable={() => undefined}
        onForceOcr={() => undefined}
        redaction={redaction ?? { phase: "idle", message: null, pendingCount: 0, available: true }}
        scanner={{ scanning: false, message: null, hits: [] }}
        pendingEdits={[]}
        onRemovePendingEdit={() => undefined}
        onRunScanner={() => undefined}
        onMarkScannerHit={() => undefined}
        onHelpRequested={() => undefined}
        onConnectToAi={onConnectToAi ?? (() => undefined)}
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
