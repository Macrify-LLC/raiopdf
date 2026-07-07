// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import { downloadSignedUpdate, installDownloadedUpdate } from "./appUpdates";

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

  it("installDownloadedUpdate installs the staged handle and downloads nothing", async () => {
    const update = fakeUpdate();

    await installDownloadedUpdate(update);

    expect(update.install).toHaveBeenCalledOnce();
    expect(update.download).not.toHaveBeenCalled();
  });
});
