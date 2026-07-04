// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEngineBridge } from "./useEngineBridge";
import type { EngineBridge } from "./useEngineBridge";

const sidecarState = vi.hoisted(() => ({
  instances: [] as Array<{
    ocrCalls: unknown[];
  }>,
}));

vi.mock("@raiopdf/engine-sidecar", () => {
  class SidecarPdfEngine {
    readonly ocrCalls: unknown[] = [];

    constructor() {
      sidecarState.instances.push(this);
    }

    async ocrBytes(_bytes: Uint8Array, options: { knownPageCount?: number } = {}) {
      this.ocrCalls.push(options);
      return {
        bytes: new Uint8Array([9]),
        pageCount: options.knownPageCount ?? 1,
      };
    }

    async close() {
      return undefined;
    }
  }

  return { SidecarPdfEngine };
});

describe("useEngineBridge runOcr", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    window.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>() => ({
      port: 1234,
      token: "test-token",
      ocrToolchain: { available: true, missing: [] },
    }) as T;
    sidecarState.instances.length = 0;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    delete window.__RAIOPDF_TEST_TAURI_INVOKE__;
    delete window.__RAIOPDF_TEST_ENGINE_FETCH__;
    container?.remove();
    root = null;
    container = null;
  });

  it("defaults OCR to skip-text", async () => {
    const bridge = renderHookValue();

    await act(async () => {
      await bridge.runOcr(new Uint8Array([1]));
    });

    expect(sidecarState.instances[0]?.ocrCalls[0]).toMatchObject({ ocrType: "skip-text" });
  });

  it("passes force-ocr through to the sidecar", async () => {
    const bridge = renderHookValue();
    let result: Awaited<ReturnType<EngineBridge["runOcr"]>> | undefined;

    await act(async () => {
      result = await bridge.runOcr(new Uint8Array([1]), { ocrType: "force-ocr", pageCount: 4 });
    });

    expect(result).toEqual({ bytes: new Uint8Array([9]), pageCount: 4 });
    expect(sidecarState.instances[0]?.ocrCalls[0]).toMatchObject({
      ocrType: "force-ocr",
      knownPageCount: 4,
    });
  });

  function renderHookValue(): EngineBridge {
    let bridge: EngineBridge | null = null;
    render(<Harness onReady={(value) => { bridge = value; }} />);

    if (!bridge) {
      throw new Error("Engine bridge was not rendered.");
    }

    return bridge;
  }

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
  }
});

function Harness({ onReady }: { onReady: (bridge: EngineBridge) => void }) {
  const bridge = useEngineBridge();

  useEffect(() => {
    onReady(bridge);
  }, [bridge, onReady]);

  return null;
}
