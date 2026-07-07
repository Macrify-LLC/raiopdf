// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "../lib/appUpdates";
import { UpdatePill } from "./UpdatePill";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const handlers = {
  onDownload: vi.fn(),
  onInstall: vi.fn(),
  onRelaunch: vi.fn(),
};

function renderPill(status: AppUpdateStatus) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<UpdatePill status={status} {...handlers} />);
  });
}

function clickTrigger() {
  const button = container?.querySelector<HTMLButtonElement>(".update-pill__button");
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function clickAction() {
  const action = container?.querySelector<HTMLButtonElement>(".update-pill__action");
  act(() => {
    action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("UpdatePill", () => {
  beforeEach(() => {
    handlers.onDownload.mockReset();
    handlers.onInstall.mockReset();
    handlers.onRelaunch.mockReset();
  });

  it.each(["idle", "current", "unavailable", "checking"] as const)(
    "renders nothing when there is no update in flight (%s)",
    (phase) => {
      renderPill({ phase, message: "" });
      expect(container?.querySelector(".update-pill")).toBeNull();
    },
  );

  it("shows the pill (data-phase) when an update is available", () => {
    renderPill({ phase: "available", message: "RaioPDF 0.1.1 is available.", availableVersion: "0.1.1" });
    const pill = container?.querySelector(".update-pill");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-phase")).toBe("available");
    // Popover is closed until the trigger is clicked.
    expect(container?.querySelector(".update-pill__popover")).toBeNull();
  });

  it("opens a popover whose action runs Download when available", () => {
    renderPill({ phase: "available", message: "available", availableVersion: "0.1.1" });
    clickTrigger();
    expect(container?.querySelector(".update-pill__popover")).not.toBeNull();
    clickAction();
    expect(handlers.onDownload).toHaveBeenCalledOnce();
    expect(handlers.onInstall).not.toHaveBeenCalled();
    expect(handlers.onRelaunch).not.toHaveBeenCalled();
  });

  it("shows progress and no action button while downloading", () => {
    renderPill({ phase: "downloading", message: "Downloading…", progress: 0.5, availableVersion: "0.1.1" });
    clickTrigger();
    expect(container?.querySelector(".update-pill__progress")).not.toBeNull();
    expect(container?.querySelector(".update-pill__action")).toBeNull();
  });

  it("runs Install (not Download) when downloaded", () => {
    renderPill({ phase: "downloaded", message: "ready", availableVersion: "0.1.1" });
    clickTrigger();
    clickAction();
    expect(handlers.onInstall).toHaveBeenCalledOnce();
    expect(handlers.onDownload).not.toHaveBeenCalled();
  });

  it("runs Relaunch when installed", () => {
    renderPill({ phase: "installed", message: "Update installed.", availableVersion: "0.1.1" });
    clickTrigger();
    clickAction();
    expect(handlers.onRelaunch).toHaveBeenCalledOnce();
  });

  it("offers a retry (Download) on error", () => {
    renderPill({ phase: "error", message: "failed", availableVersion: "0.1.1" });
    clickTrigger();
    clickAction();
    expect(handlers.onDownload).toHaveBeenCalledOnce();
  });

  it("closes the popover when the phase becomes hidden (no leaked listeners)", () => {
    renderPill({ phase: "available", message: "available", availableVersion: "0.1.1" });
    clickTrigger();
    expect(container?.querySelector(".update-pill__popover")).not.toBeNull();

    // Phase flips to a hidden phase → the pill hides entirely.
    act(() => {
      root?.render(<UpdatePill status={{ phase: "current", message: "" }} {...handlers} />);
    });
    expect(container?.querySelector(".update-pill")).toBeNull();

    // Back to a visible phase → the popover is closed (open was reset on hide),
    // not silently re-shown with stale listeners.
    act(() => {
      root?.render(
        <UpdatePill
          status={{ phase: "available", message: "available", availableVersion: "0.1.1" }}
          {...handlers}
        />,
      );
    });
    expect(container?.querySelector(".update-pill")).not.toBeNull();
    expect(container?.querySelector(".update-pill__popover")).toBeNull();
  });
});
