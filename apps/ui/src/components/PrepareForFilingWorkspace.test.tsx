import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPack, preflight } from "@raiopdf/rules";
import { PrepareForFilingWorkspace } from "./PrepareForFilingWorkspace";
import type { DocumentState } from "../hooks/useDocument";

const MiB = 1024 * 1024;

describe("PrepareForFilingWorkspace", () => {
  it("renders selection checks from the output preflight report", () => {
    const pack = getPack();
    const report = preflight(
      {
        filename: "motion - part 1 of 2.pdf",
        fileBytes: 14 * MiB,
        searchableText: true,
        pdfaCompliant: true,
        pages: [],
      },
      pack,
      {
        files: [
          { filename: "motion - part 1 of 2.pdf", fileBytes: 14 * MiB },
          { filename: "motion - part 2 of 2.pdf", fileBytes: 14 * MiB },
        ],
      },
    );

    const html = renderToStaticMarkup(
      <PrepareForFilingWorkspace
        document={mockDocument}
        pack={pack}
        report={null}
        loadingReport={false}
        progress={{ phase: "done", message: null }}
        result={{
          parts: [
            {
              fileName: "motion - part 1 of 2.pdf",
              byteLength: 14 * MiB,
              pageIndexes: [0],
              oversized: false,
            },
            {
              fileName: "motion - part 2 of 2.pdf",
              byteLength: 14 * MiB,
              pageIndexes: [1],
              oversized: false,
            },
          ],
          report,
          verifiedAt: "2026-07-03T00:00:00.000Z",
        }}
        impact={null}
        pdfAAvailable
        compressAvailable
        onPrepare={() => undefined}
        onDismissImpact={() => undefined}
        onCompressFirst={() => undefined}
      />,
    );

    expect(html).toContain("Portal envelope size cap");
    expect(html).toContain("exceeding");
    expect(html).toContain("warning");
  });
});

const mockDocument: DocumentState = {
  bytes: new Uint8Array([1]),
  engineHandle: null,
  pageCount: 2,
  currentPage: 1,
  zoom: 1,
  dirty: false,
  fitWidth: true,
  fileName: "motion.pdf",
  filePath: null,
  fileSizeBytes: 28 * MiB,
  hasTextLayer: true,
  pageSizeInches: null,
  error: null,
};
