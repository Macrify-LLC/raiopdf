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

    const disclosure = getButton("View exactly what will be sent");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    clickButton("View exactly what will be sent");

    expect(getButton("Hide payload").getAttribute("aria-expanded")).toBe("true");
    expect(getPayload()?.id).toBe(getButton("Hide payload").getAttribute("aria-controls"));
    expect(getPayload()?.tabIndex).toBe(0);
    expect(getPayload()?.textContent).toBe(formatCrashReportPreview(payload));
    expect(getPayload()?.textContent).toContain(payload.body);
  });

  it("fires the action callbacks from the three action controls", () => {
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

    expect(onOpenGitHubIssue).toHaveBeenCalledTimes(1);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    expect(onNeverAsk).toHaveBeenCalledTimes(1);
  });

  it("disables the primary action while the browser open is pending", () => {
    renderDialog(
      <CrashReportDialog
        payload={payload}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
        isOpening
      />,
    );

    expect(getButton("Open GitHub issue").hasAttribute("disabled")).toBe(true);
  });

  it("renders browser-open failures as an inline status", () => {
    renderDialog(
      <CrashReportDialog
        payload={payload}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
        openStatus="Couldn't open your browser — try again, or use File → Export Diagnostics."
      />,
    );

    expect(document.querySelector("[role='status']")?.textContent).toContain(
      "Couldn't open your browser",
    );
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
  const button = getButton(name);

  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement => element.textContent?.trim() === name,
  );

  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }

  return button;
}

function getPayload(): HTMLElement | null {
  return document.querySelector("[aria-label='Crash report payload']");
}
