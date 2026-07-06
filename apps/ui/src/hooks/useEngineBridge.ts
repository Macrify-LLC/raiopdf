import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import { SidecarPdfEngine } from "@raiopdf/engine-sidecar";
import type {
  PdfAFlavor,
  PdfCompressOptions,
  PdfDocumentHandle,
  PdfInspectTextMapOptions,
  PdfInspectTextMapResult,
  PdfReplaceSelectedTextOptions,
  PdfReplaceTextOptions,
  PdfReplaceTextWarning,
  PdfRedactionArea,
  PdfSanitizeOptions,
  PdfSanitizeResult,
} from "@raiopdf/engine-api";

interface EngineStartResponse {
  disabled?: boolean;
  port?: number;
  token?: string;
  ocrToolchain?: EngineOcrToolchainStatus;
}

interface EngineOcrToolchainStatus {
  available: boolean;
  missing: string[];
}

export interface RunOcrOptions {
  ocrType?: "skip-text" | "force-ocr";
  pageCount?: number;
  pageIndexes?: readonly number[];
  onEngineReady?: () => void;
}

export interface RemoveEncryptionOptions {
  /**
   * Fired once the sidecar engine is confirmed ready (started fresh or
   * already warm) and the request is about to go out -- lets a caller show
   * a "starting the PDF engine" state only while that's actually happening,
   * same as `RunOcrOptions.onEngineReady`.
   */
  onEngineReady?: () => void;
}

export type RunOcrResult = {
  bytes: Uint8Array;
  pageCount: number;
};

export type ReplaceTextBridgeOptions = PdfReplaceTextOptions;
export type ReplaceSelectedTextBridgeOptions = PdfReplaceSelectedTextOptions;

export interface EngineBridge {
  available: boolean;
  ocrAvailable: boolean;
  starting: boolean;
  error: string | null;
  /**
   * Fire-and-forget: starts the engine in the background (or no-ops if it's
   * already running/starting) without surfacing a loading state or an
   * error. Meant for pre-warming while a confirm dialog is on screen so the
   * real operation, when the user commits to it, has less to wait on.
   */
  warmEngine: () => void;
  runOcr: (bytes: Uint8Array, options?: RunOcrOptions) => Promise<RunOcrResult>;
  redactAreas: (bytes: Uint8Array, areas: readonly PdfRedactionArea[]) => Promise<Uint8Array>;
  convertToPdfA: (bytes: Uint8Array, flavor: PdfAFlavor) => Promise<Uint8Array>;
  compress: (bytes: Uint8Array, options: PdfCompressOptions) => Promise<Uint8Array>;
  removeEncryption: (
    bytes: Uint8Array,
    password: string,
    options?: RemoveEncryptionOptions,
  ) => Promise<Uint8Array>;
  sanitize: (bytes: Uint8Array, options?: PdfSanitizeOptions) => Promise<{
    bytes: Uint8Array;
    removed: PdfSanitizeResult["removed"];
  }>;
  replaceText: (bytes: Uint8Array, options: ReplaceTextBridgeOptions) => Promise<{
    bytes: Uint8Array;
    replacedCounts: readonly number[] | null;
    warnings: readonly PdfReplaceTextWarning[];
  }>;
  inspectTextMap: (
    bytes: Uint8Array,
    options?: PdfInspectTextMapOptions,
  ) => Promise<PdfInspectTextMapResult>;
  replaceSelectedText: (bytes: Uint8Array, options: ReplaceSelectedTextBridgeOptions) => Promise<{
    bytes: Uint8Array;
    warnings: readonly PdfReplaceTextWarning[];
  }>;
  repair: (bytes: Uint8Array) => Promise<Uint8Array>;
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __RAIOPDF_TEST_TAURI_INVOKE__?: TauriInvoke;
    __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
  }
}

export class EngineBridgeUnavailableError extends Error {
  constructor(message = "This action is available in the desktop app.") {
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
  const [ocrToolchainMissing, setOcrToolchainMissing] = useState<readonly string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<SidecarPdfEngine | null>(null);
  const ocrToolchainMissingRef = useRef<readonly string[]>([]);
  // Dedupe concurrent ensureEngine() callers behind one in-flight start so
  // two operations kicked off back-to-back don't both invoke engine_start.
  // Cleared on settle (success or failure) so a failed start never poisons
  // later attempts.
  const inFlightStartRef = useRef<Promise<SidecarPdfEngine> | null>(null);

  const setMissingOcrToolchain = useCallback((missing: readonly string[]) => {
    ocrToolchainMissingRef.current = missing;
    setOcrToolchainMissing(missing);
  }, []);

  const startEngine = useCallback(async (): Promise<SidecarPdfEngine> => {
    setStarting(true);
    setError(null);

    try {
      const invoke = await getTauriInvoke();
      const response = await invoke<EngineStartResponse>("engine_start");

      if (response.disabled) {
        // Genuine "no engine in this installation" — the only case that
        // permanently disables engine features for the session.
        engineRef.current = null;
        setDisabled(true);
        throw new EngineBridgeUnavailableError();
      }

      if (typeof response.port !== "number" || typeof response.token !== "string") {
        // Malformed start response: fail this attempt but do NOT latch
        // disabled — a later attempt may succeed.
        engineRef.current = null;
        throw new Error("engine_start returned an incomplete response");
      }

      setMissingOcrToolchain(response.ocrToolchain?.available === false
        ? response.ocrToolchain.missing
        : []);

      const engine = new SidecarPdfEngine({
        authToken: response.token,
        // The shell binds the authenticated proxy to IPv4 loopback. On Windows,
        // WebView may resolve localhost to ::1 first and fail before retrying.
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
  }, [setMissingOcrToolchain]);

  const ensureEngine = useCallback((): Promise<SidecarPdfEngine> => {
    if (!runtimeAvailable || disabled) {
      return Promise.reject(new EngineBridgeUnavailableError());
    }

    const existingEngine = engineRef.current;
    if (existingEngine) {
      return Promise.resolve(existingEngine);
    }

    const inFlight = inFlightStartRef.current;
    if (inFlight) {
      return inFlight;
    }

    const startPromise: Promise<SidecarPdfEngine> = startEngine().finally(() => {
      // Only this call's own promise clears the ref -- a generation-safe
      // no-op if something else already replaced it.
      if (inFlightStartRef.current === startPromise) {
        inFlightStartRef.current = null;
      }
    });

    inFlightStartRef.current = startPromise;

    return startPromise;
  }, [disabled, runtimeAvailable, startEngine]);

  const warmEngine = useCallback(() => {
    void ensureEngine().catch(() => {
      // Pre-warm failures are silent -- the real operation surfaces its own
      // error when it actually needs the engine.
    });
  }, [ensureEngine]);

  const runOcr = useCallback(
    (bytes: Uint8Array, options: RunOcrOptions = {}) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        if (ocrToolchainMissingRef.current.length > 0) {
          throw new EngineBridgeUnavailableError(
            "OCR toolchain missing from this installation.",
          );
        }

        options.onEngineReady?.();

        // Single raw-byte OCR request (#107): the sidecar returns bytes +
        // page count directly, skipping the redundant basic-info probe.
        return engine.ocrBytes(bytes, {
          languages: ["eng"],
          ocrType: options.ocrType ?? "skip-text",
          deskew: false,
          ...(options.pageIndexes?.length
            ? { pageIndexes: options.pageIndexes }
            : {}),
          ...(options.pageCount !== undefined
            ? { knownPageCount: options.pageCount }
            : {}),
        });
      }),
    [ensureEngine],
  );

  const redactAreas = useCallback(
    (bytes: Uint8Array, areas: readonly PdfRedactionArea[]) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        const sourceHandle = await engine.open(bytes);
        let outputHandle: PdfDocumentHandle | null = null;

        try {
          outputHandle = await engine.redactAreas(sourceHandle, areas);

          return await engine.saveToBytes(outputHandle);
        } finally {
          await closeHandle(engine, outputHandle);
          await closeHandle(engine, sourceHandle);
        }
      }),
    [ensureEngine],
  );

  const convertToPdfA = useCallback(
    (bytes: Uint8Array, flavor: PdfAFlavor) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        const sourceHandle = await engine.open(bytes);
        let outputHandle: PdfDocumentHandle | null = null;

        try {
          outputHandle = await engine.convertToPdfA(sourceHandle, {
            flavor,
            strict: false,
          });

          return await engine.saveToBytes(outputHandle);
        } finally {
          await closeHandle(engine, outputHandle);
          await closeHandle(engine, sourceHandle);
        }
      }),
    [ensureEngine],
  );

  const compress = useCallback(
    (bytes: Uint8Array, options: PdfCompressOptions) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        const sourceHandle = await engine.open(bytes);
        let outputHandle: PdfDocumentHandle | null = null;

        try {
          outputHandle = await engine.compress(sourceHandle, options);

          return await engine.saveToBytes(outputHandle);
        } finally {
          await closeHandle(engine, outputHandle);
          await closeHandle(engine, sourceHandle);
        }
      }),
    [ensureEngine],
  );

  const removeEncryption = useCallback(
    (bytes: Uint8Array, password: string, options: RemoveEncryptionOptions = {}) =>
      withEngineRetry(ensureEngine, engineRef, (engine) => {
        options.onEngineReady?.();

        return engine.removeEncryption(bytes, password);
      }),
    [ensureEngine],
  );

  const sanitize = useCallback(
    (bytes: Uint8Array, options: PdfSanitizeOptions = {}) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        const sourceHandle = await engine.open(bytes);
        let outputHandle: PdfDocumentHandle | null = null;

        try {
          const result = await engine.sanitize(sourceHandle, options);
          outputHandle = result.document;

          return {
            bytes: await engine.saveToBytes(outputHandle),
            removed: result.removed,
          };
        } finally {
          await closeHandle(engine, outputHandle);
          await closeHandle(engine, sourceHandle);
        }
      }),
    [ensureEngine],
  );

  const repair = useCallback(
    (bytes: Uint8Array) =>
      withEngineRetry(ensureEngine, engineRef, (engine) => engine.repairBytes(bytes)),
    [ensureEngine],
  );

  const replaceText = useCallback(
    (bytes: Uint8Array, options: ReplaceTextBridgeOptions) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        const sourceHandle = await engine.open(bytes);
        let outputHandle: PdfDocumentHandle | null = null;

        try {
          const result = await engine.replaceText(sourceHandle, options);
          outputHandle = result.document;

          return {
            bytes: await engine.saveToBytes(outputHandle),
            replacedCounts: result.replacedCounts,
            warnings: result.warnings,
          };
        } finally {
          await closeHandle(engine, outputHandle);
          await closeHandle(engine, sourceHandle);
        }
      }),
    [ensureEngine],
  );

  const inspectTextMap = useCallback(
    (bytes: Uint8Array, options: PdfInspectTextMapOptions = {}) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        const sourceHandle = await engine.open(bytes);

        try {
          return await engine.inspectTextMap(sourceHandle, options);
        } finally {
          await closeHandle(engine, sourceHandle);
        }
      }),
    [ensureEngine],
  );

  const replaceSelectedText = useCallback(
    (bytes: Uint8Array, options: ReplaceSelectedTextBridgeOptions) =>
      withEngineRetry(ensureEngine, engineRef, async (engine) => {
        const sourceHandle = await engine.open(bytes);
        let outputHandle: PdfDocumentHandle | null = null;

        try {
          const result = await engine.replaceSelectedText(sourceHandle, options);
          outputHandle = result.document;

          return {
            bytes: await engine.saveToBytes(outputHandle),
            warnings: result.warnings,
          };
        } finally {
          await closeHandle(engine, outputHandle);
          await closeHandle(engine, sourceHandle);
        }
      }),
    [ensureEngine],
  );

  return {
    available: runtimeAvailable && !disabled,
    ocrAvailable: runtimeAvailable && !disabled && ocrToolchainMissing.length === 0,
    starting,
    error,
    warmEngine,
    runOcr,
    redactAreas,
    convertToPdfA,
    compress,
    removeEncryption,
    sanitize,
    replaceText,
    inspectTextMap,
    replaceSelectedText,
    repair,
  };
}

/**
 * Runs `run` against a live engine, self-healing once if it turns out the
 * cached engine was already dead (e.g. the sidecar idle-shut-down and the
 * bridge was still holding its stale port/token -- issue #1 in the
 * 2026-07-03 live-test fix plan). On a connection-level failure this drops
 * the cached engine, starts a fresh one, and retries `run` exactly once;
 * any other failure (a genuinely bad PDF, a wrong password, etc.) surfaces
 * immediately with no retry.
 */
async function withEngineRetry<T>(
  ensureEngine: () => Promise<SidecarPdfEngine>,
  engineRef: MutableRefObject<SidecarPdfEngine | null>,
  run: (engine: SidecarPdfEngine) => Promise<T>,
): Promise<T> {
  const engine = await ensureEngine();

  try {
    return await run(engine);
  } catch (error) {
    if (!isConnectionFailure(error)) {
      throw error;
    }

    // Generation-safe: a concurrent caller may already have installed a
    // fresh engine while this one was failing -- don't wipe that out.
    if (engineRef.current === engine) {
      engineRef.current = null;
    }

    const freshEngine = await ensureEngine();

    return run(freshEngine);
  }
}

/**
 * Connection-level failures and genuinely bad PDFs both surface from the
 * sidecar as `PdfEngineError("INVALID_DOCUMENT", ...)` (see
 * packages/engine-sidecar/src/index.ts:773-793), so the error `code` can't
 * tell them apart. What can: a network-level fetch failure always wraps a
 * `TypeError` somewhere in the `.cause` chain, while an HTTP error response
 * (a bad PDF Stirling actually processed and rejected) never does. Walk the
 * chain instead of branching on `code`.
 */
function isConnectionFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof TypeError) {
      return true;
    }

    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
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
