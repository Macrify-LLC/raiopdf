// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The repo sets this per test file (see ToolPanel.expansion.test.tsx); without it
// async act() does not flush effects.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { recordDiagnosticEvent, resetDiagnosticsForTests } from "../lib/diagnostics";
import { ErrorActions } from "./ErrorActions";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

async function clickButton(label: string): Promise<void> {
  const button = buttons().find((candidate) => candidate.textContent?.trim().startsWith(label));
  if (!button) {
    throw new Error(`no button starting with ${label}: ${buttons().map((b) => b.textContent).join(" | ")}`);
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Building the prompt awaits the shell's scrubber, and each recorded
    // diagnostic also has a floating log-write promise in flight — so a fixed
    // microtask count is load-dependent and flaky. Yield the macrotask queue
    // instead, which lets every pending await settle.
    for (let yields = 0; yields < 5; yields += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll("button") ?? []);
}

function statusText(): string {
  return container?.querySelector(".error-actions__status")?.textContent?.trim() ?? "";
}

beforeEach(() => {
  resetDiagnosticsForTests();
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  resetDiagnosticsForTests();
});

describe("ErrorActions", () => {
  it("offers both actions for the failure it was given", () => {
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "OCR could not finish");

    render(<ErrorActions diagnosticId={diagnosticId} />);

    const labels = buttons().map((button) => button.textContent?.trim());
    expect(labels).toEqual(["Help diagnose this", "Email a report"]);
  });

  it("renders nothing for a message with no diagnostic", () => {
    // The capability-gap case: a surface reaches its error phase for a missing
    // toolchain while deliberately recording nothing. It used to offer a report
    // anyway, attaching whichever unrelated failure happened to be newest.
    recordDiagnosticEvent("merge.failed", "an earlier, unrelated failure");

    render(<ErrorActions diagnosticId={null} />);

    expect(buttons()).toHaveLength(0);
    expect(container?.textContent).toBe("");
  });

  it("renders nothing once the diagnostic has aged out of the ring buffer", () => {
    const diagnosticId = recordDiagnosticEvent("first.failed", "oldest");
    for (let index = 0; index < 10; index += 1) {
      recordDiagnosticEvent("filler.failed", `filler ${index}`);
    }

    render(<ErrorActions diagnosticId={diagnosticId} />);

    expect(buttons()).toHaveLength(0);
  });

  it("copies a prompt describing the failure it was given", async () => {
    const first = recordDiagnosticEvent("merge.failed", "merge blew up");
    const second = recordDiagnosticEvent("ocr.failed", "ocr blew up");
    const onCopyPrompt = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    render(<ErrorActions diagnosticId={first} onCopyPrompt={onCopyPrompt} />);
    await clickButton("Help diagnose this");

    const copied = onCopyPrompt.mock.calls[0]?.[0] ?? "";
    // The regression this guards: the prompt must describe the displayed failure,
    // not the newest one.
    expect(copied).toContain("merge blew up");
    expect(copied).not.toContain("ocr blew up");
    expect(copied).toContain(`Reference: ${first}`);
    expect(second).not.toBe(first);
  });

  it("says outright that RaioPDF has no AI of its own", () => {
    // "No AI, no cloud, no telemetry" is the product's promise, so a primary
    // action that mentions AI has to be unambiguous where the user reads it.
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");

    render(<ErrorActions diagnosticId={diagnosticId} />);

    expect(container?.textContent).toContain("RaioPDF has no AI of its own");
    expect(container?.textContent).toContain("Nothing is sent anywhere until you send it");
  });

  it("confirms the copy in a live region", async () => {
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");
    const onCopyPrompt = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    render(<ErrorActions diagnosticId={diagnosticId} onCopyPrompt={onCopyPrompt} />);
    await clickButton("Help diagnose this");

    const status = container?.querySelector(".error-actions__status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(statusText()).toContain("Paste it into your own AI assistant");
  });

  it("offers a selectable fallback, collapsed, when the clipboard is blocked", async () => {
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");
    const onCopyPrompt = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error("blocked"));

    render(<ErrorActions diagnosticId={diagnosticId} onCopyPrompt={onCopyPrompt} />);
    await clickButton("Help diagnose this");

    expect(statusText()).toContain("select and copy it");
    const fallback = container?.querySelector("details.error-actions__fallback");
    expect(fallback).not.toBeNull();
    // Collapsed on purpose: several thousand characters inline traps a
    // screen-reader user inside them.
    expect((fallback as HTMLDetailsElement | null)?.open).toBe(false);
    expect(fallback?.querySelector("code")?.textContent).toContain("I hit an error in RaioPDF");
    expect(fallback?.querySelector("summary")?.textContent).toContain("characters");
  });

  it("copies nothing when canonical redaction is unavailable", async () => {
    // Fails closed on purpose: the prompt tells the reader the text was already
    // scrubbed, so handing over path-only-scrubbed text would make that a lie —
    // and a shell that can't answer may be the very failure being diagnosed.
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");
    const onCopyPrompt = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const originalInternals = "__TAURI_INTERNALS__" in window;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    try {
      render(<ErrorActions diagnosticId={diagnosticId} onCopyPrompt={onCopyPrompt} />);
      await clickButton("Help diagnose this");

      expect(onCopyPrompt).not.toHaveBeenCalled();
      expect(statusText()).toContain("couldn’t prepare a safe copy");
      expect(container?.querySelector("details.error-actions__fallback")).toBeNull();
    } finally {
      if (!originalInternals) {
        delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    }
  });

  it("does not let one action's stale outcome mask the other's", async () => {
    // With both flags set the precedence hid the newer failure behind the older
    // one, and a later successful copy was masked by a stale mail failure.
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");
    const onCopyPrompt = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const onOpenMailDraft = vi
      .fn<(mailto: string) => Promise<void>>()
      .mockRejectedValue(new Error("no handler"));

    render(
      <ErrorActions
        diagnosticId={diagnosticId}
        onCopyPrompt={onCopyPrompt}
        onOpenMailDraft={onOpenMailDraft}
      />,
    );
    await clickButton("Email a report");
    expect(statusText()).toContain("crash-reports@macrify.me");

    await clickButton("Help diagnose this");

    expect(statusText()).toContain("Paste it into your own AI assistant");
    expect(statusText()).not.toContain("crash-reports@macrify.me");
  });

  it("reports a mail client that could not be opened, with the address", async () => {
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");
    const onOpenMailDraft = vi
      .fn<(mailto: string) => Promise<void>>()
      .mockRejectedValue(new Error("no handler"));

    render(<ErrorActions diagnosticId={diagnosticId} onOpenMailDraft={onOpenMailDraft} />);
    await clickButton("Email a report");

    expect(statusText()).toContain("crash-reports@macrify.me");
  });

  it("drafts a mailto for the displayed failure", async () => {
    const diagnosticId = recordDiagnosticEvent("filing.failed", "filing blew up");
    const onOpenMailDraft = vi.fn<(mailto: string) => Promise<void>>().mockResolvedValue(undefined);

    render(<ErrorActions diagnosticId={diagnosticId} onOpenMailDraft={onOpenMailDraft} />);
    await clickButton("Email a report");

    const mailto = onOpenMailDraft.mock.calls[0]?.[0] ?? "";
    expect(mailto.startsWith("mailto:crash-reports@macrify.me?")).toBe(true);
    expect(decodeURIComponent(mailto)).toContain(`Ref: ${diagnosticId}`);
  });

  it("groups the actions and keeps them keyboard reachable", () => {
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");

    render(<ErrorActions diagnosticId={diagnosticId} />);

    const group = container?.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe("Report this problem");
    // Native buttons in DOM order: no tabindex juggling to get wrong.
    for (const button of buttons()) {
      expect(button.getAttribute("tabindex")).toBeNull();
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  it("still discloses the no-AI fact in compact placements", () => {
    // It used to be dropped when compact, which left the disclosure missing on two
    // of six surfaces — where the only other copy is the raw error message. A
    // tighter placement gets shorter wording, not silence.
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");

    render(<ErrorActions diagnosticId={diagnosticId} compact />);

    expect(container?.querySelector(".error-actions--compact")).not.toBeNull();
    expect(container?.textContent).toContain("RaioPDF has no AI");
    expect(container?.textContent).toContain("sends nothing");
    // The actions themselves must survive the tighter treatment.
    expect(buttons()).toHaveLength(2);
  });

  it("keeps a caller's placement class", () => {
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "nope");

    render(<ErrorActions diagnosticId={diagnosticId} className="ocr-dialog__report" />);

    expect(container?.querySelector(".ocr-dialog__report")).not.toBeNull();
  });
});
