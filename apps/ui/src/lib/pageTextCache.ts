import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { PDFDocumentProxy } from "./pdfjs";
import { getPdfPageTextContent } from "./pdfTextContent";

type TextItemLike = {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  hasEOL?: unknown;
};

interface TextSpan {
  start: number;
  end: number;
  area: PdfRedactionArea;
}

export interface ExtractedPageText {
  pageIndex: number;
  text: string;
  spans: TextSpan[];
}

export interface PageTextSource {
  bytes: Uint8Array;
  pdfDocument: PDFDocumentProxy;
}

export type PageTextInput = PDFDocumentProxy | PageTextSource;

interface PageTextDocumentCache {
  pdfDocument: PDFDocumentProxy;
  pages: Map<number, Promise<ExtractedPageText>>;
}

const REDACTION_PADDING_PT = 2;
const textCaches = new WeakMap<Uint8Array, WeakMap<PDFDocumentProxy, PageTextDocumentCache>>();
// Bare-proxy inputs (the streamed, no-bytes path) cache keyed on the proxy
// itself. Proxy identity IS document identity there: every open and every
// committed generation produces a NEW PDFDocumentProxy, so proxy-keyed
// caching is (openToken, generation)-keyed by construction [R1-8].
const proxyTextCaches = new WeakMap<PDFDocumentProxy, PageTextDocumentCache>();

export async function extractPageText(input: PageTextInput): Promise<ExtractedPageText[]> {
  const pageIndexes = Array.from(
    { length: getPdfDocument(input).numPages },
    (_, pageIndex) => pageIndex,
  );

  return extractPageTextForIndexes(input, pageIndexes);
}

export async function extractPageTextForIndexes(
  input: PageTextInput,
  pageIndexes: readonly number[],
): Promise<ExtractedPageText[]> {
  const cache = isPageTextSource(input) ? getDocumentCache(input) : getProxyCache(input);
  return Promise.all(pageIndexes.map((pageIndex) => getCachedPageText(cache, pageIndex)));
}

function getPdfDocument(input: PageTextInput): PDFDocumentProxy {
  return isPageTextSource(input) ? input.pdfDocument : input;
}

function isPageTextSource(input: PageTextInput): input is PageTextSource {
  return "bytes" in input && "pdfDocument" in input;
}

function getDocumentCache(source: PageTextSource): PageTextDocumentCache {
  let cachesForBytes = textCaches.get(source.bytes);

  if (!cachesForBytes) {
    cachesForBytes = new WeakMap();
    textCaches.set(source.bytes, cachesForBytes);
  }

  let cache = cachesForBytes.get(source.pdfDocument);

  if (!cache) {
    cache = {
      pdfDocument: source.pdfDocument,
      pages: new Map(),
    };
    cachesForBytes.set(source.pdfDocument, cache);
  }

  return cache;
}

function getProxyCache(pdfDocument: PDFDocumentProxy): PageTextDocumentCache {
  let cache = proxyTextCaches.get(pdfDocument);

  if (!cache) {
    cache = {
      pdfDocument,
      pages: new Map(),
    };
    proxyTextCaches.set(pdfDocument, cache);
  }

  return cache;
}

function getCachedPageText(
  cache: PageTextDocumentCache,
  pageIndex: number,
): Promise<ExtractedPageText> {
  const cached = cache.pages.get(pageIndex);

  if (cached) {
    return cached;
  }

  const page = extractSinglePageText(cache.pdfDocument, pageIndex);
  cache.pages.set(pageIndex, page);
  return page;
}

async function extractSinglePageText(
  pdfDocument: PDFDocumentProxy,
  pageIndex: number,
): Promise<ExtractedPageText> {
  const pageNumber = pageIndex + 1;
  const page = await pdfDocument.getPage(pageNumber);
  const textContent = await getPdfPageTextContent(page);
  const spans: TextSpan[] = [];
  let text = "";
  let previousTextItem: TextItemLike | null = null;

  for (const rawItem of textContent.items) {
    const item = rawItem as TextItemLike;
    const itemText = typeof item.str === "string" ? item.str : "";

    if (previousTextItem && itemText) {
      text += inferTextSeparator(previousTextItem, item);
    }

    const start = text.length;
    text += itemText;
    const end = text.length;

    if (itemText.trim()) {
      const area = textItemToRedactionArea(item, pageIndex);

      if (area) {
        spans.push({ start, end, area });
      }
    }

    if (item.hasEOL === true && text && !text.endsWith("\n")) {
      text += "\n";
    }

    if (!itemText) {
      continue;
    }

    previousTextItem = item;
  }

  return {
    pageIndex,
    text,
    spans,
  };
}

function inferTextSeparator(previous: TextItemLike, current: TextItemLike): "" | " " | "\n" {
  const previousText = typeof previous.str === "string" ? previous.str : "";
  const currentText = typeof current.str === "string" ? current.str : "";

  if (
    !previousText ||
    !currentText ||
    /\s$/.test(previousText) ||
    /^\s/.test(currentText) ||
    previous.hasEOL === true
  ) {
    return "";
  }

  const previousMetrics = getTextItemMetrics(previous);
  const currentMetrics = getTextItemMetrics(current);

  if (!previousMetrics || !currentMetrics) {
    return "";
  }

  const lineThreshold = Math.max(previousMetrics.height, currentMetrics.height, 8) * 0.5;

  if (Math.abs(previousMetrics.y - currentMetrics.y) > lineThreshold) {
    return "\n";
  }

  const gap = currentMetrics.x - (previousMetrics.x + previousMetrics.width);
  const spaceThreshold = Math.max(1, Math.max(previousMetrics.height, currentMetrics.height, 8) * 0.15);

  return gap > spaceThreshold ? " " : "";
}

function getTextItemMetrics(
  item: TextItemLike,
): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(item.transform) || item.transform.length < 6) {
    return null;
  }

  const transform = item.transform;
  const x = Number(transform[4]);
  const y = Number(transform[5]);
  const width = Number(item.width);
  const transformHeight = Math.abs(Number(transform[3]));
  const itemHeight = Number(item.height);
  const height = Math.max(
    Number.isFinite(itemHeight) ? Math.abs(itemHeight) : 0,
    Number.isFinite(transformHeight) ? transformHeight : 0,
    8,
  );

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return { x, y, width, height };
}

function textItemToRedactionArea(
  item: TextItemLike,
  pageIndex: number,
): PdfRedactionArea | null {
  if (!Array.isArray(item.transform) || item.transform.length < 6) {
    return null;
  }

  const transform = item.transform;
  const x = Number(transform[4]);
  const baselineY = Number(transform[5]);
  const width = Number(item.width);
  const transformHeight = Math.abs(Number(transform[3]));
  const itemHeight = Number(item.height);
  const height = Math.max(
    Number.isFinite(itemHeight) ? Math.abs(itemHeight) : 0,
    Number.isFinite(transformHeight) ? transformHeight : 0,
    8,
  );

  if (!Number.isFinite(x) || !Number.isFinite(baselineY) || !Number.isFinite(width)) {
    return null;
  }

  return {
    pageIndex,
    x: Math.max(0, x - REDACTION_PADDING_PT),
    y: Math.max(0, baselineY - height * 0.35 - REDACTION_PADDING_PT),
    w: Math.max(1, width + REDACTION_PADDING_PT * 2),
    h: Math.max(1, height * 1.35 + REDACTION_PADDING_PT * 2),
  };
}

function unionAreas(left: PdfRedactionArea, right: PdfRedactionArea): PdfRedactionArea {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.w, right.x + right.w);
  const maxY = Math.max(left.y + left.h, right.y + right.h);

  return {
    pageIndex: left.pageIndex,
    x,
    y,
    w: Math.max(1, maxX - x),
    h: Math.max(1, maxY - y),
  };
}

/**
 * Bounding box that fully covers the matched text range `[start, end)`.
 *
 * Unions the *entire* box of every text span the range touches. Because each
 * span box is already padded (see `textItemToRedactionArea`), the result is
 * deliberately over-inclusive — use this wherever the area must never leave a
 * sliver of the matched text uncovered, i.e. redaction and the sensitive-info
 * scanner. Verified redaction re-extracts to confirm removal, so undershooting
 * here would fail that check.
 */
export function areaForTextRange(
  page: ExtractedPageText,
  start: number,
  end: number,
): PdfRedactionArea | null {
  const matchingSpans = page.spans.filter((span) => span.start < end && span.end > start);

  if (matchingSpans.length === 0) {
    return null;
  }

  return matchingSpans.map((span) => span.area).reduce(unionAreas);
}

/**
 * Tight bounding box clipped to just the matched characters within each span.
 *
 * A pdf.js text item often covers a whole line, so the safe `areaForTextRange`
 * paints far more than a single-word match. This variant slices each touched
 * span's box proportionally to the matched character offsets, so search
 * highlights and edit-match previews frame the word rather than the line.
 *
 * The slice assumes a roughly uniform glyph advance across the text item —
 * per-glyph metrics aren't available at this layer — which is visually correct
 * for the overwhelming majority of matches. It is display-only: never feed this
 * to redaction, which must stay over-inclusive.
 */
export function matchAreaForTextRange(
  page: ExtractedPageText,
  start: number,
  end: number,
): PdfRedactionArea | null {
  const matchingSpans = page.spans.filter((span) => span.start < end && span.end > start);

  if (matchingSpans.length === 0) {
    return null;
  }

  return matchingSpans.map((span) => clipSpanAreaToRange(span, start, end)).reduce(unionAreas);
}

function clipSpanAreaToRange(
  span: TextSpan,
  start: number,
  end: number,
): PdfRedactionArea {
  const spanLength = span.end - span.start;
  const { area } = span;
  const overlapStart = Math.max(start, span.start);
  const overlapEnd = Math.min(end, span.end);

  // Whole span covered (or unmeasurable) → keep the span's own box.
  if (spanLength <= 0 || (overlapStart <= span.start && overlapEnd >= span.end)) {
    return area;
  }

  const fractionStart = (overlapStart - span.start) / spanLength;
  const fractionEnd = (overlapEnd - span.start) / spanLength;

  return {
    pageIndex: area.pageIndex,
    x: area.x + fractionStart * area.w,
    y: area.y,
    w: Math.max(1, (fractionEnd - fractionStart) * area.w),
    h: area.h,
  };
}
