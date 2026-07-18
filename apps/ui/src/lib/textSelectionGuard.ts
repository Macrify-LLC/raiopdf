/**
 * Text-selection whitespace guard for the pdf.js text layer.
 *
 * The viewer renders selectable text with pdf.js's bare `TextLayer`, which
 * (unlike the viewer-level `TextLayerBuilder`) ships no "endOfContent"
 * sentinel. Without one, dragging a selection through whitespace -- the gap
 * between paragraphs -- makes Chromium snap the selection focus to the
 * nearest text below and the highlight runs away to the bottom of the next
 * paragraph.
 *
 * This is a faithful port of TextLayerBuilder's guard (pdf.js
 * web/text_layer_builder.js, global selection listeners), with pdf.js's
 * `.textLayer` / `.endOfContent` / `.selecting` class names mapped to this
 * app's `page-view__text-layer` / `__text-end` / `--selecting`. Two pieces
 * work together:
 *
 * - While the pointer is down inside a layer, the layer's `--selecting`
 *   class expands the sentinel from a parked zero-height strip to cover the
 *   whole layer beneath the spans, so whitespace under the drag hits an
 *   unselectable div instead of snapping to far-away text.
 * - On every selectionchange, the sentinel is re-inserted in the DOM right
 *   next to the selection's moving edge and made selectable. When the cursor
 *   then hovers it, the browser extends the selection into the empty
 *   sentinel -- i.e. to a boundary immediately adjacent to where the
 *   selection already ends -- so the focus stays put instead of running away.
 *
 * The module also OWNS THE SELECTION PAINT. Native `::selection` is
 * translucent and paints one rect per text node; pdf.js text layers fragment
 * lines into many overlapping runs (word processors emit a run per word), so
 * the native paint double-tints wherever runs overlap -- visibly darker
 * bands over the spaces between words. Native `::selection` is therefore
 * transparent in the text layer (PageList.css), and this module paints the
 * selection itself: client rects merged into one box per visual line, drawn
 * once per line into a per-page overlay. Same approach as pdf.js's
 * `enableSelectionRendering` draw layer, sized to this app.
 */

import { mergeClientRectsIntoLines } from "./clientRectLines";
import { closestTextLayer } from "./selectedTextEdit";

const SELECTING_CLASS = "page-view__text-layer--selecting";

interface GuardedLayer {
  endOfContent: HTMLElement;
  paintOverlay: HTMLElement;
}

const textLayers = new Map<HTMLElement, GuardedLayer>();

let selectionChangeAC: AbortController | null = null;
let prevRange: Range | null = null;
// Cached Gecko probe (upstream pdf.js caches this too): selectionchange is a
// hot path and getComputedStyle forces a style resolution per call.
let isGecko: boolean | null = null;

/**
 * Register a rendered text-layer container: creates and appends the sentinel
 * and installs the shared document-level listeners while at least one layer
 * is registered. Returns an unregister callback for the effect cleanup; the
 * caller clears the container's children (including the sentinel) itself.
 */
export function registerTextSelectionGuard(container: HTMLElement): () => void {
  const endOfContent = document.createElement("div");
  endOfContent.className = "page-view__text-end";
  container.append(endOfContent);

  // The paint overlay lives OUTSIDE the text layer, as its earlier sibling:
  // it must not rotate with `data-main-rotation` (client rects are already
  // visual coordinates) and must paint beneath the layer's spans.
  const paintOverlay = document.createElement("div");
  paintOverlay.className = "page-view__selection-paint";
  container.parentElement?.insertBefore(paintOverlay, container);

  textLayers.set(container, { endOfContent, paintOverlay });

  // Arm the guard the moment a drag could start: with `--selecting` set
  // before the first pointer move, the expanded sentinel catches a drag that
  // heads straight into whitespace, so the runaway never forms. (Class
  // toggling at mousedown does not disturb Chromium's native drag; the
  // selectionchange handler below keeps the class in sync afterwards.)
  const mousedownAC = new AbortController();
  container.addEventListener(
    "mousedown",
    () => {
      container.classList.add(SELECTING_CLASS);
    },
    { signal: mousedownAC.signal },
  );

  enableGlobalSelectionListener();

  return () => {
    mousedownAC.abort();
    paintOverlay.remove();
    textLayers.delete(container);
    container.classList.remove(SELECTING_CLASS);
    if (textLayers.size === 0) {
      selectionChangeAC?.abort();
      selectionChangeAC = null;
      prevRange = null;
    }
  };
}

function reset(layer: GuardedLayer, container: HTMLElement): void {
  const { endOfContent } = layer;
  // Fast path: nothing to undo. This runs for every registered layer on
  // every selectionchange outside the viewer (typing in the search box, form
  // fields), so skip the DOM writes when the sentinel is already parked.
  // NOTE: reset() runs on pointerup while the selection persists, so it must
  // never clear the paint overlay -- paint syncs only to selectionchange.
  if (
    endOfContent.parentNode === container &&
    endOfContent.nextSibling === null &&
    !container.classList.contains(SELECTING_CLASS) &&
    endOfContent.style.width === ""
  ) {
    return;
  }
  // Re-park the sentinel as the layer's last child; the selectionchange
  // handler may have moved it next to a span deep inside the layer.
  container.append(endOfContent);
  endOfContent.style.width = "";
  endOfContent.style.height = "";
  endOfContent.style.userSelect = "";
  container.classList.remove(SELECTING_CLASS);
}

/**
 * Repaint one layer's selection overlay from the live selection's client
 * rects. Rects are clipped to the layer's own bounds (a cross-page selection
 * reports rects for every page), the sentinel's box is excluded (mid-drag it
 * is selectable and sized to the whole layer), and the result is merged into
 * one box per visual line so overlapping text runs tint exactly once.
 */
function paintSelection(
  layer: GuardedLayer,
  container: HTMLElement,
  selection: Selection,
): void {
  const containerBounds = container.getBoundingClientRect();
  const sentinelBounds = layer.endOfContent.getBoundingClientRect();
  const rects: DOMRect[] = [];

  for (let i = 0; i < selection.rangeCount; i++) {
    for (const rect of selection.getRangeAt(i).getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      if (
        rect.right < containerBounds.left ||
        rect.left > containerBounds.right ||
        rect.bottom < containerBounds.top ||
        rect.top > containerBounds.bottom
      ) {
        continue;
      }
      if (
        Math.abs(rect.left - sentinelBounds.left) < 1 &&
        Math.abs(rect.top - sentinelBounds.top) < 1 &&
        Math.abs(rect.right - sentinelBounds.right) < 1 &&
        Math.abs(rect.bottom - sentinelBounds.bottom) < 1
      ) {
        continue;
      }
      rects.push(rect);
    }
  }

  const lines = mergeClientRectsIntoLines(rects);
  const overlay = layer.paintOverlay;
  const overlayBounds = overlay.getBoundingClientRect();

  while (overlay.childElementCount > lines.length) {
    overlay.lastElementChild?.remove();
  }
  while (overlay.childElementCount < lines.length) {
    overlay.append(document.createElement("div"));
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const box = overlay.children[i] as HTMLElement;
    box.style.left = `${line.left - overlayBounds.left}px`;
    box.style.top = `${line.top - overlayBounds.top}px`;
    box.style.width = `${line.right - line.left}px`;
    box.style.height = `${line.bottom - line.top}px`;
  }
}

function clearPaint(layer: GuardedLayer): void {
  if (layer.paintOverlay.childElementCount > 0) {
    layer.paintOverlay.replaceChildren();
  }
}

function enableGlobalSelectionListener(): void {
  if (selectionChangeAC) {
    return;
  }
  selectionChangeAC = new AbortController();
  const { signal } = selectionChangeAC;

  let isPointerDown = false;
  document.addEventListener(
    "pointerdown",
    () => {
      isPointerDown = true;
    },
    { signal },
  );
  document.addEventListener(
    "pointerup",
    () => {
      isPointerDown = false;
      textLayers.forEach(reset);
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      isPointerDown = false;
      textLayers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    "keyup",
    () => {
      if (!isPointerDown) {
        textLayers.forEach(reset);
      }
    },
    { signal },
  );

  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        textLayers.forEach(reset);
        textLayers.forEach(clearPaint);
        return;
      }

      // Even though the spec says rangeCount should be 0 or 1, Firefox
      // creates multiple ranges when selecting across pages.
      const activeTextLayers = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const textLayerDiv of textLayers.keys()) {
          if (!activeTextLayers.has(textLayerDiv) && range.intersectsNode(textLayerDiv)) {
            activeTextLayers.add(textLayerDiv);
          }
        }
      }
      for (const [textLayerDiv, layer] of textLayers) {
        if (activeTextLayers.has(textLayerDiv)) {
          textLayerDiv.classList.add(SELECTING_CLASS);
          paintSelection(layer, textLayerDiv, selection);
        } else {
          reset(layer, textLayerDiv);
          clearPaint(layer);
        }
      }

      // Selection lives entirely outside the viewer (search box, form
      // fields, dialogs) -- by far the most frequent case. Everything below
      // only matters for a selection inside a text layer, so stop here.
      // (Deviation from pdf.js, which runs the tail unconditionally.)
      if (activeTextLayers.size === 0) {
        prevRange = null;
        return;
      }

      // Gecko handles the whitespace hit-test well on its own; the sentinel
      // repositioning below is the Blink/WebKit path (WebView2 today,
      // WKWebView for the future macOS build).
      if (isGecko === null) {
        const firstLayer = textLayers.keys().next().value;
        if (!firstLayer) {
          return;
        }
        isGecko =
          getComputedStyle(firstLayer).getPropertyValue("-moz-user-select") === "none";
      }
      if (isGecko) {
        return;
      }

      const range = selection.getRangeAt(0);
      const modifyStart =
        prevRange !== null &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
      if (anchor && anchor.nodeType === Node.TEXT_NODE) {
        anchor = anchor.parentNode;
      }
      // A range that ends at offset 0 of a node visibly ends after the
      // previous node -- walk back to the element the selection ends in.
      if (anchor && !modifyStart && range.endOffset === 0) {
        do {
          while (anchor && !anchor.previousSibling) {
            anchor = anchor.parentNode;
          }
          anchor = anchor?.previousSibling ?? null;
        } while (anchor && anchor.childNodes.length === 0);
      }
      if (!anchor) {
        return;
      }

      // Resolve the owning layer from the anchor's PARENT, exactly like
      // pdf.js: when the selection boundary is the text-layer element itself
      // (the browser can land there after extending into the sentinel), a
      // self-matching closest() would pass the layer here and the insert
      // below -- which uses anchor.parentElement -- would move the sentinel
      // OUTSIDE the layer, disarming the guard until the next reset.
      const parentTextLayer = anchor.parentElement ? closestTextLayer(anchor.parentElement) : null;
      const endDiv = parentTextLayer ? textLayers.get(parentTextLayer)?.endOfContent : undefined;
      if (endDiv && parentTextLayer && anchor.parentElement) {
        endDiv.style.width = parentTextLayer.style.width;
        endDiv.style.height = parentTextLayer.style.height;
        // Selectable while parked at the edge: the browser extends the
        // selection into the empty sentinel instead of hunting past it.
        endDiv.style.userSelect = "text";
        // Skip the insert when already in position -- insertBefore detaches
        // and reattaches even for a same-position move, and every mutation
        // near a live drag-selection risks Chromium abandoning the drag.
        const target = modifyStart ? anchor : anchor.nextSibling;
        if (
          endDiv !== target &&
          (endDiv.parentNode !== anchor.parentElement || endDiv.nextSibling !== target)
        ) {
          anchor.parentElement.insertBefore(endDiv, target);
        }
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}
