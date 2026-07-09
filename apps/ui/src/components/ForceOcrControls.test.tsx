// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OcrUiState } from "../App";
import { ForceOcrConfirmationDialog } from "./ForceOcrConfirmationDialog";
import { resetDialogStackForTests } from "./FloatingDialog";
import { TextLayerDetailPanel } from "./TextLayerDetailPanel";
import { ToolPanel, type SidecarStatus } from "./ToolPanel";

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
        pageCount={2}
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
        onRotateLeft={() => undefined}
        onRotateRight={() => undefined}
        sidecarStatus={idleSidecarStatus}
        onApplyPageNumbers={async () => true}
        onApplyWatermark={async () => true}
        compressAvailable
        onCompress={async () => true}
        redaction={{ phase: "idle", message: null, pendingCount: 0, available: true }}
        scanner={{ scanning: false, message: null, hits: [] }}
        pendingEdits={[]}
        onRemovePendingEdit={() => undefined}
        onConfirmRedactions={() => undefined}
        onCancelRedactions={() => undefined}
        onRunScanner={() => undefined}
        onMarkScannerHit={() => undefined}
        onHelpRequested={() => undefined}
        onConnectToAi={() => undefined}
        printMarkupAnnotations={true}
        onPrintMarkupAnnotationsChange={() => undefined}
        onFlattenMarkupAnnotations={() => undefined}
        markupAnnotationMessage={null}
      />,
    );

    const button = getButton("Redo searchable text");
    expect(button.disabled).toBe(false);

    click(button);

    expect(onForceOcr).toHaveBeenCalledTimes(1);
  });

  it("disables Make Searchable while the confirm dialog is up, with no inline OCR status", () => {
    render(<ToolPanelHarness ocrState={{ phase: "confirm", message: null }} />);

    expect(getButton("Make Searchable (OCR)").disabled).toBe(true);
    expect(getButton("Redo searchable text").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Making searchable");
  });

  it("disables Make Searchable while OCR is running, with no inline OCR status", () => {
    render(<ToolPanelHarness ocrState={{ phase: "processing", message: "Making searchable…" }} />);

    expect(getButton("Make Searchable (OCR)").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Making searchable");
  });

  it("shows a result notice once OCR finishes, replacing the old always-on status box", () => {
    render(
      <ToolPanelHarness
        ocrState={{ phase: "done", message: "Rebuilt the text layer on 3 pages." }}
      />,
    );

    const notice = document.querySelector('.tool-panel__inline-card[data-tone="ok"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Rebuilt the text layer on 3 pages.");
    expect(getButton("Make Searchable (OCR)").disabled).toBe(false);
  });

  it("surfaces a force-OCR residual text warning after applying the rebuilt output", () => {
    render(
      <ToolPanelHarness
        ocrState={{
          phase: "done",
          message: "Rebuilt the text layer on 3 pages. Warning: 1 page may still have imperfect text.",
        }}
      />,
    );

    const notice = document.querySelector('.tool-panel__inline-card[data-tone="ok"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Warning: 1 page may still have imperfect text.");
  });

  it("renders a caution-toned notice when OCR finished with a thin-text warning", () => {
    render(
      <ToolPanelHarness
        ocrState={{
          phase: "done",
          tone: "caution",
          message: "Made a searchable copy of 4 pages. Heads up: pages 2, 3, 5, and 6 already have a thin text layer over a scanned page image, so normal OCR left those pages as-is. Run Force OCR to rebuild them.",
        }}
      />,
    );

    const notice = document.querySelector('.tool-panel__inline-card[data-tone="caution"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Made a searchable copy of 4 pages.");
    expect(document.querySelector('.tool-panel__inline-card[data-tone="ok"]')).toBeNull();
  });

  it("surfaces OCR engine error details instead of only the generic failure", () => {
    render(
      <ToolPanelHarness
        ocrState={{
          phase: "error",
          message: "Couldn't make this document searchable. Stirling PDF request failed: connection refused",
        }}
      />,
    );

    const notice = document.querySelector('.tool-panel__inline-card[data-tone="danger"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Stirling PDF request failed: connection refused");
  });

  it("shows OCR errors as a neutral note when the desktop engine is unavailable, not an alarming one", () => {
    render(
      <ToolPanelHarness
        ocrState={{ phase: "error", message: "This tool only works in the installed RaioPDF app." }}
        ocrAvailable={false}
      />,
    );

    const notice = document.querySelector('.tool-panel__inline-card[data-tone="neutral"]');
    expect(notice).not.toBeNull();
  });

  it("exposes annotation print and flatten controls", () => {
    const onPrintMarkupAnnotationsChange = vi.fn();
    const onFlattenMarkupAnnotations = vi.fn();

    render(
      <ToolPanel
        hasDocument
        pageCount={2}
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
        onForceOcr={() => undefined}
        onRotateLeft={() => undefined}
        onRotateRight={() => undefined}
        sidecarStatus={idleSidecarStatus}
        onApplyPageNumbers={async () => true}
        onApplyWatermark={async () => true}
        compressAvailable
        onCompress={async () => true}
        redaction={{ phase: "idle", message: null, pendingCount: 0, available: true }}
        scanner={{ scanning: false, message: null, hits: [] }}
        pendingEdits={[]}
        onRemovePendingEdit={() => undefined}
        onConfirmRedactions={() => undefined}
        onCancelRedactions={() => undefined}
        onRunScanner={() => undefined}
        onMarkScannerHit={() => undefined}
        onHelpRequested={() => undefined}
        onConnectToAi={() => undefined}
        printMarkupAnnotations={true}
        onPrintMarkupAnnotationsChange={onPrintMarkupAnnotationsChange}
        onFlattenMarkupAnnotations={onFlattenMarkupAnnotations}
        markupAnnotationMessage="Merged 1 markup item permanently into the page."
      />,
    );

    const switchButton = document.querySelector("[role='switch'][aria-labelledby='markup-print-label']");
    expect(switchButton?.getAttribute("aria-checked")).toBe("true");

    click(switchButton as HTMLButtonElement);
    click(getButton("Make markup permanent"));

    expect(onPrintMarkupAnnotationsChange).toHaveBeenCalledWith(false);
    expect(onFlattenMarkupAnnotations).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Merged 1 markup item");
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

    click(getButton("Redo Searchable Text"));

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

function ToolPanelHarness({
  ocrState,
  ocrAvailable = true,
}: {
  ocrState: OcrUiState;
  ocrAvailable?: boolean;
}) {
  return (
    <ToolPanel
      hasDocument
      pageCount={2}
      ocrState={ocrState}
      ocrAvailable={ocrAvailable}
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
      onForceOcr={() => undefined}
      onRotateLeft={() => undefined}
      onRotateRight={() => undefined}
      sidecarStatus={idleSidecarStatus}
      onApplyPageNumbers={async () => true}
      onApplyWatermark={async () => true}
      compressAvailable
      onCompress={async () => true}
      redaction={{ phase: "idle", message: null, pendingCount: 0, available: true }}
      scanner={{ scanning: false, message: null, hits: [] }}
      pendingEdits={[]}
      onRemovePendingEdit={() => undefined}
      onConfirmRedactions={() => undefined}
      onCancelRedactions={() => undefined}
      onRunScanner={() => undefined}
      onMarkScannerHit={() => undefined}
      onHelpRequested={() => undefined}
      onConnectToAi={() => undefined}
      printMarkupAnnotations={true}
      onPrintMarkupAnnotationsChange={() => undefined}
      onFlattenMarkupAnnotations={() => undefined}
      markupAnnotationMessage={null}
    />
  );
}

const idleSidecarStatus: SidecarStatus = {
  running: false,
  message: null,
  removed: [],
  beforeBytes: null,
  afterBytes: null,
};

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
