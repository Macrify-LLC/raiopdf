// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PdfInspectTextMapResult, PdfTextMapPage } from "@raiopdf/engine-api";
import {
  captureCurrentTextSelection,
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

  it("refuses selected text when browser and engine page text differ", () => {
    const textMap = map(["John Smith", " v. ", "John Smith"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith v. John  Smith",
      start: 15,
      end: 25,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: false,
      message: expect.stringContaining("inferred spacing"),
    });
  });

  it("refuses a mismatched page even when the selected string exists exactly once elsewhere", () => {
    const textMap = map(["John", "Smith", " v. ", "John Smith"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith v. John Smith",
      start: 0,
      end: 10,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: false,
      message: expect.stringContaining("inferred spacing"),
    });
  });

  it("refuses selections with inferred spaces absent from the engine text map", () => {
    const textMap = map(["John", "Smith"]);
    const resolved = resolveSelectedTextTarget(selection({
      pageText: "John Smith",
      start: 0,
      end: 10,
      text: "John Smith",
    }), textMap);

    expect(resolved).toMatchObject({
      ok: false,
      message: expect.stringContaining("inferred spacing"),
    });
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
