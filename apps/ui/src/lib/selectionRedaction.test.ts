import { PDFDocument } from "pdf-lib";
// Same Node-safe legacy build already used by rotationViewport.repro.test.ts
// and packages/rules/src/pdfjsNode.ts, so a REAL pdf.js `PageViewport` (with
// real rotation/scale matrix math) backs the rotated-viewport case below —
// not a hand-rolled stub that could quietly diverge from pdf.js's own
// convertToPdfPoint/convertToViewportPoint behavior.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { pdfRectToViewportRect, type PageViewport, type PdfSpaceRect } from "./viewportGeometry";
import { redactionAreasFromClientRects, type RectLike } from "./selectionRedaction";

async function buildViewport(
  pageSize: [number, number],
  options: { scale?: number; rotation?: number } = {},
): Promise<PageViewport> {
  const document = await PDFDocument.create();
  document.addPage(pageSize);
  const bytes = await document.save();
  const task = getDocument({ data: new Uint8Array(bytes) });

  try {
    const pdfDocument = await task.promise;
    const page = await pdfDocument.getPage(1);
    return page.getViewport({
      scale: options.scale ?? 1,
      rotation: options.rotation ?? 0,
    }) as unknown as PageViewport;
  } finally {
    await task.destroy();
  }
}

/** A page frame flush with the viewport's own top-left origin, in CSS px. */
function frameFor(viewport: PageViewport): RectLike {
  return { left: 0, top: 0, width: viewport.width, height: viewport.height };
}

describe("redactionAreasFromClientRects", () => {
  it("converts a client rect to the matching PDF-space area", async () => {
    const viewport = await buildViewport([200, 100]);
    const frame = frameFor(viewport);
    // Known PDF-space rect, round-tripped through the viewport to build the
    // "client rect" a real selection would report at that position.
    const knownPdfRect: PdfSpaceRect = { x: 20, y: 30, w: 40, h: 10 };
    const clientRect = pdfRectToViewportRect(knownPdfRect, viewport);

    const [area] = redactionAreasFromClientRects([clientRect], frame, viewport, 0, { padPt: 0 });

    expect(area).toBeDefined();
    expect(area!.x).toBeCloseTo(knownPdfRect.x, 5);
    expect(area!.y).toBeCloseTo(knownPdfRect.y, 5);
    expect(area!.w).toBeCloseTo(knownPdfRect.w, 5);
    expect(area!.h).toBeCloseTo(knownPdfRect.h, 5);
  });

  it("converts correctly under a rotated, zoomed viewport (matches box-draw geometry)", async () => {
    const viewport = await buildViewport([200, 100], { scale: 1.5, rotation: 90 });
    const frame = frameFor(viewport);
    const knownPdfRect: PdfSpaceRect = { x: 20, y: 10, w: 40, h: 15 };
    const clientRect = pdfRectToViewportRect(knownPdfRect, viewport);

    const [area] = redactionAreasFromClientRects([clientRect], frame, viewport, 0, { padPt: 0 });

    expect(area).toBeDefined();
    expect(area!.x).toBeCloseTo(knownPdfRect.x, 5);
    expect(area!.y).toBeCloseTo(knownPdfRect.y, 5);
    expect(area!.w).toBeCloseTo(knownPdfRect.w, 5);
    expect(area!.h).toBeCloseTo(knownPdfRect.h, 5);
  });

  it("stamps the given pageIndex on every produced area", async () => {
    const viewport = await buildViewport([200, 100]);
    const frame = frameFor(viewport);
    const first = pdfRectToViewportRect({ x: 10, y: 10, w: 20, h: 8 }, viewport);
    const second = pdfRectToViewportRect({ x: 10, y: 40, w: 20, h: 8 }, viewport);

    const areas = redactionAreasFromClientRects([first, second], frame, viewport, 3);

    expect(areas).toHaveLength(2);
    expect(areas.every((area) => area.pageIndex === 3)).toBe(true);
  });

  it("produces one area per visual line of a multi-line selection", async () => {
    const viewport = await buildViewport([200, 200]);
    const frame = frameFor(viewport);
    const line1 = pdfRectToViewportRect({ x: 10, y: 150, w: 60, h: 10 }, viewport);
    const line2 = pdfRectToViewportRect({ x: 10, y: 130, w: 45, h: 10 }, viewport);
    const line3 = pdfRectToViewportRect({ x: 10, y: 110, w: 30, h: 10 }, viewport);

    const areas = redactionAreasFromClientRects([line1, line2, line3], frame, viewport, 0);

    expect(areas).toHaveLength(3);
  });

  it("merges duplicate and adjacent browser fragments on the same visual line", async () => {
    const viewport = await buildViewport([240, 120]);
    const frame = frameFor(viewport);
    const firstFragment: RectLike = { left: 20, top: 20, width: 35, height: 12 };
    const secondFragment: RectLike = { left: 59, top: 20, width: 42, height: 13 };
    const duplicateSecond: RectLike = { left: 59, top: 20, width: 42, height: 12 };
    const nextLine: RectLike = { left: 20, top: 48, width: 50, height: 12 };

    const areas = redactionAreasFromClientRects(
      [firstFragment, secondFragment, duplicateSecond, nextLine],
      frame,
      viewport,
      0,
      { padPt: 0 },
    );

    expect(areas).toHaveLength(2);
    const firstLine = pdfRectToViewportRect(areas[0]!, viewport);
    expect(firstLine.left).toBeCloseTo(20, 5);
    expect(firstLine.top).toBeCloseTo(20, 5);
    expect(firstLine.width).toBeCloseTo(81, 5);
    expect(firstLine.height).toBeCloseTo(13, 5);
  });

  it("coalesces a visual line transitively when tiny top offsets reorder fragments", async () => {
    const viewport = await buildViewport([240, 140]);
    const frame = frameFor(viewport);
    // The trailing fragment sorts first because its top is fractionally
    // smaller. The middle fragment later bridges it to the leading fragment.
    const leading: RectLike = { left: 20, top: 20, width: 35, height: 12 };
    const middle: RectLike = { left: 59, top: 20, width: 38, height: 12 };
    const trailing: RectLike = { left: 101, top: 19.5, width: 40, height: 13 };

    const areas = redactionAreasFromClientRects(
      [leading, middle, trailing],
      frame,
      viewport,
      0,
      { padPt: 0 },
    );

    expect(areas).toHaveLength(1);
    const line = pdfRectToViewportRect(areas[0]!, viewport);
    expect(line.left).toBeCloseTo(20, 5);
    expect(line.top).toBeCloseTo(19.5, 5);
    expect(line.width).toBeCloseTo(121, 5);
    expect(line.height).toBeCloseTo(13, 5);
  });

  it("merges the duplicate fragment geometry emitted by Linux Chromium", async () => {
    const viewport = await buildViewport([800, 600]);
    const frame = frameFor(viewport);
    // Captured from the real PDF.js smoke fixture on GitHub's Ubuntu runner.
    // The final fragment sorts before all the others by 0.4px, while several
    // fully-selected spans expose both a 33.2px and a 37px client rect.
    const rects: RectLike[] = [
      { left: 314.453125, top: 339.84375, width: 175.45944213867188, height: 37 },
      { left: 489.90625, top: 341.84375, width: 9.234375, height: 33.234375 },
      { left: 489.90625, top: 339.84375, width: 9.234375, height: 37 },
      { left: 498.1875, top: 341.84375, width: 73.8504638671875, height: 33.234375 },
      { left: 498.1875, top: 339.84375, width: 73.8504638671875, height: 37 },
      { left: 572.0625, top: 341.84375, width: 8.3125, height: 33.234375 },
      { left: 572.0625, top: 339.84375, width: 8.3125, height: 37 },
      { left: 592.015625, top: 339.4375, width: 119.634521484375, height: 39 },
    ];

    expect(
      redactionAreasFromClientRects(rects, frame, viewport, 0, { padPt: 0 }),
    ).toHaveLength(1);
  });

  it("keeps separated same-height fragments as distinct areas", async () => {
    const viewport = await buildViewport([300, 120]);
    const frame = frameFor(viewport);
    const leftColumn: RectLike = { left: 20, top: 20, width: 40, height: 12 };
    const rightColumn: RectLike = { left: 180, top: 20, width: 40, height: 12 };

    const areas = redactionAreasFromClientRects(
      [leftColumn, rightColumn],
      frame,
      viewport,
      0,
      { padPt: 0 },
    );

    expect(areas).toHaveLength(2);
  });

  it("clamps a rect that overshoots the frame to the page bounds", async () => {
    const viewport = await buildViewport([200, 100]);
    const frame = frameFor(viewport);
    // Wildly overshoots on every side (e.g. the pointer released past the
    // page edge, or into the scroller's gap between pages).
    const overshooting: RectLike = { left: -50, top: -50, width: 400, height: 400 };

    const [area] = redactionAreasFromClientRects([overshooting], frame, viewport, 0, { padPt: 0 });

    expect(area).toBeDefined();
    expect(area!.x).toBeCloseTo(0, 3);
    expect(area!.y).toBeCloseTo(0, 3);
    expect(area!.w).toBeCloseTo(200, 2);
    expect(area!.h).toBeCloseTo(100, 2);
  });

  it("drops rects below the minimum side threshold (empty/caret ranges)", async () => {
    const viewport = await buildViewport([200, 100]);
    const frame = frameFor(viewport);
    const caret: RectLike = { left: 10, top: 10, width: 1, height: 1 };
    const real = pdfRectToViewportRect({ x: 20, y: 20, w: 30, h: 10 }, viewport);

    const areas = redactionAreasFromClientRects([caret, real], frame, viewport, 0);

    expect(areas).toHaveLength(1);
  });

  it("respects a custom minSidePx threshold", async () => {
    const viewport = await buildViewport([200, 100]);
    const frame = frameFor(viewport);
    const rect: RectLike = { left: 10, top: 10, width: 3, height: 3 };

    expect(redactionAreasFromClientRects([rect], frame, viewport, 0)).toHaveLength(1);
    expect(
      redactionAreasFromClientRects([rect], frame, viewport, 0, { minSidePx: 5 }),
    ).toHaveLength(0);
  });

  it("pads the converted area by padPt on the horizontal sides, and less vertically", async () => {
    const viewport = await buildViewport([200, 100]);
    const frame = frameFor(viewport);
    const rect = pdfRectToViewportRect({ x: 50, y: 50, w: 20, h: 10 }, viewport);

    const unpadded = redactionAreasFromClientRects([rect], frame, viewport, 0, { padPt: 0 })[0]!;
    const padded = redactionAreasFromClientRects([rect], frame, viewport, 0, { padPt: 3 })[0]!;

    expect(padded.x).toBeCloseTo(unpadded.x - 3, 5);
    expect(padded.w).toBeCloseTo(unpadded.w + 6, 5);

    // Vertical padding is real but deliberately smaller than the horizontal
    // pad, so a padded line box is much less likely to rope in a neighbor
    // line (see the module comment on VERTICAL_PAD_FRACTION).
    const verticalPad = padded.h - unpadded.h;
    expect(verticalPad).toBeGreaterThan(0);
    expect(verticalPad).toBeLessThan(padded.w - unpadded.w);
  });

  it("keeps horizontal and vertical padding visually correct on a rotated page", async () => {
    const viewport = await buildViewport([200, 100], { scale: 1.5, rotation: 90 });
    const frame = frameFor(viewport);
    const rect = pdfRectToViewportRect({ x: 30, y: 20, w: 40, h: 15 }, viewport);

    const unpadded = redactionAreasFromClientRects([rect], frame, viewport, 0, { padPt: 0 })[0]!;
    const padded = redactionAreasFromClientRects([rect], frame, viewport, 0, { padPt: 3 })[0]!;
    const unpaddedViewport = pdfRectToViewportRect(unpadded, viewport);
    const paddedViewport = pdfRectToViewportRect(padded, viewport);

    expect(paddedViewport.left).toBeCloseTo(unpaddedViewport.left - 4.5, 5);
    expect(paddedViewport.width).toBeCloseTo(unpaddedViewport.width + 9, 5);
    expect(paddedViewport.top).toBeCloseTo(unpaddedViewport.top - 1.5, 5);
    expect(paddedViewport.height).toBeCloseTo(unpaddedViewport.height + 3, 5);
  });
});
