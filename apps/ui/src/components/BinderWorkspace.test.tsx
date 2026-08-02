// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= class DOMMatrixStub {};
});

import { PDFDocument } from "pdf-lib";
import type { BinderExhibitInput, DocumentState } from "../hooks/useDocument";
import type { PdfBinderOptions } from "@raiopdf/engine-api";
import {
  listExhibitStampTemplates,
  resetExhibitStampCacheForTests,
} from "../lib/exhibitStamps";
import { BinderWorkspace } from "./BinderWorkspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue("Command pick_pdfs_for_add not found"),
}));

const documentState = {
  bytes: null,
  source: { kind: "memory", bytes: new Uint8Array([1, 2, 3]) },
  generation: 1,
  engineHandle: null,
  pageCount: 2,
  currentPage: 1,
  zoom: 1,
  dirty: false,
  fitWidth: false,
  fileName: "current.pdf",
  filePath: null,
  fileSizeBytes: 3,
  hasTextLayer: null,
  textLayerCoverage: null,
  pageSizeInches: null,
  outline: null,
  outlineStatus: null,
  signatureInvalidationNotice: null,
  protectionSource: null,
  protectionFacts: null,
  protectedSourceGrant: null,
  tempBackingGrant: null,
  error: null,
} satisfies DocumentState;

describe("BinderWorkspace", () => {
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

  it("keeps the DOM fallback add input PDF-only", () => {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <BinderWorkspace
          document={documentState}
          onBuildBinder={async () => true}
          onOpenRequested={() => undefined}
          onCancel={() => undefined}
        />,
      );
    });

    const input = window.document.querySelector<HTMLInputElement>(
      'input[aria-label="Add exhibits"]',
    );

    expect(input).not.toBeNull();
    expect(input?.accept).toBe("application/pdf,.pdf");
    expect(input?.accept).not.toContain("docx");
  });

  it("offers a stamp design for the exhibit labels without touching its counter", async () => {
    window.localStorage.clear();
    resetExhibitStampCacheForTests();

    const builds: Array<{
      exhibits: readonly BinderExhibitInput[];
      options: PdfBinderOptions;
    }> = [];
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <BinderWorkspace
          document={documentState}
          onBuildBinder={async (exhibits, options) => {
            builds.push({ exhibits, options });
            return true;
          }}
          onOpenRequested={() => undefined}
          onCancel={() => undefined}
        />,
      );
      await Promise.resolve();
    });

    // Plain text is the default, with every stored design offered beside it.
    expect(designChoiceLabels()).toEqual([
      "Label design: Text label",
      "Label design: Plaintiff's Exhibit",
      "Label design: Defendant's Exhibit",
      "Label design: Exhibit",
    ]);
    expect(designChoice("Text label").getAttribute("aria-pressed")).toBe("true");

    await addExhibit("motion.pdf");
    await click(designChoice("Plaintiff's Exhibit"));
    await click(buttonWithText("Build Binder"));

    const build = builds[0];
    expect(build?.options.stampDesign).toMatchObject({ widthPt: 115.2, heightPt: 72 });
    // The sticker's wording comes from the BINDER's own exhibit order (the
    // default prefix and letter style), not from the design's template.
    expect(build?.exhibits[0]?.label).toBe("Exhibit A");
    expect(build?.exhibits[0]?.labelLines).toEqual(["Exhibit", "A"]);
    // ...so the stamp gallery's running count is untouched by a binder build.
    resetExhibitStampCacheForTests();
    expect(listExhibitStampTemplates().map((template) => template.nextIndex)).toEqual([
      0,
      0,
      0,
    ]);
  });

  it("does not mute the stable Add exhibits action when experiments are off", () => {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<BinderWorkspace document={documentState} onBuildBinder={async () => true} onOpenRequested={() => undefined} onCancel={() => undefined} onCaptionRequested={() => undefined} experimentalFeaturesEnabled={false} />);
    });

    const addExhibits = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Add exhibits"));
    const caption = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Add caption / cover page"));
    expect(addExhibits?.className).not.toContain("experimental-locked");
    expect(caption?.className).toContain("experimental-locked");
    expect(caption?.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Enable it in Settings");
  });

  function designChoiceLabels(): (string | null)[] {
    return [...window.document.querySelectorAll(".binder-stamp-design")].map((button) =>
      button.getAttribute("aria-label"),
    );
  }

  function designChoice(name: string): HTMLButtonElement {
    const button = window.document.querySelector<HTMLButtonElement>(
      `[aria-label="Label design: ${name}"]`,
    );

    if (!button) {
      throw new Error(`expected a label-design choice for "${name}"`);
    }

    return button;
  }

  function buttonWithText(text: string): HTMLButtonElement {
    const button = [...window.document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(text),
    );

    if (!button) {
      throw new Error(`expected a button containing "${text}"`);
    }

    return button;
  }

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.click();
    });
    await settle();
  }

  async function addExhibit(name: string): Promise<void> {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const bytes = await pdf.save();
    const file = new File([bytes.slice().buffer as ArrayBuffer], name, {
      type: "application/pdf",
    });
    const input = window.document.querySelector<HTMLInputElement>(
      'input[aria-label="Add exhibits"]',
    );

    if (!input) {
      throw new Error("expected the add-exhibits input");
    }

    Object.defineProperty(input, "files", { value: [file], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  }

  /** Reading a picked file and building the binder each chain a few promises. */
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 8; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }
});
