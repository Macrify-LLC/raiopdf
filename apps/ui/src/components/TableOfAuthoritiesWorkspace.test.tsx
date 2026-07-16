// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentFileInput, DocumentState } from "../hooks/useDocument";

const rulesMocks = vi.hoisted(() => ({
  detectAuthorities: vi.fn(() => [
    {
      id: "authority-a",
      kind: "case",
      canonical: "123 So. 3d 456",
      hits: [{ pageIndex: 0 }, { pageIndex: 2 }],
    },
    {
      id: "authority-b",
      kind: "case",
      canonical: "Smith v. Jones",
      hits: [{ pageIndex: 1 }],
    },
    {
      id: "authority-c",
      kind: "statute",
      canonical: "Fla. Stat. § 95.11",
      hits: [{ pageIndex: 3 }],
    },
  ]),
}));

const toaMocks = vi.hoisted(() => ({
  generateToaPdf: vi.fn(async (..._args: unknown[]) => new Uint8Array([37, 80, 68, 70])),
  saveToaPdf: vi.fn(async () => ({ name: "toa.pdf", path: "toa-grant" })),
}));

vi.mock("@raiopdf/rules", () => ({
  detectAuthorities: rulesMocks.detectAuthorities,
  reporterTable: {},
}));

vi.mock("../lib/toaPreview", () => ({
  generateToaPdf: toaMocks.generateToaPdf,
}));

vi.mock("../lib/toaActions", async () => {
  const actual = await vi.importActual<typeof import("../lib/toaActions")>("../lib/toaActions");
  return {
    ...actual,
    saveToaPdf: toaMocks.saveToaPdf,
  };
});

vi.mock("./PdfMiniThumb", () => ({
  PdfMiniThumb: ({ label }: { label: string }) => <div data-testid="pdf-mini-thumb">{label}</div>,
}));

import { TableOfAuthoritiesWorkspace } from "./TableOfAuthoritiesWorkspace";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("TableOfAuthoritiesWorkspace", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    rulesMocks.detectAuthorities.mockClear();
    toaMocks.generateToaPdf.mockClear();
    toaMocks.saveToaPdf.mockClear();
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

  it("renders detected authorities and supports exclude, edit, merge, add, and save", async () => {
    const extractPageTextByPage = vi.fn(async () => [
      { pageIndex: 0, text: "123 So. 3d 456" },
      { pageIndex: 1, text: "Smith v. Jones" },
    ]);
    renderWorkspace({ extractPageTextByPage });
    await waitForText("Fla. Stat. § 95.11");

    expect(extractPageTextByPage).toHaveBeenCalledTimes(1);
    expect(host?.textContent).toContain("123 So. 3d 456");
    expect(host?.textContent).toContain("Fla. Stat. § 95.11");

    await click(rowFor("123 So. 3d 456").querySelector<HTMLInputElement>("input[type='checkbox']")!);
    expect(rowFor("123 So. 3d 456").getAttribute("data-excluded")).toBe("true");

    await change(rowCitationInput("Smith v. Jones"), "Smith v. Jones, Inc.");
    expect(host?.textContent).toContain("Smith v. Jones, Inc.");

    await change(rowFor("123 So. 3d 456").querySelector<HTMLSelectElement>("select")!, "authority-b");
    await click(rowButton("123 So. 3d 456", "Merge"));
    expect(host?.textContent).not.toContain("123 So. 3d 456");
    expect(rowFor("Smith v. Jones, Inc.").textContent).toContain("Pages 1, 2, 3");

    const addSection = host!.querySelector<HTMLElement>("[aria-label='Add missed authority']")!;
    await change(addSection.querySelector<HTMLInputElement>("input[placeholder='123 So. 3d 456']")!, "Fla. R. Civ. P. 1.510");
    await change(addSection.querySelector<HTMLInputElement>("input[placeholder='1, 4-6']")!, "2, 4");
    await click(buttonByText("Add authority"));
    expect(host?.textContent).toContain("Fla. R. Civ. P. 1.510");

    await click(buttonByText("Save as PDF"));
    expect(toaMocks.saveToaPdf).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          citation: "Smith v. Jones, Inc.",
          pageIndexes: [0, 1, 2],
        }),
        expect.objectContaining({
          citation: "Fla. R. Civ. P. 1.510",
          pageIndexes: [1, 3],
        }),
      ]),
      5,
      "motion Table of Authorities.pdf",
    );
    expect(host?.textContent).toContain("Saved toa.pdf.");
  });

  it("renders prepend output with physical page numbers and preview with source page numbers", async () => {
    const extractPageTextByPage = vi.fn(async () => [
      { pageIndex: 0, text: "123 So. 3d 456" },
    ]);
    const onPrependTable = vi.fn(async () => true);
    renderWorkspace({ extractPageTextByPage, onPrependTable });
    await waitForText("Fla. Stat. § 95.11");

    // The debounced preview render is the standalone flow: source numbering
    // (the default mode — no "physical" argument).
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(toaMocks.generateToaPdf).toHaveBeenCalled();
    expect(toaMocks.generateToaPdf.mock.calls.every((call) => call[1] === undefined)).toBe(true);

    toaMocks.generateToaPdf.mockClear();
    await click(buttonByText("Prepend to current PDF"));

    // Prepending makes the table page 1, so the rendered references must
    // shift to physical positions.
    expect(toaMocks.generateToaPdf).toHaveBeenCalledTimes(1);
    expect(toaMocks.generateToaPdf.mock.calls[0]?.[1]).toBe("physical");
    expect(onPrependTable).toHaveBeenCalledTimes(1);
  });

  it("shows the persistent full-citations-only hint in the review card", async () => {
    const extractPageTextByPage = vi.fn(async () => [
      { pageIndex: 0, text: "123 So. 3d 456" },
    ]);
    renderWorkspace({ extractPageTextByPage });
    await waitForText("Fla. Stat. § 95.11");

    // Honest disclosure: detection covers full citations only, so the page
    // lists are incomplete wherever the brief uses short forms.
    expect(host?.textContent).toContain("Page lists count full citations only");
    expect(host?.textContent).toContain("id., supra");
    expect(host?.textContent).toContain("410 U.S. at 116");
  });

  it("routes garbled hidden text to force OCR instead of detecting authorities", async () => {
    const extractPageTextByPage = vi.fn(async () => []);
    const onForceOcr = vi.fn();
    renderWorkspace({
      document: memoryDocument({
        textLayerCoverage: {
          mixedPages: [],
          textPages: [0, 1],
          imageOnlyPages: [],
          garbledPages: [{
            pageIndex: 0,
            confidence: 0.92,
            reason: "low_alpha_entropy",
            puaRatio: 0,
            replacementRatio: 0,
            alphaRatio: 0.12,
          }],
          trivialTextImagePages: [],
        },
      }),
      extractPageTextByPage,
      onForceOcr,
    });

    expect(host?.textContent).toContain("Hidden text looks garbled");
    expect(extractPageTextByPage).not.toHaveBeenCalled();

    await click(buttonByText("Redo searchable text"));
    expect(onForceOcr).toHaveBeenCalledTimes(1);
  });

  function renderWorkspace(overrides: {
    document?: DocumentState;
    extractPageTextByPage?: (bytes: Uint8Array) => Promise<readonly { pageIndex: number; text: string }[]>;
    onPrependTable?: (file: DocumentFileInput, index: number) => Promise<boolean>;
    onForceOcr?: () => void;
  } = {}) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <TableOfAuthoritiesWorkspace
          document={overrides.document ?? memoryDocument()}
          extractPageTextByPage={overrides.extractPageTextByPage ?? vi.fn(async () => [])}
          onPrependTable={overrides.onPrependTable ?? vi.fn(async () => true)}
          onForceOcr={overrides.onForceOcr ?? vi.fn()}
          onCancel={() => undefined}
        />,
      );
    });
  }

  function rowFor(text: string): HTMLElement {
    const rows = [...host!.querySelectorAll<HTMLElement>(".toa-row")];
    const row = rows.find((candidate) =>
      candidate.querySelector<HTMLInputElement>(".toa-field--citation input")?.value.includes(text)
    ) ?? rows.find((candidate) => candidate.textContent?.includes(text));

    if (!row) {
      throw new Error(`Row not found: ${text}`);
    }

    return row;
  }

  function rowCitationInput(text: string): HTMLInputElement {
    const input = rowFor(text).querySelector<HTMLInputElement>(".toa-field--citation input");

    if (!input) {
      throw new Error(`Citation input not found: ${text}`);
    }

    return input;
  }

  function rowButton(rowText: string, buttonText: string): HTMLButtonElement {
    const button = [...rowFor(rowText).querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.includes(buttonText));

    if (!button) {
      throw new Error(`Button not found: ${buttonText}`);
    }

    return button;
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = [...host!.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes(text));

    if (!button) {
      throw new Error(`Button not found: ${text}`);
    }

    return button;
  }

  async function waitForText(text: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      if (host?.textContent?.includes(text) || hasInputValue(text)) {
        return;
      }
    }

    throw new Error(`Text not rendered: ${text}`);
  }

  function hasInputValue(text: string): boolean {
    return [...host!.querySelectorAll<HTMLInputElement>("input")]
      .some((input) => input.value.includes(text));
  }

  async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
    await act(async () => {
      const prototype = input instanceof HTMLInputElement
        ? window.HTMLInputElement.prototype
        : window.HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function memoryDocument(overrides: Partial<DocumentState> = {}): DocumentState {
  const bytes = new Uint8Array([37, 80, 68, 70]);

  return {
    bytes,
    source: { kind: "memory", bytes },
    generation: 1,
    engineHandle: null,
    pageCount: 4,
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
    protectionSource: null,
    protectionFacts: null,
    protectedSourceGrant: null,
    error: null,
    ...overrides,
  };
}
