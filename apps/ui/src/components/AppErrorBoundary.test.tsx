// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The repo sets this per test file (see ToolPanel.expansion.test.tsx); without it
// async act() does not flush effects.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { getRecentDiagnostics, resetDiagnosticsForTests } from "../lib/diagnostics";
import { AppErrorBoundary } from "./AppErrorBoundary";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let consoleError: ReturnType<typeof vi.spyOn> | null = null;

function Boom(): never {
  throw new Error("render exploded");
}

function render(node: Parameters<Root["render"]>[0]): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll("button") ?? []);
}

beforeEach(() => {
  resetDiagnosticsForTests();
  window.sessionStorage.clear();
  // React logs caught errors; the noise isn't the subject under test.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
  consoleError?.mockRestore();
  consoleError = null;
  window.sessionStorage.clear();
  resetDiagnosticsForTests();
});

describe("AppErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <p>the app</p>
      </AppErrorBoundary>,
    );

    expect(container?.textContent).toContain("the app");
    expect(container?.querySelector(".app-error-boundary")).toBeNull();
  });

  it("catches a render failure and offers a way to report it", () => {
    // Without this, a throw during render leaves a blank window: the failure is
    // logged but nothing appears and there is nothing to click.
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(container?.textContent).toContain("Something went wrong");
    const labels = buttons().map((button) => button.textContent?.trim());
    expect(labels).toContain("Reload RaioPDF");
    expect(labels).toContain("Help diagnose this");
    expect(labels).toContain("Email a report");
  });

  it("records a diagnostic including the component stack", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    const entry = getRecentDiagnostics().at(-1);
    expect(entry?.kind).toBe("ui.render-failed");
    expect(entry?.message).toContain("render exploded");
    // The stack is the whole reason to record here rather than let the
    // window-level handler do it: it names the subtree that failed.
    expect(entry?.details).toContain("componentStack=");
    expect(entry?.details).toContain("Boom");
  });

  it("moves focus to the heading so the user isn't stranded", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(document.activeElement).toBe(container?.querySelector(".app-error-boundary__heading"));
  });

  it("marks the fallback as an alert", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(container?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("stops offering Reload once reloading has not cleared it", () => {
    // A render error that reproduces on load turns Reload into a loop the user
    // cannot escape, so the offer has to run out.
    window.sessionStorage.setItem("raiopdf.errorBoundary.reloadAttempts", "2");

    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(buttons().map((button) => button.textContent?.trim())).not.toContain("Reload RaioPDF");
    expect(container?.textContent).toContain("Reloading didn’t clear it");
    // Reporting must still be possible — that's the point of the surface.
    expect(buttons().map((button) => button.textContent?.trim())).toContain("Help diagnose this");
  });

  it("counts a reload attempt so the guard can trip", () => {
    const onReload = vi.fn();

    render(
      <AppErrorBoundary onReload={onReload}>
        <Boom />
      </AppErrorBoundary>,
    );
    const reload = buttons().find((button) => button.textContent?.trim() === "Reload RaioPDF");
    act(() => {
      reload?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("raiopdf.errorBoundary.reloadAttempts")).toBe("1");
  });

  it("clears a spent reload budget once a render succeeds", () => {
    // Regression: the counter only ever incremented, so after one recovered failure
    // a later unrelated one inherited a spent budget — no Reload button, plus copy
    // claiming a reload had been tried when it hadn't.
    window.sessionStorage.setItem("raiopdf.errorBoundary.reloadAttempts", "2");

    render(
      <AppErrorBoundary>
        <p>the app</p>
      </AppErrorBoundary>,
    );

    expect(window.sessionStorage.getItem("raiopdf.errorBoundary.reloadAttempts")).toBeNull();
  });

  it("scopes the alert to the explanation, not the whole panel", () => {
    // role="alert" implies aria-atomic, so putting it on the container made
    // ErrorActions' nested status region re-announce everything on every copy.
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.className).toContain("app-error-boundary__body");
    expect(container?.querySelector(".app-error-boundary")?.getAttribute("role")).toBeNull();
  });

  it("tells the user their files were not touched", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(container?.textContent).toContain("files on disk are untouched");
  });
});
