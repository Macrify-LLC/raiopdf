// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { getPack } from "@raiopdf/rules";
import type { FileAddResult } from "../lib/readFileForAdd";
import { BatchCleanupWorkspace } from "./BatchCleanupWorkspace";

const progress = { running: false, message: null, result: null };

describe("BatchCleanupWorkspace add flow (FileAddResult, no byte bridge)", () => {
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
    currentFileNotice: string | null = null,
  ) {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <BatchCleanupWorkspace
          currentFile={null}
          currentFileNotice={currentFileNotice}
          packs={[getPack()]}
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

  it("queues a bytes result by name and path", async () => {
    render(async () => ({
      kind: "bytes",
      file: { bytes: new Uint8Array([1]), name: "small.pdf", path: "grant-small" },
    }));

    await clickAddPdf();

    expect(container?.textContent).toContain("small.pdf");
  });

  it("queues an above-threshold descriptor by grant — no empty-bytes bridge", async () => {
    render(async () => ({
      kind: "descriptor",
      descriptor: { grant: "grant-big", name: "big.pdf", sizeBytes: 999_999_999, pageCount: null },
    }));

    await clickAddPdf();

    expect(container?.textContent).toContain("big.pdf");
  });

  it("shows the unsaved-changes notice instead of seeding a dirty current document", () => {
    // A dirty document's on-disk bytes are stale (pre-edit), so App passes
    // currentFile=null plus a notice — the omission must be visible, and
    // nothing may be queued that would clean the stale disk file.
    const notice = "The open document has unsaved changes, so it was not added. Save the current PDF first, then reopen this tool to include it.";
    render(async () => null, notice);

    expect(container?.textContent).toContain(notice);
    expect(container?.textContent).toContain("Add PDFs to build the cleanup queue.");
  });

  it("surfaces the honest gate for a browser tooLarge result and queues nothing", async () => {
    render(async () => ({ kind: "tooLarge", name: "nope.pdf", sizeBytes: 999_999_999 }));

    await clickAddPdf();

    expect(container?.textContent).toContain('"nope.pdf" is too large to add here.');
    expect(container?.textContent).toContain("Add PDFs to build the cleanup queue.");
  });
});
