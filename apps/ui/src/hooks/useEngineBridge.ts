import { useCallback, useMemo, useRef, useState } from "react";
import { SidecarPdfEngine } from "@raiopdf/engine-sidecar";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";

interface EngineStartResponse {
  disabled?: boolean;
  port?: number;
}

export interface RunOcrOptions {
  onEngineReady?: () => void;
}

export interface EngineBridge {
  available: boolean;
  starting: boolean;
  error: string | null;
  runOcr: (bytes: Uint8Array, options?: RunOcrOptions) => Promise<Uint8Array>;
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __RAIOPDF_TEST_TAURI_INVOKE__?: TauriInvoke;
    __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
  }
}

export class EngineBridgeUnavailableError extends Error {
  constructor(message = "OCR runs in the desktop app.") {
    super(message);
    this.name = "EngineBridgeUnavailableError";
  }
}

export function isEngineBridgeUnavailableError(
  error: unknown,
): error is EngineBridgeUnavailableError {
  return error instanceof EngineBridgeUnavailableError;
}

export function useEngineBridge(): EngineBridge {
  const runtimeAvailable = useMemo(() => isTauriRuntime() || hasTestInvoke(), []);
  const [disabled, setDisabled] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<SidecarPdfEngine | null>(null);

  const ensureEngine = useCallback(async () => {
    if (!runtimeAvailable || disabled) {
      throw new EngineBridgeUnavailableError();
    }

    const existingEngine = engineRef.current;
    if (existingEngine) {
      return existingEngine;
    }

    setStarting(true);
    setError(null);

    try {
      const invoke = await getTauriInvoke();
      const response = await invoke<EngineStartResponse>("engine_start");

      if (response.disabled || typeof response.port !== "number") {
        engineRef.current = null;
        setDisabled(true);
        throw new EngineBridgeUnavailableError();
      }

      const engine = new SidecarPdfEngine({
        baseUrl: `http://127.0.0.1:${response.port}`,
        ...(window.__RAIOPDF_TEST_ENGINE_FETCH__
          ? { fetch: window.__RAIOPDF_TEST_ENGINE_FETCH__ }
          : {}),
      });
      engineRef.current = engine;

      return engine;
    } catch (caught) {
      if (caught instanceof EngineBridgeUnavailableError) {
        throw caught;
      }

      const message = "The PDF engine could not be started.";
      setError(message);
      throw new Error(message, { cause: caught });
    } finally {
      setStarting(false);
    }
  }, [disabled, runtimeAvailable]);

  const runOcr = useCallback(
    async (bytes: Uint8Array, options: RunOcrOptions = {}) => {
      const engine = await ensureEngine();
      options.onEngineReady?.();

      const sourceHandle = await engine.open(bytes);
      let outputHandle: PdfDocumentHandle | null = null;

      try {
        outputHandle = await engine.ocr(sourceHandle, {
          languages: ["eng"],
          ocrType: "skip-text",
          deskew: false,
        });

        return await engine.saveToBytes(outputHandle);
      } finally {
        await closeHandle(engine, outputHandle);
        await closeHandle(engine, sourceHandle);
      }
    },
    [ensureEngine],
  );

  return {
    available: runtimeAvailable && !disabled,
    starting,
    error,
    runOcr,
  };
}

async function closeHandle(
  engine: SidecarPdfEngine,
  handle: PdfDocumentHandle | null,
): Promise<void> {
  if (!handle) {
    return;
  }

  try {
    await engine.close(handle);
  } catch {
    // Sidecar handles are best-effort cleanup after OCR completion.
  }
}

async function getTauriInvoke(): Promise<TauriInvoke> {
  if (window.__RAIOPDF_TEST_TAURI_INVOKE__) {
    return window.__RAIOPDF_TEST_TAURI_INVOKE__;
  }

  const { invoke } = await import("@tauri-apps/api/core");

  return invoke;
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function hasTestInvoke(): boolean {
  return typeof window.__RAIOPDF_TEST_TAURI_INVOKE__ === "function";
}
