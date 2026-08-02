// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PDFDocument } from "pdf-lib";
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
    onAddFile: () => Promise<FileAddResult[] | null>,
    currentFile: { name: string; path: string | null } | null = null,
    currentPageCount = 0,
    currentFileNotice: string | null = null,
  ) {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={currentFile}
          currentFileNotice={currentFileNotice}
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
      // Flush the internal `Promise.all` page-count loop (and any subsequent
      // microtasks it schedules) before the assertions below inspect the DOM.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function fileNames(): string[] {
    return Array.from(
      window.document.querySelectorAll(".production-workspace__file-name"),
    ).map((element) => element.textContent ?? "");
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

  it("shows the unsaved-changes notice instead of seeding a dirty current document", () => {
    // A dirty document's on-disk bytes are stale (pre-edit), so App passes
    // currentFile=null plus a notice — the omission must be visible, and
    // nothing may be seeded that would Bates-stamp the stale disk file.
    const notice = "The open document has unsaved changes, so it was not added. Save the current PDF first, then reopen this tool to include it.";
    render(async () => null, null, 0, notice);

    expect(container?.textContent).toContain(notice);
    expect(container?.textContent).toContain("Add PDFs to build the production order.");
  });

  it("adds a descriptor without bytes, deferring the page count when uncounted", async () => {
    render(async () => [{
      kind: "descriptor",
      descriptor: { grant: "grant-big", name: "big.pdf", sizeBytes: 999_999_999, pageCount: null },
    }]);

    await clickAddPdf();

    expect(container?.textContent).toContain("big.pdf");
    expect(container?.textContent).toContain("page count pending");
    expect(container?.textContent).toContain(
      "Added a large PDF; its page count will be determined during the production build.",
    );
  });

  it("shows the descriptor page count when page_count(grant) supplied one", async () => {
    render(async () => [{
      kind: "descriptor",
      descriptor: { grant: "grant-big", name: "counted.pdf", sizeBytes: 999_999_999, pageCount: 41 },
    }]);

    await clickAddPdf();

    expect(container?.textContent).toContain("counted.pdf");
    expect(container?.textContent).toContain("41 pages");
    expect(container?.textContent).not.toContain("page count pending");
  });

  it("surfaces the honest gate for a tooLarge result and adds nothing", async () => {
    render(async () => [{ kind: "tooLarge", name: "nope.pdf", sizeBytes: 999_999_999 }]);

    await clickAddPdf();

    expect(container?.textContent).toContain("nope.pdf");
    expect(container?.textContent).toContain("too large to add here");
    expect(container?.textContent).toContain("Add PDFs to build the production order.");
  });

  it("adds every picked file in picker order, mixing bytes and descriptor kinds", async () => {
    render(async () => [
      { kind: "descriptor", descriptor: { grant: "g-1", name: "a-first.pdf", sizeBytes: 999_999_999, pageCount: 3 } },
      { kind: "bytes", file: { bytes: new Uint8Array([1]), name: "b-second.pdf", path: "grant-2" } },
      { kind: "descriptor", descriptor: { grant: "g-3", name: "c-third.pdf", sizeBytes: 999_999_999, pageCount: 7 } },
    ]);

    await clickAddPdf();

    // The middle pick's page count comes from a pdf-lib parse of one byte,
    // which fails -- it is reported as an uncounted failure rather than
    // silently reordering or dropping the entries around it.
    expect(fileNames()).toEqual(["a-first.pdf", "c-third.pdf"]);
    expect(container?.textContent).toContain("b-second.pdf");
    expect(container?.textContent).toContain("its pages could not be counted");
  });

  it("adds multiple valid bytes-kind files together, preserving picker order", async () => {
    const onePage = await PDFDocument.create();
    onePage.addPage();
    const onePageBytes = await onePage.save();

    const twoPage = await PDFDocument.create();
    twoPage.addPage();
    twoPage.addPage();
    const twoPageBytes = await twoPage.save();

    render(async () => [
      { kind: "bytes", file: { bytes: onePageBytes, name: "one.pdf", path: null } },
      { kind: "bytes", file: { bytes: twoPageBytes, name: "two.pdf", path: null } },
    ]);

    await clickAddPdf();

    expect(fileNames()).toEqual(["one.pdf", "two.pdf"]);
    expect(container?.textContent).toContain("1 page");
    expect(container?.textContent).toContain("2 pages");
  });

  it("reports a partial failure without dropping the files that succeeded", async () => {
    render(async () => [
      { kind: "descriptor", descriptor: { grant: "g-ok", name: "ok.pdf", sizeBytes: 999_999_999, pageCount: 5 } },
      { kind: "tooLarge", name: "huge.pdf", sizeBytes: 999_999_999 },
      { kind: "error", name: "broken.pdf", message: "The PDF range could not be read." },
    ]);

    await clickAddPdf();

    expect(fileNames()).toEqual(["ok.pdf"]);
    expect(container?.textContent).toContain("1 of 3 added");
    expect(container?.textContent).toContain("huge.pdf (too large to add here)");
    expect(container?.textContent).toContain("broken.pdf (The PDF range could not be read.)");
  });
});
