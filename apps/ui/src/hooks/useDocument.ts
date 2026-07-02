import { useCallback, useMemo, useState } from "react";
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
  fileSizeBytes: null,
  hasTextLayer: null,
  pageSizeInches: null,
  error: null,
};

interface CommitOptions {
  dirty: boolean;
  currentPage?: number;
}

export function useDocument() {
  const engine = useMemo<PdfEngine>(() => new LocalPdfEngine(), []);
  const [document, setDocument] = useState<DocumentState>(INITIAL_DOCUMENT);

  const commitHandle = useCallback(
    async (engineHandle: PdfDocumentHandle, options: CommitOptions) => {
      const [bytes, pageCount] = await Promise.all([
        engine.saveToBytes(engineHandle),
        engine.pageCount(engineHandle),
      ]);

      setDocument((current) => ({
        ...current,
        bytes,
        engineHandle,
        pageCount,
        currentPage: clampPage(options.currentPage ?? current.currentPage, pageCount),
        dirty: options.dirty,
        fileSizeBytes: bytes.byteLength,
        hasTextLayer: null,
        pageSizeInches: null,
        error: null,
      }));
    },
    [engine],
  );

  const openFile = useCallback(
    async (file: File) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const engineHandle = await engine.open(bytes);
        const pageCount = await engine.pageCount(engineHandle);

        setDocument({
          bytes,
          engineHandle,
          pageCount,
          currentPage: 1,
          zoom: 1,
          fitWidth: true,
          dirty: false,
          fileName: file.name,
          fileSizeBytes: bytes.byteLength,
          hasTextLayer: null,
          pageSizeInches: null,
          error: null,
        });
        return true;
      } catch (error) {
        setDocument((current) => ({
          ...current,
          bytes: null,
          engineHandle: null,
          pageCount: 0,
          currentPage: 1,
          dirty: false,
          fileName: null,
          fileSizeBytes: null,
          hasTextLayer: null,
          pageSizeInches: null,
          error: getEngineErrorMessage(error),
        }));
        return false;
      }
    },
    [engine],
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

  const setError = useCallback((error: string | null) => {
    setDocument((current) => ({ ...current, error }));
  }, []);

  const rotatePages = useCallback(
    async (pageIndexes: readonly number[]) => {
      if (!document.engineHandle || pageIndexes.length === 0) {
        return;
      }

      const engineHandle = await engine.rotatePages(document.engineHandle, pageIndexes, 90);
      await commitHandle(engineHandle, { dirty: true });
    },
    [commitHandle, document.engineHandle, engine],
  );

  const deletePages = useCallback(
    async (pageIndexes: readonly number[]) => {
      if (!document.engineHandle || pageIndexes.length === 0) {
        return;
      }

      try {
        const engineHandle = await engine.deletePages(document.engineHandle, pageIndexes);
        await commitHandle(engineHandle, {
          dirty: true,
          currentPage: Math.min(document.currentPage, document.pageCount - pageIndexes.length),
        });
      } catch (error) {
        setError(getEngineErrorMessage(error));
      }
    },
    [
      commitHandle,
      document.currentPage,
      document.engineHandle,
      document.pageCount,
      engine,
      setError,
    ],
  );

  const reorderPages = useCallback(
    async (pageIndexes: readonly number[], currentPage?: number) => {
      if (!document.engineHandle || pageIndexes.length === 0) {
        return;
      }

      const engineHandle = await engine.reorderPages(document.engineHandle, pageIndexes);
      const options: CommitOptions = { dirty: true };

      if (currentPage !== undefined) {
        options.currentPage = currentPage;
      }

      await commitHandle(engineHandle, options);
    },
    [commitHandle, document.engineHandle, engine],
  );

  const save = useCallback(async () => {
    if (!document.engineHandle) {
      return null;
    }

    const bytes = await engine.saveToBytes(document.engineHandle);
    setDocument((current) => ({
      ...current,
      bytes,
      dirty: false,
      fileSizeBytes: bytes.byteLength,
      error: null,
    }));

    return {
      bytes,
      fileName: document.fileName ?? "Untitled.pdf",
    };
  }, [document.engineHandle, document.fileName, engine]);

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

function getEngineErrorMessage(error: unknown): string {
  if (error instanceof PdfEngineError && error.code === "EMPTY_RESULT") {
    return "A document must keep at least one page.";
  }

  return "This PDF could not be opened. The file may be corrupt or unsupported.";
}
