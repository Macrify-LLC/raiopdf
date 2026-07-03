import { describe, expect, it } from "vitest";
import {
  computeHighlightLineRects,
  excerpt,
  toPdfEdits,
  type PageTextBox,
  type PendingEdit,
} from "./edits";

describe("toPdfEdits", () => {
  it("maps every pending edit kind onto the engine union in order", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const pending: PendingEdit[] = [
      {
        kind: "highlight",
        id: "a",
        pageIndex: 0,
        rects: [{ x: 10, y: 20, w: 100, h: 12 }],
      },
      {
        kind: "textBox",
        id: "b",
        pageIndex: 1,
        rect: { x: 5, y: 6, w: 80, h: 20 },
        text: "Hello",
        fontSizePt: 11,
      },
      {
        kind: "image",
        id: "c",
        pageIndex: 0,
        rect: { x: 1, y: 2, w: 30, h: 40 },
        bytes,
        format: "png",
        dataUrl: "data:image/png;base64,",
        aspectRatio: 0.75,
      },
      {
        kind: "signature",
        id: "d",
        pageIndex: 2,
        rect: { x: 9, y: 9, w: 60, h: 25 },
        bytes,
        format: "jpeg",
        dataUrl: "data:image/jpeg;base64,",
        aspectRatio: 2.4,
      },
      { kind: "comment", id: "e", pageIndex: 0, at: { x: 15, y: 25 }, text: "Note" },
      {
        kind: "ink",
        id: "f",
        pageIndex: 1,
        strokes: [
          [
            { x: 0, y: 0 },
            { x: 5, y: 5 },
          ],
        ],
      },
    ];

    const edits = toPdfEdits(pending);

    expect(edits.map((edit) => edit.type)).toEqual([
      "highlight",
      "textBox",
      "image",
      "signature",
      "comment",
      "ink",
    ]);
    expect(edits[1]).toMatchObject({ text: "Hello", fontSizePt: 11, pageIndex: 1 });
    expect(edits[5]).toMatchObject({ strokeWidthPt: 1.5 });
  });

  it("appends changed form values as one trailing document-scoped edit", () => {
    const edits = toPdfEdits([], { name: "Ada", agreed: true });

    expect(edits).toEqual([
      { type: "formValues", values: { name: "Ada", agreed: true } },
    ]);
  });

  it("returns an empty list when there is nothing to apply", () => {
    expect(toPdfEdits([], {})).toEqual([]);
  });
});

describe("computeHighlightLineRects", () => {
  const line = (y: number, x = 50, w = 200, h = 12): PageTextBox => ({ x, y, w, h });

  it("produces one union rect per intersected text line", () => {
    const textBoxes = [
      line(700, 50, 90),
      line(700, 150, 100),
      line(680),
      line(400), // far away, outside the band
    ];
    const band = { x: 40, y: 675, w: 300, h: 45 };

    const rects = computeHighlightLineRects(band, textBoxes);

    expect(rects).toHaveLength(2);
    // Top-to-bottom reading order: the y=700 line first.
    expect(rects[0]).toMatchObject({ x: 50, y: 700, w: 200 });
    expect(rects[1]).toMatchObject({ x: 50, y: 680 });
  });

  it("clusters sideways (rotated page) lines by x instead of y", () => {
    const verticalLine = (x: number): PageTextBox => ({ x, y: 100, w: 12, h: 200 });
    const textBoxes = [verticalLine(300), verticalLine(340)];
    const band = { x: 290, y: 90, w: 70, h: 220 };

    const rects = computeHighlightLineRects(band, textBoxes, true);

    expect(rects).toHaveLength(2);
  });

  it("returns nothing when the band misses all text", () => {
    expect(
      computeHighlightLineRects({ x: 0, y: 0, w: 10, h: 10 }, [line(700)]),
    ).toEqual([]);
  });
});

describe("excerpt", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(excerpt("hello   world\nnext")).toBe("hello world next");
    expect(excerpt("a".repeat(60))).toHaveLength(42);
    expect(excerpt("a".repeat(60)).endsWith("…")).toBe(true);
  });
});
