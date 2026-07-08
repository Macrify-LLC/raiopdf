import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OcrDialog } from "./OcrDialog";

describe("OcrDialog", () => {
  it("renders the confirm form", () => {
    const html = renderToStaticMarkup(
      <OcrDialog
        phase="confirm"
        pageCount={5}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("All 5 pages will be processed.");
    expect(html).toContain("Make searchable");
  });

  it("returns no dialog for running phases", () => {
    const html = renderToStaticMarkup(
      <OcrDialog
        phase="starting-engine"
        pageCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toBe("");
  });

  it("restores the configure dialog with the OCR error", () => {
    const html = renderToStaticMarkup(
      <OcrDialog
        phase="error"
        pageCount={2}
        errorMessage="OCR could not finish."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("OCR could not finish.");
    expect(html).toContain("Try again");
  });
});
