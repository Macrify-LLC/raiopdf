// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignatureInvalidationNotice } from "../hooks/useDocument";
import { DocumentBanner } from "./DocumentBanner";

describe("DocumentBanner", () => {
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

  it("accurately identifies the working copy and exposes a labeled close button", () => {
    const onDismiss = vi.fn();

    act(() => {
      root.render(<DocumentBanner notice={notice} onDismiss={onDismiss} />);
    });

    expect(container.textContent).toContain("invalidated in this working copy");
    expect(container.textContent).toContain(
      "The original file on disk is unchanged: signed.pdf.",
    );

    const closeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close digital signature warning"]',
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

const notice: SignatureInvalidationNotice = {
  source: "owner-restricted",
  sourceFileNames: ["signed.pdf"],
  sourceFilePath: "C:\\cases\\signed.pdf",
  signature: {
    standardAcroFormSignatureCount: 1,
    hasByteRangeOrContentsMarkers: true,
    hasCertificationDictionary: false,
  },
};
