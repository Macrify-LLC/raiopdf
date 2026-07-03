import { describe, expect, it } from "vitest";
import {
  computeMountedRange,
  computePageLayout,
  estimateCanvasBytes,
  findPageAtOffset,
  mostVisiblePage,
  unionRange,
  MAX_OVERSCAN_PAGES_PER_SIDE,
  PAGE_GAP,
  PAGE_LIST_PADDING,
} from "./pageLayout";

const LETTER = { width: 612, height: 792 };

function letterLayout(pageCount: number, zoom = 1) {
  return computePageLayout(
    Array.from({ length: pageCount }, () => LETTER),
    zoom,
    true,
  );
}

describe("computePageLayout", () => {
  it("stacks pages with gaps inside the list padding", () => {
    const layout = letterLayout(3);

    expect(layout.items[0]).toMatchObject({ top: PAGE_LIST_PADDING, width: 612, height: 792 });
    expect(layout.items[1]!.top).toBe(PAGE_LIST_PADDING + 792 + PAGE_GAP);
    expect(layout.items[2]!.top).toBe(PAGE_LIST_PADDING + 2 * (792 + PAGE_GAP));
    expect(layout.totalHeight).toBe(PAGE_LIST_PADDING * 2 + 3 * 792 + 2 * PAGE_GAP);
    expect(layout.maxBaseWidth).toBe(612);
  });

  it("scales page boxes by zoom but keeps base dims for inch reporting", () => {
    const layout = letterLayout(2, 2);

    expect(layout.items[0]!.width).toBe(1224);
    expect(layout.items[0]!.height).toBe(1584);
    expect(layout.baseDims[0]).toEqual(LETTER);
    expect(layout.maxWidth).toBe(1224);
    expect(layout.maxBaseWidth).toBe(612);
  });

  it("honors mixed page sizes for the max widths", () => {
    const layout = computePageLayout(
      [LETTER, { width: 792, height: 612 }],
      1.5,
      true,
    );

    expect(layout.maxWidth).toBe(792 * 1.5);
    expect(layout.maxBaseWidth).toBe(792);
  });
});

describe("findPageAtOffset / mostVisiblePage", () => {
  it("finds the page containing an offset", () => {
    const layout = letterLayout(10);

    expect(findPageAtOffset(layout.items, 0)).toBe(0);
    expect(findPageAtOffset(layout.items, layout.items[4]!.top)).toBe(4);
    expect(findPageAtOffset(layout.items, layout.items[4]!.top + 100)).toBe(4);
    expect(findPageAtOffset(layout.items, 10_000_000)).toBe(9);
  });

  it("derives the most-visible page from the viewport intersection", () => {
    const layout = letterLayout(10);

    // Viewport mostly over page 3 (index 2).
    const scrollTop = layout.items[2]!.top - 50;
    expect(mostVisiblePage(layout.items, scrollTop, 700)).toBe(2);

    // Scrolled so page 3 shows only a sliver at the top: page 4 wins.
    const nearBottom = layout.items[2]!.top + 792 - 60;
    expect(mostVisiblePage(layout.items, nearBottom, 700)).toBe(3);
  });

  it("prefers the earlier page on an exact tie", () => {
    const layout = letterLayout(4);
    // Straddle pages 1 and 2 equally: 192px of each page visible.
    const boundary = layout.items[1]!.top - PAGE_GAP / 2;
    const page = mostVisiblePage(layout.items, boundary - 200, 400);

    expect(page).toBe(0);
  });
});

describe("computeMountedRange", () => {
  it("mounts visible pages plus the overscan buffer at 100% zoom", () => {
    const layout = letterLayout(40);
    const range = computeMountedRange(layout.items, 0, 900);

    // Pages 1-2 visible, plus two below (byte budget allows both sides).
    expect(range.start).toBe(0);
    expect(range.end).toBe(1 + MAX_OVERSCAN_PAGES_PER_SIDE);
  });

  it("caps overscan by canvas memory, not page count, at high zoom", () => {
    const layout = letterLayout(40, 4);
    // One 612x792 page at 4x = 2448*3168*4 bytes ~= 31 MB, so a single
    // overscan page nearly exhausts the 32 MB budget.
    const perPage = estimateCanvasBytes(layout.items[0]!);
    const range = computeMountedRange(layout.items, layout.items[10]!.top, 900, perPage);

    const visiblePages = range.end - range.start + 1;
    const overscanBudgetPages = 1;
    expect(visiblePages).toBeLessThanOrEqual(
      // visible pages at this zoom/viewport...
      2 + overscanBudgetPages,
    );

    // And with a zero budget, exactly the visible pages mount.
    const bare = computeMountedRange(layout.items, layout.items[10]!.top, 900, 0);
    expect(bare.start).toBe(10);
    expect(bare.end).toBe(10);
  });

  it("always mounts visible pages even when the budget is zero", () => {
    const layout = letterLayout(6);
    const range = computeMountedRange(layout.items, 0, 2600, 0);

    // ~3 pages fit in 2600px; all of them mount despite the zero budget.
    expect(range.start).toBe(0);
    expect(range.end).toBeGreaterThanOrEqual(2);
  });
});

describe("unionRange", () => {
  it("covers both ranges (selection-drag freeze)", () => {
    expect(unionRange({ start: 2, end: 5 }, { start: 4, end: 8 })).toEqual({
      start: 2,
      end: 8,
    });
  });

  it("passes through when one side is empty", () => {
    expect(unionRange({ start: 0, end: -1 }, { start: 3, end: 4 })).toEqual({
      start: 3,
      end: 4,
    });
    expect(unionRange({ start: 3, end: 4 }, { start: 0, end: -1 })).toEqual({
      start: 3,
      end: 4,
    });
  });
});
