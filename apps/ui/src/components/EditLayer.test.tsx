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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { DEFAULT_SHAPE_STROKE_WIDTH_PT } from "../lib/editStyles";
import type { PendingEdit } from "../lib/edits";
import type { PDFPageProxy } from "../lib/pdfjs";
import type { PageViewport } from "../lib/viewportGeometry";
import type { EditingState } from "../hooks/useEditing";
import { EditLayer, TextBoxDraftEditor } from "./EditLayer";

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
    const edited = await engine.applyEdits(document, [
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

  beforeEach(() => {
    originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = () => undefined;
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

    if (originalSetPointerCapture) {
      HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
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

  it("removes a pending callout as one box-and-leader unit", async () => {
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
      "callout",
    );

    expect(container?.querySelectorAll(".edit-layer__callout-box")).toHaveLength(1);
    expect(container?.querySelectorAll(".edit-layer__callout-leader")).toHaveLength(1);

    const box = container?.querySelector<HTMLElement>(".edit-layer__callout-box");
    expect(box).not.toBeNull();

    await act(async () => {
      box!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.querySelectorAll(".edit-layer__callout-box")).toHaveLength(0);
    expect(container?.querySelectorAll(".edit-layer__callout-leader")).toHaveLength(0);
  });

  async function renderEditLayer(
    initialEdits: readonly PendingEdit[],
    tool: EditingState["tool"] = "shapeRect",
  ): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<EditLayerHarness initialEdits={initialEdits} tool={tool} />);
      await Promise.resolve();
    });
  }
});

function EditLayerHarness({
  initialEdits,
  tool,
}: {
  initialEdits: readonly PendingEdit[];
  tool: EditingState["tool"];
}) {
  const [pendingEdits, setPendingEdits] = useState(initialEdits);
  const editing = useMemo<EditingState>(
    () =>
      ({
        tool,
        pendingEdits,
        removeEdit: (id) =>
          setPendingEdits((current) => current.filter((edit) => edit.id !== id)),
        shapeStyles: {
          shapeRect: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT, fillColor: null },
          shapeEllipse: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT, fillColor: null },
          shapeLine: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
          shapeArrow: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
        },
        calloutStyle: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
      }) as EditingState,
    [pendingEdits, tool],
  );

  return <EditLayer page={testPage} viewport={testViewport} pageIndex={0} editing={editing} />;
}

const testPage = {
  getTextContent: async () => ({ items: [] }),
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
  type: "pointerdown" | "pointerup",
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
