import type {
  PdfInspectTextMapResult,
  PdfRedactionArea,
  PdfSelectedTextTarget,
  PdfTextMapElement,
  PdfTextMapPage,
} from "@raiopdf/engine-api";

export interface CapturedTextSelection {
  pageIndex: number;
  text: string;
  pageText: string;
  start: number;
  end: number;
}

export type TextSelectionCaptureResult =
  | { ok: true; selection: CapturedTextSelection }
  | { ok: false; reason: "empty" | "invalid"; message: string };

export type TextSelectionResolveResult =
  | { ok: true; area: PdfRedactionArea; target: PdfSelectedTextTarget }
  | { ok: false; message: string };

export const TEXT_LAYER_SELECTOR = ".page-view__text-layer[data-page-index]";

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

  return {
    ok: true,
    selection: {
      pageIndex,
      text,
      pageText,
      start,
      end,
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

  if (selection.pageText === page.text) {
    const target = targetForRange(textMap.sourceFingerprint, page, selection.start, selection.end);

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

  return {
    ok: false,
    message: "The selected text does not match the editable PDF text map. PDFs with inferred spacing are refused for selected-text edits.",
  };
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

  if (areas.length === 0) {
    return null;
  }

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

function targetForRange(
  sourceDocumentFingerprint: string,
  page: PdfTextMapPage,
  start: number,
  end: number,
): PdfSelectedTextTarget | null {
  if (start < 0 || end <= start || page.text.slice(start, end).length !== end - start) {
    return null;
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
