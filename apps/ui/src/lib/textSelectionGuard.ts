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
 */

const SELECTING_CLASS = "page-view__text-layer--selecting";
const LAYER_SELECTOR = ".page-view__text-layer";

const textLayers = new Map<HTMLElement, HTMLElement>();

let selectionChangeAC: AbortController | null = null;
let prevRange: Range | null = null;

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
  textLayers.set(container, endOfContent);

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
    textLayers.delete(container);
    container.classList.remove(SELECTING_CLASS);
    if (textLayers.size === 0) {
      selectionChangeAC?.abort();
      selectionChangeAC = null;
      prevRange = null;
    }
  };
}

function reset(endOfContent: HTMLElement, container: HTMLElement): void {
  // Re-park the sentinel as the layer's last child; the selectionchange
  // handler may have moved it next to a span deep inside the layer. Skip the
  // no-op case -- every DOM mutation near a live drag-selection is a chance
  // for Chromium to abandon the drag.
  if (endOfContent.parentNode !== container || endOfContent.nextSibling !== null) {
    container.append(endOfContent);
  }
  endOfContent.style.width = "";
  endOfContent.style.height = "";
  endOfContent.style.userSelect = "";
  container.classList.remove(SELECTING_CLASS);
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
      for (const [textLayerDiv, endDiv] of textLayers) {
        if (activeTextLayers.has(textLayerDiv)) {
          textLayerDiv.classList.add(SELECTING_CLASS);
        } else {
          reset(endDiv, textLayerDiv);
        }
      }

      // Gecko handles the whitespace hit-test well on its own; the sentinel
      // repositioning below is the Blink/WebKit path (WebView2 today, WKWebView
      // for the future macOS build).
      const firstLayer = textLayers.keys().next().value;
      if (
        firstLayer &&
        getComputedStyle(firstLayer).getPropertyValue("-moz-user-select") === "none"
      ) {
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

      const anchorElement = anchor instanceof Element ? anchor : anchor.parentElement;
      const parentTextLayer = anchorElement?.closest<HTMLElement>(LAYER_SELECTOR);
      const endDiv = parentTextLayer ? textLayers.get(parentTextLayer) : undefined;
      if (endDiv && parentTextLayer && anchor.parentElement) {
        if (endDiv.style.width !== parentTextLayer.style.width) {
          endDiv.style.width = parentTextLayer.style.width;
        }
        if (endDiv.style.height !== parentTextLayer.style.height) {
          endDiv.style.height = parentTextLayer.style.height;
        }
        // Selectable while parked at the edge: the browser extends the
        // selection into the empty sentinel instead of hunting past it.
        if (endDiv.style.userSelect !== "text") {
          endDiv.style.userSelect = "text";
        }
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
