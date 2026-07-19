// @vitest-environment jsdom
import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PDFStream,
} from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { DEFAULT_SHAPE_STROKE_WIDTH_PT } from "../lib/editStyles";
import type { PendingEdit } from "../lib/edits";
import type { PDFPageProxy } from "../lib/pdfjs";
import type { PageViewport } from "../lib/viewportGeometry";
import type { EditingState } from "../hooks/useEditing";
import { captureCurrentTextSelection } from "../lib/selectedTextEdit";
import { EditLayer, TextBoxDraftEditor, type EditLayerProps } from "./EditLayer";

vi.mock("../lib/selectedTextEdit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/selectedTextEdit")>()),
  captureCurrentTextSelection: vi.fn(() => ({
    ok: false as const,
    reason: "empty" as const,
    message: "Select text on one page before queuing a selected replacement.",
  })),
}));

type LocalEngine = ReturnType<typeof createLocalPdfEngine>;
type ApplyEditsArgs = Parameters<LocalEngine["applyEdits"]>;

let testTextContentItems: unknown[] = [];

function applyBakedEdits(
  engine: LocalEngine,
  document: ApplyEditsArgs[0],
  edits: ApplyEditsArgs[1],
  options: ApplyEditsArgs[2] = {},
) {
  return engine.applyEdits(document, edits, { markupMode: "baked", ...options });
}

describe("TextBoxDraftEditor", () => {
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

  it("renders the same wrapped lines that the engine bakes", async () => {
    const text = "Preview wraps these words\nand splits supercalifragilistic";
    const fontSizePt = 12;
    const widthPt = 86;

    await renderDraftEditor({
      kind: "textBox",
      editId: null,
      rect: { left: 0, top: 0, width: widthPt, height: 100 },
      text,
      fontSizePt,
      fontFamily: "times",
      bold: true,
      italic: true,
      align: "left",
    });

    const previewLines = await readPreviewLines();
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[240, 240]]));
    const edited = await applyBakedEdits(engine, document, [
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 24, y: 100, w: widthPt, h: 100 },
        text,
        fontSizePt,
        fontFamily: "times",
        bold: true,
        italic: true,
      },
    ]);
    const bytes = await engine.saveToBytes(edited);
    const bakedLines = readTextDraws(await readDecodedPageContent(bytes, 0));

    expect(previewLines).toEqual(bakedLines);
    expect(previewLines).toEqual([
      "Preview wraps ",
      "these words",
      "and splits ",
      "supercalifragilist",
      "ic",
    ]);
  });

  async function renderDraftEditor(
    draft: Parameters<typeof TextBoxDraftEditor>[0]["draft"],
  ): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TextBoxDraftEditor
          draft={draft}
          scale={1}
          onTextChange={() => undefined}
          onFontSizeChange={() => undefined}
          onTextStyleChange={() => undefined}
          onCommit={() => undefined}
          onCancel={() => undefined}
        />,
      );
      await Promise.resolve();
    });
  }

  async function readPreviewLines(): Promise<string[]> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const lines = [
        ...(container?.querySelectorAll(
          ".edit-layer__text-draft-preview .edit-layer__text-line",
        ) ?? []),
      ].map((line) => line.textContent ?? "");

      if (lines.length > 2) {
        return lines;
      }

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    return [
      ...(container?.querySelectorAll(
        ".edit-layer__text-draft-preview .edit-layer__text-line",
      ) ?? []),
    ].map((line) => line.textContent ?? "");
  }
});

describe("EditLayer shape removal", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let originalSetPointerCapture: typeof HTMLElement.prototype.setPointerCapture | undefined;
  let originalSvgSetPointerCapture: typeof SVGElement.prototype.setPointerCapture | undefined;

  beforeEach(() => {
    testTextContentItems = [];
    originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
    originalSvgSetPointerCapture = SVGElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = () => undefined;
    SVGElement.prototype.setPointerCapture = () => undefined;
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
    vi.restoreAllMocks();

    if (originalSetPointerCapture) {
      HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    }

    if (originalSvgSetPointerCapture) {
      SVGElement.prototype.setPointerCapture = originalSvgSetPointerCapture;
    } else {
      delete (SVGElement.prototype as Partial<SVGElement>).setPointerCapture;
    }
  });

  it("removes the clicked same-kind shape instead of only checking the first one", async () => {
    await renderEditLayer([
      {
        kind: "shape",
        id: "first-rect",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 10, y: 10, w: 30, h: 30 },
      },
      {
        kind: "shape",
        id: "second-rect",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 100, y: 100, w: 30, h: 30 },
      },
    ]);

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    layer!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 240,
        height: 240,
        right: 240,
        bottom: 240,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 115, 115);
      dispatchPointerEvent(layer!, "pointerup", 115, 115);
      await Promise.resolve();
    });

    const rects = [...(container?.querySelectorAll("svg.edit-layer__shapes rect") ?? [])];

    expect(rects).toHaveLength(1);
    expect(rects[0]?.getAttribute("x")).toBe("10");
  });

  it("keeps a pinned shape when a same-kind-tool click lands on it", async () => {
    // Regression: shapes get no click-through CSS, so a pinned shape's
    // pointerdown reaches the layer; a same-kind-tool click then runs the
    // tiny-drag removal path, which must skip pinned shapes.
    await renderEditLayer(
      [
        {
          kind: "shape",
          id: "pinned-rect",
          pageIndex: 0,
          pinned: true,
          shape: "rect",
          rect: { x: 20, y: 20, w: 60, h: 40 },
        },
      ],
      "shapeRect", // same kind → an unpinned shape here would be deleted
    );

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 40, 40); // inside the shape
      dispatchPointerEvent(layer!, "pointerup", 40, 40); // no drag → remove path
      await Promise.resolve();
    });

    expect(container?.querySelectorAll("svg.edit-layer__shapes rect")).toHaveLength(1);
  });

  it("clamps captured shape drags that end past the page edge", async () => {
    await renderEditLayer([], "shapeRect");

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 100, 100);
      dispatchPointerEvent(layer!, "pointermove", 320, 300);
      dispatchPointerEvent(layer!, "pointerup", 320, 300);
      await Promise.resolve();
    });

    const rect = container?.querySelector<SVGRectElement>("svg.edit-layer__shapes rect");
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("x")).toBe("100");
    expect(rect?.getAttribute("y")).toBe("100");
    expect(rect?.getAttribute("width")).toBe("140");
    expect(rect?.getAttribute("height")).toBe("140");
  });

  it("limits text-markup drags to text boxes under the drag band", async () => {
    const addEdit = vi.fn();
    const removeAllRanges = vi.fn();
    testTextContentItems = [
      {
        str: "first line",
        transform: [1, 0, 0, 12, 10, 20],
        width: 80,
        height: 12,
      },
      {
        str: "second line",
        transform: [1, 0, 0, 12, 10, 90],
        width: 210,
        height: 12,
      },
    ];
    await renderEditLayer([], "highlight", { addEdit });

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    stubLayerBounds(layer!);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({
        getClientRects: () => [
          {
            left: 10,
            top: 20,
            right: 90,
            bottom: 32,
          },
          {
            left: 10,
            top: 90,
            right: 220,
            bottom: 102,
          },
        ],
      }),
      removeAllRanges,
    } as unknown as Selection);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 10, 17);
      dispatchPointerEvent(layer!, "pointerup", 90, 36);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(addEdit).toHaveBeenCalledOnce();
    expect(addEdit.mock.calls[0]?.[0]).toMatchObject({
      kind: "highlight",
      pageIndex: 0,
      rects: [{ x: 10, y: 17, w: 80, h: 15 }],
    });
    expect(removeAllRanges).toHaveBeenCalled();
  });

  it("surfaces the page-level no-text-layer message for text markup", async () => {
    const addEdit = vi.fn();
    testTextContentItems = [];

    await renderEditLayer([], "highlight", { addEdit });

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 10, 10);
      dispatchPointerEvent(layer!, "pointerup", 90, 40);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(addEdit).not.toHaveBeenCalled();
    expect(container?.textContent).toContain(
      "This page has no text layer, so text markup is unavailable here.",
    );
  });

  it("removes a pending callout as one box-and-leader unit via its X", async () => {
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-1",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Review this",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    expect(container?.querySelectorAll(".edit-layer__callout-box")).toHaveLength(1);
    expect(container?.querySelectorAll(".edit-layer__callout-leader")).toHaveLength(1);

    const remove = container?.querySelector<HTMLElement>(".edit-layer__pin-remove");
    expect(remove).not.toBeNull();

    await act(async () => {
      remove!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.querySelectorAll(".edit-layer__callout-box")).toHaveLength(0);
    expect(container?.querySelectorAll(".edit-layer__callout-leader")).toHaveLength(0);
  });

  it("keeps a pinned callout's X hidden until it is unpinned", async () => {
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-pinned",
          pageIndex: 0,
          pinned: true,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Locked",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    // Pinned: only the pin badge, no X.
    expect(container?.querySelector(".edit-layer__pin-remove")).toBeNull();
    const badge = container?.querySelector<HTMLElement>(".edit-layer__pin-badge[data-pinned='true']");
    expect(badge).not.toBeNull();

    // Unpin, and the X appears.
    await act(async () => {
      badge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.querySelector(".edit-layer__pin-remove")).not.toBeNull();
  });

  it("previews callout leaders from the nearest box boundary point", async () => {
    const cases = [
      {
        id: "callout-side",
        tip: { x: 180, y: 150 },
        expectedAnchor: { x: 120, y: 150 },
      },
      {
        id: "callout-corner",
        tip: { x: 180, y: 200 },
        expectedAnchor: { x: 120, y: 170 },
      },
      {
        id: "callout-inside",
        tip: { x: 60, y: 135 },
        expectedAnchor: { x: 60, y: 120 },
      },
    ];

    await renderEditLayer(
      cases.map(({ id, tip }) => ({
        kind: "callout",
        id,
        pageIndex: 0,
        rect: { x: 40, y: 120, w: 80, h: 50 },
        tip,
        text: "Review this",
        fontSizePt: 12,
      })),
      "callout",
    );

    const leaders = [...(container?.querySelectorAll(".edit-layer__callout-leader line") ?? [])];

    expect(leaders).toHaveLength(cases.length);

    for (const [index, { tip, expectedAnchor }] of cases.entries()) {
      expect(leaders[index]?.getAttribute("x1")).toBe(String(expectedAnchor.x));
      expect(leaders[index]?.getAttribute("y1")).toBe(String(expectedAnchor.y));
      expect(leaders[index]?.getAttribute("x2")).toBe(String(tip.x));
      expect(leaders[index]?.getAttribute("y2")).toBe(String(tip.y));
    }
  });

  it("moves line shapes as a whole item", async () => {
    await renderEditLayer(
      [
        {
          kind: "shape",
          id: "line-1",
          pageIndex: 0,
          shape: "line",
          from: { x: 20, y: 20 },
          to: { x: 80, y: 80 },
        },
      ],
      "select",
    );

    const hitLine = container?.querySelector<SVGLineElement>(".edit-layer__shape-hit-line");
    expect(hitLine).not.toBeNull();

    await act(async () => {
      dispatchPointerEvent(hitLine!, "pointerdown", 30, 30);
      dispatchPointerEvent(hitLine!, "pointermove", 45, 40);
      dispatchPointerEvent(hitLine!, "pointerup", 45, 40);
      await Promise.resolve();
    });

    const visibleLine = [...(container?.querySelectorAll("svg.edit-layer__shapes line") ?? [])]
      .find((line) => !line.classList.contains("edit-layer__shape-hit-line"));

    expect(visibleLine?.getAttribute("x1")).toBe("35");
    expect(visibleLine?.getAttribute("y1")).toBe("30");
    expect(visibleLine?.getAttribute("x2")).toBe("95");
    expect(visibleLine?.getAttribute("y2")).toBe("90");
  });

  it("locks a pinned overlay item against dragging", async () => {
    await renderEditLayer(
      [
        {
          kind: "textBox",
          id: "applied-text",
          pageIndex: 0,
          pinned: true,
          rect: { x: 20, y: 20, w: 80, h: 30 },
          text: "Applied",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    const textBox = container?.querySelector<HTMLElement>(".edit-layer__text-box");
    expect(textBox).not.toBeNull();

    await act(async () => {
      dispatchPointerEvent(textBox!, "pointerdown", 25, 25);
      dispatchPointerEvent(textBox!, "pointermove", 45, 35);
      dispatchPointerEvent(textBox!, "pointerup", 45, 35);
      await Promise.resolve();
    });

    // Pinned items are locked in place; the drag is a no-op.
    expect(textBox?.style.left).toBe("20px");
    expect(textBox?.style.top).toBe("20px");
  });

  it("keeps an unpinned overlay item draggable", async () => {
    await renderEditLayer(
      [
        {
          kind: "textBox",
          id: "draft-text",
          pageIndex: 0,
          pinned: false,
          rect: { x: 20, y: 20, w: 80, h: 30 },
          text: "Draft",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    const textBox = container?.querySelector<HTMLElement>(".edit-layer__text-box");
    expect(textBox).not.toBeNull();

    await act(async () => {
      dispatchPointerEvent(textBox!, "pointerdown", 25, 25);
      dispatchPointerEvent(textBox!, "pointermove", 45, 35);
      dispatchPointerEvent(textBox!, "pointerup", 45, 35);
      await Promise.resolve();
    });

    expect(textBox?.style.left).toBe("40px");
    expect(textBox?.style.top).toBe("30px");
  });

  it("places a live reusable text field in form-authoring mode", async () => {
    await renderEditLayer([], "formText");

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 20, 30);
      await Promise.resolve();
    });

    const field = container?.querySelector<HTMLElement>(".edit-layer__form-field");
    const valueInput = field?.querySelector<HTMLInputElement>(".edit-layer__form-field-input");
    const nameInput = field?.querySelector<HTMLInputElement>('input[aria-label="Field name"]');

    expect(field?.dataset.fieldType).toBe("text");
    expect(field?.style.left).toBe("20px");
    expect(field?.style.top).toBe("30px");
    expect(field?.style.width).toBe("180px");
    expect(field?.style.height).toBe("24px");
    expect(valueInput?.value).toBe("");
    expect(nameInput?.value).toMatch(
      /^raio\.text\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("places and fills a reusable checkbox in form-authoring mode", async () => {
    await renderEditLayer([], "formCheckbox");

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 40, 50);
      await Promise.resolve();
    });

    const field = container?.querySelector<HTMLElement>(".edit-layer__form-field");
    const checkbox = field?.querySelector<HTMLInputElement>(".edit-layer__form-field-checkbox");

    expect(field?.dataset.fieldType).toBe("checkbox");
    expect(field?.style.width).toBe("18px");
    expect(field?.style.height).toBe("18px");
    expect(checkbox?.checked).toBe(false);

    await act(async () => {
      checkbox?.click();
      await Promise.resolve();
    });

    expect(checkbox?.checked).toBe(true);
  });

  it("selects and drags a reusable text field through its value input", async () => {
    await renderEditLayer(
      [
        {
          kind: "formField",
          fieldType: "text",
          id: "client-name",
          name: "client.name",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 120, h: 24 },
          initialValue: "Jane Doe",
        },
      ],
      "select",
    );

    const field = container?.querySelector<HTMLElement>(".edit-layer__form-field");
    const valueInput = field?.querySelector<HTMLInputElement>(".edit-layer__form-field-input");
    expect(field).not.toBeNull();
    expect(valueInput).not.toBeNull();

    await act(async () => {
      dispatchPointerEvent(valueInput!, "pointerdown", 25, 25);
      dispatchPointerEvent(valueInput!, "pointerup", 25, 25);
      await Promise.resolve();
    });

    expect(field?.dataset.selected).toBe("true");
    const initialLeft = Number.parseFloat(field?.style.left ?? "0");
    const initialTop = Number.parseFloat(field?.style.top ?? "0");

    await act(async () => {
      dispatchPointerEvent(valueInput!, "pointerdown", 25, 25);
      dispatchPointerEvent(valueInput!, "pointermove", 45, 35);
      dispatchPointerEvent(valueInput!, "pointerup", 45, 35);
      await Promise.resolve();
    });

    expect(field?.style.left).toBe(`${initialLeft + 20}px`);
    expect(field?.style.top).toBe(`${initialTop + 10}px`);
  });

  it("shows an armed image ghost at the pointer before placement", async () => {
    await renderEditLayer([], "image", {
      armedImage: {
        bytes: new Uint8Array([1]),
        format: "png",
        dataUrl: "data:image/png;base64,AA==",
        width: 80,
        height: 40,
      },
    });

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointermove", 120, 120);
      await Promise.resolve();
    });

    const ghost = container?.querySelector<HTMLElement>(".edit-layer__stamp-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost?.style.left).toBe("90px");
    expect(ghost?.style.top).toBe("105px");
  });

  it("disarms and selects a placed signature", async () => {
    const disarmSignature = vi.fn();

    await renderEditLayer([], "sign", {
      armedSignature: {
        bytes: new Uint8Array([1]),
        format: "png",
        dataUrl: "data:image/png;base64,AA==",
        width: 80,
        height: 40,
      },
      disarmSignature,
    });

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    expect(layer).not.toBeNull();
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchPointerEvent(layer!, "pointerdown", 120, 120);
      await Promise.resolve();
    });

    expect(disarmSignature).toHaveBeenCalledOnce();
    expect(container?.querySelector(".edit-layer__stamp[data-selected='true']")).not.toBeNull();
  });

  it("right-click on an unpinned callout offers Edit text, Pin and Delete", async () => {
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-menu",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Note",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchContextMenu(layer!, 50, 40); // inside the callout rect
      await Promise.resolve();
    });

    expect(contextMenuLabels(container)).toEqual(["Edit text", "Pin", "Delete"]);
  });

  it("right-click on a pinned callout falls through (no item menu)", async () => {
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-pinned-menu",
          pageIndex: 0,
          pinned: true,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Locked",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchContextMenu(layer!, 50, 40);
      await Promise.resolve();
    });

    // Pinned items are click-through: no item menu, and with nothing beneath,
    // no context menu at all.
    expect(container?.querySelector(".context-menu")).toBeNull();
  });

  it("clicking a context-menu item never falls through to start a placement", async () => {
    // Regression: with an interactive tool active the edit layer owns
    // pointerdown; a menu rendered inside it must absorb the item-click's
    // pointerdown or the click starts a new placement and captures the pointer.
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-menu-passthrough",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Note",
          fontSizePt: 12,
        },
      ],
      "callout", // the callout tool is active, so the layer is interactive
    );

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchContextMenu(layer!, 50, 40); // inside the callout rect
      await Promise.resolve();
    });

    const menuItem = container?.querySelector<HTMLElement>(".context-menu__item");
    expect(menuItem).not.toBeNull();

    await act(async () => {
      dispatchPointerEvent(menuItem!, "pointerdown", 50, 40);
      await Promise.resolve();
    });

    // The pointerdown was absorbed by the menu: no callout placement draft
    // started underneath it.
    expect(container?.querySelector(".edit-layer__callout-placement")).toBeNull();
  });

  it("double-clicking a placed callout opens its inline text editor", async () => {
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-dblclick",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Before",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    const box = container?.querySelector<HTMLElement>(".edit-layer__callout-box");
    expect(box).not.toBeNull();

    await act(async () => {
      box!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
    });

    // The inline editor is open (a draft box with a textarea), and the placed
    // overlay is hidden so the two don't stack.
    const textarea = container?.querySelector<HTMLTextAreaElement>(".edit-layer__text-input");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("Before");
    expect(container?.querySelectorAll(".edit-layer__callout-box")).toHaveLength(1);
    expect(
      container?.querySelector(".edit-layer__callout-box.edit-layer__text-draft"),
    ).not.toBeNull();
    // The leader still draws while editing so the callout keeps its target.
    expect(container?.querySelector(".edit-layer__callout-leader")).not.toBeNull();
  });

  it("Edit text on a callout menu edits the text in place, keeping the tip", async () => {
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-edit-menu",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Before",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchContextMenu(layer!, 50, 40); // inside the callout rect
      await Promise.resolve();
    });

    const editItem = [...(container?.querySelectorAll(".context-menu__item") ?? [])].find(
      (item) => item.textContent === "Edit text",
    );
    expect(editItem).toBeTruthy();

    await act(async () => {
      editItem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const textarea = container?.querySelector<HTMLTextAreaElement>(".edit-layer__text-input");
    expect(textarea).not.toBeNull();

    // Retype the note and commit with Enter.
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue?.call(textarea, "After");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      textarea!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await Promise.resolve();
    });

    // The editor closed and the placed callout now shows the new text — with a
    // single box and its leader still anchored at the original tip.
    expect(container?.querySelector(".edit-layer__text-input")).toBeNull();
    const boxes = [...(container?.querySelectorAll(".edit-layer__callout-box") ?? [])];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.textContent).toContain("After");
    expect(container?.querySelectorAll(".edit-layer__callout-leader")).toHaveLength(1);
  });

  it("right-click on a highlight offers to remove it", async () => {
    await renderEditLayer(
      [
        {
          kind: "highlight",
          id: "hl-menu",
          pageIndex: 0,
          rects: [{ x: 10, y: 10, w: 100, h: 12 }],
        },
      ],
      "select",
    );

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchContextMenu(layer!, 40, 16); // inside the highlight rect
      await Promise.resolve();
    });

    expect(contextMenuLabels(container)).toEqual(["Remove highlight"]);

    const remove = container?.querySelector<HTMLElement>(".context-menu__item");
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.querySelectorAll(".edit-layer__highlight")).toHaveLength(0);
  });

  it("right-click with a text selection offers markup and creates it", async () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({
        getClientRects: () => [
          { left: 10, top: 20, right: 90, bottom: 32, width: 80, height: 12 },
        ],
      }),
      removeAllRanges: () => undefined,
    } as unknown as Selection);

    await renderEditLayer([], "select");

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchContextMenu(layer!, 5, 5); // not over any item — selection path
      await Promise.resolve();
    });

    expect(contextMenuLabels(container)).toEqual([
      "Copy",
      "Highlight",
      "Underline",
      "Strike through",
    ]);

    const highlight = [...(container?.querySelectorAll<HTMLElement>(".context-menu__item") ?? [])].find(
      (item) => item.textContent === "Highlight",
    );
    await act(async () => {
      highlight!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.querySelectorAll(".edit-layer__highlight").length).toBeGreaterThan(0);
  });

  it("does not union a multi-column selection across the gutter", async () => {
    // Two runs on the same visual line but in different columns (a wide
    // horizontal gap). They must stay two rects, not one that paints the gutter.
    const addEdit = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({
        getClientRects: () => [
          { left: 10, top: 20, right: 90, bottom: 32, width: 80, height: 12 },
          { left: 150, top: 20, right: 230, bottom: 32, width: 80, height: 12 },
        ],
      }),
      removeAllRanges: () => undefined,
    } as unknown as Selection);

    await renderEditLayer([], "select", { addEdit });

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);

    await act(async () => {
      dispatchContextMenu(layer!, 5, 5); // selection path, not over an item
      await Promise.resolve();
    });

    const highlight = [
      ...(container?.querySelectorAll<HTMLElement>(".context-menu__item") ?? []),
    ].find((item) => item.textContent === "Highlight");
    await act(async () => {
      highlight!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(addEdit).toHaveBeenCalledTimes(1);
    const rects = addEdit.mock.calls[0]?.[0]?.rects as { x: number; y: number; w: number; h: number }[];
    expect(rects).toHaveLength(2);
    // Neither rect spans the ~60px gutter between the columns.
    for (const rect of rects) {
      expect(rect.w).toBeLessThan(100);
    }
  });

  it("offers Replace text... after Copy when the host provides the entry", async () => {
    mockSelectionWithRects();
    vi.mocked(captureCurrentTextSelection).mockReturnValue({
      ok: true,
      selection: capturedSelection(),
    });
    const onReplace = vi.fn();

    await renderEditLayer([], "select", {}, {
      onReplaceTextInSelection: onReplace,
      replaceTextInSelectionBlocked: () => false,
    });

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);
    await act(async () => {
      dispatchContextMenu(layer!, 5, 5);
      await Promise.resolve();
    });

    expect(contextMenuLabels(container)).toEqual([
      "Copy",
      "Replace text...",
      "Highlight",
      "Underline",
      "Strike through",
    ]);

    const item = findContextMenuItem("Replace text...");
    expect(item.disabled).toBe(false);
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onReplace).toHaveBeenCalledWith(capturedSelection());
  });

  it("renders Replace text... disabled when the page gate blocks or the capture fails", async () => {
    mockSelectionWithRects();
    vi.mocked(captureCurrentTextSelection).mockReturnValue({
      ok: true,
      selection: capturedSelection(),
    });

    await renderEditLayer([], "select", {}, {
      onReplaceTextInSelection: () => undefined,
      replaceTextInSelectionBlocked: () => true,
    });

    let layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);
    await act(async () => {
      dispatchContextMenu(layer!, 5, 5);
      await Promise.resolve();
    });
    expect(findContextMenuItem("Replace text...").disabled).toBe(true);

    // Capture failure (e.g. a cross-page selection) also disables the item.
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.mocked(captureCurrentTextSelection).mockReturnValue({
      ok: false,
      reason: "invalid",
      message: "Selected text editing only supports one page at a time.",
    });
    mockSelectionWithRects();

    await renderEditLayer([], "select", {}, {
      onReplaceTextInSelection: () => undefined,
      replaceTextInSelectionBlocked: () => false,
    });
    layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);
    await act(async () => {
      dispatchContextMenu(layer!, 5, 5);
      await Promise.resolve();
    });
    expect(findContextMenuItem("Replace text...").disabled).toBe(true);
  });

  it("dispatches a stale open menu through the LATEST replace handler", async () => {
    mockSelectionWithRects();
    vi.mocked(captureCurrentTextSelection).mockReturnValue({
      ok: true,
      selection: capturedSelection(),
    });
    const staleHandler = vi.fn();
    const latestHandler = vi.fn();

    await renderEditLayer([], "select", {}, {
      onReplaceTextInSelection: staleHandler,
      replaceTextInSelectionBlocked: () => false,
    });

    const layer = container?.querySelector<HTMLElement>(".edit-layer");
    stubLayerBounds(layer!);
    await act(async () => {
      dispatchContextMenu(layer!, 5, 5);
      await Promise.resolve();
    });

    // The menu is open with items built against staleHandler; swap the prop
    // before clicking — the ref dispatch must run the replacement handler.
    await act(async () => {
      root?.render(
        <EditLayerHarness
          initialEdits={[]}
          tool="select"
          overrides={{}}
          layerProps={{
            onReplaceTextInSelection: latestHandler,
            replaceTextInSelectionBlocked: () => false,
          }}
        />,
      );
      await Promise.resolve();
    });

    const item = findContextMenuItem("Replace text...");
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(staleHandler).not.toHaveBeenCalled();
    expect(latestHandler).toHaveBeenCalledWith(capturedSelection());
  });

  function mockSelectionWithRects() {
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "comes before",
      getRangeAt: () => ({
        getClientRects: () => [
          { left: 10, top: 20, right: 90, bottom: 32, width: 80, height: 12 },
        ],
      }),
      removeAllRanges: () => undefined,
    } as unknown as Selection);
  }

  function capturedSelection() {
    return {
      pageIndex: 0,
      text: "comes before",
      pageText: "This cause comes before the Court.",
      start: 11,
      end: 23,
    };
  }

  function findContextMenuItem(label: string): HTMLButtonElement {
    const item = [
      ...(container?.querySelectorAll<HTMLButtonElement>(".context-menu__item") ?? []),
    ].find((candidate) => candidate.textContent === label);

    if (!item) {
      throw new Error(`Context-menu item not found: ${label}`);
    }

    return item;
  }

  it("ignores right-clicks inside a text field so the native menu survives", async () => {
    await renderEditLayer(
      [
        {
          kind: "callout",
          id: "callout-guard",
          pageIndex: 0,
          rect: { x: 20, y: 20, w: 90, h: 40 },
          tip: { x: 160, y: 80 },
          text: "Note",
          fontSizePt: 12,
        },
      ],
      "select",
    );

    // A text field over the annotation (mimics an open inline editor). Even
    // though the point is inside the callout, the handler must bail.
    const field = document.createElement("textarea");
    container!.appendChild(field);

    await act(async () => {
      dispatchContextMenu(field, 50, 40);
      await Promise.resolve();
    });

    expect(container?.querySelector(".context-menu")).toBeNull();
  });

  async function renderEditLayer(
    initialEdits: readonly PendingEdit[],
    tool: EditingState["tool"] = "shapeRect",
    overrides: Partial<EditingState> = {},
    layerProps: Pick<EditLayerProps, "onReplaceTextInSelection" | "replaceTextInSelectionBlocked"> = {},
  ): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <EditLayerHarness
          initialEdits={initialEdits}
          tool={tool}
          overrides={overrides}
          layerProps={layerProps}
        />,
      );
      await Promise.resolve();
    });
  }
});

function EditLayerHarness({
  initialEdits,
  tool,
  overrides,
  layerProps = {},
}: {
  initialEdits: readonly PendingEdit[];
  tool: EditingState["tool"];
  overrides: Partial<EditingState>;
  layerProps?: Pick<EditLayerProps, "onReplaceTextInSelection" | "replaceTextInSelectionBlocked">;
}) {
  const [pendingEdits, setPendingEdits] = useState(initialEdits);
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null);
  const editing = useMemo<EditingState>(
    () =>
      ({
        tool,
        pendingEdits,
        // Shared selection lives on EditingState since the continuous-scroll
        // viewer mounts one EditLayer per page; the layer destructures these
        // at runtime, so the partial mock must provide them.
        selectedEditId,
        setSelectedEditId,
        addEdit: (edit: PendingEdit) => setPendingEdits((current) => [...current, edit]),
        updateEdit: (id: string, update: (edit: PendingEdit) => PendingEdit) =>
          setPendingEdits((current) =>
            current.map((edit) => (edit.id === id ? update(edit) : edit)),
          ),
        removeEdit: (id: string) =>
          setPendingEdits((current) => current.filter((edit) => edit.id !== id)),
        setEditStatus: (id: string, status: NonNullable<PendingEdit["status"]>) =>
          setPendingEdits((current) =>
            current.map((edit) => (edit.id === id ? { ...edit, status } : edit)),
          ),
        draftEditCount: pendingEdits.filter((edit) => edit.status !== "applied").length,
        appliedEditCount: pendingEdits.filter((edit) => edit.status === "applied").length,
        highlightStyle: {},
        textMarkupStyles: { underline: {}, strikethrough: {} },
        applyPending: () =>
          setPendingEdits((current) =>
            current.map((edit) => ({ ...edit, status: "applied" })),
          ),
        unapplyPending: () =>
          setPendingEdits((current) =>
            current.map((edit) =>
              edit.status === "applied" ? { ...edit, status: "draft" } : edit,
            ),
          ),
        shapeStyles: {
          shapeRect: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT, fillColor: null },
          shapeEllipse: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT, fillColor: null },
          shapeLine: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
          shapeArrow: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
        },
        calloutStyle: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
        disarmImage: () => undefined,
        disarmSignature: () => undefined,
        setTool: () => undefined,
        setMessage: () => undefined,
        ...overrides,
      }) as unknown as EditingState,
    [overrides, pendingEdits, selectedEditId, tool],
  );

  return (
    <EditLayer
      page={testPage}
      viewport={testViewport}
      pageIndex={0}
      editing={editing}
      {...layerProps}
    />
  );
}

const testPage = {
  getTextContent: async () => ({ items: testTextContentItems }),
} as unknown as PDFPageProxy;

const testViewport = {
  width: 240,
  height: 240,
  scale: 1,
  rotation: 0,
  convertToPdfPoint: (x: number, y: number) => [x, y],
  convertToViewportPoint: (x: number, y: number) => [x, y],
} as unknown as PageViewport;

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX,
    clientY,
    button: 0,
  }) as PointerEvent;

  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

function dispatchContextMenu(target: Element, clientX: number, clientY: number): void {
  target.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX, clientY, button: 2 }),
  );
}

function contextMenuLabels(container: HTMLElement | null): string[] {
  return [...(container?.querySelectorAll(".context-menu__item") ?? [])].map(
    (item) => item.textContent ?? "",
  );
}

function stubLayerBounds(layer: HTMLElement): void {
  layer.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 240,
      height: 240,
      right: 240,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

async function createPdf(pageSizes: ReadonlyArray<readonly [number, number]>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const pageSize of pageSizes) {
    pdf.addPage([pageSize[0], pageSize[1]]);
  }

  return pdf.save();
}

async function readDecodedPageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPage(pageIndex).node.Contents();
  const contentObjects =
    contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

  return contentObjects
    .map((object) => (object instanceof PDFStream ? object : pdf.context.lookup(object)))
    .filter((object): object is PDFStream => object instanceof PDFStream)
    .map((stream) => decodePdfStream(stream))
    .join("\n");
}

function decodePdfStream(stream: PDFStream): string {
  if (stream instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }

  return new TextDecoder().decode(stream.getContents());
}

function readTextDraws(content: string): string[] {
  return [...content.matchAll(/<([0-9A-F]+)> Tj/gi)].map((match) => decodeHexText(match[1]!));
}

function decodeHexText(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  return new TextDecoder().decode(bytes);
}
