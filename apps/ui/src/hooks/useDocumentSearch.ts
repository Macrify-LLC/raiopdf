import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { TextLayerCoverage } from "@raiopdf/rules";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import {
  extractPageText,
  findTextMatchAreasInPages,
} from "../lib/legalTools";
import { extractPageTextForIndexes } from "../lib/pageTextCache";

const SEARCH_DEBOUNCE_MS = 250;
/**
 * Streamed-mode extraction window: how many pages are pulled per step. Small
 * enough that progress is visible and cancel is responsive on a 2,556-page
 * range-read document; large enough that the per-window overhead is noise.
 */
const SEARCH_WINDOW_PAGES = 8;

interface DocumentSearchSource {
  /** Null in streamed mode — extraction then runs proxy-only, windowed. */
  bytes: Uint8Array | null;
  proxy: PDFDocumentProxy;
}

export interface DocumentSearchMatch {
  id: string;
  area: PdfRedactionArea;
}

export interface DocumentSearchProgress {
  donePages: number;
  totalPages: number;
}

export interface DocumentSearchState {
  query: string;
  results: readonly DocumentSearchMatch[];
  activeIndex: number | null;
  activeMatch: DocumentSearchMatch | null;
  status: "idle" | "searching" | "error";
  resultLabel: string;
  warning: string | null;
  canNavigate: boolean;
  /** Non-null only during a streamed, windowed search pass [R1-3]. */
  progress: DocumentSearchProgress | null;
  setQuery: (query: string) => void;
  clear: () => void;
  /** Stops an in-flight streamed pass, keeping the matches found so far. */
  cancel: () => void;
  goToNext: () => void;
  goToPrevious: () => void;
}

export function useDocumentSearch({
  pdfDocumentState,
  documentGeneration,
  textLayerCoverage,
  setCurrentPage,
}: {
  pdfDocumentState: DocumentSearchSource | null;
  /** Document identity [R1-8] — replaces the old bytes-reference keying. */
  documentGeneration: number;
  textLayerCoverage: TextLayerCoverage | null;
  setCurrentPage: (page: number) => void;
}): DocumentSearchState {
  const [query, setQueryState] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<DocumentSearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<DocumentSearchState["status"]>("idle");
  const [progress, setProgress] = useState<DocumentSearchProgress | null>(null);
  const documentGenerationRef = useRef(documentGeneration);
  const pdfDocumentStateRef = useRef<DocumentSearchSource | null>(pdfDocumentState);
  const searchRunRef = useRef(0);

  useEffect(() => {
    documentGenerationRef.current = documentGeneration;
  }, [documentGeneration]);

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
    setProgress(null);
  }, []);

  const cancel = useCallback(() => {
    searchRunRef.current += 1;
    setStatus("idle");
    setProgress(null);
  }, []);

  useEffect(() => {
    clear();
  }, [clear, documentGeneration]);

  const setQuery = useCallback((nextQuery: string) => {
    searchRunRef.current += 1;
    setQueryState(nextQuery);
    setResults([]);
    setActiveIndex(null);
    setStatus(nextQuery.trim() ? "searching" : "idle");
    setProgress(null);
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
    const source = pdfDocumentState;

    if (!trimmedQuery) {
      // Functional reset: an unstable `pdfDocumentState` reference must not
      // be able to loop this effect through a fresh-array state change.
      setResults((current) => (current.length > 0 ? [] : current));
      setActiveIndex(null);
      setStatus("idle");
      setProgress(null);
      return;
    }

    if (!source) {
      return;
    }

    const runId = searchRunRef.current + 1;
    searchRunRef.current = runId;
    const sourceGeneration = documentGeneration;
    const sourceProxy = source.proxy;
    const isCurrentRun = () => (
      searchRunRef.current === runId &&
      documentGenerationRef.current === sourceGeneration &&
      pdfDocumentStateRef.current?.proxy === sourceProxy
    );
    setStatus("searching");

    if (source.bytes !== null) {
      // Memory mode: one whole-document extraction via the bytes-keyed
      // cache — today's small-file path, unchanged.
      void extractPageText({ bytes: source.bytes, pdfDocument: sourceProxy })
        .then((pages) => {
          if (!isCurrentRun()) {
            return;
          }

          const areas = findTextMatchAreasInPages(pages, trimmedQuery);
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
          if (!isCurrentRun()) {
            return;
          }

          setResults([]);
          setActiveIndex(null);
          setStatus("error");
        });
      return;
    }

    // Streamed mode [R1-3]: lazy and windowed. Extraction walks the document
    // in small page windows through the range transport, streaming matches
    // into the result list with visible progress; a superseded run (new
    // query, cancel, document change) stops at the next window boundary.
    // Worst case a full search downloads the whole file once — acceptable
    // and user-initiated, unlike open.
    const totalPages = sourceProxy.numPages;
    setProgress({ donePages: 0, totalPages });

    void (async () => {
      const collected: DocumentSearchMatch[] = [];

      for (let start = 0; start < totalPages; start += SEARCH_WINDOW_PAGES) {
        const windowEnd = Math.min(start + SEARCH_WINDOW_PAGES, totalPages);
        const windowIndexes = Array.from(
          { length: windowEnd - start },
          (_, offset) => start + offset,
        );
        const pages = await extractPageTextForIndexes(sourceProxy, windowIndexes);

        if (!isCurrentRun()) {
          return;
        }

        const areas = findTextMatchAreasInPages(pages, trimmedQuery);

        if (areas.length > 0) {
          const firstMatchOfRun = collected.length === 0;

          for (const area of areas) {
            collected.push({ id: `search-${runId}-${collected.length}`, area });
          }

          setResults([...collected]);

          if (firstMatchOfRun) {
            setActiveIndex(0);
            setCurrentPage(collected[0]!.area.pageIndex + 1);
          }
        }

        setProgress({ donePages: windowEnd, totalPages });
      }

      if (!isCurrentRun()) {
        return;
      }

      setResults([...collected]);
      setActiveIndex((current) => current ?? (collected.length > 0 ? 0 : null));
      setStatus("idle");
      setProgress(null);
    })().catch(() => {
      if (!isCurrentRun()) {
        return;
      }

      setStatus("error");
      setProgress(null);
    });
  }, [debouncedQuery, documentGeneration, pdfDocumentState, setCurrentPage]);

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

  const warning = useMemo(() => documentSearchWarning(textLayerCoverage), [textLayerCoverage]);

  const resultLabel = useMemo(() => {
    const warningLabel = warning ? "Unreliable" : "";

    if (!query.trim()) {
      return warningLabel;
    }

    if (status === "searching") {
      // Streamed passes surface page progress so a 2,556-page search reads
      // as working, not hung.
      const searchingLabel = progress
        ? `Searching ${progress.donePages}/${progress.totalPages}`
        : "Searching";
      return warningLabel ? `${searchingLabel} - ${warningLabel}` : searchingLabel;
    }

    if (status === "error") {
      return warningLabel ? `Search failed - ${warningLabel}` : "Search failed";
    }

    if (results.length === 0 || activeIndex === null) {
      return warningLabel ? `0 of 0 - ${warningLabel}` : "0 of 0";
    }

    const countLabel = `${activeIndex + 1} of ${results.length}`;
    return warningLabel ? `${countLabel} - ${warningLabel}` : countLabel;
  }, [activeIndex, progress, query, results.length, status, warning]);

  return {
    query,
    results,
    activeIndex,
    activeMatch: activeIndex === null ? null : results[activeIndex] ?? null,
    status,
    resultLabel,
    warning,
    canNavigate: results.length > 0,
    progress,
    setQuery,
    clear,
    cancel,
    goToNext,
    goToPrevious,
  };
}

export function documentSearchWarning(textLayerCoverage: TextLayerCoverage | null): string | null {
  const garbledPageCount = textLayerCoverage?.garbledPages.length ?? 0;
  const trivialTextImagePageCount = textLayerCoverage?.trivialTextImagePages?.length ?? 0;
  if (garbledPageCount === 0 && trivialTextImagePageCount === 0) {
    return null;
  }

  if (trivialTextImagePageCount > 0) {
    return `Search may be incomplete - ${trivialTextImagePageCount} page${trivialTextImagePageCount === 1 ? "" : "s"} only ${trivialTextImagePageCount === 1 ? "has" : "have"} a tiny text layer over scanned page images.`;
  }

  return `Search may be incomplete - the text layer looks garbled on ${garbledPageCount} page${garbledPageCount === 1 ? "" : "s"}.`;
}
