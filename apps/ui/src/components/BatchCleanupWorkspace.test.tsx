import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPack } from "@raiopdf/rules";
import { BatchCleanupWorkspace } from "./BatchCleanupWorkspace";
import type { OpenedFile } from "../lib/filePort";

describe("BatchCleanupWorkspace", () => {
  it("renders human status labels and friendly per-file reasons", () => {
    const html = renderToStaticMarkup(
      <BatchCleanupWorkspace
        currentFile={mockFile}
        packs={[getPack()]}
        progress={{
          running: false,
          message: null,
          result: {
            packageRoot: "/tmp/package",
            reportPdf: "/tmp/package/report.pdf",
            reportJson: "/tmp/package/report.json",
            files: [
              {
                sourceFilename: "source.pdf",
                status: "failed",
                reason: "failed to read /home/jacob/cases/source.pdf",
                outputs: [],
              },
            ],
          },
        }}
        onAddFile={async () => null}
        onRun={async () => undefined}
      />,
    );

    expect(html).toContain("Needs attention");
    expect(html).toContain("That file could not be cleaned up. Check the source PDF and try again.");
    expect(html).not.toContain("/home/jacob/cases/source.pdf");
  });

  it("renders per-file garbled counts and the garble force-OCR decision", () => {
    const html = renderToStaticMarkup(
      <BatchCleanupWorkspace
        currentFile={mockFile}
        packs={[getPack()]}
        progress={{
          running: false,
          message: null,
          result: {
            packageRoot: "/tmp/package",
            reportPdf: "/tmp/package/report.pdf",
            reportJson: "/tmp/package/report.json",
            files: [
              {
                sourceFilename: "source.pdf",
                status: "done",
                reason: null,
                ocrDecision: "Garbled text layer detected; force OCR to rebuild it.",
                ocrType: "force-ocr",
                facts: { garbledPages: 2 },
                outputs: ["out/source.pdf"],
              },
            ],
          },
        }}
        onAddFile={async () => null}
        onRun={async () => undefined}
      />,
    );

    expect(html).toContain("2 garbled pages detected");
    expect(html).toContain("Force OCR: Garbled text layer detected; force OCR to rebuild it.");
  });
});

const mockFile: OpenedFile = {
  name: "source.pdf",
  path: "/home/jacob/cases/source.pdf",
  bytes: new Uint8Array([1]),
};
