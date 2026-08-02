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
    onAddFile: () => Promise<FileAddResult[] | null>,
    currentFileNotice: string | null = null,
    onAddFolder?: () => Promise<FileAddResult[] | null>,
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
          onAddFolder={onAddFolder}
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
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function clickAdd(label: string) {
    const button = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function fileNames(): string[] {
    return Array.from(
      window.document.querySelectorAll(".batch-workspace__file-name"),
    ).map((element) => element.textContent ?? "");
  }

  it("queues a bytes result by name and path", async () => {
    render(async () => [{
      kind: "bytes",
      file: { bytes: new Uint8Array([1]), name: "small.pdf", path: "grant-small" },
    }]);

    await clickAddPdf();

    expect(container?.textContent).toContain("small.pdf");
  });

  it("queues an above-threshold descriptor by grant — no empty-bytes bridge", async () => {
    render(async () => [{
      kind: "descriptor",
      descriptor: { grant: "grant-big", name: "big.pdf", sizeBytes: 999_999_999, pageCount: null },
    }]);

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
    render(async () => [{ kind: "tooLarge", name: "nope.pdf", sizeBytes: 999_999_999 }]);

    await clickAddPdf();

    expect(container?.textContent).toContain("nope.pdf");
    expect(container?.textContent).toContain("too large to add here");
    expect(container?.textContent).toContain("Add PDFs to build the cleanup queue.");
  });

  it("queues every picked file in picker order", async () => {
    render(async () => [
      { kind: "bytes", file: { bytes: new Uint8Array([1]), name: "a-first.pdf", path: "grant-1" } },
      { kind: "descriptor", descriptor: { grant: "grant-2", name: "b-second.pdf", sizeBytes: 999_999_999, pageCount: null } },
      { kind: "bytes", file: { bytes: new Uint8Array([2]), name: "c-third.pdf", path: "grant-3" } },
    ]);

    await clickAddPdf();

    expect(fileNames()).toEqual(["a-first.pdf", "b-second.pdf", "c-third.pdf"]);
  });

  it("reports a partial failure without dropping the files that succeeded", async () => {
    render(async () => [
      { kind: "bytes", file: { bytes: new Uint8Array([1]), name: "ok.pdf", path: "grant-ok" } },
      { kind: "tooLarge", name: "huge.pdf", sizeBytes: 999_999_999 },
      { kind: "error", name: "broken.pdf", message: "The PDF range could not be read." },
    ]);

    await clickAddPdf();

    expect(fileNames()).toEqual(["ok.pdf"]);
    expect(container?.textContent).toContain("1 of 3 added");
    expect(container?.textContent).toContain("huge.pdf (too large to add here)");
    expect(container?.textContent).toContain("broken.pdf (The PDF range could not be read.)");
  });
  it("hides Add Folder when the runtime has no folder picker", () => {
    render(async () => null);

    expect(container?.textContent).toContain("Add PDF");
    expect(container?.textContent).not.toContain("Add Folder");
  });

  it("queues a folder add through the same path as a file add", async () => {
    render(
      async () => null,
      null,
      async () => [
        { kind: "bytes", file: { bytes: new Uint8Array([1]), name: "folder-a.pdf", path: "grant-a" } },
        { kind: "descriptor", descriptor: { grant: "grant-b", name: "folder-b.pdf", sizeBytes: 999_999_999, pageCount: null } },
        { kind: "error", name: "folder-c.pdf", message: "The PDF could not be read." },
      ],
    );

    await clickAdd("Add Folder");

    expect(fileNames()).toEqual(["folder-a.pdf", "folder-b.pdf"]);
    expect(container?.textContent).toContain("2 of 3 added");
  });
});
