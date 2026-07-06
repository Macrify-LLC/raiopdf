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
import { EditLayer, TextBoxDraftEditor } from "./EditLayer";

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

  async function renderEditLayer(
    initialEdits: readonly PendingEdit[],
    tool: EditingState["tool"] = "shapeRect",
    overrides: Partial<EditingState> = {},
  ): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <EditLayerHarness initialEdits={initialEdits} tool={tool} overrides={overrides} />,
      );
      await Promise.resolve();
    });
  }
});

function EditLayerHarness({
  initialEdits,
  tool,
  overrides,
}: {
  initialEdits: readonly PendingEdit[];
  tool: EditingState["tool"];
  overrides: Partial<EditingState>;
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

  return <EditLayer page={testPage} viewport={testViewport} pageIndex={0} editing={editing} />;
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
