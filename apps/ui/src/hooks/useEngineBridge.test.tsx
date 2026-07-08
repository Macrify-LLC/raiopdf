// @vitest-environment jsdom
import { StrictMode, act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfEngineError } from "@raiopdf/engine-api";
import { useEngineBridge } from "./useEngineBridge";
import type { EngineBridge } from "./useEngineBridge";

const sidecarState = vi.hoisted(() => ({
  instances: [] as Array<{
    inspectTextMapCalls: unknown[];
    ocrCalls: unknown[];
    replaceSelectedTextCalls: unknown[];
    replaceTextCalls: unknown[];
    removeEncryptionCalls: Array<{ password: string }>;
    closedHandles: string[];
    options: unknown;
  }>,
  // Queued outcomes for the NEXT ocr() call, consumed across all instances
  // in call order (not per-instance) -- lets a test simulate "the first
  // attempt fails, a fresh engine's attempt succeeds."
  ocrBehaviors: [] as Array<Error | undefined>,
  // Same shape, for removeEncryption().
  removeEncryptionBehaviors: [] as Array<Error | undefined>,
  replaceSelectedTextBehaviors: [] as Array<Error | undefined>,
  replaceTextBehaviors: [] as Array<Error | undefined>,
}));

vi.mock("@raiopdf/engine-sidecar", () => {
  class SidecarPdfEngine {
    readonly inspectTextMapCalls: unknown[] = [];
    readonly ocrCalls: unknown[] = [];
    readonly replaceSelectedTextCalls: unknown[] = [];
    readonly replaceTextCalls: unknown[] = [];
    readonly removeEncryptionCalls: Array<{ password: string }> = [];
    readonly closedHandles: string[] = [];
    readonly options: unknown;
    private nextHandle = 1;
    private readonly bytesByHandle = new Map<string, Uint8Array>();

    constructor(options?: unknown) {
      this.options = options;
      sidecarState.instances.push(this);
    }

    async ocrBytes(_bytes: Uint8Array, options: { knownPageCount?: number; pageIndexes?: readonly number[] } = {}) {
      this.ocrCalls.push(options);
      const behavior = sidecarState.ocrBehaviors.shift();

      if (behavior) {
        throw behavior;
      }

      return {
        bytes: new Uint8Array([9]),
        pageCount: options.knownPageCount ?? 1,
      };
    }

    async removeEncryption(_bytes: Uint8Array, password: string) {
      this.removeEncryptionCalls.push({ password });
      const behavior = sidecarState.removeEncryptionBehaviors.shift();

      if (behavior) {
        throw behavior;
      }

      return new Uint8Array([7]);
    }

    async open(bytes: Uint8Array) {
      const handle = `test-pdf:${this.nextHandle}`;
      this.nextHandle += 1;
      this.bytesByHandle.set(handle, bytes);

      return handle;
    }

    async replaceText(handle: string, options: unknown) {
      this.replaceTextCalls.push({ handle, options });
      const behavior = sidecarState.replaceTextBehaviors.shift();

      if (behavior) {
        throw behavior;
      }

      const outputHandle = `test-pdf:${this.nextHandle}`;
      this.nextHandle += 1;
      this.bytesByHandle.set(outputHandle, new Uint8Array([5]));

      return {
        document: outputHandle,
        replacedCounts: null,
        warnings: [{ code: "COUNTS_UNAVAILABLE", message: "Counts unavailable." }],
      };
    }

    async inspectTextMap(handle: string, options: unknown) {
      this.inspectTextMapCalls.push({ handle, options });

      return {
        sourceFingerprint: "document-fingerprint",
        pages: [{
          pageIndex: 0,
          text: "John Smith",
          sourceFingerprint: "fingerprint",
          elements: [],
        }],
      };
    }

    async replaceSelectedText(handle: string, options: unknown) {
      this.replaceSelectedTextCalls.push({ handle, options });
      const behavior = sidecarState.replaceSelectedTextBehaviors.shift();

      if (behavior) {
        throw behavior;
      }

      const outputHandle = `test-pdf:${this.nextHandle}`;
      this.nextHandle += 1;
      this.bytesByHandle.set(outputHandle, new Uint8Array([6]));

      return {
        document: outputHandle,
        warnings: [],
      };
    }

    async saveToBytes(handle: string) {
      return this.bytesByHandle.get(handle) ?? new Uint8Array();
    }

    async close(handle: string) {
      this.closedHandles.push(handle);

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
    sidecarState.ocrBehaviors.length = 0;
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

  it("uses IPv4 loopback for the desktop engine proxy", async () => {
    const bridge = renderHookValue();

    await act(async () => {
      await bridge.runOcr(new Uint8Array([1]));
    });

    expect(sidecarState.instances[0]?.options).toMatchObject({
      baseUrl: "http://127.0.0.1:1234",
    });
  });

  it("passes force-ocr through to the sidecar", async () => {
    const bridge = renderHookValue();
    let result: Awaited<ReturnType<EngineBridge["runOcr"]>> | undefined;

    await act(async () => {
      result = await bridge.runOcr(new Uint8Array([1]), {
        ocrType: "force-ocr",
        pageCount: 4,
        pageIndexes: [0, 2],
      });
    });

    expect(result).toEqual({ bytes: new Uint8Array([9]), pageCount: 4 });
    expect(sidecarState.instances[0]?.ocrCalls[0]).toMatchObject({
      ocrType: "force-ocr",
      knownPageCount: 4,
      pageIndexes: [0, 2],
    });
  });

  it("self-heals after an idle-killed engine: retries once against a fresh engine and succeeds", async () => {
    // Simulates the idle-shutdown bug (issue #1): the cached engine's port
    // is dead, so the first request fails with a fetch-style connection
    // error -- a TypeError somewhere in the .cause chain, wrapped the same
    // way packages/engine-sidecar/src/index.ts:773-793 wraps a real fetch
    // failure.
    const connectionError = new Error("Stirling PDF request failed.", {
      cause: new TypeError("Failed to fetch"),
    });
    sidecarState.ocrBehaviors.push(connectionError);

    const bridge = renderHookValue();
    let result: Awaited<ReturnType<EngineBridge["runOcr"]>> | undefined;

    await act(async () => {
      result = await bridge.runOcr(new Uint8Array([1]));
    });

    expect(result?.bytes).toEqual(new Uint8Array([9]));
    // One dead engine, one fresh replacement -- exactly one retry.
    expect(sidecarState.instances).toHaveLength(2);
    expect(sidecarState.instances[0]?.ocrCalls).toHaveLength(1);
    expect(sidecarState.instances[1]?.ocrCalls).toHaveLength(1);
  });

  it("dedupes two concurrent ops against a dead engine into a single engine_start", async () => {
    let engineStartCalls = 0;
    window.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command === "engine_start") {
        engineStartCalls += 1;
      }

      return {
        port: 1234,
        token: "test-token",
        ocrToolchain: { available: true, missing: [] },
      } as T;
    };

    const bridge = renderHookValue();

    await act(async () => {
      await Promise.all([
        bridge.runOcr(new Uint8Array([1])),
        bridge.runOcr(new Uint8Array([2])),
      ]);
    });

    expect(engineStartCalls).toBe(1);
    expect(sidecarState.instances).toHaveLength(1);
  });

  it("does not install a sidecar engine after unmounting during start", async () => {
    const startCalled = createDeferred<void>();
    const startResponse = createDeferred<{
      port: number;
      token: string;
      ocrToolchain: { available: boolean; missing: string[] };
    }>();
    window.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command === "engine_start") {
        startCalled.resolve();
        return await startResponse.promise as T;
      }

      throw new Error(`Unexpected command: ${command}`);
    };

    const bridge = renderHookValue();

    act(() => {
      bridge.warmEngine();
    });
    await act(async () => {
      await startCalled.promise;
    });
    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      startResponse.resolve({
        port: 1234,
        token: "test-token",
        ocrToolchain: { available: true, missing: [] },
      });
      await startResponse.promise;
    });

    expect(sidecarState.instances).toHaveLength(0);
  });

  it("survives StrictMode effect replay before starting the engine", async () => {
    const bridge = renderHookValue({ strict: true });

    await act(async () => {
      await bridge.runOcr(new Uint8Array([1]));
    });

    expect(sidecarState.instances).toHaveLength(1);
    expect(sidecarState.instances[0]?.ocrCalls).toHaveLength(1);
  });

  it("does not retry a non-connection failure (e.g. a genuinely bad PDF)", async () => {
    // No .cause chain -- this is what a real Stirling HTTP error response
    // looks like (throwResponseError never sets `cause`), distinct from a
    // network-level failure.
    const invalidDocumentError = new Error(
      "Stirling PDF request failed: bad file (INVALID_DOCUMENT)",
    );
    sidecarState.ocrBehaviors.push(invalidDocumentError);

    const bridge = renderHookValue();
    let caught: unknown = null;

    await act(async () => {
      try {
        await bridge.runOcr(new Uint8Array([1]));
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(invalidDocumentError);
    // No retry -- only the one engine, one failed attempt.
    expect(sidecarState.instances).toHaveLength(1);
    expect(sidecarState.instances[0]?.ocrCalls).toHaveLength(1);
  });

  function renderHookValue(options: { strict?: boolean } = {}): EngineBridge {
    let bridge: EngineBridge | null = null;
    render(
      options.strict
        ? <StrictMode><Harness onReady={(value) => { bridge = value; }} /></StrictMode>
        : <Harness onReady={(value) => { bridge = value; }} />,
    );

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

describe("useEngineBridge removeEncryption", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    window.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>() => ({
      port: 1234,
      token: "test-token",
      ocrToolchain: { available: true, missing: [] },
    }) as T;
    sidecarState.instances.length = 0;
    sidecarState.removeEncryptionBehaviors.length = 0;
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

  it("passes the password through and resolves with the decrypted bytes", async () => {
    const bridge = renderHookValue();
    let bytes: Uint8Array | undefined;

    await act(async () => {
      bytes = await bridge.removeEncryption(new Uint8Array([1]), "correct horse battery staple");
    });

    expect(bytes).toEqual(new Uint8Array([7]));
    expect(sidecarState.instances[0]?.removeEncryptionCalls).toEqual([
      { password: "correct horse battery staple" },
    ]);
  });

  it("fires onEngineReady once the engine is confirmed ready", async () => {
    const bridge = renderHookValue();
    const readyOrder: string[] = [];

    await act(async () => {
      await bridge.removeEncryption(new Uint8Array([1]), "secret", {
        onEngineReady: () => readyOrder.push("ready"),
      });
    });

    expect(readyOrder).toEqual(["ready"]);
  });

  it("propagates a wrong-password ENCRYPTED_DOCUMENT without retrying", async () => {
    // Mirrors packages/engine-sidecar's real mapping: a wrong password comes
    // back as PdfEngineError("ENCRYPTED_DOCUMENT", ...) with no .cause
    // TypeError -- a content-level rejection, not a connection failure, so
    // withEngineRetry must not spin up a second engine and retry it.
    const wrongPassword = new PdfEngineError(
      "ENCRYPTED_DOCUMENT",
      "The PDF password was not accepted.",
    );
    sidecarState.removeEncryptionBehaviors.push(wrongPassword);

    const bridge = renderHookValue();
    let caught: unknown = null;

    await act(async () => {
      try {
        await bridge.removeEncryption(new Uint8Array([1]), "wrong-guess");
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(wrongPassword);
    expect(sidecarState.instances).toHaveLength(1);
    expect(sidecarState.instances[0]?.removeEncryptionCalls).toHaveLength(1);
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

describe("useEngineBridge replaceText", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    window.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>() => ({
      port: 1234,
      token: "test-token",
      ocrToolchain: { available: true, missing: [] },
    }) as T;
    sidecarState.instances.length = 0;
    sidecarState.replaceTextBehaviors.length = 0;
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

  it("opens bytes, runs replaceText, saves output bytes, and closes both handles", async () => {
    const bridge = renderHookValue();
    let result: Awaited<ReturnType<EngineBridge["replaceText"]>> | undefined;

    await act(async () => {
      result = await bridge.replaceText(new Uint8Array([1]), {
        operations: [{ find: "Plaintiff", replace: "Petitioner" }],
        wholeWord: true,
      });
    });

    expect(result).toEqual({
      bytes: new Uint8Array([5]),
      replacedCounts: null,
      warnings: [{ code: "COUNTS_UNAVAILABLE", message: "Counts unavailable." }],
    });
    expect(sidecarState.instances[0]?.replaceTextCalls[0]).toMatchObject({
      handle: "test-pdf:1",
      options: {
        operations: [{ find: "Plaintiff", replace: "Petitioner" }],
        wholeWord: true,
      },
    });
    expect(sidecarState.instances[0]?.closedHandles).toEqual(["test-pdf:2", "test-pdf:1"]);
  });

  it("propagates PdfEngineError from replaceText without retrying", async () => {
    const signed = new PdfEngineError(
      "SIGNED_DOCUMENT",
      "Text editing would invalidate existing PDF signatures.",
    );
    sidecarState.replaceTextBehaviors.push(signed);

    const bridge = renderHookValue();
    let caught: unknown = null;

    await act(async () => {
      try {
        await bridge.replaceText(new Uint8Array([1]), {
          operations: [{ find: "Plaintiff", replace: "Petitioner" }],
        });
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(signed);
    expect(sidecarState.instances).toHaveLength(1);
    expect(sidecarState.instances[0]?.replaceTextCalls).toHaveLength(1);
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

describe("useEngineBridge selected text editing", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    window.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>() => ({
      port: 1234,
      token: "test-token",
      ocrToolchain: { available: true, missing: [] },
    }) as T;
    sidecarState.instances.length = 0;
    sidecarState.replaceSelectedTextBehaviors.length = 0;
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

  it("opens bytes, inspects the text map, and closes the source handle", async () => {
    const bridge = renderHookValue();
    let result: Awaited<ReturnType<EngineBridge["inspectTextMap"]>> | undefined;

    await act(async () => {
      result = await bridge.inspectTextMap(new Uint8Array([1]), {
        pageIndexes: [0],
      });
    });

    expect(result?.pages[0]?.text).toBe("John Smith");
    expect(sidecarState.instances[0]?.inspectTextMapCalls[0]).toMatchObject({
      handle: "test-pdf:1",
      options: { pageIndexes: [0] },
    });
    expect(sidecarState.instances[0]?.closedHandles).toEqual(["test-pdf:1"]);
  });

  it("opens bytes, replaces selected text, saves output bytes, and closes both handles", async () => {
    const bridge = renderHookValue();
    let result: Awaited<ReturnType<EngineBridge["replaceSelectedText"]>> | undefined;

    await act(async () => {
      result = await bridge.replaceSelectedText(new Uint8Array([1]), {
        replacement: "Jane Doe",
        target: {
          pageIndex: 0,
          start: 0,
          end: 10,
          expectedText: "John Smith",
          sourceDocumentFingerprint: "document-fingerprint",
          sourceFingerprint: "fingerprint",
          firstElementIndex: 0,
          lastElementIndex: 0,
          firstElementOffset: 0,
          lastElementOffset: 10,
        },
      });
    });

    expect(result).toEqual({ bytes: new Uint8Array([6]), warnings: [] });
    expect(sidecarState.instances[0]?.replaceSelectedTextCalls[0]).toMatchObject({
      handle: "test-pdf:1",
      options: {
        replacement: "Jane Doe",
        target: {
          expectedText: "John Smith",
          sourceDocumentFingerprint: "document-fingerprint",
          sourceFingerprint: "fingerprint",
        },
      },
    });
    expect(sidecarState.instances[0]?.closedHandles).toEqual(["test-pdf:2", "test-pdf:1"]);
  });

  it("propagates PdfEngineError from replaceSelectedText without retrying", async () => {
    const stale = new PdfEngineError(
      "INVALID_DOCUMENT",
      "The selected text target is stale.",
    );
    sidecarState.replaceSelectedTextBehaviors.push(stale);

    const bridge = renderHookValue();
    let caught: unknown = null;

    await act(async () => {
      try {
        await bridge.replaceSelectedText(new Uint8Array([1]), {
          replacement: "Jane Doe",
          target: {
            pageIndex: 0,
            start: 0,
            end: 10,
            expectedText: "John Smith",
            sourceDocumentFingerprint: "document-fingerprint",
            sourceFingerprint: "fingerprint",
            firstElementIndex: 0,
            lastElementIndex: 0,
            firstElementOffset: 0,
            lastElementOffset: 10,
          },
        });
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(stale);
    expect(sidecarState.instances).toHaveLength(1);
    expect(sidecarState.instances[0]?.replaceSelectedTextCalls).toHaveLength(1);
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}
