// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditTextModeBar } from "./EditTextModeBar";
import { EditTextReviewDialog } from "./EditTextReviewDialog";
import { EditTextStatusPanel } from "./EditTextStatusPanel";
import {
  TEXT_EDIT_ADVISORY,
  TEXT_EDIT_STREAMED_GATE_MESSAGE,
  TEXT_EDIT_WHOLE_DOCUMENT_DISCLOSURE,
  TEXT_EDIT_ZERO_CHANGE_MESSAGE,
  type PendingTextReplacement,
} from "../lib/textEdit";
import type { TextEditState } from "../hooks/useTextEdit";

describe("EditText components", () => {
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

  it("queues from the mode bar and navigates with Enter/Shift+Enter", () => {
    const queueReplaceAll = vi.fn();
    const queueSelectedReplacement = vi.fn(async () => undefined);
    const captureSelectedText = vi.fn();
    const goToNext = vi.fn();
    const goToPrevious = vi.fn();
    render(
      <EditTextModeBar
        textEdit={state({
          find: "John",
          queueReplaceAll,
          queueSelectedReplacement,
          captureSelectedText,
          goToNext,
          goToPrevious,
        })}
        onExit={() => undefined}
      />,
    );

    const findInput = getInput("Find text");
    act(() => {
      findInput.dispatchEvent(keyboard("keydown", "Enter"));
    });
    expect(goToNext).toHaveBeenCalled();

    act(() => {
      findInput.dispatchEvent(keyboard("keydown", "Enter", true));
    });
    expect(goToPrevious).toHaveBeenCalled();

    act(() => {
      getButton("Replace all").click();
    });
    expect(queueReplaceAll).toHaveBeenCalled();

    const selectionButton = getButton("Replace selection");
    let pointerAllowed = true;
    act(() => {
      pointerAllowed = selectionButton.dispatchEvent(new Event("pointerdown", {
        bubbles: true,
        cancelable: true,
      }));
    });
    act(() => {
      selectionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(pointerAllowed).toBe(false);
    expect(queueSelectedReplacement).toHaveBeenCalled();

    act(() => {
      getInput("Replace with").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(captureSelectedText).toHaveBeenCalled();
  });

  it("renders gate, advisory, and positional-space caution in the status panel", () => {
    render(
      <EditTextStatusPanel
        textEdit={state({
          gate: { blocked: true, message: TEXT_EDIT_STREAMED_GATE_MESSAGE, notes: [] },
        })}
        onHelp={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain(TEXT_EDIT_STREAMED_GATE_MESSAGE);

    render(
      <EditTextStatusPanel
        textEdit={state({
          gate: { blocked: false, message: null, notes: ["Image-only pages are skipped."] },
          positionalSpaceRisk: true,
          pendingOps: [op()],
        })}
        onHelp={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain(TEXT_EDIT_ADVISORY);
    expect(document.body.textContent).toContain("Multi-word finds can miss");
    expect(document.body.textContent).toContain("Image-only pages are skipped.");
  });

  it("disables replacement queue actions while selected text is resolving", () => {
    render(
      <EditTextModeBar
        textEdit={state({ find: "John", selectionResolving: true })}
        onExit={() => undefined}
      />,
    );

    expect(getButton("Replace selection").disabled).toBe(true);
    expect(getButton("Replace all").disabled).toBe(true);
  });

  it("shows captured selection status separately from bulk queued replacements", () => {
    render(
      <EditTextStatusPanel
        textEdit={state({
          selectedReplacementText: "John Smith",
          pendingOps: [op()],
        })}
        onHelp={() => undefined}
      />,
    );

    expect(document.body.textContent).toContain("Selected for replacement: John Smith");
    expect(document.body.textContent).toContain("1 queued replacement");
  });

  it("renders whole-document disclosure and disables Apply for zero-change review", () => {
    render(<EditTextReviewDialog textEdit={state({ phase: "review", staged: staged(true) })} />);

    expect(document.body.textContent).toContain(TEXT_EDIT_WHOLE_DOCUMENT_DISCLOSURE);
    expect(document.body.textContent).toContain(TEXT_EDIT_ZERO_CHANGE_MESSAGE);
    expect(getButton("Apply").disabled).toBe(true);
  });

  it("disables Apply when one operation did not change", () => {
    render(<EditTextReviewDialog textEdit={state({ phase: "review", staged: staged(false, "unchanged", true) })} />);

    expect(getButton("Apply").disabled).toBe(true);
  });

  function render(element: ReactNode) {
    if (!container) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }

    act(() => {
      root?.render(element);
    });
  }
});

function state(overrides: Partial<TextEditState> = {}): TextEditState {
  return {
    find: "",
    replace: "",
    wholeWord: false,
    matches: [],
    activeMatch: null,
    activeMatchIndex: null,
    matchLabel: "",
    pendingOps: [],
    phase: "idle",
    gate: { blocked: false, message: null, notes: [] },
    message: null,
    staged: null,
    positionalSpaceRisk: false,
    selectionResolving: false,
    selectedReplacementText: null,
    setFind: () => undefined,
    setReplace: () => undefined,
    setWholeWord: () => undefined,
    captureSelectedText: () => undefined,
    queueReplaceAll: () => undefined,
    queueSelectedReplacement: async () => undefined,
    removePendingOp: () => undefined,
    clear: () => undefined,
    goToNext: () => undefined,
    goToPrevious: () => undefined,
    review: async () => undefined,
    apply: async () => undefined,
    cancelReview: () => undefined,
    ...overrides,
  };
}

function staged(
  zeroChange: boolean,
  status: "changed" | "not-found" | "unchanged" = zeroChange ? "not-found" : "changed",
  selected = false,
): NonNullable<TextEditState["staged"]> {
  return {
    bytes: new Uint8Array([1]),
    warnings: [{ code: "COUNTS_UNAVAILABLE", message: "" }],
    replacedCounts: null,
    report: {
      operations: [{
        operationId: "op",
        find: "John",
        replace: "Jane",
        selected,
        foundBefore: zeroChange ? [] : [0],
        foundAfter: [],
        replacedEstimate: zeroChange ? 0 : 1,
        status,
      }],
      changedPageIndexes: zeroChange ? [] : [0],
      zeroChange,
      advisory: null,
    },
    originalPages: [{ pageIndex: 0, text: "John", spans: [] }],
    candidatePages: [{ pageIndex: 0, text: zeroChange ? "John" : "Jane", spans: [] }],
    signatureInvalidationNotice: null,
    sourceOpenToken: 1,
    sourceGeneration: 1,
  };
}

function op(): PendingTextReplacement {
  return {
    id: "op",
    find: "John Smith",
    replace: "Jane Smith",
    wholeWord: false,
    pageIndexes: "all",
  };
}

function getInput(label: string): HTMLInputElement {
  const input = document.querySelector(`input[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input ${label} not found.`);
  }
  return input;
}

function getButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button ${label} not found.`);
  }
  return button;
}

function keyboard(type: string, key: string, shiftKey = false): KeyboardEvent {
  return new KeyboardEvent(type, { key, shiftKey, bubbles: true, cancelable: true });
}
