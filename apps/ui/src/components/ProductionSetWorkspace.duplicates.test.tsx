// @vitest-environment jsdom
//
// Advisory add-time duplicate detection: the "duplicate" badge, the
// "N duplicate files" status line, the produce-all/produce-once radio, and
// the rule that a hashing failure only skips the badge -- it never blocks
// the add or the build. jsdom's `window.crypto` has no `subtle`
// (SubtleCrypto), unlike a real browser/Tauri webview, so this file patches
// in Node's WebCrypto before any component code runs.
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileAddResult } from "../lib/readFileForAdd";
import {
  ProductionSetWorkspace,
  type ProductionSetProgress,
  type ProductionSetRunInput,
} from "./ProductionSetWorkspace";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const idleProgress: ProductionSetProgress = { running: false, message: null, result: null };

describe("ProductionSetWorkspace duplicate detection", () => {
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

  function render(options: {
    onAddFile?: () => Promise<FileAddResult[] | null>;
    onHashGrant?: (grant: string) => Promise<string | null>;
    onRun?: (input: ProductionSetRunInput) => Promise<void>;
    currentFile?: { name: string; path: string | null } | null;
    currentPageCount?: number;
  } = {}) {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={options.currentFile ?? null}
          currentPageCount={options.currentPageCount ?? 0}
          progress={idleProgress}
          onAddFile={options.onAddFile ?? (async () => null)}
          onHashGrant={options.onHashGrant}
          onRun={options.onRun ?? (async () => undefined)}
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
    // Real (Node) `crypto.subtle.digest` resolves off the libuv threadpool,
    // not purely on the microtask queue -- a plain `await Promise.resolve()`
    // loop never yields to that phase, so wait on a real macrotask a few
    // times to flush the page-count/hash `Promise.all` and the
    // fire-and-forget descriptor-hash chain (add -> hash -> patch state).
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function badgeCount(): number {
    return window.document.querySelectorAll(".production-workspace__file-badge").length;
  }

  function prefixInput(): HTMLInputElement {
    return window.document.querySelector("input[placeholder='e.g. SMITH']") as HTMLInputElement;
  }

  function outputDirInput(): HTMLInputElement {
    return window.document.querySelector("input[placeholder='Choose an empty folder...']") as HTMLInputElement;
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = Array.from(window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(`Button not found containing: ${text}`);
    }
    return button;
  }

  function radioByLabel(text: string): HTMLInputElement {
    const label = Array.from(window.document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    const input = label?.querySelector('input[type="radio"]');
    if (!input) {
      throw new Error(`Radio not found for label: ${text}`);
    }
    return input as HTMLInputElement;
  }

  function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function makePdfBytes(seed: string): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    page.drawText(seed, { x: 5, y: 100, size: 10 });
    return pdf.save();
  }

  it("badges two byte-identical (bytes-kind) adds and shows the status line + radios", async () => {
    const bytes = await makePdfBytes("same-content");
    render({
      onAddFile: async () => [
        { kind: "bytes", file: { bytes, name: "a.pdf", path: null } },
        { kind: "bytes", file: { bytes: bytes.slice(), name: "b.pdf", path: null } },
      ],
    });

    await clickAddPdf();

    expect(badgeCount()).toBe(2);
    expect(container?.textContent).toContain("2 duplicate files in this production");
    expect(container?.textContent).toContain("Produce all (cross-referenced)");
    expect(container?.textContent).toContain("Produce once");
    // Default radio is "Produce all".
    expect(radioByLabel("Produce all (cross-referenced)").checked).toBe(true);
    expect(radioByLabel("Produce once").checked).toBe(false);
  });

  it("does not badge two bytes-kind adds with different content", async () => {
    const bytesA = await makePdfBytes("content-a");
    const bytesB = await makePdfBytes("content-b");
    render({
      onAddFile: async () => [
        { kind: "bytes", file: { bytes: bytesA, name: "a.pdf", path: null } },
        { kind: "bytes", file: { bytes: bytesB, name: "b.pdf", path: null } },
      ],
    });

    await clickAddPdf();

    // Both files actually landed (not a vacuous pass from a stuck add).
    expect(container?.textContent).toContain("a.pdf");
    expect(container?.textContent).toContain("b.pdf");
    expect(badgeCount()).toBe(0);
    expect(container?.textContent).not.toContain("duplicate files in this production");
  });

  it("badges two descriptor-kind adds using the mocked hash command", async () => {
    const onHashGrant = vi.fn(async (grant: string) => (grant === "g-a" || grant === "g-b" ? "same-hash" : null));
    render({
      onAddFile: async () => [
        { kind: "descriptor", descriptor: { grant: "g-a", name: "big-a.pdf", sizeBytes: 999_999_999, pageCount: 3 } },
        { kind: "descriptor", descriptor: { grant: "g-b", name: "big-b.pdf", sizeBytes: 999_999_999, pageCount: 3 } },
      ],
      onHashGrant,
    });

    await clickAddPdf();

    expect(onHashGrant).toHaveBeenCalledWith("g-a");
    expect(onHashGrant).toHaveBeenCalledWith("g-b");
    expect(badgeCount()).toBe(2);
    expect(container?.textContent).toContain("2 duplicate files in this production");
  });

  it("does not block the add when the hash command fails for a descriptor-kind source", async () => {
    const onHashGrant = vi.fn(async (): Promise<string | null> => {
      throw new Error("hash command unavailable");
    });
    render({
      onAddFile: async () => [
        { kind: "descriptor", descriptor: { grant: "g-a", name: "big-a.pdf", sizeBytes: 999_999_999, pageCount: 3 } },
      ],
      onHashGrant,
    });

    await clickAddPdf();

    // The file is still added and unbadged -- a hashing failure only skips
    // the badge, it never drops the file or blocks the add.
    expect(container?.textContent).toContain("big-a.pdf");
    expect(badgeCount()).toBe(0);
  });

  it("never badges anything when no onHashGrant is supplied (e.g. the browser build)", async () => {
    render({
      onAddFile: async () => [
        { kind: "descriptor", descriptor: { grant: "g-a", name: "big-a.pdf", sizeBytes: 999_999_999, pageCount: 3 } },
        { kind: "descriptor", descriptor: { grant: "g-b", name: "big-b.pdf", sizeBytes: 999_999_999, pageCount: 3 } },
      ],
    });

    await clickAddPdf();

    expect(container?.textContent).toContain("big-a.pdf");
    expect(container?.textContent).toContain("big-b.pdf");
    expect(badgeCount()).toBe(0);
  });

  it("threads the selected duplicateHandling into onRun, defaulting to produce-all", async () => {
    const bytes = await makePdfBytes("same-content");
    const onRun = vi.fn<(input: ProductionSetRunInput) => Promise<void>>(async () => undefined);
    render({
      onAddFile: async () => [
        { kind: "bytes", file: { bytes, name: "a.pdf", path: null } },
        { kind: "bytes", file: { bytes: bytes.slice(), name: "b.pdf", path: null } },
      ],
      onRun,
    });

    await clickAddPdf();
    typeInto(outputDirInput(), "/tmp/production-package");
    typeInto(prefixInput(), "DUP");

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({ duplicateHandling: "produce-all" });

    await act(async () => {
      radioByLabel("Produce once").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      buttonByText("Build Production").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[1]?.[0]).toMatchObject({ duplicateHandling: "produce-once" });
  });

  it("shows the duplicate-count note on a completed build's result card", async () => {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={null}
          currentPageCount={0}
          progress={{
            running: false,
            message: null,
            result: {
              packageRoot: "/tmp/out",
              indexLocation: null,
              nextNumber: 5,
              fileCount: 3,
              duplicateCount: 2,
              loadFileDat: null,
              withheldCount: 0,
              redactedCount: 0,
              privilegeLogLocation: null,
              slipSheetCount: 0,
            },
          }}
          onAddFile={async () => null}
          onRun={async () => undefined}
        />,
      );
    });

    expect(container?.textContent).toContain("2 duplicates detected");
  });

  it("shows no duplicate note when duplicateCount is 0", async () => {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProductionSetWorkspace
          currentFile={null}
          currentPageCount={0}
          progress={{
            running: false,
            message: null,
            result: {
              packageRoot: "/tmp/out",
              indexLocation: null,
              nextNumber: 5,
              fileCount: 3,
              duplicateCount: 0,
              loadFileDat: null,
              withheldCount: 0,
              redactedCount: 0,
              privilegeLogLocation: null,
              slipSheetCount: 0,
            },
          }}
          onAddFile={async () => null}
          onRun={async () => undefined}
        />,
      );
    });

    expect(container?.textContent).not.toContain("duplicate");
  });
});
