// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPack, preflight, resolvePrepPlan } from "@raiopdf/rules";
import { PrepareForFilingWorkspace } from "./PrepareForFilingWorkspace";
import type { DocumentState } from "../hooks/useDocument";

const MiB = 1024 * 1024;

describe("PrepareForFilingWorkspace", () => {
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
        prepPlan={resolvePrepPlan(pack, mockFacts)}
        courtProfiles={[]}
        selectedCourtProfile={null}
        facts={mockFacts}
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
          skippedSteps: [],
          overrides: [],
        }}
        impact={null}
        pdfAAvailable
        compressAvailable
        onPackChange={() => undefined}
        onCourtProfileSelect={() => undefined}
        onCourtProfileSave={() => undefined}
        onPrepare={() => undefined}
        onDismissImpact={() => undefined}
        onCompressFirst={() => undefined}
      />,
    );

    expect(html).toContain("Portal envelope size cap");
    expect(html).toContain("exceeding");
    expect(html).toContain("warning");
  });

  it("shows a filing-check read failure near the preflight checks", () => {
    const pack = getPack();
    const html = renderToStaticMarkup(
      <PrepareForFilingWorkspace
        document={mockDocument}
        pack={pack}
        prepPlan={resolvePrepPlan(pack, mockFacts)}
        courtProfiles={[]}
        selectedCourtProfile={null}
        facts={mockFacts}
        report={null}
        loadingReport={false}
        reportError="RaioPDF could not read the facts needed for filing checks."
        progress={{ phase: "idle", message: null }}
        result={null}
        impact={null}
        pdfAAvailable
        compressAvailable
        onPackChange={() => undefined}
        onCourtProfileSelect={() => undefined}
        onCourtProfileSave={() => undefined}
        onPrepare={() => undefined}
        onDismissImpact={() => undefined}
        onCompressFirst={() => undefined}
      />,
    );

    expect(html).toContain("RaioPDF could not read the facts needed for filing checks.");
    expect(html).toContain("disabled=");
  });

  it("renders the remove-encryption prep step as available for encrypted facts", () => {
    const pack = getPack("federal-cmecf");
    const encryptedFacts = {
      ...mockFacts,
      encryptionState: "encrypted" as const,
    };
    const html = renderToStaticMarkup(
      <PrepareForFilingWorkspace
        document={mockDocument}
        pack={pack}
        prepPlan={resolvePrepPlan(pack, encryptedFacts)}
        courtProfiles={[]}
        selectedCourtProfile={null}
        facts={encryptedFacts}
        report={null}
        loadingReport={false}
        progress={{ phase: "idle", message: null }}
        result={null}
        impact={null}
        pdfAAvailable
        compressAvailable
        onPackChange={() => undefined}
        onCourtProfileSelect={() => undefined}
        onCourtProfileSave={() => undefined}
        onPrepare={() => undefined}
        onDismissImpact={() => undefined}
        onCompressFirst={() => undefined}
      />,
    );

    expect(html).toContain("Remove encryption");
    // Item 6/7 collapses each rule's detail paragraph (where "Raio will ask
    // for the password..." and "not yet available in Raio" used to live)
    // behind a chevron, default-closed -- so "available" is now asserted at
    // the always-visible one-line row instead: its `data-disabled` flag.
    expect(articleContaining(html, "Remove encryption")).toContain('data-disabled="false"');
  });

  it("asks whether to flatten RaioPDF markup annotations before filing", () => {
    const pack = getPack();
    const onPrepare = vi.fn();

    render(
      <PrepareForFilingWorkspace
        document={mockDocument}
        pack={pack}
        prepPlan={resolvePrepPlan(pack, mockFacts)}
        courtProfiles={[]}
        selectedCourtProfile={null}
        facts={mockFacts}
        report={preflight(mockFacts, pack)}
        loadingReport={false}
        progress={{ phase: "idle", message: null }}
        result={null}
        impact={{
          conversionImpact: null,
          unappliedRedactionMarks: 0,
          markupAnnotationCount: 2,
        }}
        pdfAAvailable
        compressAvailable
        onPackChange={() => undefined}
        onCourtProfileSelect={() => undefined}
        onCourtProfileSave={() => undefined}
        onPrepare={onPrepare}
        onDismissImpact={() => undefined}
        onCompressFirst={() => undefined}
      />,
    );

    expect(document.body.textContent).toContain("RaioPDF markup annotation");
    click(getButton("Flatten them"));

    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(onPrepare.mock.calls[0]?.[1]).toMatchObject({
      acknowledgeImpact: true,
      markupAnnotations: "flatten",
    });
  });

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
  }
});

/** Finds the `<article ...>` opening tag for the row whose text contains `needle`. */
function articleContaining(html: string, needle: string): string {
  const needleIndex = html.indexOf(needle);
  expect(needleIndex).toBeGreaterThan(-1);
  const articleStart = html.lastIndexOf("<article", needleIndex);
  expect(articleStart).toBeGreaterThan(-1);
  const articleTagEnd = html.indexOf(">", articleStart);
  return html.slice(articleStart, articleTagEnd + 1);
}

function getButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement => element.textContent?.trim() === name,
  );

  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }

  return button;
}

function click(button: HTMLButtonElement) {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

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
  textLayerCoverage: {
    imageOnlyPages: [],
    mixedPages: [],
    textPages: [0, 1],
    garbledPages: [],
  },
  pageSizeInches: null,
  signatureInvalidationNotice: null,
  error: null,
};

const mockFacts = {
  pages: [],
  fileBytes: 28 * MiB,
  filename: "motion.pdf",
};
