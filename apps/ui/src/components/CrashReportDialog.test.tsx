// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDialogStackForTests } from "./FloatingDialog";
import {
  CrashReportDialog,
  formatCrashReportPreview,
  type CrashReportPayload,
} from "./CrashReportDialog";

const payload: CrashReportPayload = {
  title: "Crash report: panic",
  body: "RaioPDF crash report\n\nSignature: panic\n\nApplication log tail (scrubbed)\nline one",
};

describe("CrashReportDialog", () => {
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

  it("does not render when there is no pending payload", () => {
    renderDialog(
      <CrashReportDialog
        payload={null}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("reveals the literal payload text", () => {
    renderDialog(
      <CrashReportDialog
        payload={payload}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    expect(getPayload()).toBeNull();

    clickButton("View exactly what will be sent");

    expect(getPayload()?.textContent).toBe(formatCrashReportPreview(payload));
    expect(getPayload()?.textContent).toContain(payload.body);
  });

  it("fires the action callbacks from the four controls", () => {
    const onOpenGitHubIssue = vi.fn();
    const onNotNow = vi.fn();
    const onNeverAsk = vi.fn();

    renderDialog(
      <CrashReportDialog
        payload={payload}
        onOpenGitHubIssue={onOpenGitHubIssue}
        onNotNow={onNotNow}
        onNeverAsk={onNeverAsk}
      />,
    );

    clickButton("Open GitHub issue");
    clickButton("Not now");
    clickButton("Never ask");
    clickButton("View exactly what will be sent");

    expect(onOpenGitHubIssue).toHaveBeenCalledTimes(1);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    expect(onNeverAsk).toHaveBeenCalledTimes(1);
  });

  function renderDialog(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
  }
});

function clickButton(name: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent === name,
  );

  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }

  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function getPayload(): HTMLElement | null {
  return document.querySelector("[aria-label='Crash report payload']");
}
