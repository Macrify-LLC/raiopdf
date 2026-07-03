// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForceOcrConfirmationDialog } from "./ForceOcrConfirmationDialog";
import { resetDialogStackForTests } from "./FloatingDialog";
import { TextLayerDetailPanel } from "./TextLayerDetailPanel";
import { ToolPanel } from "./ToolPanel";

describe("force OCR controls", () => {
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

  it("enables the garbled-text panel fix action", () => {
    const onFixGarbledText = vi.fn();

    render(
      <TextLayerDetailPanel
        garbledPages={[{
          pageIndex: 0,
          confidence: 0.92,
          reason: "combined",
          puaRatio: 0.2,
          replacementRatio: 0.1,
          alphaRatio: 0.02,
        }]}
        onFixGarbledText={onFixGarbledText}
        onClose={() => undefined}
      />,
    );

    const button = getButton("Fix garbled text");
    expect(button.disabled).toBe(false);

    click(button);

    expect(onFixGarbledText).toHaveBeenCalledTimes(1);
  });

  it("exposes a manual force path for a clean document", () => {
    const onForceOcr = vi.fn();

    render(
      <ToolPanel
        hasDocument
        ocrState={{ phase: "idle", message: null }}
        ocrAvailable
        ocrStarting={false}
        activeEditTool="select"
        activeEditDialogTool={null}
        activeLegalTool={null}
        activeOrganizeTool={null}
        onEditToolSelected={() => undefined}
        onEditDialogToolSelected={() => undefined}
        onLegalToolSelected={() => undefined}
        onOrganizeToolSelected={() => undefined}
        onMakeSearchable={() => undefined}
        onForceOcr={onForceOcr}
        redaction={{ phase: "idle", message: null, pendingCount: 0, available: true }}
        scanner={{ scanning: false, message: null, hits: [] }}
        pendingEdits={[]}
        onRemovePendingEdit={() => undefined}
        onConfirmRedactions={() => undefined}
        onCancelRedactions={() => undefined}
        onRunScanner={() => undefined}
        onMarkScannerHit={() => undefined}
        onHelpRequested={() => undefined}
      />,
    );

    const button = getButton("Force re-OCR text layer");
    expect(button.disabled).toBe(false);

    click(button);

    expect(onForceOcr).toHaveBeenCalledTimes(1);
  });

  it("shows the whole-document force OCR interstitial before running", () => {
    const onConfirm = vi.fn();

    render(
      <ForceOcrConfirmationDialog
        reason="manual"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );

    expect(document.querySelector("[role='dialog']")?.textContent).toContain(
      "whole document",
    );
    expect(document.querySelector("[role='dialog']")?.textContent).toContain(
      "the PDF may be larger",
    );

    click(getButton("Rebuild Text Layer"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
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

function getButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement => element.textContent?.trim() === name,
  );

  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }

  return button;
}

function click(button: HTMLButtonElement) {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
