import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PdfBinderOptions,
  PdfDocumentHandle,
  PdfEngine,
} from "@raiopdf/engine-api";
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
  hasTextLayer?: boolean | null;
  fileName?: string;
  filePath?: string | null;
}

interface ReplaceBytesOptions {
  dirty: boolean;
  hasTextLayer?: boolean | null;
  expectedOpenToken?: number;
  expectedSourceBytes?: Uint8Array | null;
  fileName?: string;
  filePath?: string | null;
}

export type ReplaceBytesResult = "replaced" | "stale" | "failed";

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

export interface BinderExhibitInput {
  bytes: Uint8Array;
  label: string;
}

export function useDocument() {
  const engine = useMemo<PdfEngine>(() => new LocalPdfEngine(), []);
  const [document, setDocument] = useState<DocumentState>(INITIAL_DOCUMENT);
  const activeHandleRef = useRef<PdfDocumentHandle | null>(null);
  const activeBytesRef = useRef<Uint8Array | null>(null);
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
      activeBytesRef.current = bytes;
      setDocument((current) => ({
        ...current,
        bytes,
        engineHandle,
        pageCount,
        currentPage: clampPage(resolveCurrentPage(options, current, pageCount), pageCount),
        dirty: options.dirty,
        fileName: options.fileName ?? current.fileName,
        filePath: options.filePath ?? current.filePath,
        fileSizeBytes: bytes.byteLength,
        hasTextLayer: options.hasTextLayer ?? null,
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

  const openFile = useCallback(
    async (file: DocumentFileInput) => {
      const token = openTokenRef.current + 1;
      openTokenRef.current = token;
      const previousHandle = activeHandleRef.current;
      let openedHandle: PdfDocumentHandle | null = null;
      activeHandleRef.current = null;
      activeBytesRef.current = null;
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
        activeBytesRef.current = file.bytes;
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
          activeBytesRef.current = null;
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

        let openedHandle: PdfDocumentHandle | null = null;
        const nextBytes = new Uint8Array(bytes);

        try {
          const engineHandle = await engine.open(nextBytes);
          openedHandle = engineHandle;
          const commitOptions: CommitOptions = {
            dirty: options.dirty,
            hasTextLayer: options.hasTextLayer ?? null,
          };

          if (options.fileName !== undefined) {
            commitOptions.fileName = options.fileName;
          }

          if (options.filePath !== undefined) {
            commitOptions.filePath = options.filePath;
          }

          return {
            engineHandle,
            options: commitOptions,
          };
        } catch (error) {
          await closeHandle(openedHandle);
          throw error;
        }
      }, requestedToken);

      if (replaced) {
        return "replaced";
      }

      return stale ? "stale" : "failed";
    },
    [closeHandle, engine, enqueueMutation],
  );

  const getOpenToken = useCallback(() => openTokenRef.current, []);

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

  const mergeWithFiles = useCallback(
    async (files: readonly DocumentFileInput[]) => {
      if (files.length === 0) {
        return false;
      }

      return enqueueMutation("merge", async ({ handle }) => {
        const openedHandles: PdfDocumentHandle[] = [];

        try {
          for (const file of files) {
            openedHandles.push(await engine.open(file.bytes));
          }

          return {
            engineHandle: await engine.merge([handle, ...openedHandles]),
            options: {
              dirty: true,
              currentPage: 1,
              fileName: "Merged.pdf",
              filePath: null,
            },
          };
        } finally {
          await closeHandles(openedHandles);
        }
      });
    },
    [engine, enqueueMutation],
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
          insertedHandle = await engine.open(file.bytes);

          return {
            engineHandle: await engine.insertPages(handle, insertAtPageIndex, insertedHandle),
            options: {
              dirty: true,
              currentPage: insertAtPageIndex + 1,
              fileName: "Inserted Pages.pdf",
              filePath: null,
            },
          };
        } finally {
          await closeHandle(insertedHandle);
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

        try {
          for (const exhibit of exhibits) {
            openedHandles.push(await engine.open(exhibit.bytes));
          }

          return {
            engineHandle: await engine.buildBinder(
              handle,
              exhibits.map((exhibit, index) => ({
                doc: openedHandles[index]!,
                label: exhibit.label,
              })),
              options,
            ),
            options: {
              dirty: true,
              currentPage: 1,
              fileName,
              filePath: null,
            },
          };
        } finally {
          await closeHandles(openedHandles);
        }
      });
    },
    [engine, enqueueMutation, setError],
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
    replaceBytes,
    getOpenToken,
    setCurrentPage,
    setZoom,
    setFitZoom,
    setHasTextLayer,
    setPageSizeInches,
    setError,
    rotatePages,
    deletePages,
    reorderPages,
    mergeWithFiles,
    extractPages,
    splitPages,
    insertFile,
    buildBinder,
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

  if (action === "save") {
    return "This PDF could not be saved. Try reopening the document and saving again.";
  }

  return getEngineErrorMessage(error);
}
