import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PdfBatesStampOptions,
  PdfBinderOptions,
  PdfDocumentHandle,
  PdfEdit,
  PdfEngine,
  PdfApplyEditsOptions,
  PdfImagePageInput,
  PdfOutlineState,
  PdfOutlineWriteResult,
  PdfPageNumbersOptions,
  PdfRaioAnnotationEdit,
  PdfRaioAnnotationImport,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { LocalPdfEngine } from "@raiopdf/engine-local";
import {
  RESIZE_PRESET_SIZES,
  type ResizePreset,
} from "../lib/cropResize";
import type { SignatureDetectionFacts, TextLayerCoverage } from "@raiopdf/rules";
import {
  unlockResultHasSignatureWarning,
  type ProtectedPdfSource,
  type UnlockResult,
} from "../lib/protectedPdfResolver";
import type { FileGrant } from "../lib/filePort";

export interface PageSizeInches {
  width: number;
  height: number;
}

/**
 * First-class document source [R1-1]. Streamed docs are NOT "a document with
 * `bytes: null`" — they are a distinct source kind, and "is a document open"
 * checks branch on `source !== null`, never on `engineHandle && bytes`.
 *
 * `generation` on the range kinds records the document identity the source
 * was opened under; a Phase 3 reconcile (path op output → fresh grant) opens
 * a NEW source with a bumped generation so in-flight work for the old one
 * goes stale by construction [R1-8].
 */
export type DocumentSource =
  | { kind: "memory"; bytes: Uint8Array }
  | { kind: "rangeGrant"; grant: FileGrant; sizeBytes: number; generation: number }
  | { kind: "rangeFile"; file: File; sizeBytes: number; generation: number };

/**
 * Gate copy for every mutation path while a streamed document is open. The
 * named alternatives run file-to-file through the local engine (Phase 3 path
 * ops) and never require materializing the document in memory.
 */
export const STREAMED_DOCUMENT_GATE_MESSAGE =
  "This document is too large for in-app editing. Split, extract, compress, and OCR run through the local engine and still work.";

export interface DocumentState {
  bytes: Uint8Array | null;
  source: DocumentSource | null;
  /**
   * Monotonically increasing document identity [R1-8]: bumped on every open
   * AND every committed mutation, replacing `Uint8Array` reference-identity
   * in staleness checks (`replaceBytes` guards, `isCurrentDocument`,
   * per-document caches key on `(openToken, generation)`).
   */
  generation: number;
  engineHandle: PdfDocumentHandle | null;
  pageCount: number;
  currentPage: number;
  zoom: number;
  dirty: boolean;
  fitWidth: boolean;
  fileName: string | null;
  filePath: string | null;
  fileSizeBytes: number | null;
  hasTextLayer: boolean | null;
  textLayerCoverage: TextLayerCoverage | null;
  pageSizeInches: PageSizeInches | null;
  outline: PdfOutlineState | null;
  outlineStatus: string | null;
  signatureInvalidationNotice: SignatureInvalidationNotice | null;
  error: string | null;
}

export interface SignatureInvalidationNotice {
  source: ProtectedPdfSource;
  sourceFileNames: readonly string[];
  sourceFilePath: string | null;
  signature: SignatureDetectionFacts;
}

export interface SignatureUnlockPrompt {
  source: ProtectedPdfSource;
  sourceFileNames: readonly string[];
  sourceFilePath: string | null;
  signature: SignatureDetectionFacts;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

const INITIAL_DOCUMENT: DocumentState = {
  bytes: null,
  source: null,
  generation: 0,
  engineHandle: null,
  pageCount: 0,
  currentPage: 1,
  zoom: 1,
  dirty: false,
  fitWidth: true,
  fileName: null,
  filePath: null,
  fileSizeBytes: null,
  hasTextLayer: null,
  textLayerCoverage: null,
  pageSizeInches: null,
  outline: null,
  outlineStatus: null,
  signatureInvalidationNotice: null,
  error: null,
};

interface CommitOptions {
  dirty: boolean;
  currentPage?: number | ((current: DocumentState, pageCount: number) => number);
  hasTextLayer?: boolean | null;
  textLayerCoverage?: TextLayerCoverage | null;
  knownPageCount?: number;
  fileName?: string;
  filePath?: string | null;
  outlineStatus?: string | null;
  signatureInvalidationNotice?: SignatureInvalidationNotice | null;
}

interface ReplaceBytesOptions {
  dirty: boolean;
  hasTextLayer?: boolean | null;
  textLayerCoverage?: TextLayerCoverage | null;
  knownPageCount?: number;
  expectedOpenToken?: number;
  /** Generation-based staleness guard [R1-8], replacing the old
   * `expectedSourceBytes` Uint8Array reference check. */
  expectedGeneration?: number;
  fileName?: string;
  filePath?: string | null;
  signatureInvalidationNotice?: SignatureInvalidationNotice | null;
}

export type ReplaceBytesResult = "replaced" | "stale" | "failed";

/**
 * Discriminated result of `openFile` (B3, 2026-07-03 live-test fix plan).
 * Replaces the old `Promise<boolean>` shape so a caller can branch
 * explicitly on *why* an open didn't succeed instead of inferring it from a
 * bare `false` -- a password-protected PDF and a genuinely corrupt one need
 * very different UI (a password prompt vs. routing to Repair).
 */
export type OpenFileResult =
  | { status: "opened" }
  | {
      status: "password-required";
      /** The still-encrypted source bytes, for feeding into removeEncryption. */
      bytes: Uint8Array;
      fileName: string;
      filePath: string | null;
    }
  /** User declined the signature-invalidation confirmation; not an error. */
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export interface OpenFileOptions {
  /**
   * Marks the newly opened document dirty immediately instead of clean.
   * Used for the decrypted-bytes-from-a-password-prompt path: those bytes
   * never had an on-disk representation of their own (they're a fresh
   * unlocked working copy), so Save As is the natural next step.
   */
  markDirty?: boolean;
  /**
   * User-driven opens use "new-tab" when another document is already open.
   * Internal reopen flows keep the historical replace-active behavior.
   */
  openMode?: "replace-active" | "new-tab";
}

export interface OpenStreamedFileOptions {
  openMode?: "replace-active" | "new-tab";
}

export interface DocumentTabState {
  id: string;
  document: DocumentState;
}

/**
 * A one-shot "scroll the viewer to this page" request. Every explicit
 * navigation (prev/next commands, thumbnail clicks, search jumps, mutation
 * commits that move the reader) emits one of these; the continuous-scroll
 * viewer consumes it by nonce. Derived current-page updates from scrolling
 * go through `syncVisiblePage` instead and never emit an intent.
 */
export interface PageScrollIntent {
  page: number;
  nonce: number;
}

interface OperationContext {
  handle: PdfDocumentHandle;
  token: number;
}

interface MutationGuards {
  expectedOpenToken?: number;
  expectedGeneration?: number;
}

interface StoredDocumentTab extends DocumentTabState {
  engineHandle: PdfDocumentHandle | null;
  bytes: Uint8Array | null;
  openToken: number;
  sourceKind: DocumentSource["kind"] | null;
  scrollNonce: number;
  pageScrollIntent: PageScrollIntent | null;
  mutationQueue: Promise<void>;
  busyCount: number;
}

interface OpenTarget {
  id: string;
  previousActiveTabId: string | null;
  previousHandle: PdfDocumentHandle | null;
  token: number;
  newTab: boolean;
}

export const MAX_DOCUMENT_TABS = 8;
export const NEW_TAB_BUSY_MESSAGE =
  "Finish the current document operation before opening another document.";
const MAX_DOCUMENT_TABS_MESSAGE =
  `RaioPDF can keep up to ${MAX_DOCUMENT_TABS} documents open at once. Close a tab before opening another.`;

export interface DocumentFileInput {
  bytes: Uint8Array;
  name: string;
  path?: string | null;
}

/** Input for opening a streamed (range-read) document. No bytes anywhere. */
export interface StreamedFileInput {
  source:
    | { kind: "rangeGrant"; grant: FileGrant; sizeBytes: number }
    | { kind: "rangeFile"; file: File; sizeBytes: number };
  name: string;
  /** The grant string in Tauri (grants double as `filePath` [R1-9]); null in browser. */
  path: string | null;
}

export interface SaveDocumentResult {
  bytes: Uint8Array;
  fileName: string;
  filePath: string | null;
}

export interface BinderExhibitInput {
  bytes: Uint8Array;
  label: string;
  description?: string | undefined;
  sourceFileName?: string | undefined;
}

export interface UseDocumentOptions {
  protectedPdf?: {
    confirmSignatureInvalidation: (prompt: SignatureUnlockPrompt) => Promise<boolean>;
    resolve: (bytes: Uint8Array) => Promise<UnlockResult>;
  } | undefined;
}

interface PreparedDocument {
  bytes: Uint8Array;
  engineHandle: PdfDocumentHandle;
  signatureInvalidationNotice: SignatureInvalidationNotice | null;
}

export function useDocument(options: UseDocumentOptions = {}) {
  const engine = useMemo<PdfEngine>(() => new LocalPdfEngine(), []);
  const [document, setDocumentState] = useState<DocumentState>(INITIAL_DOCUMENT);
  const [tabs, setTabs] = useState<StoredDocumentTab[]>([]);
  const tabsRef = useRef<StoredDocumentTab[]>([]);
  const tabIdCounterRef = useRef(0);
  const activeTabIdRef = useRef<string | null>(null);
  const [pageScrollIntent, setPageScrollIntent] = useState<PageScrollIntent | null>(null);
  const activeHandleRef = useRef<PdfDocumentHandle | null>(null);
  const activeBytesRef = useRef<Uint8Array | null>(null);
  const openTokenRef = useRef(0);
  const openTokenCounterRef = useRef(0);
  const prepareOpenErrorRef = useRef<string | null>(null);
  // Never reset: generation is a globally monotonic document identity, so a
  // (generation) capture alone distinguishes documents across opens [R1-8].
  const generationRef = useRef(0);
  const sourceKindRef = useRef<DocumentSource["kind"] | null>(null);
  const scrollNonceRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const busyCountRef = useRef(0);

  const setTabsState = useCallback((update: (current: StoredDocumentTab[]) => StoredDocumentTab[]) => {
    setTabs((current) => {
      const next = update(current);
      tabsRef.current = next;
      return next;
    });
  }, []);

  const snapshotActiveTab = useCallback((): StoredDocumentTab | null => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) {
      return null;
    }

    const current = tabsRef.current.find((tab) => tab.id === activeTabId);
    if (!current) {
      return null;
    }

    return {
      ...current,
      document,
      engineHandle: activeHandleRef.current,
      bytes: activeBytesRef.current,
      openToken: openTokenRef.current,
      sourceKind: sourceKindRef.current,
      scrollNonce: scrollNonceRef.current,
      pageScrollIntent,
      mutationQueue: mutationQueueRef.current,
      busyCount: busyCountRef.current,
    };
  }, [document, pageScrollIntent]);

  const syncActiveTab = useCallback((nextDocument: DocumentState, nextScrollIntent = pageScrollIntent) => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) {
      return;
    }

    setTabsState((current) => current.map((tab) => (
      tab.id === activeTabId
        ? {
            ...tab,
            document: nextDocument,
            engineHandle: activeHandleRef.current,
            bytes: activeBytesRef.current,
            openToken: openTokenRef.current,
            sourceKind: sourceKindRef.current,
            scrollNonce: scrollNonceRef.current,
            pageScrollIntent: nextScrollIntent,
            mutationQueue: mutationQueueRef.current,
            busyCount: busyCountRef.current,
          }
        : tab
    )));
  }, [pageScrollIntent, setTabsState]);

  const setDocument = useCallback((update: DocumentState | ((current: DocumentState) => DocumentState)) => {
    setDocumentState((current) => {
      const next = typeof update === "function"
        ? (update as (current: DocumentState) => DocumentState)(current)
        : update;
      syncActiveTab(next);
      return next;
    });
  }, [syncActiveTab]);

  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const getActiveGenerationValue = useCallback(() => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) {
      return document.generation;
    }

    return tabsRef.current.find((tab) => tab.id === activeTabId)?.document.generation
      ?? document.generation;
  }, [document.generation]);

  const requestPageScroll = useCallback((page: number) => {
    scrollNonceRef.current += 1;
    const intent = { page, nonce: scrollNonceRef.current };
    setPageScrollIntent(intent);
    const activeTabId = activeTabIdRef.current;
    if (activeTabId) {
      setTabsState((current) => current.map((tab) => (
        tab.id === activeTabId
          ? { ...tab, scrollNonce: scrollNonceRef.current, pageScrollIntent: intent }
          : tab
      )));
    }
  }, [setTabsState]);

  const createTabId = useCallback(() => {
    tabIdCounterRef.current += 1;
    return `document-tab-${tabIdCounterRef.current}`;
  }, []);

  const restoreTab = useCallback((tab: StoredDocumentTab) => {
    activeTabIdRef.current = tab.id;
    activeHandleRef.current = tab.engineHandle;
    activeBytesRef.current = tab.bytes;
    openTokenRef.current = tab.openToken;
    sourceKindRef.current = tab.sourceKind;
    scrollNonceRef.current = tab.scrollNonce;
    mutationQueueRef.current = tab.mutationQueue;
    busyCountRef.current = tab.busyCount;
    setDocumentState(tab.document);
    setPageScrollIntent(tab.pageScrollIntent);
  }, []);

  const createStoredTab = useCallback((
    id: string,
    nextDocument: DocumentState,
    overrides: {
      engineHandle?: PdfDocumentHandle | null;
      bytes?: Uint8Array | null;
      openToken?: number;
      sourceKind?: DocumentSource["kind"] | null;
    } = {},
  ): StoredDocumentTab => ({
    id,
    document: nextDocument,
    engineHandle: overrides.engineHandle ?? null,
    bytes: overrides.bytes ?? null,
    openToken: overrides.openToken ?? 0,
    sourceKind: overrides.sourceKind ?? null,
    scrollNonce: 0,
    pageScrollIntent: null,
    mutationQueue: Promise.resolve(),
    busyCount: 0,
  }), []);

  const prepareOpenTarget = useCallback((openMode: OpenFileOptions["openMode"] = "replace-active"): OpenTarget | null => {
    prepareOpenErrorRef.current = null;
    const hasActiveDocument = document.source !== null;
    const shouldOpenNewTab = openMode === "new-tab" && hasActiveDocument;
    const previousActiveTabId = activeTabIdRef.current;

    if (shouldOpenNewTab && tabsRef.current.length >= MAX_DOCUMENT_TABS) {
      prepareOpenErrorRef.current = MAX_DOCUMENT_TABS_MESSAGE;
      setDocument((current) => ({
        ...current,
        error: MAX_DOCUMENT_TABS_MESSAGE,
      }));
      return null;
    }

    if (shouldOpenNewTab && busyCountRef.current > 0) {
      prepareOpenErrorRef.current = NEW_TAB_BUSY_MESSAGE;
      setDocument((current) => ({
        ...current,
        error: NEW_TAB_BUSY_MESSAGE,
      }));
      return null;
    }

    if (shouldOpenNewTab) {
      const activeSnapshot = snapshotActiveTab();
      if (activeSnapshot) {
        setTabsState((current) => current.map((tab) => (
          tab.id === activeSnapshot.id ? activeSnapshot : tab
        )));
      }

      const id = createTabId();
      const token = openTokenCounterRef.current + 1;
      openTokenCounterRef.current = token;
      activeTabIdRef.current = id;
      activeHandleRef.current = null;
      activeBytesRef.current = null;
      openTokenRef.current = token;
      sourceKindRef.current = null;
      scrollNonceRef.current = 0;
      mutationQueueRef.current = Promise.resolve();
      busyCountRef.current = 0;
      setPageScrollIntent(null);
      return { id, previousActiveTabId, previousHandle: null, token, newTab: true };
    }

    let id = activeTabIdRef.current;
    if (!id) {
      id = createTabId();
      activeTabIdRef.current = id;
    }

    const token = openTokenCounterRef.current + 1;
    openTokenCounterRef.current = token;
    openTokenRef.current = token;
    return {
      id,
      previousActiveTabId,
      previousHandle: activeHandleRef.current,
      token,
      newTab: !tabsRef.current.some((tab) => tab.id === id),
    };
  }, [createTabId, document.source, setDocument, setTabsState, snapshotActiveTab]);

  const restoreAfterFailedNewTabOpen = useCallback((target: OpenTarget, error?: string) => {
    if (!target.newTab) {
      return;
    }

    const previousTab = tabsRef.current.find((tab) => tab.id === target.previousActiveTabId)
      ?? tabsRef.current.at(-1)
      ?? null;
    if (previousTab) {
      restoreTab(previousTab);
      if (error) {
        setDocument((current) => ({ ...current, error }));
      }
      return;
    }

    activeTabIdRef.current = null;
    activeHandleRef.current = null;
    activeBytesRef.current = null;
    openTokenRef.current = 0;
    sourceKindRef.current = null;
    scrollNonceRef.current = 0;
    mutationQueueRef.current = Promise.resolve();
    busyCountRef.current = 0;
    setPageScrollIntent(null);
    setDocumentState(error ? { ...INITIAL_DOCUMENT, error } : INITIAL_DOCUMENT);
  }, [restoreTab, setDocument]);

  const setError = useCallback((error: string | null) => {
    setDocument((current) => ({ ...current, error }));
  }, [setDocument]);

  const closeHandle = useCallback(
    async (engineHandle: PdfDocumentHandle | null) => {
      if (!engineHandle) {
        return;
      }

      try {
        await engine.close(engineHandle);
      } catch {
        // Close is best-effort cleanup; the visible operation result is handled elsewhere.
      }
    },
    [engine],
  );

  useEffect(() => {
    return () => {
      openTokenRef.current += 1;
      const handles = new Set<PdfDocumentHandle>();
      if (activeHandleRef.current) {
        handles.add(activeHandleRef.current);
      }
      for (const tab of tabsRef.current) {
        if (tab.engineHandle) {
          handles.add(tab.engineHandle);
        }
      }
      activeHandleRef.current = null;
      activeBytesRef.current = null;
      void Promise.all([...handles].map((handle) => closeHandle(handle)));
    };
  }, [closeHandle]);

  const commitHandle = useCallback(
    async (
      engineHandle: PdfDocumentHandle,
      options: CommitOptions,
      operation: OperationContext,
    ) => {
      const [bytes, pageCount, outline] = await Promise.all([
        engine.saveToBytes(engineHandle),
        options.knownPageCount !== undefined
          ? Promise.resolve(options.knownPageCount)
          : engine.pageCount(engineHandle),
        engine.getOutline(engineHandle),
      ]);

      if (
        openTokenRef.current !== operation.token ||
        activeHandleRef.current !== operation.handle
      ) {
        await closeHandle(engineHandle);
        return false;
      }

      const previousHandle = activeHandleRef.current;
      activeHandleRef.current = engineHandle;
      activeBytesRef.current = bytes;
      // Each commit bumps generation exactly where it swapped the bytes ref
      // before — memory-mode staleness semantics are unchanged [R1-8].
      const generation = nextGeneration();
      sourceKindRef.current = "memory";
      setDocument((current) => ({
        ...current,
        bytes,
        source: { kind: "memory", bytes },
        generation,
        engineHandle,
        pageCount,
        currentPage: clampPage(resolveCurrentPage(options, current, pageCount), pageCount),
        dirty: options.dirty,
        fileName: options.fileName ?? current.fileName,
        filePath: options.filePath !== undefined ? options.filePath : current.filePath,
        fileSizeBytes: bytes.byteLength,
        hasTextLayer: options.hasTextLayer ?? null,
        textLayerCoverage: options.textLayerCoverage ?? null,
        pageSizeInches: null,
        outline,
        outlineStatus: options.outlineStatus ?? null,
        signatureInvalidationNotice: mergeSignatureInvalidationNotice(
          current.signatureInvalidationNotice,
          options.signatureInvalidationNotice,
        ),
        error: null,
      }));

      // A mutation that explicitly moves the reader (merge -> 1, insert ->
      // the inserted page, ...) is a navigation: it becomes a scroll intent.
      // The function form (delete keeps the reader near its page) and
      // in-place mutations leave the scroll position alone.
      if (typeof options.currentPage === "number") {
        requestPageScroll(clampPage(options.currentPage, pageCount));
      }

      if (previousHandle !== engineHandle) {
        await closeHandle(previousHandle);
      }

      return true;
    },
    [closeHandle, engine, nextGeneration, requestPageScroll],
  );

  const currentOperation = useCallback((): OperationContext | null => {
    const handle = activeHandleRef.current;

    if (!handle) {
      return null;
    }

    return {
      handle,
      token: openTokenRef.current,
    };
  }, []);

  const enqueueMutation = useCallback(
    (
      operationName: string,
      operation: (context: OperationContext) => Promise<{
        engineHandle: PdfDocumentHandle;
        options: CommitOptions;
      } | null>,
      requestedToken = openTokenRef.current,
    ) => {
      const queued = mutationQueueRef.current.then(async () => {
        busyCountRef.current += 1;
        syncActiveTab(document);

        // Streamed docs are never mutated in memory: every enqueueMutation
        // op is gated with the message naming what still works [R1-2].
        try {
          if (sourceKindRef.current !== null && sourceKindRef.current !== "memory") {
            if (openTokenRef.current === requestedToken) {
              setError(STREAMED_DOCUMENT_GATE_MESSAGE);
            }

            return false;
          }

          const context = currentOperation();

          if (!context || context.token !== requestedToken) {
            return false;
          }

          try {
            const result = await operation(context);

            if (!result) {
              return false;
            }

            try {
              return await commitHandle(result.engineHandle, result.options, context);
            } catch (error) {
              await closeHandle(result.engineHandle);
              throw error;
            }
          } catch (error) {
            if (
              openTokenRef.current === context.token &&
              activeHandleRef.current === context.handle
            ) {
              setError(getActionErrorMessage(operationName, error));
            }

            return false;
          }
        } finally {
          busyCountRef.current = Math.max(0, busyCountRef.current - 1);
          syncActiveTab(document);
        }
      });

      mutationQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );

      return queued;
    },
    [closeHandle, commitHandle, currentOperation, document, setError, syncActiveTab],
  );

  const openPreparedDocument = useCallback(
    async (file: DocumentFileInput): Promise<PreparedDocument | null> => {
      try {
        return {
          bytes: file.bytes,
          engineHandle: await engine.open(file.bytes),
          signatureInvalidationNotice: null,
        };
      } catch (error) {
        if (!isProtectedOpenError(error) || !options.protectedPdf) {
          throw error;
        }

        const unlockResult = await options.protectedPdf.resolve(file.bytes);
        if (unlockResult.status !== "unlocked") {
          throw unlockFailureError(unlockResult);
        }

        const signatureInvalidationNotice = unlockResultHasSignatureWarning(unlockResult)
          ? {
              source: unlockResult.provenance.source,
              sourceFileNames: [file.name],
              sourceFilePath: file.path ?? null,
              signature: unlockResult.provenance.signature,
            }
          : null;

        if (signatureInvalidationNotice) {
          const confirmed = await options.protectedPdf.confirmSignatureInvalidation({
            source: signatureInvalidationNotice.source,
            sourceFileNames: signatureInvalidationNotice.sourceFileNames,
            sourceFilePath: signatureInvalidationNotice.sourceFilePath,
            signature: signatureInvalidationNotice.signature,
          });

          if (!confirmed) {
            return null;
          }
        }

        const unlockedBytes = new Uint8Array(unlockResult.bytes);
        let unlockedHandle: PdfDocumentHandle | null = null;

        try {
          unlockedHandle = await engine.open(unlockedBytes);

          return {
            bytes: unlockedBytes,
            engineHandle: unlockedHandle,
            signatureInvalidationNotice,
          };
        } catch (openUnlockedError) {
          await closeHandle(unlockedHandle);
          throw openUnlockedError;
        }
      }
    },
    [closeHandle, engine, options.protectedPdf],
  );

  const openFile = useCallback(
    async (file: DocumentFileInput, options: OpenFileOptions = {}): Promise<OpenFileResult> => {
      const target = prepareOpenTarget(options.openMode);
      if (!target) {
        return {
          status: "failed",
          error: prepareOpenErrorRef.current ?? MAX_DOCUMENT_TABS_MESSAGE,
        };
      }
      const { id, token, previousHandle } = target;
      let prepared: PreparedDocument | null = null;

      try {
        prepared = await openPreparedDocument(file);
        if (!prepared) {
          restoreAfterFailedNewTabOpen(target);
          return { status: "cancelled" };
        }

        const { bytes, engineHandle, signatureInvalidationNotice } = prepared;
        const signatureInvalidated = Boolean(signatureInvalidationNotice);
        const [pageCount, outline] = await Promise.all([
          engine.pageCount(engineHandle),
          engine.getOutline(engineHandle),
        ]);

        if (activeTabIdRef.current !== id || openTokenRef.current !== token) {
          await closeHandle(engineHandle);
          return { status: "failed", error: "This document was replaced before it finished opening." };
        }

        activeHandleRef.current = null;
        activeBytesRef.current = null;
        await closeHandle(previousHandle);
        activeHandleRef.current = engineHandle;
        activeBytesRef.current = bytes;
        sourceKindRef.current = "memory";
        const nextDocument: DocumentState = {
          bytes,
          source: { kind: "memory", bytes },
          generation: nextGeneration(),
          engineHandle,
          pageCount,
          currentPage: 1,
          zoom: 1,
          fitWidth: true,
          dirty: (options.markDirty ?? false) || signatureInvalidated,
          fileName: file.name,
          filePath: signatureInvalidated ? null : file.path ?? null,
          fileSizeBytes: bytes.byteLength,
          hasTextLayer: null,
          textLayerCoverage: null,
          pageSizeInches: null,
          outline,
          outlineStatus: null,
          signatureInvalidationNotice,
          error: null,
        };
        setDocument(nextDocument);
        const storedTab = createStoredTab(id, nextDocument, {
          engineHandle,
          bytes,
          openToken: token,
          sourceKind: "memory",
        });
        setTabsState((current) => (
          current.some((tab) => tab.id === id)
            ? current.map((tab) => (tab.id === id ? { ...tab, ...storedTab } : tab))
            : [...current, storedTab]
        ));
        prepared = null;
        requestPageScroll(1);
        return { status: "opened" };
      } catch (error) {
        await closeHandle(prepared?.engineHandle ?? null);

        if (activeTabIdRef.current !== id || openTokenRef.current !== token) {
          return { status: "failed", error: getEngineErrorMessage(error) };
        }

        // ENCRYPTED_DOCUMENT: raw engine error when no protected-PDF resolver
        // is wired. PASSWORD_REQUIRED: the resolver ran, silently unlocked
        // owner-restricted PDFs if it could, and reports a genuine open
        // password is needed. Both route to the password prompt.
        if (
          error instanceof PdfEngineError &&
          (error.code === "ENCRYPTED_DOCUMENT" || error.code === "PASSWORD_REQUIRED")
        ) {
          // No active bytes/handle -- the document stays in a clean, empty
          // state while the caller shows a password prompt. The still-
          // encrypted bytes travel in the result itself (not `document`),
          // since they're not this hook's concern until they're unlocked.
          // Any previously open document is being replaced by the prompt
          // flow, so release its handle rather than leaking it.
          if (!target.newTab) {
            activeHandleRef.current = null;
            activeBytesRef.current = null;
            sourceKindRef.current = null;
            await closeHandle(previousHandle);
            setTabsState((current) => current.filter((tab) => tab.id !== id));
            activeTabIdRef.current = null;
            openTokenRef.current = 0;
            scrollNonceRef.current = 0;
            mutationQueueRef.current = Promise.resolve();
            busyCountRef.current = 0;
            setPageScrollIntent(null);
            setDocument(INITIAL_DOCUMENT);
          } else {
            restoreAfterFailedNewTabOpen(target);
          }
          return {
            status: "password-required",
            bytes: file.bytes,
            fileName: file.name,
            filePath: file.path ?? null,
          };
        }

        const message = getEngineErrorMessage(error);
        if (previousHandle || target.newTab) {
          // A failed replacement open keeps the current document on screen --
          // and USABLE: the refs must keep pointing at the still-open
          // previous handle or save/rotate/delete on the visible document
          // would find no engine handle (Codex Cloud P1 on #115).
          if (target.newTab) {
            restoreAfterFailedNewTabOpen(target, message);
          } else {
            setDocument((current) => ({ ...current, error: message }));
          }
        } else {
          activeHandleRef.current = null;
          activeBytesRef.current = null;
          sourceKindRef.current = null;
          setDocument({
            ...INITIAL_DOCUMENT,
            error: message,
          });
        }
        return { status: "failed", error: message };
      }
    },
    [closeHandle, createStoredTab, engine, nextGeneration, openPreparedDocument, prepareOpenTarget, requestPageScroll, restoreAfterFailedNewTabOpen, setDocument, setTabsState],
  );

  /**
   * Open a streamed (large) document [R1-1]: pdf-lib is never loaded —
   * `engine.open` is skipped entirely and `engineHandle: null` is legal only
   * in this mode. `pageCount` starts at 0 and arrives from the pdf.js proxy
   * via `setStreamedPageCount` once the transport delivers the xref tail.
   */
  const openStreamedFile = useCallback(
    async (input: StreamedFileInput, options: OpenStreamedFileOptions = {}): Promise<OpenFileResult> => {
      const target = prepareOpenTarget(options.openMode);
      if (!target) {
        return {
          status: "failed",
          error: prepareOpenErrorRef.current ?? MAX_DOCUMENT_TABS_MESSAGE,
        };
      }
      const { id, token, previousHandle } = target;

      activeHandleRef.current = null;
      activeBytesRef.current = null;
      const generation = nextGeneration();
      sourceKindRef.current = input.source.kind;
      if (!target.newTab) {
        await closeHandle(previousHandle);
      }

      // Same token guard as the memory open path: if another open started
      // while the previous handle was closing, this streamed open is stale
      // and must not replace the newer document (Codex review, PR #124).
      if (activeTabIdRef.current !== id || openTokenRef.current !== token) {
        restoreAfterFailedNewTabOpen(target);
        return {
          status: "failed",
          error: "This document was replaced before it finished opening.",
        };
      }

      const nextDocument: DocumentState = {
        ...INITIAL_DOCUMENT,
        source: { ...input.source, generation },
        generation,
        // Streamed docs can't dirty (mutations are gated), so `dirty` stays
        // false for the document's whole lifetime.
        fileName: input.name,
        filePath: input.path,
        fileSizeBytes: input.source.sizeBytes,
      };
      setDocument(nextDocument);
      const storedTab = createStoredTab(id, nextDocument, {
        openToken: token,
        sourceKind: input.source.kind,
      });
      setTabsState((current) => (
        current.some((tab) => tab.id === id)
          ? current.map((tab) => (tab.id === id ? { ...tab, ...storedTab } : tab))
          : [...current, storedTab]
      ));
      requestPageScroll(1);
      return { status: "opened" };
    },
    [closeHandle, createStoredTab, nextGeneration, prepareOpenTarget, requestPageScroll, restoreAfterFailedNewTabOpen, setDocument, setTabsState],
  );

  /**
   * Commit the page count reported by the streamed pdf.js proxy. Guarded by
   * generation so a proxy that finished loading for a superseded document
   * can't stamp its count onto the current one.
   */
  const setStreamedPageCount = useCallback(
    (pageCount: number, expected: { generation: number }) => {
      setDocument((current) => {
        if (
          current.generation !== expected.generation ||
          current.source === null ||
          current.source.kind === "memory"
        ) {
          return current;
        }

        return {
          ...current,
          pageCount,
          currentPage: clampPage(current.currentPage, pageCount),
        };
      });
    },
    [],
  );

  const replaceBytes = useCallback(
    async (bytes: Uint8Array, options: ReplaceBytesOptions): Promise<ReplaceBytesResult> => {
      const requestedToken = options.expectedOpenToken ?? openTokenRef.current;
      let stale = false;

      const replaced = await enqueueMutation("replace", async () => {
        if (
          options.expectedOpenToken !== undefined &&
          openTokenRef.current !== options.expectedOpenToken
        ) {
          stale = true;
          return null;
        }

        if (
          options.expectedGeneration !== undefined &&
          getActiveGenerationValue() !== options.expectedGeneration
        ) {
          stale = true;
          return null;
        }

        const nextBytes = new Uint8Array(bytes);
        const replacementFile: DocumentFileInput = {
          bytes: nextBytes,
          name: options.fileName ?? "Document.pdf",
        };
        if (options.filePath !== undefined) {
          replacementFile.path = options.filePath;
        }

        const prepared = await openPreparedDocument(replacementFile);

        if (!prepared) {
          return null;
        }

        const signatureInvalidationNotice = mergeSignatureInvalidationNotice(
          options.signatureInvalidationNotice ?? null,
          prepared.signatureInvalidationNotice,
        );
        const commitOptions: CommitOptions = {
          dirty: options.dirty || Boolean(signatureInvalidationNotice),
          hasTextLayer: options.hasTextLayer ?? null,
          textLayerCoverage: options.textLayerCoverage ?? null,
          ...(options.knownPageCount !== undefined
            ? { knownPageCount: options.knownPageCount }
            : {}),
          signatureInvalidationNotice,
        };

        if (options.fileName !== undefined) {
          commitOptions.fileName = options.fileName;
        }

        if (signatureInvalidationNotice) {
          commitOptions.filePath = null;
        } else if (options.filePath !== undefined) {
          commitOptions.filePath = options.filePath;
        }

        return {
          engineHandle: prepared.engineHandle,
          options: commitOptions,
        };
      }, requestedToken);

      if (replaced) {
        return "replaced";
      }

      return stale ? "stale" : "failed";
    },
    [enqueueMutation, openPreparedDocument],
  );

  const getOpenToken = useCallback(() => openTokenRef.current, []);
  const getGeneration = useCallback(() => getActiveGenerationValue(), [getActiveGenerationValue]);

  /**
   * Explicit navigation: updates `currentPage` AND emits a scroll intent so
   * the continuous-scroll viewer brings the page into view. Every caller —
   * prev/next commands, thumbnail clicks, search navigation — is a scroll
   * intent by construction.
   */
  const setCurrentPage = useCallback((page: number) => {
    setDocument((current) => ({
      ...current,
      currentPage: clampPage(page, current.pageCount),
    }));
    // The viewer clamps against its own layout; an out-of-range intent can
    // never scroll past the last page.
    requestPageScroll(Math.max(1, Math.round(page)));
  }, [requestPageScroll]);

  /**
   * Derived update from the viewer's scroll position (most-visible page).
   * Never emits a scroll intent — that would fight the user's scrolling.
   */
  const syncVisiblePage = useCallback((page: number) => {
    setDocument((current) => {
      const clamped = clampPage(page, current.pageCount);

      return clamped === current.currentPage
        ? current
        : { ...current, currentPage: clamped };
    });
  }, []);

  const setZoom = useCallback((zoom: number) => {
    setDocument((current) => ({
      ...current,
      zoom: clampZoom(zoom),
      fitWidth: false,
    }));
  }, []);

  const setFitZoom = useCallback((zoom: number) => {
    setDocument((current) => ({
      ...current,
      zoom: clampZoom(zoom),
      fitWidth: true,
    }));
  }, []);

  const setHasTextLayer = useCallback((hasTextLayer: boolean) => {
    setDocument((current) => ({ ...current, hasTextLayer }));
  }, []);

  const setTextLayerCoverage = useCallback((textLayerCoverage: TextLayerCoverage | null) => {
    setDocument((current) => ({ ...current, textLayerCoverage }));
  }, []);

  const setPageSizeInches = useCallback((pageSizeInches: PageSizeInches) => {
    setDocument((current) => ({ ...current, pageSizeInches }));
  }, []);

  const rotatePages = useCallback(
    async (pageIndexes: readonly number[], degrees = 90) => {
      if (pageIndexes.length === 0) {
        return false;
      }

      return enqueueMutation("rotate", async ({ handle }) => ({
        engineHandle: await engine.rotatePages(handle, pageIndexes, degrees),
        options: { dirty: true },
      }));
    },
    [engine, enqueueMutation],
  );

  const deletePages = useCallback(
    async (pageIndexes: readonly number[]) => {
      if (pageIndexes.length === 0) {
        return false;
      }

      return enqueueMutation("delete", async ({ handle }) => {
        const result = await engine.deletePages(handle, pageIndexes);

        return {
          engineHandle: result.document,
          options: {
            dirty: true,
            currentPage: (current, pageCount) => Math.min(current.currentPage, pageCount),
            outlineStatus: outlineStatusFromRemovedTargets(result.removedTargets),
          },
        };
      });
    },
    [engine, enqueueMutation],
  );

  const reorderPages = useCallback(
    async (pageIndexes: readonly number[], currentPage?: number) => {
      if (pageIndexes.length === 0) {
        return false;
      }

      const options: CommitOptions = { dirty: true };

      if (currentPage !== undefined) {
        options.currentPage = currentPage;
      }

      return enqueueMutation("reorder", async ({ handle }) => {
        const result = await engine.reorderPages(handle, pageIndexes);

        return {
          engineHandle: result.document,
          options: {
            ...options,
            outlineStatus: outlineStatusFromRemovedTargets(result.removedTargets),
          },
        };
      });
    },
    [engine, enqueueMutation],
  );

  const mergeWithFiles = useCallback(
    async (files: readonly DocumentFileInput[]) => {
      if (files.length === 0) {
        return false;
      }

      return enqueueMutation("merge", async ({ handle }) => {
        const openedHandles: PdfDocumentHandle[] = [];
        let signatureInvalidationNotice: SignatureInvalidationNotice | null = null;

        try {
          for (const file of files) {
            const prepared = await openPreparedDocument(file);
            if (!prepared) {
              return null;
            }

            openedHandles.push(prepared.engineHandle);
            signatureInvalidationNotice = mergeSignatureInvalidationNotice(
              signatureInvalidationNotice,
              prepared.signatureInvalidationNotice,
            );
          }

          const result = await engine.merge([handle, ...openedHandles], {
            labels: [
              document.fileName ?? "Current document",
              ...files.map((file) => file.name),
            ],
          });

          return {
            engineHandle: result.document,
            options: {
              dirty: true,
              currentPage: 1,
              fileName: "Merged.pdf",
              filePath: null,
              outlineStatus: outlineStatusFromRemovedTargets(result.removedTargets),
              signatureInvalidationNotice,
            },
          };
        } finally {
          await closeHandles(openedHandles);
        }
      });
    },
    [document.fileName, engine, enqueueMutation, openPreparedDocument],
  );

  const extractPages = useCallback(
    async (pageIndexes: readonly number[]) => {
      if (pageIndexes.length === 0) {
        return false;
      }

      return enqueueMutation("extract", async ({ handle }) => {
        const pageCount = await engine.pageCount(handle);
        const extracted = uniqueSortedPageIndexes(pageIndexes, pageCount);
        const deletedPages = complementPageIndexes(extracted, pageCount);

        const result = await extractHandle(engine, handle, deletedPages);

        return {
          engineHandle: result.document,
          options: {
            dirty: true,
            currentPage: 1,
            fileName: "Extracted Pages.pdf",
            filePath: null,
            outlineStatus: outlineStatusFromRemovedTargets(result.removedTargets),
          },
        };
      });
    },
    [engine, enqueueMutation],
  );

  const splitPages = useCallback(
    async (
      pageGroups: readonly (readonly number[])[],
      suggestedBaseName: string,
    ): Promise<SaveDocumentResult[] | null> => {
      await mutationQueueRef.current;

      const handle = activeHandleRef.current;
      const token = openTokenRef.current;

      if (!handle || pageGroups.length === 0) {
        return null;
      }

      const outputHandles: PdfDocumentHandle[] = [];

      try {
        const pageCount = await engine.pageCount(handle);
        const results: SaveDocumentResult[] = [];

        for (const [index, pageGroup] of pageGroups.entries()) {
          const keptPages = uniqueSortedPageIndexes(pageGroup, pageCount);
          const outputResult = await extractHandle(
            engine,
            handle,
            complementPageIndexes(keptPages, pageCount),
          );
          const outputHandle = outputResult.document;
          outputHandles.push(outputHandle);

          const bytes = await engine.saveToBytes(outputHandle);

          if (activeHandleRef.current !== handle || openTokenRef.current !== token) {
            return null;
          }

          results.push({
            bytes,
            fileName: `${suggestedBaseName} - Part ${index + 1}.pdf`,
            filePath: null,
          });
        }

        setError(null);
        return results;
      } catch (error) {
        if (activeHandleRef.current === handle && openTokenRef.current === token) {
          setError(getActionErrorMessage("split", error));
        }

        return null;
      } finally {
        await closeHandles(outputHandles);
      }
    },
    [engine, setError],
  );

  const insertFile = useCallback(
    async (file: DocumentFileInput, insertAtPageIndex: number) => {
      return enqueueMutation("insert", async ({ handle }) => {
        let insertedHandle: PdfDocumentHandle | null = null;

        try {
          const prepared = await openPreparedDocument(file);
          if (!prepared) {
            return null;
          }

          insertedHandle = prepared.engineHandle;

          const result = await engine.insertPages(handle, insertAtPageIndex, insertedHandle, {
            sourceLabel: file.name,
          });

          return {
            engineHandle: result.document,
            options: {
              dirty: true,
              currentPage: insertAtPageIndex + 1,
              fileName: "Inserted Pages.pdf",
              filePath: null,
              outlineStatus: outlineStatusFromRemovedTargets(result.removedTargets),
              signatureInvalidationNotice: prepared.signatureInvalidationNotice,
            },
          };
        } finally {
          await closeHandle(insertedHandle);
        }
      });
    },
    [closeHandle, engine, enqueueMutation, openPreparedDocument],
  );

  const cropResizePages = useCallback(
    async (
      pageIndexes: readonly number[],
      options: { cropMarginIn: number; resizePreset: ResizePreset },
    ) => {
      if (pageIndexes.length === 0) {
        return false;
      }

      return enqueueMutation("crop", async ({ handle }) => {
        let croppedHandle: PdfDocumentHandle | null = null;

        try {
          croppedHandle = await engine.cropPages(handle, pageIndexes, options.cropMarginIn);

          if (options.resizePreset === "original") {
            const engineHandle = croppedHandle;
            croppedHandle = null;

            return {
              engineHandle,
              options: {
                dirty: true,
                fileName: "Cropped Pages.pdf",
                filePath: null,
              },
            };
          }

          return {
            engineHandle: await engine.resizePages(
              croppedHandle,
              pageIndexes,
              RESIZE_PRESET_SIZES[options.resizePreset],
            ),
            options: {
              dirty: true,
              fileName: "Cropped Pages.pdf",
              filePath: null,
            },
          };
        } finally {
          await closeHandle(croppedHandle);
        }
      });
    },
    [closeHandle, engine, enqueueMutation],
  );

  const buildBinder = useCallback(
    async (
      exhibits: readonly BinderExhibitInput[],
      options: PdfBinderOptions,
      fileName: string,
    ) => {
      if (exhibits.length === 0) {
        setError("Add at least one exhibit before building the binder.");
        return false;
      }

      return enqueueMutation("build binder", async ({ handle }) => {
        const openedHandles: PdfDocumentHandle[] = [];
        let signatureInvalidationNotice: SignatureInvalidationNotice | null = null;

        try {
          for (const exhibit of exhibits) {
            const prepared = await openPreparedDocument({
              bytes: exhibit.bytes,
              name: exhibit.sourceFileName ?? exhibit.label,
              path: null,
            });
            if (!prepared) {
              return null;
            }

            openedHandles.push(prepared.engineHandle);
            signatureInvalidationNotice = mergeSignatureInvalidationNotice(
              signatureInvalidationNotice,
              prepared.signatureInvalidationNotice,
            );
          }

          return {
            engineHandle: await engine.buildBinder(
              handle,
              exhibits.map((exhibit, index) => ({
                doc: openedHandles[index]!,
                label: exhibit.label,
                description: exhibit.description,
                sourceFileName: exhibit.sourceFileName,
              })),
              options,
            ),
            options: {
              dirty: true,
              currentPage: 1,
              fileName,
              filePath: null,
              signatureInvalidationNotice,
            },
          };
        } finally {
          await closeHandles(openedHandles);
        }
      });
    },
    [engine, enqueueMutation, openPreparedDocument, setError],
  );

  const batesStamp = useCallback(
    async (
      options: PdfBatesStampOptions,
      guards: MutationGuards = {},
    ) => {
      const requestedToken = guards.expectedOpenToken ?? openTokenRef.current;

      return enqueueMutation("Bates numbering", async ({ handle }) => {
        if (
          guards.expectedOpenToken !== undefined &&
          openTokenRef.current !== guards.expectedOpenToken
        ) {
          return null;
        }

        if (
          guards.expectedGeneration !== undefined &&
          getActiveGenerationValue() !== guards.expectedGeneration
        ) {
          return null;
        }

        return {
          engineHandle: await engine.batesStamp(handle, options),
          options: { dirty: true },
        };
      }, requestedToken);
    },
    [engine, enqueueMutation],
  );

  const applyEdits = useCallback(
    async (
      edits: readonly PdfEdit[],
      options: { flatten: boolean; printMarkupAnnotations?: boolean },
    ) => {
      if (edits.length === 0) {
        return false;
      }

      return enqueueMutation("apply edits", async ({ handle }) => {
        const applyOptions: PdfApplyEditsOptions = {
          markupMode: "annotation",
          printMarkupAnnotations: options.printMarkupAnnotations ?? true,
        };
        let editedHandle: PdfDocumentHandle | null = await engine.applyEdits(
          handle,
          edits,
          applyOptions,
        );

        try {
          if (options.flatten) {
            const flattenedHandle = await engine.flattenForm(editedHandle);
            await closeHandle(editedHandle);
            editedHandle = flattenedHandle;
          }

          const engineHandle = editedHandle;
          editedHandle = null;

          return {
            engineHandle,
            options: { dirty: true, hasTextLayer: null },
          };
        } finally {
          await closeHandle(editedHandle);
        }
      });
    },
    [closeHandle, engine, enqueueMutation],
  );

  const readRaioPdfAnnotations = useCallback(async (): Promise<readonly PdfRaioAnnotationImport[]> => {
    const handle = activeHandleRef.current;

    if (!handle) {
      return [];
    }

    return engine.readRaioPdfAnnotations(handle);
  }, [engine]);

  const applyAnnotationSavePlan = useCallback(
    async (
      plan: {
        appendEdits: readonly PdfEdit[];
        updateEdits: readonly { annotId: string; edit: PdfRaioAnnotationEdit }[];
        deleteAnnotIds: readonly string[];
      },
      options: { flatten: boolean; printMarkupAnnotations?: boolean },
    ) => {
      const hasChanges = plan.appendEdits.length > 0 ||
        plan.updateEdits.length > 0 ||
        plan.deleteAnnotIds.length > 0;

      if (!hasChanges) {
        return false;
      }

      return enqueueMutation("apply annotation edits", async ({ handle }) => {
        const applyOptions: PdfApplyEditsOptions = {
          markupMode: "annotation",
          printMarkupAnnotations: options.printMarkupAnnotations ?? true,
        };
        const handlesToClose: PdfDocumentHandle[] = [];
        let currentHandle = handle;
        let finalHandle: PdfDocumentHandle | null = null;

        try {
          if (plan.appendEdits.length > 0) {
            currentHandle = await engine.applyEdits(currentHandle, plan.appendEdits, applyOptions);
            handlesToClose.push(currentHandle);
          }

          for (const update of plan.updateEdits) {
            const nextHandle = await engine.updateAnnotationById(
              currentHandle,
              update.annotId,
              update.edit,
              applyOptions,
            );
            currentHandle = nextHandle;
            handlesToClose.push(nextHandle);
          }

          for (const annotId of plan.deleteAnnotIds) {
            const nextHandle = await engine.deleteAnnotationById(currentHandle, annotId);
            currentHandle = nextHandle;
            handlesToClose.push(nextHandle);
          }

          if (options.flatten) {
            const flattenedHandle = await engine.flattenForm(currentHandle);
            currentHandle = flattenedHandle;
            handlesToClose.push(flattenedHandle);
          }

          finalHandle = currentHandle;

          return {
            engineHandle: currentHandle,
            options: { dirty: true, hasTextLayer: null },
          };
        } finally {
          await Promise.all(
            handlesToClose
              .filter((candidate) => candidate !== finalHandle)
              .map((candidate) => closeHandle(candidate)),
          );
        }
      });
    },
    [closeHandle, engine, enqueueMutation],
  );

  const flattenMarkupAnnotations = useCallback(async () => {
    return enqueueMutation("flatten markup", async ({ handle }) => ({
      engineHandle: await engine.flattenMarkupAnnotations(handle),
      options: { dirty: true, hasTextLayer: null },
    }));
  }, [engine, enqueueMutation]);

  const scrubMetadata = useCallback(async () => {
    return enqueueMutation("scrub metadata", async ({ handle }) => ({
      engineHandle: await engine.scrubMetadata(handle),
      options: { dirty: true },
    }));
  }, [engine, enqueueMutation]);

  const pageNumbers = useCallback(
    async (
      options: PdfPageNumbersOptions,
      guards: MutationGuards = {},
    ) => {
      const requestedToken = guards.expectedOpenToken ?? openTokenRef.current;

      return enqueueMutation("page numbers", async ({ handle }) => {
        if (
          guards.expectedOpenToken !== undefined &&
          openTokenRef.current !== guards.expectedOpenToken
        ) {
          return null;
        }

        if (
          guards.expectedGeneration !== undefined &&
          getActiveGenerationValue() !== guards.expectedGeneration
        ) {
          return null;
        }

        return {
          engineHandle: await engine.pageNumbers(handle, options),
          options: { dirty: true },
        };
      }, requestedToken);
    },
    [engine, enqueueMutation],
  );

  const watermark = useCallback(
    async (
      options: PdfWatermarkOptions,
      guards: MutationGuards = {},
    ) => {
      const requestedToken = guards.expectedOpenToken ?? openTokenRef.current;

      return enqueueMutation("watermark", async ({ handle }) => {
        if (
          guards.expectedOpenToken !== undefined &&
          openTokenRef.current !== guards.expectedOpenToken
        ) {
          return null;
        }

        if (
          guards.expectedGeneration !== undefined &&
          getActiveGenerationValue() !== guards.expectedGeneration
        ) {
          return null;
        }

        return {
          engineHandle: await engine.watermark(handle, options),
          options: { dirty: true },
        };
      }, requestedToken);
    },
    [engine, enqueueMutation],
  );

  const insertImagePages = useCallback(
    async (
      images: readonly PdfImagePageInput[],
      insertAtPageIndex: number,
      guards: MutationGuards = {},
    ) => {
      const requestedToken = guards.expectedOpenToken ?? openTokenRef.current;

      return enqueueMutation("insert image pages", async ({ handle }) => {
        if (
          guards.expectedOpenToken !== undefined &&
          openTokenRef.current !== guards.expectedOpenToken
        ) {
          return null;
        }

        if (
          guards.expectedGeneration !== undefined &&
          getActiveGenerationValue() !== guards.expectedGeneration
        ) {
          return null;
        }

        const result = await engine.insertImagePages(handle, insertAtPageIndex, images);

        return {
          engineHandle: result.document,
          options: {
            dirty: true,
            currentPage: insertAtPageIndex + 1,
            fileName: "Inserted Images.pdf",
            filePath: null,
            outlineStatus: outlineStatusFromRemovedTargets(result.removedTargets),
          },
        };
      }, requestedToken);
    },
    [engine, enqueueMutation],
  );

  const replaceOutline = useCallback(
    async (outline: PdfOutlineState) => {
      return enqueueMutation("bookmarks", async ({ handle }) => {
        const result = await engine.replaceOutline(handle, outline);

        return {
          engineHandle: result.document,
          options: {
            dirty: true,
            outlineStatus: outlineStatusFromRemovedTargets(result.removedTargets),
          },
        };
      });
    },
    [engine, enqueueMutation],
  );

  const save = useCallback(async (): Promise<SaveDocumentResult | null> => {
    await mutationQueueRef.current;

    const engineHandle = activeHandleRef.current;
    const token = openTokenRef.current;

    if (!engineHandle) {
      return null;
    }

    try {
      const bytes = await engine.saveToBytes(engineHandle);

      if (activeHandleRef.current !== engineHandle || openTokenRef.current !== token) {
        return null;
      }

      let fileName = "Untitled.pdf";
      let filePath: string | null = null;
      setDocument((current) => {
        fileName = current.fileName ?? fileName;
        filePath = current.filePath;

        return {
          ...current,
          bytes,
          // Fresh source object so the preview reloads from the saved
          // serialization (the old bytes-ref-change behavior). Generation is
          // intentionally NOT bumped: a save re-serializes the same content,
          // and in-flight work guarded by generation must stay valid across
          // it — mirroring how the engine-side bytes ref was left untouched
          // here before [R1-8].
          source: { kind: "memory", bytes },
          fileSizeBytes: bytes.byteLength,
          error: null,
        };
      });

      return {
        bytes,
        fileName,
        filePath,
      };
    } catch (error) {
      if (activeHandleRef.current === engineHandle && openTokenRef.current === token) {
        setError(getActionErrorMessage("save", error));
      }

      return null;
    }
  }, [engine, setError]);

  const markSaved = useCallback((saved: { fileName: string; filePath: string | null }) => {
    setDocument((current) => ({
      ...current,
      dirty: false,
      fileName: saved.fileName,
      filePath: saved.filePath,
      error: null,
    }));
  }, []);

  const markDirty = useCallback(() => {
    setDocument((current) => (current.dirty ? current : { ...current, dirty: true }));
  }, []);

  const markClean = useCallback(() => {
    setDocument((current) => (current.dirty ? { ...current, dirty: false } : current));
  }, []);

  const switchTab = useCallback((tabId: string) => {
    if (tabId === activeTabIdRef.current) {
      return true;
    }

    if (busyCountRef.current > 0) {
      setError("Finish the current document operation before switching tabs.");
      return false;
    }

    const activeSnapshot = snapshotActiveTab();
    const nextTab = tabsRef.current.find((tab) => tab.id === tabId);
    if (!nextTab) {
      return false;
    }

    const nextTabs = tabsRef.current.map((tab) => (
      activeSnapshot && tab.id === activeSnapshot.id ? activeSnapshot : tab
    ));
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    restoreTab(nextTab);
    return true;
  }, [restoreTab, setError, snapshotActiveTab]);

  const closeTab = useCallback(async (tabId: string) => {
    const isActive = tabId === activeTabIdRef.current;
    const tab = isActive
      ? snapshotActiveTab()
      : tabsRef.current.find((candidate) => candidate.id === tabId) ?? null;

    if (!tab) {
      return false;
    }

    if ((isActive ? busyCountRef.current : tab.busyCount) > 0) {
      setError("Finish the current document operation before closing this tab.");
      return false;
    }

    const currentTabs = isActive && tab
      ? tabsRef.current.map((candidate) => (candidate.id === tab.id ? tab : candidate))
      : tabsRef.current;
    const closingIndex = currentTabs.findIndex((candidate) => candidate.id === tabId);
    const nextTabs = currentTabs.filter((candidate) => candidate.id !== tabId);
    tabsRef.current = nextTabs;
    setTabs(nextTabs);

    if (isActive) {
      openTokenRef.current += 1;
      activeHandleRef.current = null;
      activeBytesRef.current = null;
      sourceKindRef.current = null;
      mutationQueueRef.current = Promise.resolve();
      busyCountRef.current = 0;
      setPageScrollIntent(null);
    }

    await closeHandle(tab.engineHandle);

    if (isActive) {
      const nextActive = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? null;
      if (nextActive) {
        restoreTab(nextActive);
      } else {
        activeTabIdRef.current = null;
        openTokenRef.current = 0;
        scrollNonceRef.current = 0;
        setDocumentState(INITIAL_DOCUMENT);
      }
    }

    return true;
  }, [closeHandle, restoreTab, setError, snapshotActiveTab]);

  return {
    document,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      document: tab.id === activeTabIdRef.current ? document : tab.document,
    })),
    activeTabId: activeTabIdRef.current,
    pageScrollIntent,
    openFile,
    openStreamedFile,
    switchTab,
    closeTab,
    setStreamedPageCount,
    replaceBytes,
    getOpenToken,
    getGeneration,
    setCurrentPage,
    syncVisiblePage,
    setZoom,
    setFitZoom,
    setHasTextLayer,
    setTextLayerCoverage,
    setPageSizeInches,
    setError,
    rotatePages,
    deletePages,
    reorderPages,
    mergeWithFiles,
    extractPages,
    splitPages,
    insertFile,
    cropResizePages,
    buildBinder,
    batesStamp,
    applyEdits,
    readRaioPdfAnnotations,
    applyAnnotationSavePlan,
    flattenMarkupAnnotations,
    scrubMetadata,
    pageNumbers,
    watermark,
    insertImagePages,
    replaceOutline,
    save,
    markSaved,
    markDirty,
    markClean,
  };

  async function closeHandles(handles: readonly PdfDocumentHandle[]) {
    await Promise.all(handles.map((handle) => closeHandle(handle)));
  }
}

async function extractHandle(
  engine: PdfEngine,
  handle: PdfDocumentHandle,
  deletedPages: readonly number[],
): Promise<PdfOutlineWriteResult> {
  if (deletedPages.length === 0) {
    return {
      document: await engine.open(await engine.saveToBytes(handle)),
      removedTargets: 0,
    };
  }

  return engine.deletePages(handle, deletedPages);
}

function outlineStatusFromRemovedTargets(removedTargets: number): string | null {
  if (removedTargets === 0) {
    return null;
  }

  return `Removed ${removedTargets} bookmark${removedTargets === 1 ? "" : "s"} whose target no longer exists.`;
}

function uniqueSortedPageIndexes(
  pageIndexes: readonly number[],
  pageCount: number,
): number[] {
  const unique = [...new Set(pageIndexes)].sort((left, right) => left - right);

  if (
    unique.length === 0 ||
    unique.some((pageIndex) => pageIndex < 0 || pageIndex >= pageCount)
  ) {
    throw new PdfEngineError(
      "INVALID_PAGE_INDEX",
      "The page range is outside this document.",
    );
  }

  return unique;
}

function complementPageIndexes(
  keptPages: readonly number[],
  pageCount: number,
): number[] {
  const kept = new Set(keptPages);

  return Array.from({ length: pageCount }, (_, index) => index).filter(
    (pageIndex) => !kept.has(pageIndex),
  );
}

function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0) {
    return 1;
  }

  return Math.min(Math.max(Math.round(page), 1), pageCount);
}

function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

function resolveCurrentPage(
  options: CommitOptions,
  current: DocumentState,
  pageCount: number,
): number {
  if (typeof options.currentPage === "function") {
    return options.currentPage(current, pageCount);
  }

  return options.currentPage ?? current.currentPage;
}

function getEngineErrorMessage(error: unknown): string {
  if (error instanceof PdfEngineError && error.code === "PASSWORD_REQUIRED") {
    return "This PDF needs an open password before Raio can unlock it.";
  }

  if (error instanceof PdfEngineError && error.code === "ENCRYPTED_DOCUMENT") {
    return "This PDF is password-protected.";
  }

  if (error instanceof PdfEngineError && error.code === "UNSUPPORTED") {
    return error.message;
  }

  if (error instanceof PdfEngineError && error.code === "EMPTY_RESULT") {
    return "A document must keep at least one page.";
  }

  return "This PDF could not be opened. The file may be corrupt or unsupported.";
}

function getActionErrorMessage(action: string, error: unknown): string {
  if (error instanceof PdfEngineError && error.code === "PASSWORD_REQUIRED") {
    return "This PDF needs an open password before Raio can unlock it.";
  }

  if (error instanceof PdfEngineError && error.code === "EMPTY_RESULT") {
    return "A document must keep at least one page.";
  }

  if (error instanceof PdfEngineError && error.code === "ENCRYPTED_DOCUMENT") {
    return "This PDF is encrypted. Remove encryption with the open password before editing.";
  }

  if (action === "rotate") {
    return "The selected pages could not be rotated. Check the selection and try again.";
  }

  if (action === "delete") {
    return "The selected pages could not be deleted. Check the selection and try again.";
  }

  if (action === "reorder") {
    return "The selected pages could not be moved. Check the selection and try again.";
  }

  if (action === "merge") {
    return "The PDFs could not be merged. Check the files and try again.";
  }

  if (action === "extract") {
    return "Those pages could not be extracted. Check the range and try again.";
  }

  if (action === "split") {
    return "The document could not be split. Check the page ranges and try again.";
  }

  if (action === "insert") {
    return "The selected file could not be inserted. Check the file and try again.";
  }

  if (action === "build binder") {
    return "The binder could not be built. Check the exhibit files and try again.";
  }

  if (action === "apply edits") {
    return "The edits could not be applied. The document was left unchanged.";
  }

  if (action === "flatten markup") {
    return "The markup annotations could not be flattened. The document was left unchanged.";
  }

  if (action === "save") {
    return "This PDF could not be saved. Try reopening the document and saving again.";
  }

  return getEngineErrorMessage(error);
}

function isProtectedOpenError(error: unknown): boolean {
  return error instanceof PdfEngineError &&
    (error.code === "ENCRYPTED_DOCUMENT" || error.code === "PASSWORD_REQUIRED");
}

function unlockFailureError(result: Exclude<UnlockResult, { status: "unlocked" }>): PdfEngineError {
  if (result.status === "password_required") {
    return new PdfEngineError(
      "PASSWORD_REQUIRED",
      "This PDF needs an open password before Raio can unlock it.",
    );
  }

  return result.error;
}

function mergeSignatureInvalidationNotice(
  current: SignatureInvalidationNotice | null | undefined,
  next: SignatureInvalidationNotice | null | undefined,
): SignatureInvalidationNotice | null {
  if (!next) {
    return current ?? null;
  }

  if (!current) {
    return next;
  }

  return {
    ...current,
    sourceFileNames: uniqueStrings([
      ...current.sourceFileNames,
      ...next.sourceFileNames,
    ]),
    sourceFilePath: current.sourceFilePath ?? next.sourceFilePath,
    signature: {
      standardAcroFormSignatureCount:
        current.signature.standardAcroFormSignatureCount +
        next.signature.standardAcroFormSignatureCount,
      hasByteRangeOrContentsMarkers:
        current.signature.hasByteRangeOrContentsMarkers ||
        next.signature.hasByteRangeOrContentsMarkers,
      hasCertificationDictionary:
        current.signature.hasCertificationDictionary ||
        next.signature.hasCertificationDictionary,
    },
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
