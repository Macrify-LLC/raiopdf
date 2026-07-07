// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type { Event } from "@tauri-apps/api/event";
import type { OpenedFileSource } from "./filePort";
import { setLargeDocThresholdBytes } from "./largeDocThreshold";

const tauriState = vi.hoisted(() => ({
  coreModuleLoads: 0,
  webviewModuleLoads: 0,
  invokeCalls: [] as Array<{ command: string; args: unknown }>,
  invokeHandler: undefined as ((command: string, args?: unknown) => unknown) | undefined,
  dragHandler: undefined as ((event: Event<DragDropEvent>) => void) | undefined,
  unlistenCalls: 0,
}));

vi.mock("@tauri-apps/api/core", () => {
  tauriState.coreModuleLoads += 1;
  return {
    invoke: async (command: string, args?: unknown) => {
      tauriState.invokeCalls.push({ command, args });
      if (!tauriState.invokeHandler) {
        throw new Error(`Unexpected invoke: ${command}`);
      }

      return tauriState.invokeHandler(command, args);
    },
  };
});

vi.mock("@tauri-apps/api/webview", () => {
  tauriState.webviewModuleLoads += 1;
  return {
    getCurrentWebview: () => ({
      onDragDropEvent: async (handler: (event: Event<DragDropEvent>) => void) => {
        tauriState.dragHandler = handler;
        return () => {
          tauriState.unlistenCalls += 1;
        };
      },
    }),
  };
});

import { listenForDesktopPdfDrops } from "./tauriDropOpen";

beforeEach(() => {
  tauriState.coreModuleLoads = 0;
  tauriState.webviewModuleLoads = 0;
  tauriState.invokeCalls.length = 0;
  tauriState.invokeHandler = undefined;
  tauriState.dragHandler = undefined;
  tauriState.unlistenCalls = 0;
  setLargeDocThresholdBytes(null);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function enableTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

function emitDrop(paths: string[]) {
  tauriState.dragHandler?.({
    event: "tauri://drag-drop",
    id: 1,
    payload: {
      type: "drop",
      paths,
      position: { x: 0, y: 0 },
    },
  } as Event<DragDropEvent>);
}

async function flushPromises() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("listenForDesktopPdfDrops", () => {
  it("does not load Tauri APIs in browser mode", async () => {
    const unlisten = await listenForDesktopPdfDrops(() => {
      throw new Error("browser mode should not open drops");
    });

    expect(unlisten).toBeNull();
    expect(tauriState.coreModuleLoads).toBe(0);
    expect(tauriState.webviewModuleLoads).toBe(0);
  });

  it("ignores dropped paths with no PDF", async () => {
    enableTauriRuntime();
    const opened: OpenedFileSource[] = [];

    await listenForDesktopPdfDrops((source) => {
      opened.push(source);
    });
    emitDrop(["C:\\cases\\notes.txt", "/tmp/image.png"]);
    await flushPromises();

    expect(opened).toEqual([]);
    expect(tauriState.invokeCalls).toEqual([]);
  });

  it("opens the first PDF path from a desktop drop", async () => {
    enableTauriRuntime();
    const opened: OpenedFileSource[] = [];
    tauriState.invokeHandler = (command, args) => {
      expect(command).toBe("open_dropped_pdf");
      expect(args).toEqual({ path: "C:\\cases\\Case.PDF" });
      return {
        bytesToken: null,
        fileGrant: "grant-1",
        name: "Case.PDF",
        sizeBytes: 128,
        thresholdBytes: 64,
      };
    };

    await listenForDesktopPdfDrops((source) => {
      opened.push(source);
    });
    emitDrop(["C:\\cases\\notes.txt", "C:\\cases\\Case.PDF", "C:\\cases\\other.pdf"]);
    await flushPromises();

    expect(tauriState.invokeCalls).toEqual([
      { command: "open_dropped_pdf", args: { path: "C:\\cases\\Case.PDF" } },
    ]);
    expect(opened).toEqual([
      {
        kind: "rangeGrant",
        grant: "grant-1",
        name: "Case.PDF",
        sizeBytes: 128,
      },
    ]);
  });

  it("unregisters cleanly", async () => {
    enableTauriRuntime();

    const unlisten = await listenForDesktopPdfDrops(() => {});
    unlisten?.();

    expect(tauriState.unlistenCalls).toBe(1);
  });
});
