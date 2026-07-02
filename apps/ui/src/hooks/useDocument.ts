import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdfDocumentHandle, PdfEngine } from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { LocalPdfEngine } from "@raiopdf/engine-local";

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
  pageSizeInches: PageSizeInches | null;
  error: string | null;
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
  pageSizeInches: null,
  error: null,
};

interface CommitOptions {
  dirty: boolean;
  currentPage?: number | ((current: DocumentState, pageCount: number) => number);
}

interface OperationContext {
  handle: PdfDocumentHandle;
  token: number;
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

export function useDocument() {
  const engine = useMemo<PdfEngine>(() => new LocalPdfEngine(), []);
  const [document, setDocument] = useState<DocumentState>(INITIAL_DOCUMENT);
  const activeHandleRef = useRef<PdfDocumentHandle | null>(null);
  const openTokenRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());

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
        engine.pageCount(engineHandle),
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
      setDocument((current) => ({
        ...current,
        bytes,
        engineHandle,
        pageCount,
        currentPage: clampPage(resolveCurrentPage(options, current, pageCount), pageCount),
        dirty: options.dirty,
        fileSizeBytes: bytes.byteLength,
        hasTextLayer: null,
        pageSizeInches: null,
        error: null,
      }));

      if (previousHandle !== engineHandle) {
        await closeHandle(previousHandle);
      }

      return true;
    },
    [closeHandle, engine],
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
      }>,
    ) => {
      const queued = mutationQueueRef.current.then(async () => {
        const context = currentOperation();

        if (!context) {
          return false;
        }

        try {
          const result = await operation(context);
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

  const openFile = useCallback(
    async (file: DocumentFileInput) => {
      const token = openTokenRef.current + 1;
      openTokenRef.current = token;
      const previousHandle = activeHandleRef.current;
      let openedHandle: PdfDocumentHandle | null = null;
      activeHandleRef.current = null;
      setDocument(INITIAL_DOCUMENT);
      await closeHandle(previousHandle);

      try {
        const engineHandle = await engine.open(file.bytes);
        openedHandle = engineHandle;
        const pageCount = await engine.pageCount(engineHandle);

        if (openTokenRef.current !== token) {
          await closeHandle(engineHandle);
          return false;
        }

        activeHandleRef.current = engineHandle;
        setDocument({
          bytes: file.bytes,
          engineHandle,
          pageCount,
          currentPage: 1,
          zoom: 1,
          fitWidth: true,
          dirty: false,
          fileName: file.name,
          filePath: file.path ?? null,
          fileSizeBytes: file.bytes.byteLength,
          hasTextLayer: null,
          pageSizeInches: null,
          error: null,
        });
        return true;
      } catch (error) {
        await closeHandle(openedHandle);

        if (openTokenRef.current === token) {
          activeHandleRef.current = null;
          setDocument({
            ...INITIAL_DOCUMENT,
            error: getEngineErrorMessage(error),
          });
        }

        return false;
      }
    },
    [closeHandle, engine],
  );

  const setCurrentPage = useCallback((page: number) => {
    setDocument((current) => ({
      ...current,
      currentPage: clampPage(page, current.pageCount),
    }));
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

  const setPageSizeInches = useCallback((pageSizeInches: PageSizeInches) => {
    setDocument((current) => ({ ...current, pageSizeInches }));
  }, []);

  const rotatePages = useCallback(
    async (pageIndexes: readonly number[]) => {
      if (pageIndexes.length === 0) {
        return false;
      }

      return enqueueMutation("rotate", async ({ handle }) => ({
        engineHandle: await engine.rotatePages(handle, pageIndexes, 90),
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
    openFile,
    setCurrentPage,
    setZoom,
    setFitZoom,
    setHasTextLayer,
    setPageSizeInches,
    setError,
    rotatePages,
    deletePages,
    reorderPages,
    save,
    markSaved,
  };
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
  if (error instanceof PdfEngineError && error.code === "ENCRYPTED_DOCUMENT") {
    return "This PDF is encrypted. Encrypted documents are not supported yet.";
  }

  if (error instanceof PdfEngineError && error.code === "EMPTY_RESULT") {
    return "A document must keep at least one page.";
  }

  return "This PDF could not be opened. The file may be corrupt or unsupported.";
}

function getActionErrorMessage(action: string, error: unknown): string {
  if (error instanceof PdfEngineError && error.code === "EMPTY_RESULT") {
    return "A document must keep at least one page.";
  }

  if (error instanceof PdfEngineError && error.code === "ENCRYPTED_DOCUMENT") {
    return "This PDF is encrypted. Encrypted documents are not supported yet.";
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

  if (action === "save") {
    return "This PDF could not be saved. Try reopening the document and saving again.";
  }

  return getEngineErrorMessage(error);
}
