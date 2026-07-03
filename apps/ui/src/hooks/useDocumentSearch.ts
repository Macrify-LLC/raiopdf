import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import {
  extractPageText,
  findTextRedactionAreasInPages,
} from "../lib/legalTools";

const SEARCH_DEBOUNCE_MS = 250;

interface DocumentSearchSource {
  bytes: Uint8Array;
  proxy: PDFDocumentProxy;
}

export interface DocumentSearchMatch {
  id: string;
  area: PdfRedactionArea;
}

export interface DocumentSearchState {
  query: string;
  results: readonly DocumentSearchMatch[];
  activeIndex: number | null;
  activeMatch: DocumentSearchMatch | null;
  status: "idle" | "searching" | "error";
  resultLabel: string;
  canNavigate: boolean;
  setQuery: (query: string) => void;
  clear: () => void;
  goToNext: () => void;
  goToPrevious: () => void;
}

export function useDocumentSearch({
  pdfDocumentState,
  documentBytes,
  setCurrentPage,
}: {
  pdfDocumentState: DocumentSearchSource | null;
  documentBytes: Uint8Array | null;
  setCurrentPage: (page: number) => void;
}): DocumentSearchState {
  const [query, setQueryState] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<DocumentSearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<DocumentSearchState["status"]>("idle");
  const documentBytesRef = useRef<Uint8Array | null>(documentBytes);
  const pdfDocumentStateRef = useRef<DocumentSearchSource | null>(pdfDocumentState);
  const searchRunRef = useRef(0);

  useEffect(() => {
    documentBytesRef.current = documentBytes;
  }, [documentBytes]);

  useEffect(() => {
    pdfDocumentStateRef.current = pdfDocumentState;
  }, [pdfDocumentState]);

  const clear = useCallback(() => {
    searchRunRef.current += 1;
    setQueryState("");
    setDebouncedQuery("");
    setResults([]);
    setActiveIndex(null);
    setStatus("idle");
  }, []);

  useEffect(() => {
    clear();
  }, [clear, documentBytes]);

  const setQuery = useCallback((nextQuery: string) => {
    searchRunRef.current += 1;
    setQueryState(nextQuery);
    setResults([]);
    setActiveIndex(null);
    setStatus(nextQuery.trim() ? "searching" : "idle");
  }, []);

  useEffect(() => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setDebouncedQuery("");
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(trimmedQuery);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    const trimmedQuery = debouncedQuery.trim();

    if (!trimmedQuery || !documentBytes) {
      if (!trimmedQuery) {
        setResults([]);
        setActiveIndex(null);
        setStatus("idle");
      }

      return;
    }

    const source = pdfDocumentState;

    if (!source || source.bytes !== documentBytes) {
      return;
    }

    const runId = searchRunRef.current + 1;
    searchRunRef.current = runId;
    const sourceBytes = documentBytes;
    const sourceProxy = source.proxy;
    setStatus("searching");

    void extractPageText({ bytes: source.bytes, pdfDocument: source.proxy })
      .then((pages) => {
        if (
          searchRunRef.current !== runId ||
          documentBytesRef.current !== sourceBytes ||
          pdfDocumentStateRef.current?.proxy !== sourceProxy
        ) {
          return;
        }

        const areas = findTextRedactionAreasInPages(pages, trimmedQuery);
        const nextResults = areas.map((area, index) => ({
          id: `search-${index}`,
          area,
        }));

        setResults(nextResults);
        setActiveIndex(nextResults.length > 0 ? 0 : null);
        setStatus("idle");

        const firstResult = nextResults[0];
        if (firstResult) {
          setCurrentPage(firstResult.area.pageIndex + 1);
        }
      })
      .catch(() => {
        if (
          searchRunRef.current !== runId ||
          documentBytesRef.current !== sourceBytes ||
          pdfDocumentStateRef.current?.proxy !== sourceProxy
        ) {
          return;
        }

        setResults([]);
        setActiveIndex(null);
        setStatus("error");
      });
  }, [debouncedQuery, documentBytes, pdfDocumentState, setCurrentPage]);

  const goToResult = useCallback(
    (index: number) => {
      if (results.length === 0) {
        return;
      }

      const normalizedIndex = (index + results.length) % results.length;
      const match = results[normalizedIndex];

      if (!match) {
        return;
      }

      setActiveIndex(normalizedIndex);
      setCurrentPage(match.area.pageIndex + 1);
    },
    [results, setCurrentPage],
  );

  const goToNext = useCallback(() => {
    goToResult(activeIndex === null ? 0 : activeIndex + 1);
  }, [activeIndex, goToResult]);

  const goToPrevious = useCallback(() => {
    goToResult(activeIndex === null ? results.length - 1 : activeIndex - 1);
  }, [activeIndex, goToResult, results.length]);

  const resultLabel = useMemo(() => {
    if (!query.trim()) {
      return "";
    }

    if (status === "searching") {
      return "Searching";
    }

    if (status === "error") {
      return "Search failed";
    }

    if (results.length === 0 || activeIndex === null) {
      return "0 of 0";
    }

    return `${activeIndex + 1} of ${results.length}`;
  }, [activeIndex, query, results.length, status]);

  return {
    query,
    results,
    activeIndex,
    activeMatch: activeIndex === null ? null : results[activeIndex] ?? null,
    status,
    resultLabel,
    canNavigate: results.length > 0,
    setQuery,
    clear,
    goToNext,
    goToPrevious,
  };
}
