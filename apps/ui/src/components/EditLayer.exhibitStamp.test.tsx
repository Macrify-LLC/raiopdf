// @vitest-environment jsdom
import { act, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExhibitStampAllocation } from "../lib/exhibitStamps";
import { exhibitLabelLines, formatExhibitLabel } from "../lib/exhibitLabels";
import { DEFAULT_TEXT_COLOR } from "../lib/editStyles";
import type { PendingEdit, PendingExhibitStamp } from "../lib/edits";
import type { PDFPageProxy } from "../lib/pdfjs";
import type { PageViewport } from "../lib/viewportGeometry";
import type { ArmedExhibitStamp, EditingState } from "../hooks/useEditing";
import { EditLayer } from "./EditLayer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEMPLATE: ArmedExhibitStamp["template"] = {
  version: 1,
  id: "plaintiffs-exhibit",
  name: "Plaintiff's Exhibit",
  prefix: "Plaintiff's Exhibit",
  identifierStyle: "numbers",
  nextIndex: 0,
  layout: "stacked",
  widthPt: 100,
  heightPt: 60,
  fontFamily: "helvetica",
  bold: true,
  italic: false,
  fontSizePt: 14,
  textColor: DEFAULT_TEXT_COLOR,
  fillColor: { r: 1, g: 1, b: 1 },
  borderColor: DEFAULT_TEXT_COLOR,
  borderWidthPt: 1,
  cornerRadiusPt: 4,
  createdAt: 0,
  updatedAt: 0,
};

describe("EditLayer exhibit stamps", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latestEdits: readonly PendingEdit[] = [];
  let allocationFails = false;
  let originalSetPointerCapture: typeof HTMLElement.prototype.setPointerCapture | undefined;

  beforeEach(() => {
    latestEdits = [];
    allocationFails = false;
    originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = () => undefined;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();

    if (originalSetPointerCapture) {
      HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    }
  });

  it("previews the next label under the cursor before anything is placed", async () => {
    await renderLayer("stamp");
    const layer = getLayer();

    await act(async () => {
      dispatchPointerEvent(layer, "pointermove", 120, 120);
      await Promise.resolve();
    });

    const ghost = container?.querySelector<HTMLElement>(".edit-layer__stamp-ghost");
    expect(ghost).not.toBeNull();
    // Centered on the pointer at the template's designed size.
    expect(ghost?.style.left).toBe("70px");
    expect(ghost?.style.top).toBe("90px");
    expect(ghost?.textContent).toBe("Plaintiff's Exhibit1");
    // Nothing is placed until the page is clicked.
    expect(latestEdits).toHaveLength(0);
  });

  it("stays armed and stamps consecutive numbers on repeat clicks", async () => {
    // The double-place guard suppresses a second click inside 350ms, so the
    // clock has to move the way it would between two deliberate stamps.
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    await renderLayer("stamp");
    const layer = getLayer();

    await act(async () => {
      dispatchPointerEvent(layer, "pointerdown", 120, 120);
      await Promise.resolve();
    });

    expect(placedStamps()).toHaveLength(1);
    expect(placedStamps()[0]?.lines).toEqual(["Plaintiff's Exhibit", "1"]);
    expect(placedStamps()[0]?.sequence?.index).toBe(0);
    // The design baseline is the box as placed, so a later resize scales from it.
    expect(placedStamps()[0]?.design).toEqual({
      widthPt: 100,
      heightPt: 60,
      fontSizePt: 14,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
    });

    // The ghost already previews the next number.
    await act(async () => {
      dispatchPointerEvent(layer, "pointermove", 60, 60);
      await Promise.resolve();
    });
    expect(
      container?.querySelector(".edit-layer__stamp-ghost")?.textContent,
    ).toBe("Plaintiff's Exhibit2");

    // The tool never disarmed, so the next click stamps the next exhibit.
    clock += 500;
    await act(async () => {
      dispatchPointerEvent(layer, "pointerdown", 60, 60);
      await Promise.resolve();
    });

    expect(placedStamps().map((stamp) => stamp.lines[1])).toEqual(["1", "2"]);
  });

  it("places nothing when the exhibit number could not be reserved", async () => {
    allocationFails = true;
    await renderLayer("stamp");
    const layer = getLayer();

    await act(async () => {
      dispatchPointerEvent(layer, "pointerdown", 120, 120);
      await Promise.resolve();
    });

    expect(placedStamps()).toHaveLength(0);
    expect(container?.querySelectorAll(".edit-layer__exhibit-stamp")).toHaveLength(0);
  });

  it("opens the gallery instead of stamping when nothing is armed", async () => {
    const setStampCardOpen = vi.fn();
    await renderLayer("stamp", [], { armedExhibitStamp: null, setStampCardOpen });

    await act(async () => {
      dispatchPointerEvent(getLayer(), "pointerdown", 120, 120);
      await Promise.resolve();
    });

    expect(setStampCardOpen).toHaveBeenCalledWith(true);
    expect(placedStamps()).toHaveLength(0);
  });

  it("moves a placed stamp without touching its label size", async () => {
    await renderLayer("select", [placedStamp()]);
    const stamp = container?.querySelector<HTMLElement>(".edit-layer__exhibit-stamp");
    expect(stamp).not.toBeNull();

    await act(async () => {
      dispatchPointerEvent(stamp!, "pointerdown", 25, 25);
      dispatchPointerEvent(stamp!, "pointermove", 45, 35);
      dispatchPointerEvent(stamp!, "pointerup", 45, 35);
      await Promise.resolve();
    });

    expect(placedStamps()[0]).toMatchObject({
      rect: { x: 40, y: 30, w: 100, h: 60 },
      fontSizePt: 14,
      borderWidthPt: 1,
    });
  });

  it("scales the label and border by one factor when a corner is dragged", async () => {
    await renderLayer("select", [{ ...placedStamp(), status: "draft" }], {
      selectedEditId: "stamp-1",
    });

    const handle = container?.querySelector<HTMLElement>(
      ".edit-layer__resize-handle[data-corner='se']",
    );
    expect(handle).not.toBeNull();

    // Drag the SE corner out by 100px on the wide axis; the aspect lock takes
    // the height with it.
    await act(async () => {
      dispatchPointerEvent(handle!, "pointerdown", 120, 80);
      dispatchPointerEvent(handle!, "pointermove", 220, 80);
      dispatchPointerEvent(handle!, "pointerup", 220, 80);
      await Promise.resolve();
    });

    const resized = placedStamps()[0]!;

    expect(resized.rect.w).toBe(200);
    expect(resized.rect.w / resized.rect.h).toBeCloseTo(100 / 60, 5);
    // One factor (2x) drives the label, the border, and the rounding together.
    expect(resized.fontSizePt).toBe(28);
    expect(resized.borderWidthPt).toBe(2);
    expect(resized.cornerRadiusPt).toBe(8);
    expect(resized.design).toEqual(placedStamp().design);
  });

  it("renumbers one sticker from the Edit label popover", async () => {
    await renderLayer("select", [placedStamp()]);
    const layer = getLayer();
    stubLayerBounds(layer);

    await act(async () => {
      layer.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 50, button: 2 }),
      );
      await Promise.resolve();
    });

    expect(contextMenuLabels()).toEqual(["Edit label...", "Pin", "Delete"]);

    await act(async () => {
      findContextMenuItem("Edit label...").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    const input = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Exhibit number or letter"]',
    );
    expect(input?.value).toBe("1");

    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      setValue?.call(input, "7");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(placedStamps()[0]).toMatchObject({
      lines: ["Plaintiff's Exhibit", "7"],
      sequence: { index: 6 },
    });
    expect(container?.querySelector('input[aria-label="Exhibit number or letter"]')).toBeNull();
  });

  it("removes a placed stamp through the shared removal door", async () => {
    const removeEdit = vi.fn();
    await renderLayer("select", [placedStamp()], { removeEdit });

    const remove = container?.querySelector<HTMLElement>(".edit-layer__pin-remove");
    expect(remove).not.toBeNull();

    await act(async () => {
      remove!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(removeEdit).toHaveBeenCalledWith("stamp-1");
  });

  function placedStamps(): PendingExhibitStamp[] {
    return latestEdits.filter((edit): edit is PendingExhibitStamp => edit.kind === "stamp");
  }

  function getLayer(): HTMLElement {
    const layer = container?.querySelector<HTMLElement>(".edit-layer");

    if (!layer) {
      throw new Error("Edit layer not rendered.");
    }

    stubLayerBounds(layer);

    return layer;
  }

  function contextMenuLabels(): string[] {
    return [...(container?.querySelectorAll(".context-menu__item") ?? [])].map(
      (item) => item.textContent ?? "",
    );
  }

  function findContextMenuItem(label: string): HTMLElement {
    const item = [
      ...(container?.querySelectorAll<HTMLElement>(".context-menu__item") ?? []),
    ].find((candidate) => candidate.textContent === label);

    if (!item) {
      throw new Error(`Context-menu item not found: ${label}`);
    }

    return item;
  }

  async function renderLayer(
    tool: EditingState["tool"],
    initialEdits: readonly PendingEdit[] = [],
    overrides: Partial<EditingState> = {},
  ): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Harness
          tool={tool}
          initialEdits={initialEdits}
          overrides={overrides}
          allocationFails={allocationFails}
          onEdits={(edits) => {
            latestEdits = edits;
          }}
        />,
      );
      await Promise.resolve();
    });
  }
});

/**
 * Stands in for the store-backed editing state: a template whose counter only
 * moves when a stamp is actually allocated, so the layer's "allocate, then
 * place" ordering is what the assertions see.
 */
function Harness({
  tool,
  initialEdits,
  overrides,
  allocationFails,
  onEdits,
}: {
  tool: EditingState["tool"];
  initialEdits: readonly PendingEdit[];
  overrides: Partial<EditingState>;
  allocationFails: boolean;
  onEdits: (edits: readonly PendingEdit[]) => void;
}) {
  const [pendingEdits, setPendingEdits] = useState(initialEdits);
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null);
  const [nextIndex, setNextIndex] = useState(0);
  const nextIndexRef = useRef(0);

  onEdits(pendingEdits);

  const editing = useMemo<EditingState>(
    () =>
      ({
        tool,
        pendingEdits,
        selectedEditId,
        setSelectedEditId,
        addEdit: (edit: PendingEdit) => setPendingEdits((current) => [...current, edit]),
        updateEdit: (id: string, update: (edit: PendingEdit) => PendingEdit) =>
          setPendingEdits((current) =>
            current.map((edit) => (edit.id === id ? update(edit) : edit)),
          ),
        removeEdit: (id: string) =>
          setPendingEdits((current) => current.filter((edit) => edit.id !== id)),
        draftEditCount: pendingEdits.length,
        appliedEditCount: 0,
        highlightStyle: {},
        textMarkupStyles: { underline: {}, strikethrough: {} },
        shapeStyles: {
          shapeRect: { strokeWidthPt: 1.5, fillColor: null },
          shapeEllipse: { strokeWidthPt: 1.5, fillColor: null },
          shapeLine: { strokeWidthPt: 1.5 },
          shapeArrow: { strokeWidthPt: 1.5 },
        },
        calloutStyle: { strokeWidthPt: 1.5 },
        armedExhibitStamp: armedStamp(nextIndex),
        stampCardOpen: false,
        setStampCardOpen: () => undefined,
        disarmExhibitStamp: () => undefined,
        allocateExhibitStampIdentifier: () => {
          if (allocationFails) {
            return Promise.resolve(null);
          }

          const index = nextIndexRef.current;
          nextIndexRef.current = index + 1;
          setNextIndex(index + 1);

          return Promise.resolve(allocationAt(index));
        },
        disarmImage: () => undefined,
        disarmSignature: () => undefined,
        setTool: () => undefined,
        setMessage: () => undefined,
        ...overrides,
      }) as unknown as EditingState,
    [allocationFails, nextIndex, overrides, pendingEdits, selectedEditId, tool],
  );

  return <EditLayer page={testPage} viewport={testViewport} pageIndex={0} editing={editing} />;
}

function armedStamp(index: number): ArmedExhibitStamp {
  return {
    templateId: TEMPLATE.id,
    label: formatExhibitLabel(TEMPLATE.prefix, TEMPLATE.identifierStyle, index),
    lines: exhibitLabelLines(
      TEMPLATE.prefix,
      TEMPLATE.identifierStyle,
      index,
      TEMPLATE.layout,
    ),
    sequence: {
      schemaVersion: 1,
      identifierStyle: TEMPLATE.identifierStyle,
      prefix: TEMPLATE.prefix,
      layout: TEMPLATE.layout,
      index,
    },
    template: TEMPLATE,
  };
}

function allocationAt(index: number): ExhibitStampAllocation {
  const armed = armedStamp(index);

  return {
    label: armed.label,
    lines: armed.lines,
    sequence: armed.sequence,
    templateId: TEMPLATE.id,
    templateRevision: index + 1,
  };
}

function placedStamp(): PendingExhibitStamp {
  return {
    kind: "stamp",
    id: "stamp-1",
    pageIndex: 0,
    rect: { x: 20, y: 20, w: 100, h: 60 },
    lines: ["Plaintiff's Exhibit", "1"],
    fontSizePt: 14,
    bold: true,
    color: DEFAULT_TEXT_COLOR,
    fillColor: { r: 1, g: 1, b: 1 },
    borderColor: DEFAULT_TEXT_COLOR,
    borderWidthPt: 1,
    cornerRadiusPt: 4,
    templateId: TEMPLATE.id,
    templateRevision: 1,
    sequence: {
      schemaVersion: 1,
      identifierStyle: "numbers",
      prefix: "Plaintiff's Exhibit",
      layout: "stacked",
      index: 0,
    },
    design: {
      widthPt: 100,
      heightPt: 60,
      fontSizePt: 14,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
    },
  };
}

const testPage = {
  getTextContent: async () => ({ items: [] }),
} as unknown as PDFPageProxy;

const testViewport = {
  width: 400,
  height: 400,
  scale: 1,
  rotation: 0,
  convertToPdfPoint: (x: number, y: number) => [x, y],
  convertToViewportPoint: (x: number, y: number) => [x, y],
} as unknown as PageViewport;

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX,
    clientY,
    button: 0,
  }) as PointerEvent;

  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

function stubLayerBounds(layer: HTMLElement): void {
  layer.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 400,
      height: 400,
      right: 400,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
