import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PdfBatesStampOptions,
  PdfBinderOptions,
  PdfDocumentHandle,
  PdfEdit,
  PdfEngine,
  PdfImagePageInput,
  PdfPageNumbersOptions,
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

export interface PageSizeInches {
  width: number;
  height: number;
}

export interface DocumentState {
  bytes: Uint8Array | null;
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
  signatureInvalidationNotice?: SignatureInvalidationNotice | null;
}

interface ReplaceBytesOptions {
  dirty: boolean;
  hasTextLayer?: boolean | null;
  textLayerCoverage?: TextLayerCoverage | null;
  knownPageCount?: number;
  expectedOpenToken?: number;
  expectedSourceBytes?: Uint8Array | null;
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
  expectedSourceBytes?: Uint8Array | null;
}

export interface DocumentFileInput {
  bytes: Uint8Array;
  name: string;
  path?: string | null;
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
  const [document, setDocument] = useState<DocumentState>(INITIAL_DOCUMENT);
  const [pageScrollIntent, setPageScrollIntent] = useState<PageScrollIntent | null>(null);
  const activeHandleRef = useRef<PdfDocumentHandle | null>(null);
  const activeBytesRef = useRef<Uint8Array | null>(null);
  const openTokenRef = useRef(0);
  const scrollNonceRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const requestPageScroll = useCallback((page: number) => {
    scrollNonceRef.current += 1;
    setPageScrollIntent({ page, nonce: scrollNonceRef.current });
  }, []);

  const setError = useCallback((error: string | null) => {
    setDocument((current) => ({ ...current, error }));
  }, []);

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
      const engineHandle = activeHandleRef.current;
      activeHandleRef.current = null;
      activeBytesRef.current = null;
      void closeHandle(engineHandle);
    };
  }, [closeHandle]);

  const commitHandle = useCallback(
    async (
      engineHandle: PdfDocumentHandle,
      options: CommitOptions,
      operation: OperationContext,
    ) => {
      const [bytes, pageCount] = await Promise.all([
        engine.saveToBytes(engineHandle),
        options.knownPageCount !== undefined
          ? Promise.resolve(options.knownPageCount)
          : engine.pageCount(engineHandle),
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
      setDocument((current) => ({
        ...current,
        bytes,
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
    [closeHandle, engine, requestPageScroll],
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
      });

      mutationQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );

      return queued;
    },
    [closeHandle, commitHandle, currentOperation, setError],
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
      const token = openTokenRef.current + 1;
      openTokenRef.current = token;
      const previousHandle = activeHandleRef.current;
      let prepared: PreparedDocument | null = null;

      try {
        prepared = await openPreparedDocument(file);
        if (!prepared) {
          return { status: "cancelled" };
        }

        const { bytes, engineHandle, signatureInvalidationNotice } = prepared;
        const signatureInvalidated = Boolean(signatureInvalidationNotice);
        const pageCount = await engine.pageCount(engineHandle);

        if (openTokenRef.current !== token) {
          await closeHandle(engineHandle);
          return { status: "failed", error: "This document was replaced before it finished opening." };
        }

        activeHandleRef.current = null;
        activeBytesRef.current = null;
        await closeHandle(previousHandle);
        activeHandleRef.current = engineHandle;
        activeBytesRef.current = bytes;
        setDocument({
          bytes,
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
          signatureInvalidationNotice,
          error: null,
        });
        prepared = null;
        requestPageScroll(1);
        return { status: "opened" };
      } catch (error) {
        await closeHandle(prepared?.engineHandle ?? null);

        if (openTokenRef.current !== token) {
          return { status: "failed", error: getEngineErrorMessage(error) };
        }

        activeHandleRef.current = null;
        activeBytesRef.current = null;

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
          setDocument(INITIAL_DOCUMENT);
          return {
            status: "password-required",
            bytes: file.bytes,
            fileName: file.name,
            filePath: file.path ?? null,
          };
        }

        const message = getEngineErrorMessage(error);
        if (previousHandle) {
          // A failed replacement open keeps the current document on screen.
          setDocument((current) => ({ ...current, error: message }));
        } else {
          setDocument({
            ...INITIAL_DOCUMENT,
            error: message,
          });
        }
        return { status: "failed", error: message };
      }
    },
    [closeHandle, engine, openPreparedDocument, requestPageScroll],
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
          options.expectedSourceBytes !== undefined &&
          activeBytesRef.current !== options.expectedSourceBytes
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

      return enqueueMutation("delete", async ({ handle }) => ({
        engineHandle: await engine.deletePages(handle, pageIndexes),
        options: {
          dirty: true,
          currentPage: (current, pageCount) => Math.min(current.currentPage, pageCount),
        },
      }));
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

      return enqueueMutation("reorder", async ({ handle }) => ({
        engineHandle: await engine.reorderPages(handle, pageIndexes),
        options,
      }));
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

          return {
            engineHandle: await engine.merge([handle, ...openedHandles]),
            options: {
              dirty: true,
              currentPage: 1,
              fileName: "Merged.pdf",
              filePath: null,
              signatureInvalidationNotice,
            },
          };
        } finally {
          await closeHandles(openedHandles);
        }
      });
    },
    [engine, enqueueMutation, openPreparedDocument],
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

        return {
          engineHandle: await extractHandle(engine, handle, deletedPages),
          options: {
            dirty: true,
            currentPage: 1,
            fileName: "Extracted Pages.pdf",
            filePath: null,
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
          const outputHandle = await extractHandle(
            engine,
            handle,
            complementPageIndexes(keptPages, pageCount),
          );
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

          return {
            engineHandle: await engine.insertPages(handle, insertAtPageIndex, insertedHandle),
            options: {
              dirty: true,
              currentPage: insertAtPageIndex + 1,
              fileName: "Inserted Pages.pdf",
              filePath: null,
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
      guards: { expectedOpenToken?: number; expectedSourceBytes?: Uint8Array | null } = {},
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
          guards.expectedSourceBytes !== undefined &&
          activeBytesRef.current !== guards.expectedSourceBytes
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
    async (edits: readonly PdfEdit[], options: { flatten: boolean }) => {
      if (edits.length === 0) {
        return false;
      }

      return enqueueMutation("apply edits", async ({ handle }) => {
        let editedHandle: PdfDocumentHandle | null = await engine.applyEdits(handle, edits);

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

  const scrubMetadata = useCallback(async () => {
    return enqueueMutation("scrub metadata", async ({ handle }) => ({
      engineHandle: await engine.scrubMetadata(handle),
      options: { dirty: true },
    }));
  }, [engine, enqueueMutation]);

  const pageNumbers = useCallback(
    async (
      options: PdfPageNumbersOptions,
      guards: { expectedOpenToken?: number; expectedSourceBytes?: Uint8Array | null } = {},
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
          guards.expectedSourceBytes !== undefined &&
          activeBytesRef.current !== guards.expectedSourceBytes
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
      guards: { expectedOpenToken?: number; expectedSourceBytes?: Uint8Array | null } = {},
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
          guards.expectedSourceBytes !== undefined &&
          activeBytesRef.current !== guards.expectedSourceBytes
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
          guards.expectedSourceBytes !== undefined &&
          activeBytesRef.current !== guards.expectedSourceBytes
        ) {
          return null;
        }

        return {
          engineHandle: await engine.insertImagePages(handle, insertAtPageIndex, images),
          options: {
            dirty: true,
            currentPage: insertAtPageIndex + 1,
            fileName: "Inserted Images.pdf",
            filePath: null,
          },
        };
      }, requestedToken);
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

  return {
    document,
    pageScrollIntent,
    openFile,
    replaceBytes,
    getOpenToken,
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
    scrubMetadata,
    pageNumbers,
    watermark,
    insertImagePages,
    save,
    markSaved,
  };

  async function closeHandles(handles: readonly PdfDocumentHandle[]) {
    await Promise.all(handles.map((handle) => closeHandle(handle)));
  }
}

async function extractHandle(
  engine: PdfEngine,
  handle: PdfDocumentHandle,
  deletedPages: readonly number[],
): Promise<PdfDocumentHandle> {
  if (deletedPages.length === 0) {
    return engine.open(await engine.saveToBytes(handle));
  }

  return engine.deletePages(handle, deletedPages);
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
