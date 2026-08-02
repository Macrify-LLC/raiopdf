// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackIntegrityBanner } from "./PackIntegrityBanner";

describe("PackIntegrityBanner", () => {
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

  it("can be dismissed from its accessible close button", () => {
    act(() => {
      root.render(<PackIntegrityBanner message="Jurisdiction rules could not be verified." />);
    });

    const closeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close jurisdiction rules warning"]',
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
