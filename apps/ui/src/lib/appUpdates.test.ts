// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  downloadSignedUpdate,
  formatUpdateDownloadError,
  installDownloadedUpdate,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
} from "./appUpdates";

/**
 * A stand-in for the plugin's Update handle. `download` emits the same event
 * shape the real plugin does so the progress mapping is exercised.
 */
function fakeUpdate(overrides: Partial<Record<"download" | "install", unknown>> = {}) {
  const download = vi.fn(
    async (onEvent?: (event: { event: string; data: Record<string, number> }) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
      onEvent?.({ event: "Finished", data: {} });
    },
  );
  const install = vi.fn(async () => undefined);
  return { download, install, ...overrides } as unknown as Update & {
    download: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
  };
}

describe("appUpdates — download and install are decoupled", () => {
  it("downloadSignedUpdate downloads but NEVER installs (no auto-install)", async () => {
    const update = fakeUpdate();
    const progress: (number | null)[] = [];

    await downloadSignedUpdate(update, (value) => progress.push(value));

    expect(update.download).toHaveBeenCalledOnce();
    // The whole point of the redesign: downloading must not trigger an install.
    expect(update.install).not.toHaveBeenCalled();
    // Progress maps Started→0, Progress→fractions, Finished→1.
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(Math.max(...progress.map((value) => value ?? 0))).toBeLessThanOrEqual(1);
  });

  it("downloadSignedUpdate reports indeterminate progress when total is unknown", async () => {
    const update = fakeUpdate({
      download: vi.fn(
        async (onEvent?: (event: { event: string; data: Record<string, number> }) => void) => {
          onEvent?.({ event: "Started", data: {} }); // no contentLength
          onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
        },
      ),
    });
    const progress: (number | null)[] = [];

    await downloadSignedUpdate(update, (value) => progress.push(value));

    expect(progress[0]).toBeNull();
  });

  it("downloads with the 60-minute total-request deadline", async () => {
    const update = fakeUpdate();

    await downloadSignedUpdate(update, () => undefined);

    // The plugin timeout is a TOTAL request deadline, so it doubles as a
    // minimum sustained speed for the ~400 MB artifact. 60 minutes keeps that
    // floor under 1 Mbps while still guaranteeing a terminal state.
    expect(UPDATE_DOWNLOAD_TIMEOUT_MS).toBe(60 * 60_000);
    expect(update.download).toHaveBeenCalledWith(expect.any(Function), {
      timeout: UPDATE_DOWNLOAD_TIMEOUT_MS,
    });
  });

  it("installDownloadedUpdate installs the staged handle and downloads nothing", async () => {
    const update = fakeUpdate();

    await installDownloadedUpdate(update);

    expect(update.install).toHaveBeenCalledOnce();
    expect(update.download).not.toHaveBeenCalled();
  });
});

describe("formatUpdateDownloadError", () => {
  const headline =
    "Update download could not be completed. Try again, or download the latest installer "
    + "directly from the RaioPDF GitHub releases page.";

  it("keeps the headline and points at the manual download when nothing else is known", () => {
    expect(formatUpdateDownloadError(undefined, null)).toBe(headline);
  });

  it("appends the progress reached and the underlying Error message", () => {
    const message = formatUpdateDownloadError(new Error("operation timed out"), 0.42);

    expect(message.startsWith(headline)).toBe(true);
    expect(message).toContain("stopped at 42%");
    expect(message).toContain("operation timed out");
  });

  it("handles plain-string errors from the plugin", () => {
    expect(formatUpdateDownloadError("network error: connection reset", 0)).toBe(
      `${headline} Details: stopped at 0% - network error: connection reset`,
    );
  });

  it("handles object errors with a message field, and never says [object Object]", () => {
    const message = formatUpdateDownloadError({ message: "Io error: timed out" }, null);

    expect(message).toBe(`${headline} Details: Io error: timed out`);
    expect(message).not.toContain("[object Object]");
  });

  it("serializes an unrecognized object shape instead of dropping it", () => {
    const message = formatUpdateDownloadError({ kind: "timeout", elapsedMs: 600000 }, null);

    expect(message).toContain("timeout");
    expect(message).not.toContain("[object Object]");
  });

  it("omits detail for an object that carries nothing useful", () => {
    expect(formatUpdateDownloadError({}, null)).toBe(headline);
  });

  it("truncates a very long underlying error", () => {
    const message = formatUpdateDownloadError("x".repeat(1000), null);

    expect(message.length).toBeLessThan(headline.length + 250);
    expect(message.endsWith("...")).toBe(true);
  });

  it("collapses newlines so the pill stays one readable line", () => {
    expect(formatUpdateDownloadError("first line\n  second line", null)).toBe(
      `${headline} Details: first line second line`,
    );
  });

  it("clamps out-of-range progress values", () => {
    expect(formatUpdateDownloadError(null, 1.4)).toContain("stopped at 100%");
    expect(formatUpdateDownloadError(null, -0.2)).toContain("stopped at 0%");
    expect(formatUpdateDownloadError(null, Number.NaN)).toBe(headline);
  });
});
