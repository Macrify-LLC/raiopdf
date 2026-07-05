// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfOutlineState } from "@raiopdf/engine-api";
import { DocumentNavPanel } from "./DocumentNavPanel";

describe("DocumentNavPanel", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    host?.remove();
    root = null;
    host = null;
  });

  it("switches from page thumbnails to the bookmarks alternate view", async () => {
    const container = renderPanel();

    expect(getButton(container, "Pages").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).not.toContain("Existing bookmark");

    await click(getButton(container, "Bookmarks"));

    expect(getButton(container, "Bookmarks").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Existing bookmark");
  });

  it("collapses the navigation panel while leaving the active view easy to reopen", async () => {
    const container = renderPanel();

    await click(getButton(container, "Bookmarks"));
    await click(getButton(container, "Hide navigation"));

    expect(container.querySelector(".document-nav-panel--collapsed")).not.toBeNull();
    expect(getButton(container, "Show bookmarks").textContent).toContain("Bookmarks");

    await click(getButton(container, "Show bookmarks"));

    expect(container.querySelector(".document-nav-panel--collapsed")).toBeNull();
    expect(getButton(container, "Bookmarks").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Existing bookmark");
  });

  function renderPanel(): HTMLElement {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <DocumentNavPanel
          pdfDocument={null}
          pageCount={3}
          currentPage={1}
          selectedPageIndexes={new Set()}
          outline={mockOutline}
          outlineStatus={null}
          onBookmarkNavigate={vi.fn()}
          onOutlineChange={() => Promise.resolve(true)}
        />,
      );
    });

    return host;
  }
});

const mockOutline: PdfOutlineState = {
  openMode: "default",
  revision: "test",
  items: [
    {
      id: "existing",
      title: "Existing bookmark",
      target: { kind: "page", pageIndex: 0 },
    },
  ],
};

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function getButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name);

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button "${name}" was not rendered.`);
  }

  return button;
}
