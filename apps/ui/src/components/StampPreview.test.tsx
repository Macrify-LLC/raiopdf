// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StampPreview, type StampPreviewStyle } from "./StampPreview";

describe("StampPreview", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  function renderStamp(stamp: StampPreviewStyle): HTMLElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<StampPreview stamp={stamp} scale={1} />);
    });

    const element = container.querySelector<HTMLElement>(".stamp-preview");
    if (!element) {
      throw new Error("StampPreview did not render its root element.");
    }
    return element;
  }

  const baseStamp: StampPreviewStyle = {
    lines: ["Exhibit A"],
    widthPt: 115.2,
    heightPt: 72,
    fontSizePt: 14,
  };

  // Border geometry is resolved synchronously (it doesn't wait on the async
  // preview-font load), so it can be asserted right after the first render.

  it("previews an imported stamp that omits borderWidthPt with the engine's 1pt default", () => {
    const element = renderStamp({
      ...baseStamp,
      borderColor: { r: 0, g: 0, b: 0 },
      // borderWidthPt intentionally omitted — the shape a reopened/imported
      // stamp is in when the source PDF's annotation left it unset.
    });

    expect(element.style.borderWidth).toBe("1px");
    expect(element.style.borderStyle).toBe("solid");
  });

  it("still honors an explicit borderWidthPt instead of the default", () => {
    const element = renderStamp({
      ...baseStamp,
      borderColor: { r: 0, g: 0, b: 0 },
      borderWidthPt: 3,
    });

    expect(element.style.borderWidth).toBe("3px");
  });

  it("draws no border when borderColor is explicitly null, regardless of borderWidthPt", () => {
    const element = renderStamp({
      ...baseStamp,
      borderColor: null,
    });

    expect(element.style.borderWidth).toBe("0px");
    expect(element.style.borderStyle).toBe("none");
  });
});
