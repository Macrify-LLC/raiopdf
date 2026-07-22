// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= class DOMMatrixStub {};
});

import type { DocumentState } from "../hooks/useDocument";
import { BinderWorkspace } from "./BinderWorkspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue("Command pick_pdfs_for_add not found"),
}));

const documentState = {
  bytes: null,
  source: { kind: "memory", bytes: new Uint8Array([1, 2, 3]) },
  generation: 1,
  engineHandle: null,
  pageCount: 2,
  currentPage: 1,
  zoom: 1,
  dirty: false,
  fitWidth: false,
  fileName: "current.pdf",
  filePath: null,
  fileSizeBytes: 3,
  hasTextLayer: null,
  textLayerCoverage: null,
  pageSizeInches: null,
  outline: null,
  outlineStatus: null,
  signatureInvalidationNotice: null,
  protectionSource: null,
  protectionFacts: null,
  protectedSourceGrant: null,
  tempBackingGrant: null,
  error: null,
} satisfies DocumentState;

describe("BinderWorkspace", () => {
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

  it("keeps the DOM fallback add input PDF-only", () => {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <BinderWorkspace
          document={documentState}
          onBuildBinder={async () => true}
          onOpenRequested={() => undefined}
          onCancel={() => undefined}
        />,
      );
    });

    const input = window.document.querySelector<HTMLInputElement>(
      'input[aria-label="Add exhibits"]',
    );

    expect(input).not.toBeNull();
    expect(input?.accept).toBe("application/pdf,.pdf");
    expect(input?.accept).not.toContain("docx");
  });

  it("does not mute the stable Add exhibits action when experiments are off", () => {
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<BinderWorkspace document={documentState} onBuildBinder={async () => true} onOpenRequested={() => undefined} onCancel={() => undefined} onCaptionRequested={() => undefined} experimentalFeaturesEnabled={false} />);
    });

    const addExhibits = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Add exhibits"));
    const caption = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Add caption / cover page"));
    expect(addExhibits?.className).not.toContain("experimental-locked");
    expect(caption?.className).toContain("experimental-locked");
    expect(caption?.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Enable it in Settings");
  });
});
