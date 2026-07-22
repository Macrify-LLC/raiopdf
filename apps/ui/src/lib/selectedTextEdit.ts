import type {
  PdfInspectTextMapResult,
  PdfRedactionArea,
  PdfSelectedTextTarget,
  PdfTextMapElement,
  PdfTextMapPage,
} from "@raiopdf/engine-api";
import { buildPdfVisualTextMap } from "@raiopdf/engine-api";
import {
  viewportRectToPdfRect,
  type PageViewport,
} from "./viewportGeometry";

export interface CapturedTextSelection {
  pageIndex: number;
  text: string;
  pageText: string;
  start: number;
  end: number;
  /** The browser-highlighted occurrence in PDF page coordinates. */
  area?: PdfRedactionArea;
}

export type TextSelectionCaptureResult =
  | { ok: true; selection: CapturedTextSelection }
  | { ok: false; reason: "empty" | "invalid"; message: string };

export type TextSelectionResolveResult =
  | { ok: true; area: PdfRedactionArea; target: PdfSelectedTextTarget }
  | { ok: false; message: string };

type VisualTargetMatchResult =
  | { status: "unique"; area: PdfRedactionArea; target: PdfSelectedTextTarget }
  | { status: "ambiguous" | "missing" };

const textLayerViewports = new WeakMap<HTMLElement, PageViewport>();

export const TEXT_LAYER_SELECTOR = ".page-view__text-layer[data-page-index]";

/**
 * Associates a rendered pdf.js text layer with its rotation/zoom-aware page
 * viewport. Selection capture can then retain the mouse-highlighted rectangle
 * in PDF coordinates, even when focus moves into the canvas edit bar.
 */
export function registerTextLayerViewport(
  layer: HTMLElement,
  viewport: PageViewport,
): () => void {
  textLayerViewports.set(layer, viewport);
  return () => {
    if (textLayerViewports.get(layer) === viewport) {
      textLayerViewports.delete(layer);
    }
  };
}

export function captureCurrentTextSelection(
  selection: Selection | null = window.getSelection(),
): TextSelectionCaptureResult {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return {
      ok: false,
      reason: "empty",
      message: "Select text on one page before queuing a selected replacement.",
    };
  }

  const range = selection.getRangeAt(0);
  const startLayer = closestTextLayer(range.startContainer);
  const endLayer = closestTextLayer(range.endContainer);

  if (!startLayer || !endLayer || startLayer !== endLayer) {
    return {
      ok: false,
      reason: "invalid",
      message: "Selected text editing only supports one page at a time.",
    };
  }

  const pageIndex = Number(startLayer.dataset.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return {
      ok: false,
      reason: "invalid",
      message: "RaioPDF could not identify the selected page.",
    };
  }

  const text = selection.toString();
  if (!text.trim()) {
    return {
      ok: false,
      reason: "empty",
      message: "Select visible text before queuing a selected replacement.",
    };
  }

  const pageText = textContent(startLayer);
  const start = textOffsetBefore(startLayer, range.startContainer, range.startOffset);
  const end = start + text.length;

  if (pageText.slice(start, end) !== text) {
    return {
      ok: false,
      reason: "invalid",
      message: "RaioPDF could not resolve that browser selection. Try selecting the text again.",
    };
  }

  const area = selectionArea(range, startLayer, pageIndex);
  return {
    ok: true,
    selection: {
      pageIndex,
      text,
      pageText,
      start,
      end,
      ...(area ? { area } : {}),
    },
  };
}

export function selectionForReplacement(
  currentSelection: TextSelectionCaptureResult,
  savedSelection: CapturedTextSelection | null,
): TextSelectionCaptureResult {
  if (currentSelection.ok) {
    return currentSelection;
  }

  if (currentSelection.reason === "empty" && savedSelection) {
    return { ok: true, selection: savedSelection };
  }

  return currentSelection;
}

export function resolveSelectedTextTarget(
  selection: CapturedTextSelection,
  textMap: PdfInspectTextMapResult,
): TextSelectionResolveResult {
  const page = textMap.pages.find((candidate) => candidate.pageIndex === selection.pageIndex);

  if (!page) {
    return {
      ok: false,
      message: "RaioPDF could not read the selected page's editable text map.",
    };
  }

  const visualText = buildPdfVisualTextMap(page);
  if (selection.pageText === visualText.text) {
    const target = targetForVisualRange(
      textMap.sourceFingerprint,
      page,
      visualText,
      selection.start,
      selection.end,
    );

    if (!target) {
      return {
        ok: false,
        message: "The selected text does not line up with the editable PDF text map.",
      };
    }

    const area = areaForTarget(page, target);
    if (!area) {
      return {
        ok: false,
        message: "RaioPDF could not locate the selected text on the page.",
      };
    }

    return { ok: true, area, target };
  }

  // OCR and pdf.js may expose different whole-page whitespace or reading
  // order even when selected text maps cleanly to the editable PDF. In that
  // case DOM offsets are not trustworthy, so match every safe exact occurrence
  // and use the browser-highlighted PDF rectangle to identify which one the
  // user selected. The engine still revalidates raw/visible text, element and
  // document fingerprints before mutation.
  const fallback = targetForVisualTextAtArea(
    textMap.sourceFingerprint,
    page,
    visualText,
    selection.text,
    selection.area,
  );
  if (fallback.status === "unique") {
    return { ok: true, area: fallback.area, target: fallback.target };
  }
  if (fallback.status === "ambiguous") {
    return {
      ok: false,
      message: "Nothing changed. RaioPDF found the text more than once but could not safely identify the highlighted occurrence in the PDF text map.",
    };
  }

  return {
    ok: false,
    message: "Nothing changed. The highlighted text and its position do not line up with a safe editable PDF text map.",
  };
}

function targetForVisualTextAtArea(
  sourceDocumentFingerprint: string,
  page: PdfTextMapPage,
  visualMap: ReturnType<typeof buildPdfVisualTextMap>,
  selectedText: string,
  selectedArea: PdfRedactionArea | undefined,
): VisualTargetMatchResult {
  if (!selectedText || selectedText !== selectedText.trim()) {
    return { status: "missing" };
  }

  const matches: Array<{ area: PdfRedactionArea; target: PdfSelectedTextTarget }> = [];
  let fromIndex = 0;
  while (fromIndex <= visualMap.text.length - selectedText.length) {
    const start = visualMap.text.indexOf(selectedText, fromIndex);
    if (start < 0) {
      break;
    }
    const target = targetForVisualRange(
      sourceDocumentFingerprint,
      page,
      visualMap,
      start,
      start + selectedText.length,
    );
    const area = target ? areaForTarget(page, target) : null;
    if (target && area) {
      matches.push({ area, target });
    }
    fromIndex = start + Math.max(1, selectedText.length);
  }

  if (matches.length === 0) {
    return { status: "missing" };
  }
  if (matches.length === 1) {
    return { status: "unique", ...matches[0]! };
  }
  if (!selectedArea) {
    return { status: "ambiguous" };
  }

  const ranked = matches
    .map((match) => ({ match, score: spatialMatchScore(selectedArea, match.area) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0]!;
  const runnerUp = ranked[1]!;

  // A positive score requires either meaningful box overlap or a close center
  // match. The margin prevents overlapping/duplicate PDF text objects from
  // being guessed at when they occupy effectively the same visual location.
  if (best.score < 0 || best.score - runnerUp.score < 0.35) {
    return { status: "ambiguous" };
  }

  return { status: "unique", ...best.match };
}

function spatialMatchScore(selected: PdfRedactionArea, candidate: PdfRedactionArea): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(selected.x + selected.w, candidate.x + candidate.w) - Math.max(selected.x, candidate.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(selected.y + selected.h, candidate.y + candidate.h) - Math.max(selected.y, candidate.y),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const smallerArea = Math.max(1, Math.min(selected.w * selected.h, candidate.w * candidate.h));
  const overlap = intersection / smallerArea;
  const selectedCenterX = selected.x + selected.w / 2;
  const selectedCenterY = selected.y + selected.h / 2;
  const candidateCenterX = candidate.x + candidate.w / 2;
  const candidateCenterY = candidate.y + candidate.h / 2;
  const xScale = Math.max(4, selected.w, candidate.w);
  const yScale = Math.max(4, selected.h, candidate.h);
  const distance = Math.hypot(
    (selectedCenterX - candidateCenterX) / xScale,
    (selectedCenterY - candidateCenterY) / yScale,
  );

  if (overlap < 0.2 && distance > 1.25) {
    return -1;
  }
  return overlap * 4 - distance;
}

function areaForTarget(
  page: PdfTextMapPage,
  target: PdfSelectedTextTarget,
): PdfRedactionArea | null {
  const targetElements = page.elements
    .filter((element) => (
      element.elementIndex >= target.firstElementIndex &&
      element.elementIndex <= target.lastElementIndex
    ));
  if (targetElements.length === 0 || !elementsShareBaseline(targetElements)) {
    return null;
  }

  const areas = targetElements.map((element) => clipElementArea(element, target));
  return areas.reduce(unionAreas);
}

function elementsShareBaseline(elements: readonly PdfTextMapElement[]): boolean {
  if (elements.length <= 1) {
    return true;
  }

  const first = elements[0]!.area;
  const tolerance = Math.max(2, first.h * 0.75);

  return elements.every((element) => (
    Math.abs(element.area.y - first.y) <= tolerance &&
    Math.abs(element.area.h - first.h) <= tolerance
  ));
}

function clipElementArea(
  element: PdfTextMapElement,
  target: PdfSelectedTextTarget,
): PdfRedactionArea {
  const overlapStart = Math.max(element.start, target.start);
  const overlapEnd = Math.min(element.end, target.end);
  const elementLength = element.end - element.start;

  if (elementLength <= 0 || (overlapStart <= element.start && overlapEnd >= element.end)) {
    return element.area;
  }

  const fractionStart = (overlapStart - element.start) / elementLength;
  const fractionEnd = (overlapEnd - element.start) / elementLength;

  return {
    ...element.area,
    x: element.area.x + element.area.w * fractionStart,
    w: Math.max(1, element.area.w * (fractionEnd - fractionStart)),
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

function targetForVisualRange(
  sourceDocumentFingerprint: string,
  page: PdfTextMapPage,
  visualMap: ReturnType<typeof buildPdfVisualTextMap>,
  visibleStart: number,
  visibleEnd: number,
): PdfSelectedTextTarget | null {
  if (
    visibleStart < 0 ||
    visibleEnd <= visibleStart ||
    visibleEnd > visualMap.rawOffsets.length ||
    visualMap.text.length !== visualMap.rawOffsets.length
  ) {
    return null;
  }

  const selectedOffsets = visualMap.rawOffsets.slice(visibleStart, visibleEnd);
  const rawOffsets = selectedOffsets.filter(
    (offset): offset is number => offset !== null,
  );
  if (rawOffsets.length === 0 || selectedOffsets[0] === null || selectedOffsets.at(-1) === null) {
    return null;
  }

  const start = rawOffsets[0]!;
  const end = rawOffsets.at(-1)! + 1;
  let expectedRawOffset = start;
  for (const rawOffset of selectedOffsets) {
    if (rawOffset !== null) {
      if (rawOffset !== expectedRawOffset) {
        return null;
      }
      expectedRawOffset += 1;
    }
  }

  const first = page.elements.find((element) => start >= element.start && start < element.end);
  const last = [...page.elements]
    .reverse()
    .find((element) => end > element.start && end <= element.end);

  if (!first || !last || !rangeTouchesContiguousElements(page.elements, first, last)) {
    return null;
  }

  return {
    pageIndex: page.pageIndex,
    start,
    end,
    expectedText: page.text.slice(start, end),
    expectedVisibleText: visualMap.text.slice(visibleStart, visibleEnd),
    sourceDocumentFingerprint,
    sourceFingerprint: page.sourceFingerprint,
    firstElementIndex: first.elementIndex,
    lastElementIndex: last.elementIndex,
    firstElementOffset: start - first.start,
    lastElementOffset: end - last.start,
  };
}

function rangeTouchesContiguousElements(
  elements: readonly PdfTextMapElement[],
  first: PdfTextMapElement,
  last: PdfTextMapElement,
): boolean {
  for (let index = first.elementIndex; index <= last.elementIndex; index += 1) {
    if (elements[index]?.elementIndex !== index) {
      return false;
    }
  }

  return true;
}

/**
 * Walks up from a `Range` boundary node to the `.page-view__text-layer` that
 * owns it, if any. Shared by both selected-text editing (above) and
 * highlight-to-redact (`PageView.tsx`) — the two features that need to know
 * which page's text layer a live browser selection belongs to.
 */
export function closestTextLayer(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>(TEXT_LAYER_SELECTOR) ?? null;
}

function textContent(layer: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(layer);
  const text = range.toString();
  range.detach();
  return text;
}

function textOffsetBefore(root: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  const text = range.toString();
  range.detach();
  return text.length;
}

function selectionArea(
  range: Range,
  layer: HTMLElement,
  pageIndex: number,
): PdfRedactionArea | undefined {
  const viewport = textLayerViewports.get(layer);
  if (!viewport || typeof range.getClientRects !== "function") {
    return undefined;
  }

  const bounds = layer.getBoundingClientRect();
  const rects = Array.from(range.getClientRects()).filter((rect) => (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > bounds.left &&
    rect.left < bounds.right &&
    rect.bottom > bounds.top &&
    rect.top < bounds.bottom
  ));
  if (rects.length === 0 || bounds.width <= 0 || bounds.height <= 0) {
    return undefined;
  }

  const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)) - bounds.left);
  const top = Math.max(0, Math.min(...rects.map((rect) => rect.top)) - bounds.top);
  const right = Math.min(bounds.width, Math.max(...rects.map((rect) => rect.right)) - bounds.left);
  const bottom = Math.min(bounds.height, Math.max(...rects.map((rect) => rect.bottom)) - bounds.top);
  if (right <= left || bottom <= top) {
    return undefined;
  }

  return {
    pageIndex,
    ...viewportRectToPdfRect(
      { left, top, width: right - left, height: bottom - top },
      viewport,
    ),
  };
}
