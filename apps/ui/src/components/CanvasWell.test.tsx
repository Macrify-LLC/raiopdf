// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= class DOMMatrixStub {};
});
import { CanvasWell } from "./CanvasWell";

describe("CanvasWell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lets the user dismiss a document message", () => {
    const onErrorDismiss = vi.fn();

    act(() => {
      root.render(
        <CanvasWell
          error={{ message: "Some tools are turned off.", diagnosticId: null }}
          onErrorDismiss={onErrorDismiss}
        />,
      );
    });

    const closeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close message"]',
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());

    expect(onErrorDismiss).toHaveBeenCalledOnce();
  });
});
