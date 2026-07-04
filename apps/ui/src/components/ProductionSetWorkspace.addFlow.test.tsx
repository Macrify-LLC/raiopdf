// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FileAddResult } from "../lib/readFileForAdd";
import { ProductionSetWorkspace } from "./ProductionSetWorkspace";

const progress = { running: false, message: null, result: null };

describe("ProductionSetWorkspace add flow", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

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

  function render(
    onAddFile: () => Promise<FileAddResult | null>,
    currentFile: { name: string; path: string | null } | null = null,
    currentPageCount = 0,
  ) {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={currentFile}
          currentPageCount={currentPageCount}
          progress={progress}
          onAddFile={onAddFile}
          onRun={async () => undefined}
        />,
      );
    });
  }

  async function clickAddPdf() {
    const button = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Add PDF"),
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("seeds the production order from a bytes-free current document (streamed doc)", () => {
    // Post-#127 shape: `currentFile` is `{ name, path }` — no bytes — so a
    // streamed large document auto-seeds; the build is path-based downstream.
    render(
      async () => null,
      { name: "streamed.pdf", path: "grant-streamed" },
      340,
    );

    expect(container?.textContent).toContain("streamed.pdf");
    expect(container?.textContent).toContain("340 pages");
    expect(container?.textContent).not.toContain("Add PDFs to build the production order.");
  });

  it("adds a descriptor without bytes, deferring the page count when uncounted", async () => {
    render(async () => ({
      kind: "descriptor",
      descriptor: { grant: "grant-big", name: "big.pdf", sizeBytes: 999_999_999, pageCount: null },
    }));

    await clickAddPdf();

    expect(container?.textContent).toContain("big.pdf");
    expect(container?.textContent).toContain("page count pending");
    expect(container?.textContent).toContain(
      "Added a large PDF; its page count will be determined during the production build.",
    );
  });

  it("shows the descriptor page count when page_count(grant) supplied one", async () => {
    render(async () => ({
      kind: "descriptor",
      descriptor: { grant: "grant-big", name: "counted.pdf", sizeBytes: 999_999_999, pageCount: 41 },
    }));

    await clickAddPdf();

    expect(container?.textContent).toContain("counted.pdf");
    expect(container?.textContent).toContain("41 pages");
    expect(container?.textContent).not.toContain("page count pending");
  });

  it("surfaces the honest gate for a tooLarge result and adds nothing", async () => {
    render(async () => ({ kind: "tooLarge", name: "nope.pdf", sizeBytes: 999_999_999 }));

    await clickAddPdf();

    expect(container?.textContent).toContain('"nope.pdf" is too large to add here.');
    expect(container?.textContent).toContain("Add PDFs to build the production order.");
  });
});
