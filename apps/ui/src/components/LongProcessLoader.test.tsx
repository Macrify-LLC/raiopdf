import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LongProcessLoader } from "./LongProcessLoader";
import { DockedProcessLoader } from "./DockedProcessLoader";

describe("LongProcessLoader", () => {
  it("renders counted progress and optional steps", () => {
    const html = renderToStaticMarkup(
      <LongProcessLoader
        phaseLabel="Preparing filing"
        message="Normalizing pages..."
        progress={{ current: 2.8, total: 5, unit: "page" }}
        steps={[
          { id: "normalize", label: "Normalize", state: "done" },
          { id: "split", label: "Split", state: "active" },
        ]}
      />,
    );

    expect(html).toContain("Preparing filing");
    expect(html).toContain("Normalizing pages...");
    expect(html).toContain("2 of 5 pages");
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-state="active"');
  });

  it("renders cancel controls only when cancellation is real", () => {
    const html = renderToStaticMarkup(
      <LongProcessLoader
        message="Printing..."
        cancelMode="cancel"
        cancelLabel="Cancel Printing"
        cancelMessage="Stops after the current part."
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("Cancel Printing");
    expect(html).toContain("Stops after the current part.");
  });

  it("does not render cancel controls without explicit real-cancel mode", () => {
    const html = renderToStaticMarkup(
      <LongProcessLoader
        message="Making searchable..."
        cancelLabel="Cancel OCR"
        onCancel={vi.fn()}
      />,
    );

    expect(html).not.toContain("Cancel OCR");
  });

  it("hides invalid progress totals and formats percentages", () => {
    const invalid = renderToStaticMarkup(
      <LongProcessLoader message="Working..." progress={{ current: 1, total: 0, unit: "page" }} />,
    );
    const percent = renderToStaticMarkup(
      <LongProcessLoader message="Finishing..." progress={{ current: 49.8, total: 100, unit: "%" }} />,
    );

    expect(invalid).not.toContain("0 pages");
    expect(percent).toContain("49%");
  });
});

describe("DockedProcessLoader", () => {
  it("renders phase, horizontal steps, and determinate progress without dialog chrome", () => {
    const html = renderToStaticMarkup(
      <DockedProcessLoader
        phaseLabel="Make Searchable"
        message="Making searchable: 2 of 5 pages"
        progress={{ current: 2, total: 5, unit: "page" }}
        steps={[
          { id: "ocr", label: "OCR", state: "active" },
          { id: "verify", label: "Verify", state: "pending" },
        ]}
      />,
    );

    expect(html).toContain("docked-process-loader");
    expect(html).toContain("Make Searchable");
    expect(html).toContain("Making searchable: 2 of 5 pages");
    expect(html).toContain("2 of 5 pages");
    expect(html).toContain('data-state="active"');
    expect(html).not.toContain("floating-dialog__header");
    expect(html).not.toContain("Prepare for Filing menu");
  });

  it("renders a real cancel action when supplied", () => {
    const html = renderToStaticMarkup(
      <DockedProcessLoader
        message="Making searchable..."
        cancelLabel="Cancel OCR"
        cancelMessage="Stops the OCR run."
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("Cancel OCR");
    expect(html).toContain("Stops the OCR run.");
  });

  it("disables the cancel action after cancellation is requested", () => {
    const html = renderToStaticMarkup(
      <DockedProcessLoader
        message="Cancelling OCR..."
        cancelRequested
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("Cancelling...");
    expect(html).toContain("disabled");
  });
});
