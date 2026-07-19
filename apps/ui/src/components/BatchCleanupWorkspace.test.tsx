import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPack } from "@raiopdf/rules";
import { BatchCleanupWorkspace, type BatchCleanupSourceFile } from "./BatchCleanupWorkspace";

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

  it("renders a Browse button that is disabled outside the desktop app", () => {
    const html = renderToStaticMarkup(
      <BatchCleanupWorkspace
        currentFile={mockFile}
        packs={[getPack()]}
        progress={{ running: false, message: null, result: null }}
        onAddFile={async () => null}
        onRun={async () => undefined}
      />,
    );

    expect(html).toContain("Browse…");
    // jsdom/node has no __TAURI_INTERNALS__, so the affordance renders
    // disabled with its reason — the same gate the plain-browser build hits.
    expect(html).toContain("Browsing for a folder only works in the installed RaioPDF app.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Browse…<\/button>/);
  });

  it("offers Open folder on the completion card when a reveal handler is wired", () => {
    const progress = {
      running: false,
      message: null,
      result: {
        packageRoot: "/tmp/package",
        reportPdf: "/tmp/package/report.pdf",
        reportJson: "/tmp/package/report.json",
        files: [],
      },
    };

    const withHandler = renderToStaticMarkup(
      <BatchCleanupWorkspace
        currentFile={mockFile}
        packs={[getPack()]}
        progress={progress}
        onAddFile={async () => null}
        onRun={async () => undefined}
        onOpenPackageRoot={() => undefined}
      />,
    );
    expect(withHandler).toContain("Open folder");

    const withoutHandler = renderToStaticMarkup(
      <BatchCleanupWorkspace
        currentFile={mockFile}
        packs={[getPack()]}
        progress={progress}
        onAddFile={async () => null}
        onRun={async () => undefined}
      />,
    );
    expect(withoutHandler).not.toContain("Open folder");
  });
});

// No bytes anywhere: the workspace's queue is path-based end-to-end, so a
// streamed (large) current document seeds the queue exactly like a small one.
const mockFile: BatchCleanupSourceFile = {
  name: "source.pdf",
  path: "/home/jacob/cases/source.pdf",
};
