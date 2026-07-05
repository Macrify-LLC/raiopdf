import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OcrDialog } from "./OcrDialog";

describe("OcrDialog long-process loader", () => {
  it("passes path-operation progress into the reusable long-process loader", () => {
    const html = renderToStaticMarkup(
      <OcrDialog
        phase="processing"
        pageCount={5}
        progress={{
          jobToken: "job-1",
          phase: "ocr",
          description: "OCR",
          completed: 2.5,
          total: 5,
          unit: "page",
        }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("long-process-loader");
    expect(html).toContain("Making searchable: 2 of 5 pages");
    expect(html).toContain("long-process-loader__progress-bar");
  });
});
