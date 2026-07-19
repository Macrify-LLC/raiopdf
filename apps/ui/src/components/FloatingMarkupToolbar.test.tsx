// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditingState } from "../hooks/useEditing";
import { COMMAND_BAR_EDIT_TOOLS } from "../lib/toolRegistry";
import { FloatingMarkupToolbar } from "./FloatingMarkupToolbar";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("FloatingMarkupToolbar", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    host?.remove();
    root = null;
    host = null;
  });

  it("renders the command-bar edit tools as a horizontal toolbar with expandable labels", () => {
    renderToolbar();

    const toolbar = getToolbar();
    const buttons = getButtons();

    expect(toolbar.getAttribute("aria-orientation")).toBe("horizontal");
    expect(buttons).toHaveLength(COMMAND_BAR_EDIT_TOOLS.length);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(
      COMMAND_BAR_EDIT_TOOLS.map((tool) => tool.label),
    );
    // Each button now carries its tool name as text (collapsed by CSS until
    // hover/active); the icon is aria-hidden, so the button's text is the label.
    expect(buttons.map((button) => button.textContent)).toEqual(
      COMMAND_BAR_EDIT_TOOLS.map((tool) => tool.label),
    );
  });

  it("reflects the active editing tool", () => {
    renderToolbar({ tool: "highlight" });

    expect(getButton("Highlight").getAttribute("aria-pressed")).toBe("true");
    expect(getButton("Select").getAttribute("aria-pressed")).toBe("false");
  });

  it("calls the wrapped editing setTool when a tool is clicked", () => {
    const setTool = vi.fn();
    renderToolbar({ setTool });

    click(getButton("Underline"));

    expect(setTool).toHaveBeenCalledWith("underline");
  });

  it("returns to select when the active non-select tool is clicked again", () => {
    const setTool = vi.fn();
    renderToolbar({ tool: "highlight", setTool });

    click(getButton("Highlight"));

    expect(setTool).toHaveBeenCalledWith("select");
  });

  it("moves the roving tab stop with arrow keys", () => {
    renderToolbar();

    const select = getButton("Select");
    const highlight = getButton("Highlight");

    expect(select.tabIndex).toBe(0);
    expect(highlight.tabIndex).toBe(-1);

    keyDown(getToolbar(), "ArrowDown");

    expect(select.tabIndex).toBe(-1);
    expect(highlight.tabIndex).toBe(0);
    expect(document.activeElement).toBe(highlight);
  });

  function renderToolbar(overrides: Partial<EditingState> = {}) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(<FloatingMarkupToolbar editing={{ ...mockEditing, ...overrides }} />);
    });
  }

  function getToolbar(): HTMLElement {
    const toolbar = host?.querySelector<HTMLElement>('[role="toolbar"][aria-label="Markup tools"]');

    if (!toolbar) {
      throw new Error("Toolbar was not rendered.");
    }

    return toolbar;
  }

  function getButtons(): HTMLButtonElement[] {
    return Array.from(getToolbar().querySelectorAll<HTMLButtonElement>("button"));
  }

  function getButton(label: string): HTMLButtonElement {
    const button = getButtons().find((candidate) => candidate.getAttribute("aria-label") === label);

    if (!button) {
      throw new Error(`Button ${label} was not rendered.`);
    }

    return button;
  }
});

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function keyDown(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const noop = () => undefined;

const mockEditing: EditingState = {
  tool: "select",
  setTool: noop,
  pendingEdits: [],
  addEdit: noop,
  updateEdit: noop,
  removeEdit: noop,
  clearPending: noop,
  clearPendingEdits: noop,
  draftEditCount: 0,
  appliedEditCount: 0,
  applyPending: noop,
  unapplyPending: noop,
  setEditStatus: noop,
  loadImportedAnnotations: noop,
  armedImage: null,
  handleImageFile: noop,
  disarmImage: noop,
  armedSignature: null,
  signatureCardOpen: false,
  setSignatureCardOpen: noop,
  savedSignatures: [],
  saveSignature: () => false,
  deleteSavedSignature: noop,
  armSignatureFromDataUrl: async () => false,
  disarmSignature: noop,
  flattenOnSave: true,
  setFlattenOnSave: noop,
  hasFormFields: false,
  formValues: {},
  setFormValue: noop,
  highlightStyle: {},
  updateHighlightStyle: noop,
  textMarkupStyles: {
    underline: {},
    strikethrough: {},
  },
  updateTextMarkupStyle: noop,
  textBoxStyle: {},
  updateTextBoxStyle: noop,
  calloutStyle: { strokeWidthPt: 1.5 },
  updateCalloutStyle: noop,
  inkStyle: { strokeWidthPt: 1.5 },
  updateInkStyle: noop,
  shapeStyles: {
    shapeRect: { strokeWidthPt: 1.5, fillColor: null },
    shapeEllipse: { strokeWidthPt: 1.5, fillColor: null },
    shapeLine: { strokeWidthPt: 1.5 },
    shapeArrow: { strokeWidthPt: 1.5 },
  },
  updateShapeStyle: noop,
  selectedEditId: null,
  setSelectedEditId: noop,
  message: null,
  setMessage: noop,
  collectEdits: () => null,
  collectAnnotationSavePlan: () => null,
  collectMarkupAnnotationSavePlan: () => ({
    appendEdits: [],
    updateEdits: [],
    deleteAnnotIds: [],
    hasSignatureEdit: false,
  }),
  hasUnsavedEdits: false,
  lastUndoableEditId: null,
  resetForDocument: noop,
  captureDocumentState: () => ({
    pendingEdits: [],
    importedAnnotIds: new Set<string>(),
    formValues: {},
  }),
  restoreDocumentState: noop,
};
