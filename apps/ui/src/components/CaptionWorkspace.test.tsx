// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfEngineError } from "@raiopdf/engine-api";
import type { DocumentFileInput, DocumentState } from "../hooks/useDocument";

const captionMocks = vi.hoisted(() => ({
  generateCaptionPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  saveCaptionPdf: vi.fn(async () => ({ name: "caption.pdf", path: "caption-grant" })),
}));

vi.mock("../lib/captionPreview", () => ({
  generateCaptionPdf: captionMocks.generateCaptionPdf,
}));

vi.mock("../lib/captionActions", () => ({
  saveCaptionPdf: captionMocks.saveCaptionPdf,
}));

vi.mock("./PdfMiniThumb", () => ({
  PdfMiniThumb: ({ label }: { label: string }) => <div data-testid="pdf-mini-thumb">{label}</div>,
}));

import { CaptionWorkspace } from "./CaptionWorkspace";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("CaptionWorkspace", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    captionMocks.generateCaptionPdf.mockClear();
    captionMocks.saveCaptionPdf.mockClear();
    window.localStorage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
  });

  it("saves a valid caption through the standalone save action", async () => {
    renderWorkspace();
    await fillValidCaption();

    await click(buttonByText("Save as PDF"));

    expect(captionMocks.saveCaptionPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        styleId: "classic-boxed",
        caption: expect.objectContaining({
          courtName: "Circuit Court",
          documentTitle: "Notice of Filing",
        }),
      }),
      "Notice of Filing Caption.pdf",
    );
    expect(host?.textContent).toContain("Saved caption.pdf.");
  });

  it("prepends generated caption bytes to the open in-memory document", async () => {
    const onPrependCaption = vi.fn(async () => true);
    renderWorkspace({ onPrependCaption });
    await fillValidCaption();

    await click(buttonByText("Prepend to current PDF"));

    expect(onPrependCaption).toHaveBeenCalledWith(
      { bytes: new Uint8Array([37, 80, 68, 70]), name: "Notice of Filing Caption.pdf", path: null },
      0,
    );
  });

  it("surfaces the typed overflow message when the caption cannot fit on one page", async () => {
    renderWorkspace();
    await fillValidCaption();

    const overflow = new PdfEngineError(
      "CONTENT_OVERFLOW",
      "The caption content does not fit on one page (needs about 900pt of the 648pt available). Remove parties, shorten names, or trim the signature block.",
    );
    captionMocks.saveCaptionPdf.mockRejectedValueOnce(overflow);

    await click(buttonByText("Save as PDF"));

    expect(host?.textContent).toContain("does not fit on one page");
    expect(host?.textContent).not.toContain("The caption PDF could not be saved.");
  });

  function renderWorkspace(overrides: {
    document?: DocumentState;
    onPrependCaption?: (file: DocumentFileInput, index: number) => Promise<boolean>;
  } = {}) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <CaptionWorkspace
          document={overrides.document ?? memoryDocument()}
          onPrependCaption={overrides.onPrependCaption ?? vi.fn(async () => true)}
          onCancel={() => undefined}
        />,
      );
    });
  }

  async function fillValidCaption() {
    await change(inputByLabel("Court name"), "Circuit Court");
    await change(inputByLabel("Document title"), "Notice of Filing");
    await change(inputByLabel("Name 1"), "Jane Smith");
  }

  function inputByLabel(text: string): HTMLInputElement {
    const labels = [...host!.querySelectorAll("label")];
    const label = labels.find((candidate) => candidate.textContent?.includes(text));
    const input = label?.querySelector("input");

    if (!input) {
      throw new Error(`Input not found: ${text}`);
    }

    return input;
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = [...host!.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes(text));

    if (!button) {
      throw new Error(`Button not found: ${text}`);
    }

    return button;
  }

  async function change(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function memoryDocument(): DocumentState {
  const bytes = new Uint8Array([37, 80, 68, 70]);

  return {
    bytes,
    source: { kind: "memory", bytes },
    generation: 1,
    engineHandle: null,
    pageCount: 2,
    currentPage: 1,
    zoom: 1,
    dirty: false,
    fitWidth: false,
    fileName: "motion.pdf",
    filePath: null,
    fileSizeBytes: bytes.byteLength,
    hasTextLayer: true,
    textLayerCoverage: null,
    pageSizeInches: null,
    outline: null,
    outlineStatus: null,
    signatureInvalidationNotice: null,
    error: null,
  };
}
