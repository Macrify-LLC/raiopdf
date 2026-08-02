// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocateIdentifier,
  listExhibitStampTemplates,
  resetExhibitStampCacheForTests,
  saveExhibitStampTemplate,
  type ExhibitStampTemplateV1,
} from "../lib/exhibitStamps";
import { resetDialogStackForTests } from "./FloatingDialog";
import { ExhibitStampDesigner, type ExhibitStampDesignerProps } from "./ExhibitStampDesigner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)?.set;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeInputValueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("ExhibitStampDesigner", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    resetExhibitStampCacheForTests();
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
    resetDialogStackForTests();
    vi.restoreAllMocks();
  });

  it("titles the dialog for create", async () => {
    await render({ mode: "create", template: null });
    expect(container?.querySelector("h2")?.textContent).toBe("New exhibit stamp");
  });

  it("titles the dialog for edit", async () => {
    await render({
      mode: "edit",
      template: starterTemplate({ name: "Joint Exhibit" }),
    });
    expect(container?.querySelector("h2")?.textContent).toBe("Edit exhibit stamp");
  });

  it("pre-fills every field from the template being edited", async () => {
    await render({
      mode: "edit",
      template: starterTemplate({ name: "Joint Exhibit", prefix: "Jt. Ex." }),
    });

    expect(input('input[aria-label="Stamp name"]').value).toBe("Joint Exhibit");
    expect(input('input[aria-label="Stamp wording"]').value).toBe("Jt. Ex.");
    // Editing a design must never present the live counter as an editable
    // field -- there is no "next exhibit" input anywhere in the designer.
    expect(container?.querySelector('input[aria-label*="Next exhibit"]')).toBeNull();
  });

  it("switches the preview between stacked and inline layout", async () => {
    // "Plaintiff's Exhibit" + numbering "1" stacks onto two lines by default.
    await render({ mode: "create", template: null });
    await type(input('input[aria-label="Stamp name"]'), "Plaintiff's Exhibit");
    expect(previewLineCount()).toBe(2);

    await click(button("Inline layout"));
    expect(previewLineCount()).toBe(1);

    await click(button("Stacked layout"));
    expect(previewLineCount()).toBe(2);
  });

  it("removes the border when Border: none is picked", async () => {
    await render({ mode: "create", template: null });

    expect(previewStyle().borderStyle).toBe("solid");

    await click(swatch("Border: none"));

    expect(previewStyle().borderStyle).toBe("none");
  });

  it("makes the fill transparent when Background: none is picked", async () => {
    await render({ mode: "create", template: null });

    expect(previewStyle().background).not.toBe("transparent");

    await click(swatch("Background: none"));

    expect(previewStyle().background).toBe("transparent");
  });

  it("clamps corner rounding to half the smaller dimension, mirroring the engine", async () => {
    await render({ mode: "create", template: null });

    // Compact preset: 86.4pt x 54pt, default 1pt border -> the engine would
    // clamp any radius above (min(86.4-1, 54-1)) / 2 = 26.5.
    await click(button("Compact size"));

    const radiusInput = input('input[aria-label="Corner rounding in points"]');
    await type(radiusInput, "999");

    expect(Number(input('input[aria-label="Corner rounding in points"]').value)).toBeCloseTo(26.5, 5);
  });

  it("applies size presets and clamps free-size inputs to 0.5-4 inches", async () => {
    await render({ mode: "create", template: null });

    await click(button("Wide size"));
    expect(previewBoxSizePx()).toEqual({ width: 288, height: 144 }); // 2in x 1in @ 2px/pt

    await type(input('input[aria-label="Sticker width in inches"]'), "10");
    expect(previewBoxSizePx().width).toBe(576); // clamped to 4in

    await type(input('input[aria-label="Sticker width in inches"]'), "0.01");
    expect(previewBoxSizePx().width).toBe(72); // clamped to 0.5in
  });

  it("saves a new design to the store and reports it as new", async () => {
    const onSaved = vi.fn();
    await render({ mode: "create", template: null, onSaved });

    await type(input('input[aria-label="Stamp name"]'), "Court Exhibit");
    await click(button("Create Stamp"));

    expect(onSaved).toHaveBeenCalledWith(expect.any(String), true);
    const [savedId] = onSaved.mock.calls[0] as [string, boolean];
    resetExhibitStampCacheForTests();
    expect(listExhibitStampTemplates().find((t) => t.id === savedId)?.name).toBe("Court Exhibit");
  });

  it("does not touch the live counter when saving an edit, and reports it as not new", async () => {
    const seed = starterTemplate({ id: "joint-exhibit", name: "Joint Exhibit" });
    await saveExhibitStampTemplate(seed);
    await allocateIdentifier(seed.id);
    await allocateIdentifier(seed.id);

    resetExhibitStampCacheForTests();
    const current = listExhibitStampTemplates().find((t) => t.id === seed.id);
    if (!current) {
      throw new Error("expected the seeded template");
    }
    expect(current.nextIndex).toBe(2);

    const onSaved = vi.fn();
    await render({ mode: "edit", template: current, onSaved });

    await type(input('input[aria-label="Stamp name"]'), "Joint Exhibit (Renamed)");
    await click(button("Save Design"));

    expect(onSaved).toHaveBeenCalledWith(seed.id, false);

    resetExhibitStampCacheForTests();
    const saved = listExhibitStampTemplates().find((t) => t.id === seed.id);
    expect(saved?.name).toBe("Joint Exhibit (Renamed)");
    // The counter kept moving as if the edit never happened.
    expect(saved?.nextIndex).toBe(2);

    const next = await allocateIdentifier(seed.id);
    expect(next.ok && next.value.sequence.index).toBe(2);
  });

  async function click(element: Element | null): Promise<void> {
    if (!element) {
      throw new Error("expected an element to click");
    }

    await act(async () => {
      (element as HTMLElement).click();
      await Promise.resolve();
    });
  }

  function input(selector: string): HTMLInputElement {
    const element = container?.querySelector<HTMLInputElement>(selector);

    if (!element) {
      throw new Error(`expected to find ${selector}`);
    }

    return element;
  }

  function button(accessibleLabel: string): HTMLButtonElement | null {
    const buttons = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])];

    return (
      buttons.find(
        (candidate) =>
          candidate.getAttribute("aria-label") === accessibleLabel ||
          candidate.textContent?.trim() === accessibleLabel,
      ) ?? null
    );
  }

  function swatch(ariaLabel: string): HTMLButtonElement | null {
    return container?.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`) ?? null;
  }

  function previewStyle(): CSSStyleDeclaration {
    const preview = container?.querySelector<HTMLElement>(".stamp-preview");

    if (!preview) {
      throw new Error("expected the stamp preview to render");
    }

    return preview.style;
  }

  function previewLineCount(): number {
    return container?.querySelectorAll(".stamp-preview__line").length ?? 0;
  }

  function previewBoxSizePx(): { width: number; height: number } {
    const box = container?.querySelector<HTMLElement>(".exhibit-stamp-designer__preview-box");

    if (!box) {
      throw new Error("expected the designer preview box to render");
    }

    return { width: Number.parseFloat(box.style.width), height: Number.parseFloat(box.style.height) };
  }

  function starterTemplate(overrides: Partial<ExhibitStampTemplateV1> = {}): ExhibitStampTemplateV1 {
    const now = Date.now();

    return {
      version: 1,
      id: "starter",
      name: "Starter",
      prefix: "Starter",
      identifierStyle: "numbers",
      nextIndex: 0,
      layout: "stacked",
      widthPt: 115.2,
      heightPt: 72,
      fontFamily: "helvetica",
      bold: true,
      italic: false,
      fontSizePt: 14,
      textColor: { r: 0.067, g: 0.067, b: 0.067 },
      fillColor: { r: 1, g: 1, b: 1 },
      borderColor: { r: 0.067, g: 0.067, b: 0.067 },
      borderWidthPt: 1,
      cornerRadiusPt: 4,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  async function render(props: Partial<ExhibitStampDesignerProps> & { mode: "create" | "edit" }): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const fullProps: ExhibitStampDesignerProps = {
      mode: props.mode,
      template: props.template ?? null,
      onCancel: props.onCancel ?? (() => undefined),
      onMessage: props.onMessage ?? (() => undefined),
      onSaved: props.onSaved ?? (() => undefined),
    };

    await act(async () => {
      root?.render(<ExhibitStampDesigner {...fullProps} />);
      await Promise.resolve();
    });
  }
});
