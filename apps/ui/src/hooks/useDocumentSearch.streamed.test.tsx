// @vitest-environment jsdom
import { act, useEffect, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { useDocumentSearch, type DocumentSearchState } from "./useDocumentSearch";

// Streamed search extracts through the bare-proxy path of pageTextCache, so
// a fake proxy with pdf.js-shaped text items exercises the real pipeline.
function createFakeStreamedProxy(pageCount: number, needlePages: readonly number[]): PDFDocumentProxy {
  return {
    numPages: pageCount,
    async getPage(pageNumber: number) {
      const hasNeedle = needlePages.includes(pageNumber);
      return {
        async getTextContent() {
          return {
            items: [
              {
                str: hasNeedle ? "the needle sits here" : "nothing to see",
                transform: [12, 0, 0, 12, 72, 700],
                width: 90,
                height: 12,
                hasEOL: false,
              },
            ],
          };
        },
      };
    },
  } as unknown as PDFDocumentProxy;
}

describe("useDocumentSearch streamed (windowed) mode", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latest: DocumentSearchState | null = null;

  beforeEach(() => {
    latest = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("streams matches window-by-window off the proxy and navigates to the first hit", async () => {
    const setCurrentPage = vi.fn();
    const proxy = createFakeStreamedProxy(20, [5, 17]);

    render(proxy, setCurrentPage);

    act(() => {
      getHook().setQuery("needle");
    });
    expect(getHook().status).toBe("searching");

    // Debounce (250 ms) + the windowed extraction loop.
    await waitFor(() => getHook().status === "idle");

    expect(getHook().results).toHaveLength(2);
    expect(getHook().results[0]!.area.pageIndex).toBe(4);
    expect(getHook().results[1]!.area.pageIndex).toBe(16);
    expect(getHook().activeIndex).toBe(0);
    // First match navigation fired exactly once, to the match's page.
    expect(setCurrentPage).toHaveBeenCalledWith(5);
    // Progress is cleared once the pass finishes.
    expect(getHook().progress).toBeNull();
    expect(getHook().resultLabel).toBe("1 of 2");
  });

  it("reports 0 of 0 after a full streamed pass with no matches", async () => {
    const setCurrentPage = vi.fn();
    const proxy = createFakeStreamedProxy(10, []);

    render(proxy, setCurrentPage);

    act(() => {
      getHook().setQuery("needle");
    });

    await waitFor(() => getHook().status === "idle");

    expect(getHook().results).toHaveLength(0);
    expect(getHook().resultLabel).toBe("0 of 0");
    expect(setCurrentPage).not.toHaveBeenCalled();
  });

  function render(proxy: PDFDocumentProxy, setCurrentPage: (page: number) => void) {
    act(() => {
      root!.render(
        <Harness
          proxy={proxy}
          setCurrentPage={setCurrentPage}
          onReady={(value) => { latest = value; }}
        />,
      );
    });
  }

  function getHook(): DocumentSearchState {
    if (!latest) {
      throw new Error("useDocumentSearch was not rendered.");
    }

    return latest;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
    const start = Date.now();

    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Timed out waiting for search to settle.");
      }

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }
});

function Harness({
  proxy,
  setCurrentPage,
  onReady,
}: {
  proxy: PDFDocumentProxy;
  setCurrentPage: (page: number) => void;
  onReady: (hook: DocumentSearchState) => void;
}) {
  // Stable reference, like App's state-derived pdfDocumentState — an inline
  // object would re-fire the search effect every render.
  const pdfDocumentState = useMemo(() => ({ bytes: null, proxy }), [proxy]);
  const hook = useDocumentSearch({
    // bytes: null selects the streamed, windowed branch.
    pdfDocumentState,
    documentGeneration: 1,
    textLayerCoverage: null,
    setCurrentPage,
  });

  useEffect(() => {
    onReady(hook);
  });

  return null;
}
