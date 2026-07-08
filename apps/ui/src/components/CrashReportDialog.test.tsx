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
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    resetDialogStackForTests();
  });

  it("does not render when there is no pending payload", () => {
    renderDialog(
      <CrashReportDialog
        payload={null}
        onSaveReport={() => Promise.resolve(null)}
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
        onSaveReport={() => Promise.resolve(null)}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    expect(getPayload()).toBeNull();

    const disclosure = getButton("View exactly what will be sent");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    clickButton("View exactly what will be sent");

    expect(getButton("Hide details").getAttribute("aria-expanded")).toBe("true");
    expect(getPayload()?.id).toBe(getButton("Hide details").getAttribute("aria-controls"));
    expect(getPayload()?.tabIndex).toBe(0);
    expect(getPayload()?.textContent).toBe(formatCrashReportPreview(payload));
    expect(getPayload()?.textContent).toContain(payload.body);
  });

  it("fires the action callbacks from the four action controls", async () => {
    const onSaveReport = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    const onOpenGitHubIssue = vi.fn();
    const onNotNow = vi.fn();
    const onNeverAsk = vi.fn();

    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={onSaveReport}
        onOpenGitHubIssue={onOpenGitHubIssue}
        onNotNow={onNotNow}
        onNeverAsk={onNeverAsk}
      />,
    );

    await clickButtonAndFlush("Save report to email");
    clickButton("Open GitHub issue");
    clickButton("Not now");
    clickButton("Never ask");

    expect(onSaveReport).toHaveBeenCalledTimes(1);
    expect(onOpenGitHubIssue).toHaveBeenCalledTimes(1);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    expect(onNeverAsk).toHaveBeenCalledTimes(1);
  });

  it("shows and disables the GitHub action while the browser open is pending", () => {
    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={() => Promise.resolve(null)}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
        isOpening
      />,
    );

    expect(findButton("Open GitHub issue")).toBeNull();
    expect(getButton("Opening...").hasAttribute("disabled")).toBe(true);
  });

  it("disables the save action while the report save is pending", async () => {
    const save = createDeferred<string | null>();

    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={() => save.promise}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    await act(async () => {
      getButton("Save report to email").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(getButton("Saving...").hasAttribute("disabled")).toBe(true);

    await act(async () => {
      save.resolve(null);
      await save.promise;
    });
  });

  it("renders browser-open failures as an inline status", () => {
    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={() => Promise.resolve(null)}
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

  it("saves the report and renders the email success panel", async () => {
    const onSaveReport = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValue("/Users/jane/Desktop/raiopdf-crash-report.txt");

    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={onSaveReport}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    await clickButtonAndFlush("Save report to email");

    expect(onSaveReport).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("/Users/jane/Desktop/raiopdf-crash-report.txt");
    expect(document.body.textContent).toContain("crash-reports@macrify.me");
    expect(document.activeElement).toBe(getButton("Copy email address"));
    expect(getButton("Copy email address").classList).toContain(
      "crash-report-dialog__primary-button",
    );
    expect(getButton("Done").classList).toContain("crash-report-dialog__secondary-button");
    expect(findButton("Save report to email")).toBeNull();
  });

  it("copies the support email address from the success panel", async () => {
    const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={() => Promise.resolve("/tmp/raiopdf-crash-report.txt")}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    await clickButtonAndFlush("Save report to email");
    await clickButtonAndFlush("Copy email address");

    expect(writeText).toHaveBeenCalledWith("crash-reports@macrify.me");
    expect(getButton("Copied")).toBeTruthy();
    expect(document.querySelector("[role='status']")?.textContent).toBe(
      "Email address copied to clipboard.",
    );
    expect(document.querySelector("[role='status']")?.getAttribute("aria-live")).toBe("polite");
  });

  it("leaves the normal dialog state when the save dialog is canceled", async () => {
    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={() => Promise.resolve(null)}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    await clickButtonAndFlush("Save report to email");

    expect(getButton("Save report to email")).toBeTruthy();
    expect(getButton("Open GitHub issue")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Saved to");
    expect(document.querySelector("[role='status']")).toBeNull();
  });

  it("renders save failures as an inline status", async () => {
    renderDialog(
      <CrashReportDialog
        payload={payload}
        onSaveReport={() => Promise.reject(new Error("save failed"))}
        onOpenGitHubIssue={() => undefined}
        onNotNow={() => undefined}
        onNeverAsk={() => undefined}
      />,
    );

    await clickButtonAndFlush("Save report to email");

    expect(document.querySelector("[role='status']")?.textContent).toContain(
      "Couldn't save the report",
    );
    expect(document.body.textContent).not.toContain("Saved to");
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

async function clickButtonAndFlush(name: string) {
  const button = getButton(name);

  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function clickButton(name: string) {
  const button = getButton(name);

  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = findButton(name);

  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }

  return button;
}

function findButton(name: string): HTMLButtonElement | null {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement => element.textContent?.trim() === name,
  );

  return button ?? null;
}

function getPayload(): HTMLElement | null {
  return document.querySelector("[aria-label='Crash report details']");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
