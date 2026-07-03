// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PDFStream,
} from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { TextBoxDraftEditor } from "./EditLayer";

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
