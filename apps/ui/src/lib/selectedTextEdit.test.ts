// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PdfInspectTextMapResult, PdfTextMapPage } from "@raiopdf/engine-api";
import {
  captureCurrentTextSelection,
  registerTextLayerViewport,
  resolveSelectedTextTarget,
  selectionForReplacement,
  type CapturedTextSelection,
} from "./selectedTextEdit";

describe("selectedTextEdit", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("captures a same-page pdf.js text-layer selection with DOM offsets", () => {
    const layer = textLayer(0, ["John Smith", " v. ", "John Smith"]);
    document.body.append(layer);
    selectText(layer.childNodes[2]!.firstChild!, 0, layer.childNodes[2]!.firstChild!, 10);

    const captured = captureCurrentTextSelection();

    expect(captured).toMatchObject({
      ok: true,
      selection: {
        pageIndex: 0,
        text: "John Smith",
        start: 14,
        end: 24,
      },
    });
  });

  it("refuses cross-page browser selections", () => {
    const first = textLayer(0, ["John"]);
    const second = textLayer(1, ["Smith"]);
    document.body.append(first, second);
    selectText(first.firstChild!.firstChild!, 0, second.firstChild!.firstChild!, 5);

    expect(captureCurrentTextSelection()).toMatchObject({
      ok: false,
      message: expect.stringContaining("one page"),
    });
  });

  it("resolves a duplicate selected occurrence by shared DOM and engine offsets", () => {
    const textMap = map(["John Smith", " v. ", "John Smith"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith v. John Smith",
      start: 14,
      end: 24,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: true,
      target: {
        expectedText: "John Smith",
        firstElementIndex: 2,
        lastElementIndex: 2,
        firstElementOffset: 0,
        lastElementOffset: 10,
      },
      area: {
        pageIndex: 0,
        x: 40,
        w: 60,
      },
    });
  });

  it("resolves from a captured selection after browser focus clears the live selection", () => {
    const layer = textLayer(0, ["John Smith", " v. ", "John Smith"]);
    document.body.append(layer);
    selectText(layer.childNodes[2]!.firstChild!, 0, layer.childNodes[2]!.firstChild!, 10);
    const captured = captureCurrentTextSelection();
    expect(captured.ok).toBe(true);
    window.getSelection()?.removeAllRanges();
    const queuedSelection = selectionForReplacement(captureCurrentTextSelection(), captured.ok ? captured.selection : null);

    const resolved = queuedSelection.ok
      ? resolveSelectedTextTarget(queuedSelection.selection, map(["John Smith", " v. ", "John Smith"]))
      : null;

    expect(resolved).toMatchObject({
      ok: true,
      target: {
        firstElementIndex: 2,
        expectedText: "John Smith",
      },
    });
  });

  it("does not fall back to a saved selection when the live selection is cross-page", () => {
    const first = textLayer(0, ["John Smith"]);
    const second = textLayer(1, ["Jane Doe"]);
    document.body.append(first, second);
    const saved = selection({ text: "Saved", pageText: "Saved", start: 0, end: 5 });
    selectText(first.firstChild!.firstChild!, 0, second.firstChild!.firstChild!, 8);

    expect(selectionForReplacement(captureCurrentTextSelection(), saved)).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringContaining("one page"),
    });
  });

  it("does not fall back to a saved selection when the live selection is outside the PDF text layer", () => {
    const outside = document.createElement("span");
    outside.textContent = "Outside selection";
    document.body.append(outside);
    const saved = selection({ text: "Saved", pageText: "Saved", start: 0, end: 5 });
    selectText(outside.firstChild!, 0, outside.firstChild!, 7);

    expect(selectionForReplacement(captureCurrentTextSelection(), saved)).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringContaining("one page"),
    });
  });

  it("refuses repeated text when browser and engine page text differ and no spatial selection is available", () => {
    const textMap = map(["John Smith", " v. ", "John Smith"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith v. John  Smith",
      start: 15,
      end: 25,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: false,
      message: expect.stringContaining("found the text more than once"),
    });
  });

  it("resolves one exact editable occurrence when OCR and browser page text differ", () => {
    const textMap = map(["John", "Smith", " v. ", "John Smith"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith v. John Smith",
      start: 0,
      end: 10,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: true,
      target: {
        expectedText: "John Smith",
        expectedVisibleText: "John Smith",
        firstElementIndex: 3,
        lastElementIndex: 3,
      },
    });
  });

  it("resolves the highlighted occurrence when repeated OCR text has mismatched page offsets", () => {
    const textMap = map(["Settlement", " / ", "Settlement"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "OCR header\nSettlement Settlement",
      start: 22,
      end: 32,
      text: "Settlement",
      area: { pageIndex: 0, x: 55, y: 699, w: 60, h: 13 },
    }), textMap);

    expect(resolved).toMatchObject({
      ok: true,
      target: {
        expectedText: "Settlement",
        firstElementIndex: 2,
        lastElementIndex: 2,
      },
      area: { x: 40 },
    });
  });

  it("refuses repeated text when spatial candidates occupy the same visual location", () => {
    const textMap = mapWithAreas([
      { text: "Settlement", x: 72, y: 700, w: 60, h: 12 },
      { text: " / ", x: 140, y: 700, w: 10, h: 12 },
      { text: "Settlement", x: 72, y: 700, w: 60, h: 12 },
    ]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "different OCR order Settlement",
      text: "Settlement",
      area: { pageIndex: 0, x: 72, y: 700, w: 60, h: 12 },
    }), textMap);

    expect(resolved).toMatchObject({ ok: false, message: expect.stringContaining("could not safely identify") });
  });

  it("captures the selected occurrence area in PDF page coordinates", () => {
    const layer = textLayer(0, ["Settlement"]);
    document.body.append(layer);
    Object.defineProperty(layer, "getBoundingClientRect", {
      value: () => rect(100, 50, 600, 800),
    });
    selectText(layer.firstChild!.firstChild!, 0, layer.firstChild!.firstChild!, 10);
    const range = window.getSelection()!.getRangeAt(0);
    Object.defineProperty(range, "getClientRects", {
      value: () => [rect(160, 150, 120, 20)],
    });
    const unregister = registerTextLayerViewport(layer, {
      convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    } as never);

    const captured = captureCurrentTextSelection();
    unregister();

    expect(captured).toMatchObject({
      ok: true,
      selection: {
        area: { pageIndex: 0, x: 60, y: 680, w: 120, h: 20 },
      },
    });
  });

  it("resolves a unique OCR word without trusting mismatched whole-page offsets", () => {
    const textMap = map(["CONFIDENTIAL ", "Settlement", " Agreement"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "Header text in a different OCR reading order\nSettlement",
      start: 45,
      end: 55,
      text: "Settlement",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: true,
      target: {
        expectedText: "Settlement",
        expectedVisibleText: "Settlement",
        firstElementIndex: 1,
        lastElementIndex: 1,
      },
    });
  });

  it("resolves a safe inferred word space across contiguous same-line PDF runs", () => {
    const textMap = mapWithAreas([
      { text: "John", x: 72, y: 700, w: 28, h: 12 },
      { text: "Smith", x: 108, y: 700, w: 35, h: 12 },
    ]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith",
      start: 0,
      end: 10,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: true,
      target: {
        expectedText: "JohnSmith",
        expectedVisibleText: "John Smith",
        start: 0,
        end: 9,
        firstElementIndex: 0,
        lastElementIndex: 1,
      },
    });
  });

  it.each([
    ["a column-sized gap", [{ text: "John", x: 72, y: 700, w: 28, h: 12 }, { text: "Smith", x: 220, y: 700, w: 35, h: 12 }]],
    ["a different baseline", [{ text: "John", x: 72, y: 700, w: 28, h: 12 }, { text: "Smith", x: 108, y: 690, w: 35, h: 12 }]],
    ["an incompatible height", [{ text: "John", x: 72, y: 700, w: 28, h: 12 }, { text: "Smith", x: 108, y: 700, w: 35, h: 20 }]],
  ])("refuses inferred spacing across %s", (_label, elements) => {
    const resolved = resolveSelectedTextTarget(selection({ pageText: "John Smith", end: 10 }), mapWithAreas(elements));
    expect(resolved).toMatchObject({ ok: false });
  });

  it.each([
    ["a rotated run", { x: 0.999, y: 0.045 }],
    ["RTL text", { x: -1, y: 0 }],
    ["vertical text", { x: 0, y: 1 }],
  ])("refuses inferred spacing for %s", (_label, direction) => {
    const source = mapWithAreas([
      { text: "John", x: 72, y: 700, w: 28, h: 12, direction },
      { text: "Smith", x: 108, y: 700, w: 35, h: 12, direction },
    ]);
    expect(resolveSelectedTextTarget(selection({ pageText: "John Smith", end: 10 }), source)).toMatchObject({ ok: false });
  });

  it("refuses multi-run selections that do not share a baseline", () => {
    const textMap = mapWithAreas([
      { text: "John", x: 72, y: 700, w: 28, h: 12 },
      { text: " Smith", x: 72, y: 680, w: 42, h: 12 },
    ]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith",
      start: 0,
      end: 10,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: false,
      message: expect.stringContaining("locate"),
    });
  });
});

function textLayer(pageIndex: number, texts: readonly string[]): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "page-view__text-layer";
  layer.dataset.pageIndex = String(pageIndex);

  for (const text of texts) {
    const span = document.createElement("span");
    span.textContent = text;
    layer.append(span);
  }

  return layer;
}

function selectText(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const currentSelection = window.getSelection();
  currentSelection?.removeAllRanges();
  currentSelection?.addRange(range);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function selection(overrides: Partial<CapturedTextSelection>): CapturedTextSelection {
  return {
    pageIndex: 0,
    text: "John Smith",
    pageText: "John Smith",
    start: 0,
    end: 10,
    ...overrides,
  };
}

function map(texts: readonly string[]): PdfInspectTextMapResult {
  const page = pageMap(texts);
  return {
    sourceFingerprint: "document-fingerprint",
    pages: [page],
  };
}

function mapWithAreas(elements: Array<{
  direction?: { x: number; y: number };
  h: number;
  text: string;
  w: number;
  x: number;
  y: number;
}>): PdfInspectTextMapResult {
  let text = "";
  return {
    sourceFingerprint: "document-fingerprint",
    pages: [{
      pageIndex: 0,
      text: elements.map((element) => element.text).join(""),
      sourceFingerprint: "page-fingerprint",
      elements: elements.map((element, elementIndex) => {
        const start = text.length;
        text += element.text;
        return {
          elementIndex,
          start,
          end: text.length,
          text: element.text,
          area: {
            pageIndex: 0,
            x: element.x,
            y: element.y,
            w: element.w,
            h: element.h,
          },
          direction: element.direction ?? { x: 1, y: 0 },
        };
      }),
    }],
  };
}

function pageMap(texts: readonly string[]): PdfTextMapPage {
  let text = "";
  const elements = texts.map((value, elementIndex) => {
    const start = text.length;
    text += value;

    return {
      elementIndex,
      start,
      end: text.length,
      text: value,
      area: {
        pageIndex: 0,
        x: elementIndex * 20,
        y: 700,
        w: Math.max(1, value.length * 6),
        h: 12,
      },
    };
  });

  return {
    pageIndex: 0,
    text,
    sourceFingerprint: "page-fingerprint",
    elements,
  };
}
