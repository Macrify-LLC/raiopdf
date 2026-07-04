// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { PAGE_GAP, PAGE_LIST_PADDING } from "../lib/pageLayout";
import { PageList } from "./PageList";
import { PageView } from "./PageView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Mock the pdf.js surface: the PageList/PageView pair only touches
 * TextLayer from ../lib/pdfjs, and the fake document below stands in for
 * PDFDocumentProxy/PDFPageProxy.
 */
const textLayerState = vi.hoisted(() => ({
  instances: [] as Array<{
    container: HTMLElement;
    cancelled: boolean;
    rendered: boolean;
  }>,
  cleanupCalls: 0,
}));

vi.mock("../lib/pdfjs", () => {
  class MockTextLayer {
    container: HTMLElement;
    cancelled = false;
    rendered = false;

    constructor({ container }: { container: HTMLElement }) {
      this.container = container;
      textLayerState.instances.push(this);
    }

    render() {
      this.rendered = true;
      const span = document.createElement("span");
      span.textContent = "mock text run";
      this.container.append(span);
      return Promise.resolve();
    }

    cancel() {
      this.cancelled = true;
    }

    static cleanup() {
      textLayerState.cleanupCalls += 1;
    }
  }

  return { TextLayer: MockTextLayer, OPS: {} };
});

interface RenderTaskRecord {
  cancelled: boolean;
}

const renderTasks: RenderTaskRecord[] = [];

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;
const PAGE_STRIDE = PAGE_HEIGHT + PAGE_GAP;

function createFakePdfDocument(pageCount: number): PDFDocumentProxy {
  const page = {
    getViewport({ scale }: { scale: number }) {
      return {
        width: PAGE_WIDTH * scale,
        height: PAGE_HEIGHT * scale,
        scale,
        rotation: 0,
      };
    },
    render() {
      const task: RenderTaskRecord = { cancelled: false };
      renderTasks.push(task);

      return {
        promise: Promise.resolve(),
        cancel() {
          task.cancelled = true;
        },
      };
    },
    streamTextContent() {
      return {};
    },
  };

  return {
    numPages: pageCount,
    async getPage() {
      return page;
    },
  } as unknown as PDFDocumentProxy;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("PageList virtualization", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    textLayerState.instances.length = 0;
    textLayerState.cleanupCalls = 0;
    renderTasks.length = 0;
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

  function scroller(): HTMLDivElement {
    const element = container?.querySelector('[data-testid="page-list"]');

    if (!(element instanceof HTMLDivElement)) {
      throw new Error("PageList scroller not found.");
    }

    return element;
  }

  function sizeScroller(height: number, width: number) {
    const element = scroller();
    Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  }

  async function renderList(
    pdfDocument: PDFDocumentProxy,
    props: Partial<Parameters<typeof PageList>[0]> = {},
  ) {
    await act(async () => {
      root!.render(
        <PageList pdfDocument={pdfDocument} currentPage={1} zoom={1} {...props} />,
      );
    });
    await flush();
    sizeScroller(900, 1000);
    await act(async () => {
      scroller().dispatchEvent(new Event("scroll"));
    });
    await flush();
  }

  it("lays out every page but only mounts visible pages plus the buffer", async () => {
    await renderList(createFakePdfDocument(40));

    // Every page gets a placeholder box...
    expect(container!.querySelectorAll(".page-list__page")).toHaveLength(40);

    // ...but only the visible two plus the two-page overscan get canvases.
    const canvases = container!.querySelectorAll('[data-testid="pdf-page-canvas"]');
    expect(canvases.length).toBe(4);

    const mounted = container!.querySelectorAll('.page-list__page[data-mounted="true"]');
    expect(mounted.length).toBe(4);
  });

  it("recycles canvases on scroll-out and reports the derived current page", async () => {
    const onVisiblePageChange = vi.fn();
    await renderList(createFakePdfDocument(40), { onVisiblePageChange });

    // Jump deep into the document: page 20's top.
    const targetTop = PAGE_LIST_PADDING + 19 * PAGE_STRIDE;
    scroller().scrollTop = targetTop;
    await act(async () => {
      scroller().dispatchEvent(new Event("scroll"));
    });
    await flush();

    // currentPage is DERIVED from the scroll position.
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(20);

    // The window moved: still a handful of canvases, and page 1 unmounted.
    const canvases = container!.querySelectorAll('[data-testid="pdf-page-canvas"]');
    expect(canvases.length).toBeLessThanOrEqual(7);
    const firstPage = container!.querySelector(".page-list__page");
    expect(firstPage?.querySelector("canvas")).toBeNull();
  });

  it("translates a scroll intent into a scroll position (navigation-as-intent)", async () => {
    const pdfDocument = createFakePdfDocument(12);
    await renderList(pdfDocument);

    await act(async () => {
      root!.render(
        <PageList
          pdfDocument={pdfDocument}
          currentPage={5}
          zoom={1}
          scrollIntent={{ page: 5, nonce: 7 }}
        />,
      );
    });
    await flush();

    const expectedTop = PAGE_LIST_PADDING + 4 * PAGE_STRIDE - PAGE_GAP / 2;
    expect(scroller().scrollTop).toBe(expectedTop);
  });

  it("runs the static TextLayer cleanup when the document goes away", async () => {
    await renderList(createFakePdfDocument(3));

    act(() => {
      root!.unmount();
    });
    root = null;

    expect(textLayerState.cleanupCalls).toBeGreaterThan(0);
  });
});

describe("PageList lazy measurement (streamed mode)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    textLayerState.instances.length = 0;
    renderTasks.length = 0;
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

  function createCountingFakePdfDocument(
    pageCount: number,
    heightFor: (pageNumber: number) => number,
  ): { pdfDocument: PDFDocumentProxy; getPageNumbers: number[] } {
    const getPageNumbers: number[] = [];
    const pdfDocument = {
      numPages: pageCount,
      async getPage(pageNumber: number) {
        getPageNumbers.push(pageNumber);
        return {
          rotate: 0,
          getViewport({ scale }: { scale: number }) {
            return {
              width: PAGE_WIDTH * scale,
              height: heightFor(pageNumber) * scale,
              scale,
              rotation: 0,
            };
          },
          render() {
            return { promise: Promise.resolve(), cancel() {} };
          },
          streamTextContent() {
            return {};
          },
        };
      },
    } as unknown as PDFDocumentProxy;

    return { pdfDocument, getPageNumbers };
  }

  async function renderLazyList(pdfDocument: PDFDocumentProxy) {
    await act(async () => {
      root!.render(
        <PageList pdfDocument={pdfDocument} currentPage={1} zoom={1} lazyPageMeasurement />,
      );
    });
    await flush();
    const element = container!.querySelector('[data-testid="page-list"]') as HTMLDivElement;
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 900 });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 1000 });
    await act(async () => {
      element.dispatchEvent(new Event("scroll"));
    });
    await flush();
  }

  it("never runs the full getPage sweep — only the estimate page and mounted views load", async () => {
    const { pdfDocument, getPageNumbers } = createCountingFakePdfDocument(40, () => PAGE_HEIGHT);

    await renderLazyList(pdfDocument);

    // Every page still gets a placeholder laid out from the estimate...
    expect(container!.querySelectorAll(".page-list__page")).toHaveLength(40);

    // ...but getPage ran only for the first-page estimate plus the mounted
    // window — nowhere near all 40 pages the eager sweep would touch [R2-1].
    expect(getPageNumbers.length).toBeLessThanOrEqual(8);
    expect(Math.max(...getPageNumbers)).toBeLessThanOrEqual(8);
  });

  it("refines a mounted page's dims from its rendered viewport", async () => {
    // Page 1 is the estimate (800pt tall); every other page is really 400pt.
    const { pdfDocument } = createCountingFakePdfDocument(10, (pageNumber) => (
      pageNumber === 1 ? PAGE_HEIGHT : 400
    ));

    await renderLazyList(pdfDocument);

    const pages = container!.querySelectorAll<HTMLDivElement>(".page-list__page");
    // Page 2 mounted, rendered, and reported its real height back into the
    // size cache; unvisited deep pages still carry the estimate.
    expect(pages[1]!.style.height).toBe("400px");
    expect(pages[9]!.style.height).toBe(`${PAGE_HEIGHT}px`);
  });
});

describe("PageView text layer lifecycle", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    textLayerState.instances.length = 0;
    renderTasks.length = 0;
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

  it("cancels the text layer and clears its DOM on unmount", async () => {
    await act(async () => {
      root!.render(
        <PageView
          pdfDocument={createFakePdfDocument(1)}
          pageIndex={0}
          zoom={1}
          textSelectable={false}
        />,
      );
    });
    await flush();

    expect(textLayerState.instances).toHaveLength(1);
    const instance = textLayerState.instances[0]!;
    expect(instance.rendered).toBe(true);
    expect(instance.container.childElementCount).toBeGreaterThan(0);

    const canvas = container!.querySelector('[data-testid="pdf-page-canvas"]');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);

    await act(async () => {
      root!.unmount();
    });
    root = null;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Guardrail: cancel() + container DOM cleared on unmount...
    expect(instance.cancelled).toBe(true);
    expect(instance.container.childElementCount).toBe(0);
    // ...and the canvas backing store is released (dimensions reset).
    expect((canvas as HTMLCanvasElement).width).toBe(0);
    expect((canvas as HTMLCanvasElement).height).toBe(0);
  });

  it("cancels an in-flight render task before re-rendering at a new zoom", async () => {
    const pdfDocument = createFakePdfDocument(1);

    await act(async () => {
      root!.render(
        <PageView pdfDocument={pdfDocument} pageIndex={0} zoom={1} textSelectable={false} />,
      );
    });
    await flush();
    expect(renderTasks).toHaveLength(1);

    await act(async () => {
      root!.render(
        <PageView pdfDocument={pdfDocument} pageIndex={0} zoom={2} textSelectable={false} />,
      );
    });
    await flush();

    // Zoom change cancels the previous task and starts exactly one more.
    expect(renderTasks).toHaveLength(2);
    expect(renderTasks[0]!.cancelled).toBe(true);
    const canvas = container!.querySelector('[data-testid="pdf-page-canvas"]');
    expect((canvas as HTMLCanvasElement).width).toBe(1200);
  });
});
