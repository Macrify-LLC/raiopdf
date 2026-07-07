import { describe, expect, it } from "vitest";
import {
  annotationSavePlanHasChanges,
  buildAnnotationSavePlan,
  clipMarkupRectsToDragBand,
  computeTextMarkupSelectionRects,
  excerpt,
  normalizePdfRectFromPoints,
  pendingEditsFromRaioAnnotations,
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
        kind: "underline",
        id: "u",
        pageIndex: 0,
        rects: [{ x: 20, y: 30, w: 80, h: 10 }],
      },
      {
        kind: "strikethrough",
        id: "s",
        pageIndex: 0,
        rects: [{ x: 25, y: 35, w: 75, h: 10 }],
      },
      {
        kind: "textBox",
        id: "b",
        pageIndex: 1,
        rect: { x: 5, y: 6, w: 80, h: 20 },
        text: "Hello",
        fontSizePt: 11,
        backgroundColor: { r: 1, g: 0.9, b: 0.3 },
        backgroundOpacity: 0.45,
      },
      {
        kind: "callout",
        id: "callout",
        pageIndex: 1,
        rect: { x: 15, y: 16, w: 90, h: 32 },
        tip: { x: 160, y: 70 },
        text: "See this",
        fontSizePt: 12,
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
      {
        kind: "shape",
        id: "g",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 10, y: 20, w: 80, h: 40 },
      },
      {
        kind: "shape",
        id: "h",
        pageIndex: 0,
        shape: "arrow",
        from: { x: 10, y: 10 },
        to: { x: 50, y: 30 },
      },
    ];

    const edits = toPdfEdits(pending);

    expect(edits.map((edit) => edit.type)).toEqual([
      "highlight",
      "underline",
      "strikethrough",
      "textBox",
      "callout",
      "image",
      "signature",
      "comment",
      "ink",
      "shape",
      "shape",
    ]);
    expect(edits[3]).toMatchObject({
      text: "Hello",
      fontSizePt: 11,
      pageIndex: 1,
      backgroundColor: { r: 1, g: 0.9, b: 0.3 },
      backgroundOpacity: 0.45,
    });
    expect(edits[4]).toMatchObject({
      type: "callout",
      rect: { x: 15, y: 16, w: 90, h: 32 },
      tip: { x: 160, y: 70 },
      text: "See this",
    });
    expect(edits[8]).toMatchObject({ strokeWidthPt: 1.5 });
    expect(edits[9]).toMatchObject({
      shape: "rect",
      rect: { x: 10, y: 20, w: 80, h: 40 },
    });
    expect(edits[10]).toMatchObject({
      shape: "arrow",
      from: { x: 10, y: 10 },
      to: { x: 50, y: 30 },
    });
  });

  it("omits optional edit colors and opacity when they were not set", () => {
    const edits = toPdfEdits([
      {
        kind: "highlight",
        id: "a",
        pageIndex: 0,
        rects: [{ x: 10, y: 20, w: 100, h: 12 }],
      },
      {
        kind: "textBox",
        id: "b",
        pageIndex: 0,
        rect: { x: 20, y: 30, w: 120, h: 30 },
        text: "No style",
        fontSizePt: 12,
      },
      {
        kind: "ink",
        id: "c",
        pageIndex: 0,
        strokes: [
          [
            { x: 0, y: 0 },
            { x: 20, y: 20 },
          ],
        ],
      },
      {
        kind: "underline",
        id: "d",
        pageIndex: 0,
        rects: [{ x: 20, y: 30, w: 100, h: 12 }],
        color: { r: 0x11 / 0xff, g: 0x11 / 0xff, b: 0x11 / 0xff },
      },
      {
        kind: "strikethrough",
        id: "e",
        pageIndex: 0,
        rects: [{ x: 20, y: 50, w: 100, h: 12 }],
      },
      {
        kind: "shape",
        id: "f",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 10, y: 20, w: 80, h: 40 },
        strokeColor: { r: 0x11 / 0xff, g: 0x11 / 0xff, b: 0x11 / 0xff },
        strokeWidthPt: 1.5,
        fillColor: null,
      },
    ]);

    expect(edits[0]).not.toHaveProperty("color");
    expect(edits[0]).not.toHaveProperty("opacity");
    expect(edits[1]).not.toHaveProperty("color");
    expect(edits[1]).not.toHaveProperty("backgroundColor");
    expect(edits[1]).not.toHaveProperty("backgroundOpacity");
    expect(edits[2]).not.toHaveProperty("color");
    expect(edits[2]).toMatchObject({ strokeWidthPt: 1.5 });
    expect(edits[3]).not.toHaveProperty("color");
    expect(edits[4]).not.toHaveProperty("color");
    expect(edits[5]).not.toHaveProperty("strokeColor");
    expect(edits[5]).not.toHaveProperty("strokeWidthPt");
    expect(edits[5]).not.toHaveProperty("fillColor");
  });

  it("emits chosen edit colors, highlight opacity, and ink stroke width", () => {
    const edits = toPdfEdits([
      {
        kind: "highlight",
        id: "a",
        pageIndex: 0,
        rects: [{ x: 10, y: 20, w: 100, h: 12 }],
        color: { r: 0.2, g: 0.8, b: 0.3 },
        opacity: 0.55,
      },
      {
        kind: "textBox",
        id: "b",
        pageIndex: 0,
        rect: { x: 20, y: 30, w: 120, h: 30 },
        text: "Styled",
        fontSizePt: 12,
        color: { r: 0.8, g: 0.1, b: 0.2 },
      },
      {
        kind: "ink",
        id: "c",
        pageIndex: 0,
        strokes: [
          [
            { x: 0, y: 0 },
            { x: 20, y: 20 },
          ],
        ],
        strokeWidthPt: 5,
        color: { r: 0.1, g: 0.2, b: 0.9 },
      },
      {
        kind: "underline",
        id: "d",
        pageIndex: 0,
        rects: [{ x: 30, y: 40, w: 100, h: 12 }],
        color: { r: 0.7, g: 0.1, b: 0.2 },
      },
      {
        kind: "strikethrough",
        id: "e",
        pageIndex: 0,
        rects: [{ x: 30, y: 60, w: 100, h: 12 }],
        color: { r: 0.1, g: 0.6, b: 0.3 },
        thicknessPt: 2,
      },
      {
        kind: "shape",
        id: "f",
        pageIndex: 0,
        shape: "ellipse",
        rect: { x: 40, y: 50, w: 80, h: 40 },
        strokeWidthPt: 5,
        strokeColor: { r: 0.2, g: 0.3, b: 0.4 },
        fillColor: { r: 0.8, g: 0.9, b: 0.1 },
      },
    ]);

    expect(edits[0]).toMatchObject({
      color: { r: 0.2, g: 0.8, b: 0.3 },
      opacity: 0.55,
    });
    expect(edits[1]).toMatchObject({ color: { r: 0.8, g: 0.1, b: 0.2 } });
    expect(edits[2]).toMatchObject({
      color: { r: 0.1, g: 0.2, b: 0.9 },
      strokeWidthPt: 5,
    });
    expect(edits[3]).toMatchObject({
      type: "underline",
      rects: [{ x: 30, y: 40, w: 100, h: 12 }],
      color: { r: 0.7, g: 0.1, b: 0.2 },
    });
    expect(edits[4]).toMatchObject({
      type: "strikethrough",
      color: { r: 0.1, g: 0.6, b: 0.3 },
      thicknessPt: 2,
    });
    expect(edits[5]).toMatchObject({
      type: "shape",
      shape: "ellipse",
      strokeWidthPt: 5,
      strokeColor: { r: 0.2, g: 0.3, b: 0.4 },
      fillColor: { r: 0.8, g: 0.9, b: 0.1 },
    });
  });

  it("emits non-default text box font and alignment options", () => {
    const edits = toPdfEdits([
      {
        kind: "textBox",
        id: "a",
        pageIndex: 0,
        rect: { x: 20, y: 30, w: 120, h: 30 },
        text: "Styled text",
        fontSizePt: 12,
        fontFamily: "times",
        bold: true,
        italic: true,
        align: "center",
      },
    ]);

    expect(edits[0]).toMatchObject({
      type: "textBox",
      fontFamily: "times",
      bold: true,
      italic: true,
      align: "center",
    });
  });

  it("omits default text box font and alignment options", () => {
    const edits = toPdfEdits([
      {
        kind: "textBox",
        id: "a",
        pageIndex: 0,
        rect: { x: 20, y: 30, w: 120, h: 30 },
        text: "Default text",
        fontSizePt: 12,
        fontFamily: "helvetica",
        bold: false,
        italic: false,
        align: "left",
      },
    ]);

    expect(edits[0]).not.toHaveProperty("fontFamily");
    expect(edits[0]).not.toHaveProperty("bold");
    expect(edits[0]).not.toHaveProperty("italic");
    expect(edits[0]).not.toHaveProperty("align");
  });

  it("emits a callout as one atomic edit with default callout options omitted", () => {
    const edits = toPdfEdits([
      {
        kind: "callout",
        id: "a",
        pageIndex: 0,
        rect: { x: 20, y: 30, w: 140, h: 50 },
        tip: { x: 200, y: 90 },
        text: "Look here",
        fontSizePt: 12,
        fontFamily: "helvetica",
        bold: false,
        italic: false,
        align: "left",
        strokeWidthPt: 1.5,
        strokeColor: { r: 0x11 / 0xff, g: 0x11 / 0xff, b: 0x11 / 0xff },
        arrowhead: true,
        boxBorder: true,
      },
    ]);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      type: "callout",
      pageIndex: 0,
      rect: { x: 20, y: 30, w: 140, h: 50 },
      tip: { x: 200, y: 90 },
      text: "Look here",
      fontSizePt: 12,
    });
  });

  it("threads custom callout text and leader fields", () => {
    const edits = toPdfEdits([
      {
        kind: "callout",
        id: "a",
        pageIndex: 0,
        rect: { x: 20, y: 30, w: 140, h: 50 },
        tip: { x: 200, y: 90 },
        text: "Styled callout",
        fontSizePt: 11,
        color: { r: 0.8, g: 0.1, b: 0.2 },
        fontFamily: "times",
        bold: true,
        italic: true,
        align: "right",
        strokeWidthPt: 3,
        strokeColor: { r: 0.1, g: 0.2, b: 0.9 },
        arrowhead: false,
        boxBorder: false,
        boxFill: { r: 1, g: 0.95, b: 0.65 },
      },
    ]);

    expect(edits[0]).toMatchObject({
      type: "callout",
      color: { r: 0.8, g: 0.1, b: 0.2 },
      fontFamily: "times",
      bold: true,
      italic: true,
      align: "right",
      strokeWidthPt: 3,
      strokeColor: { r: 0.1, g: 0.2, b: 0.9 },
      arrowhead: false,
      boxBorder: false,
      boxFill: { r: 1, g: 0.95, b: 0.65 },
    });
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

describe("normalizePdfRectFromPoints", () => {
  it("normalizes any drag direction to positive width and height", () => {
    expect(normalizePdfRectFromPoints({ x: 100, y: 50 }, { x: 20, y: 130 })).toEqual({
      x: 20,
      y: 50,
      w: 80,
      h: 80,
    });
  });
});

describe("buildAnnotationSavePlan", () => {
  it("skips unchanged imports, updates changed imports, deletes removed imports, and appends new edits", () => {
    const imported = pendingEditsFromRaioAnnotations([
      {
        pageIndex: 0,
        annotId: "keep",
        edit: {
          type: "highlight",
          annotId: "keep",
          pageIndex: 0,
          rects: [{ x: 10, y: 20, w: 60, h: 12 }],
          opacity: 0.4,
        },
      },
      {
        pageIndex: 0,
        annotId: "move",
        edit: {
          type: "comment",
          annotId: "move",
          pageIndex: 0,
          at: { x: 80, y: 90 },
          text: "Move me",
        },
      },
      {
        pageIndex: 0,
        annotId: "delete",
        edit: {
          type: "underline",
          annotId: "delete",
          pageIndex: 0,
          rects: [{ x: 15, y: 40, w: 70, h: 10 }],
        },
      },
    ]);
    const moved = imported.map((edit) =>
      edit.annotId === "move" && edit.kind === "comment"
        ? { ...edit, at: { x: 100, y: 110 } }
        : edit,
    );
    const pending: PendingEdit[] = [
      moved[0]!,
      moved[1]!,
      {
        kind: "textBox",
        id: "new-box",
        pageIndex: 0,
        rect: { x: 120, y: 130, w: 90, h: 30 },
        text: "New",
        fontSizePt: 12,
      },
    ];

    const plan = buildAnnotationSavePlan(pending, new Set(["keep", "move", "delete"]));

    expect(annotationSavePlanHasChanges(plan)).toBe(true);
    expect(plan.appendEdits).toEqual([
      {
        type: "textBox",
        pageIndex: 0,
        rect: { x: 120, y: 130, w: 90, h: 30 },
        text: "New",
        fontSizePt: 12,
      },
    ]);
    expect(plan.updateEdits).toEqual([
      {
        annotId: "move",
        edit: {
          type: "comment",
          annotId: "move",
          pageIndex: 0,
          at: { x: 100, y: 110 },
          text: "Move me",
        },
      },
    ]);
    expect(plan.deleteAnnotIds).toEqual(["delete"]);
  });

  it("reports no changes for unchanged imported annotations", () => {
    const pending = pendingEditsFromRaioAnnotations([
      {
        pageIndex: 0,
        annotId: "same",
        edit: {
          type: "strikethrough",
          annotId: "same",
          pageIndex: 0,
          rects: [{ x: 15, y: 40, w: 70, h: 10 }],
          thicknessPt: 2,
        },
      },
    ]);
    const plan = buildAnnotationSavePlan(pending, new Set(["same"]));

    expect(annotationSavePlanHasChanges(plan)).toBe(false);
    expect(plan).toMatchObject({
      appendEdits: [],
      updateEdits: [],
      deleteAnnotIds: [],
    });
  });

  it("plans flattening without re-appending unchanged imported annotations", () => {
    const imported = pendingEditsFromRaioAnnotations([
      {
        pageIndex: 0,
        annotId: "existing-highlight",
        edit: {
          type: "highlight",
          annotId: "existing-highlight",
          pageIndex: 0,
          rects: [{ x: 10, y: 20, w: 60, h: 12 }],
          opacity: 0.4,
        },
      },
      {
        pageIndex: 0,
        annotId: "existing-comment",
        edit: {
          type: "comment",
          annotId: "existing-comment",
          pageIndex: 0,
          at: { x: 80, y: 90 },
          text: "Already saved",
        },
      },
    ]);
    const pending: PendingEdit[] = [
      ...imported,
      {
        kind: "shape",
        id: "new-rect",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 120, y: 130, w: 90, h: 30 },
      },
    ];

    const plan = buildAnnotationSavePlan(
      pending,
      new Set(["existing-highlight", "existing-comment"]),
    );

    expect(plan.appendEdits).toEqual([
      {
        type: "shape",
        pageIndex: 0,
        shape: "rect",
        rect: { x: 120, y: 130, w: 90, h: 30 },
      },
    ]);
    expect(plan.updateEdits).toEqual([]);
    expect(plan.deleteAnnotIds).toEqual([]);
  });
});

describe("computeTextMarkupSelectionRects", () => {
  // PDF user space: bottom-left origin, y increases upward, so a higher y is
  // higher on the page. Default line runs x=50..250 unless widened.
  const line = (y: number, x = 50, w = 200, h = 12): PageTextBox => ({ x, y, w, h });

  it("hugs the caret span on a single-line selection", () => {
    const textBoxes = [line(700, 50, 500)];

    const rects = computeTextMarkupSelectionRects(
      { x: 120, y: 706 },
      { x: 300, y: 706 },
      textBoxes,
    );

    expect(rects).toEqual([{ x: 120, y: 700, w: 180, h: 12 }]);
  });

  it("runs from the start caret to end-of-line, then line-start to the end caret", () => {
    const textBoxes = [line(700, 50, 500), line(680, 50, 500)];

    const rects = computeTextMarkupSelectionRects(
      { x: 300, y: 706 }, // start, on the top line
      { x: 200, y: 684 }, // end, on the bottom line
      textBoxes,
    );

    expect(rects).toEqual([
      { x: 300, y: 700, w: 250, h: 12 }, // top: caret -> end of line
      { x: 50, y: 680, w: 150, h: 12 }, // bottom: line start -> caret
    ]);
  });

  it("spans interior lines to their full text width, not the caret column", () => {
    const textBoxes = [line(700, 50, 200), line(680, 50, 500), line(660, 50, 200)];

    const rects = computeTextMarkupSelectionRects(
      { x: 150, y: 706 },
      { x: 200, y: 664 },
      textBoxes,
    );

    // The middle line covers its whole run (w=500) even though both carets
    // sit in a narrow column — the old bounding-box behavior clipped it.
    expect(rects[1]).toEqual({ x: 50, y: 680, w: 500, h: 12 });
    expect(rects[0]).toEqual({ x: 150, y: 700, w: 100, h: 12 });
    expect(rects[2]).toEqual({ x: 50, y: 660, w: 150, h: 12 });
  });

  it("is direction-independent (dragging up gives the same shape)", () => {
    const textBoxes = [line(700, 50, 500), line(680, 50, 500)];
    const downward = computeTextMarkupSelectionRects(
      { x: 300, y: 706 },
      { x: 200, y: 684 },
      textBoxes,
    );
    const upward = computeTextMarkupSelectionRects(
      { x: 200, y: 684 },
      { x: 300, y: 706 },
      textBoxes,
    );

    expect(upward).toEqual(downward);
  });

  it("flows along the rotated axis on sideways pages", () => {
    const column = (x: number): PageTextBox => ({ x, y: 100, w: 12, h: 260 });
    const textBoxes = [column(300), column(340)];

    const rects = computeTextMarkupSelectionRects(
      { x: 306, y: 200 },
      { x: 346, y: 300 },
      textBoxes,
      true,
    );

    expect(rects).toEqual([
      { x: 300, y: 200, w: 12, h: 160 },
      { x: 340, y: 100, w: 12, h: 200 },
    ]);
  });

  it("returns nothing when the drag misses every line", () => {
    expect(
      computeTextMarkupSelectionRects({ x: 0, y: 0 }, { x: 5, y: 5 }, [line(700)]),
    ).toEqual([]);
    expect(computeTextMarkupSelectionRects({ x: 0, y: 0 }, { x: 5, y: 5 }, [])).toEqual([]);
  });
});

describe("clipMarkupRectsToDragBand", () => {
  it("drops lines outside the drag's cross-line span (greedy whitespace selection)", () => {
    const rects = [
      { x: 10, y: 105, w: 100, h: 12 }, // inside the band
      { x: 10, y: 300, w: 100, h: 12 }, // far below — browser over-selection
    ];
    const band = { x: 0, y: 100, w: 500, h: 30 };

    expect(clipMarkupRectsToDragBand(rects, band)).toEqual([{ x: 10, y: 105, w: 100, h: 12 }]);
  });

  it("keeps a single line for a thin same-line drag via the half-line tolerance", () => {
    const rects = [{ x: 10, y: 100, w: 200, h: 12 }];
    const band = { x: 20, y: 104, w: 120, h: 0 };

    expect(clipMarkupRectsToDragBand(rects, band)).toEqual(rects);
  });

  it("clips along the x axis on sideways pages", () => {
    const rects = [
      { x: 100, y: 10, w: 12, h: 200 }, // inside
      { x: 400, y: 10, w: 12, h: 200 }, // outside
    ];
    const band = { x: 90, y: 0, w: 40, h: 300 };

    expect(clipMarkupRectsToDragBand(rects, band, true)).toEqual([
      { x: 100, y: 10, w: 12, h: 200 },
    ]);
  });
});

describe("excerpt", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(excerpt("hello   world\nnext")).toBe("hello world next");
    expect(excerpt("a".repeat(60))).toHaveLength(42);
    expect(excerpt("a".repeat(60)).endsWith("…")).toBe(true);
  });
});
