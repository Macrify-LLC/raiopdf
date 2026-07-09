/**
 * Pure layout math for the continuous-scroll page list.
 *
 * The viewer lays every page out in one vertical column at its
 * viewport-derived size, but only mounts real canvases for the visible
 * range plus a small overscan buffer. All of that math lives here so it
 * can be unit-tested without a DOM.
 */

/** Base (scale-1) page dimensions in CSS pixels. */
export interface PageDims {
  width: number;
  height: number;
}

/** One laid-out page: absolute offsets within the scroll content. */
export interface PageLayoutItem {
  top: number;
  width: number;
  height: number;
}

export interface PageLayout {
  items: readonly PageLayoutItem[];
  /** Base (scale-1) dims per page, for inch reporting and fit-width. */
  baseDims: readonly PageDims[];
  totalHeight: number;
  /** Widest page at the current zoom. */
  maxWidth: number;
  /** Widest page at scale 1 (fit-width divides the container by this). */
  maxBaseWidth: number;
  /** Horizontal space reserved before the page content area. */
  leftInset: number;
  /** False while page sizes are still first-page estimates. */
  measured: boolean;
}

export interface MountedRange {
  start: number;
  end: number;
}

/** Vertical gap between consecutive pages. */
export const PAGE_GAP = 16;

/** Padding above the first and below the last page. */
export const PAGE_LIST_PADDING = 24;

/**
 * Overscan is capped by estimated canvas memory, not page count alone —
 * at high zoom a single letter page is 16x its 100% cost, so the buffer
 * must shrink instead of multiplying. 32 MB ~= 8 letter pages at 100%,
 * ~2 at 200%, ~0 at 400%.
 */
export const MAX_OVERSCAN_BYTES = 32 * 1024 * 1024;

/** Hard page-count cap per side, even when the byte budget would allow more. */
export const MAX_OVERSCAN_PAGES_PER_SIDE = 2;

const BYTES_PER_PIXEL = 4;

export function estimateCanvasBytes(item: PageLayoutItem): number {
  return Math.max(1, Math.floor(item.width) * Math.floor(item.height)) * BYTES_PER_PIXEL;
}

export function computePageLayout(
  baseDims: readonly PageDims[],
  zoom: number,
  measured: boolean,
  topInset = 0,
  bottomInset = 0,
  leftInset = 0,
): PageLayout {
  const items: PageLayoutItem[] = [];
  let top = PAGE_LIST_PADDING + topInset;
  let maxWidth = 0;
  let maxBaseWidth = 0;

  for (const dims of baseDims) {
    const width = dims.width * zoom;
    const height = dims.height * zoom;
    items.push({ top, width, height });
    top += height + PAGE_GAP;
    maxWidth = Math.max(maxWidth, width);
    maxBaseWidth = Math.max(maxBaseWidth, dims.width);
  }

  const contentBottom = items.length > 0 ? top - PAGE_GAP : top;

  return {
    items,
    baseDims,
    totalHeight: contentBottom + PAGE_LIST_PADDING + bottomInset,
    maxWidth,
    maxBaseWidth,
    leftInset,
    measured,
  };
}

export function computePageContentWidth(
  layout: PageLayout,
  viewportWidth: number,
): number {
  return Math.max(
    layout.leftInset + layout.maxWidth + PAGE_LIST_PADDING * 2,
    viewportWidth,
  );
}

export function computePageLeft(
  item: PageLayoutItem,
  layout: PageLayout,
  contentWidth: number,
): number {
  const contentAreaWidth = Math.max(0, contentWidth - layout.leftInset);

  return layout.leftInset + Math.max(PAGE_LIST_PADDING, (contentAreaWidth - item.width) / 2);
}

/** Index of the last page whose top is at or above `offset` (clamped). */
export function findPageAtOffset(
  items: readonly PageLayoutItem[],
  offset: number,
): number {
  let low = 0;
  let high = items.length - 1;
  let found = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;

    if (items[mid]!.top <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found;
}

/**
 * The page with the largest intersection with the viewport — the derived
 * `currentPage`. Earlier pages win ties so scrolling reads top-down.
 */
export function mostVisiblePage(
  items: readonly PageLayoutItem[],
  scrollTop: number,
  viewportHeight: number,
): number {
  if (items.length === 0) {
    return 0;
  }

  const viewBottom = scrollTop + Math.max(viewportHeight, 1);
  let best = findPageAtOffset(items, scrollTop);
  let bestOverlap = -1;

  for (let index = best; index < items.length; index += 1) {
    const item = items[index]!;

    if (item.top >= viewBottom) {
      break;
    }

    const overlap =
      Math.min(item.top + item.height, viewBottom) - Math.max(item.top, scrollTop);

    if (overlap > bestOverlap + 0.5) {
      bestOverlap = overlap;
      best = index;
    }
  }

  return best;
}

/**
 * Visible pages always mount; the overscan buffer extends below (scroll
 * direction bias) then above, stopping at either the per-side page cap or
 * the shared canvas-byte budget.
 */
export function computeMountedRange(
  items: readonly PageLayoutItem[],
  scrollTop: number,
  viewportHeight: number,
  budgetBytes = MAX_OVERSCAN_BYTES,
  maxPagesPerSide = MAX_OVERSCAN_PAGES_PER_SIDE,
): MountedRange {
  if (items.length === 0) {
    return { start: 0, end: -1 };
  }

  const viewBottom = scrollTop + Math.max(viewportHeight, 1);
  const first = findPageAtOffset(items, scrollTop);
  let last = first;

  while (last + 1 < items.length && items[last + 1]!.top < viewBottom) {
    last += 1;
  }

  let overscanBytes = 0;
  let end = last;

  for (let step = 0; step < maxPagesPerSide && end + 1 < items.length; step += 1) {
    const cost = estimateCanvasBytes(items[end + 1]!);

    if (overscanBytes + cost > budgetBytes) {
      break;
    }

    overscanBytes += cost;
    end += 1;
  }

  let start = first;

  for (let step = 0; step < maxPagesPerSide && start - 1 >= 0; step += 1) {
    const cost = estimateCanvasBytes(items[start - 1]!);

    if (overscanBytes + cost > budgetBytes) {
      break;
    }

    overscanBytes += cost;
    start -= 1;
  }

  return { start, end };
}

/** Smallest range covering both — used to freeze mounts mid text-selection. */
export function unionRange(left: MountedRange, right: MountedRange): MountedRange {
  if (left.end < left.start) {
    return right;
  }

  if (right.end < right.start) {
    return left;
  }

  return {
    start: Math.min(left.start, right.start),
    end: Math.max(left.end, right.end),
  };
}
