import { describe, expect, it } from "vitest";
import { locateTextInPages } from "../src/textLocate.js";
import type { PdfTextBoxItem, PdfTextBoxPage } from "../src/pdfjs-node.js";

describe("locateTextInPages", () => {
  it("does not add word breaks between touching text items", () => {
    const page = pageWithItems([
      item("con", 10, 100, 18, 12),
      item("cat", 28, 100, 18, 12),
      item("cat", 80, 100, 18, 12),
      item("concat", 120, 100, 36, 12),
    ]);

    const wholeWordCat = locateTextInPages([page], "cat", { wholeWord: true });
    expect(wholeWordCat).toHaveLength(1);
    expect(wholeWordCat[0]?.rects).toEqual([{ x: 80, y: 100, w: 18, h: 12 }]);

    const concat = locateTextInPages([page], "concat");
    expect(concat).toHaveLength(2);
    expect(concat.map((match) => match.rects)).toEqual([
      [{ x: 10, y: 100, w: 36, h: 12 }],
      [{ x: 120, y: 100, w: 36, h: 12 }],
    ]);
  });
});

function pageWithItems(items: PdfTextBoxItem[]): PdfTextBoxPage {
  return {
    pageIndex: 0,
    width: 240,
    height: 160,
    items,
  };
}

function item(str: string, x: number, y: number, w: number, h: number): PdfTextBoxItem {
  return {
    str,
    rect: { x, y, w, h },
    hasEOL: false,
  };
}
