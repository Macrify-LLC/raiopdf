// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPack, preflight, resolvePrepPlan } from "@raiopdf/rules";
import { PrepareForFilingWorkspace } from "./PrepareForFilingWorkspace";
import type { DocumentState } from "../hooks/useDocument";
import type { FileGrant } from "../lib/filePort";

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

  it("keeps unchecked prep steps neutral and disfavored pack guidance toggleable", () => {
    const pack = getPack("florida");
    const html = renderToStaticMarkup(
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

    expect(html).not.toContain("Prohibited");
    expect(html).not.toContain("Not needed");
    expect(articleContaining(html, "Flatten forms")).toContain('data-disabled="false"');
    expect(rowContaining(html, "Flatten forms")).not.toMatch(/<input[^>]*disabled/);
  });

  it("shows advisory flags when expected or recommended steps are unchecked", () => {
    const indiana = getPack("indiana-iefs");
    const florida = getPack("florida");

    render(
      <>
        <PrepareForFilingWorkspace
          document={mockDocument}
          pack={indiana}
          prepPlan={resolvePrepPlan(indiana, mockFacts)}
          stepDefaultOverrides={{ "scrub-metadata": false }}
          courtProfiles={[]}
          selectedCourtProfile={null}
          facts={mockFacts}
          report={preflight(mockFacts, indiana)}
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
        />
        <PrepareForFilingWorkspace
          document={mockDocument}
          pack={florida}
          prepPlan={resolvePrepPlan(florida, mockFacts)}
          stepDefaultOverrides={{ "convert-pdfa": false }}
          courtProfiles={[]}
          selectedCourtProfile={null}
          facts={mockFacts}
          report={preflight(mockFacts, florida)}
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
        />
      </>,
    );

    click(getButtonByLabel("Expected by this jurisdiction for Scrub metadata"));
    expect(document.body.textContent).toContain("This jurisdiction expects this step.");

    click(getButtonByLabel("Recommended by this jurisdiction for Convert to PDFA-2B"));
    expect(document.body.textContent).toContain("Recommended for this jurisdiction.");
    expect(document.body.textContent).toContain("verified");
  });

  it("treats Florida sanitize guidance as an expected removal action", () => {
    const pack = getPack("florida");

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

    const sanitizeCheckbox = getCheckbox("Sanitize active and embedded content");
    expect(sanitizeCheckbox.checked).toBe(true);
    expect(
      queryButtonByLabel("Pack guidance differs from this selection for Sanitize active and embedded content"),
    ).toBeNull();

    click(getButtonByLabel("Show details for Sanitize active and embedded content"));
    expect(rowContaining(document.body.innerHTML, "Sanitize active and embedded content")).toContain("Required");
    expect(rowContaining(document.body.innerHTML, "Sanitize active and embedded content")).not.toContain("Not preferred");

    click(sanitizeCheckbox);
    click(getButtonByLabel("Expected by this jurisdiction for Sanitize active and embedded content"));

    expect(document.body.textContent).toContain("This jurisdiction expects this step.");
    expect(document.body.textContent).toContain("Florida Courts Technology Standards v4.0, adopted May 2025");
  });

  it("shows a red advisory flag when a checked step differs from pack guidance", () => {
    const pack = getPack("florida");

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

    const flattenCheckbox = getCheckbox("Flatten forms");
    expect(flattenCheckbox.disabled).toBe(false);
    click(flattenCheckbox);
    click(getButtonByLabel("Pack guidance differs from this selection for Flatten forms"));

    expect(document.body.textContent).toContain(
      "Raio research indicates this step is not preferred in this jurisdiction.",
    );
    expect(document.body.textContent).not.toContain("Prohibited");
  });

  it("saves current checklist selections as per-pack defaults", () => {
    const pack = getPack("florida");
    const onStepDefaultOverridesChange = vi.fn();

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
        impact={null}
        pdfAAvailable
        compressAvailable
        onPackChange={() => undefined}
        onCourtProfileSelect={() => undefined}
        onCourtProfileSave={() => undefined}
        onStepDefaultOverridesChange={onStepDefaultOverridesChange}
        onPrepare={() => undefined}
        onDismissImpact={() => undefined}
        onCompressFirst={() => undefined}
      />,
    );

    click(getCheckbox("Convert to PDFA-2B"));
    click(getButton("Set current selections as my defaults for this pack"));

    expect(onStepDefaultOverridesChange).toHaveBeenCalledWith(expect.objectContaining({
      "convert-pdfa": false,
      "flatten-forms": false,
    }));
    expect(document.body.textContent).toContain("Saved as your defaults for this pack.");
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
          normalizePagesSelected: false,
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

  it("warns that normalize pages bakes kept RaioPDF markup", () => {
    const pack = getPack();

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
          markupAnnotationCount: 1,
          normalizePagesSelected: true,
        }}
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

    expect(document.body.textContent).toContain(
      "Normalize pages will bake kept markup into the filing copy",
    );
  });

  it("enables the streamed run once facts load, honoring the closed-form step rule", () => {
    const pack = getPack();
    // The closed-form rule's output [R7-1]: steps without a registered path
    // op arrive as extraUnavailableSteps and must render disabled.
    const extraUnavailableSteps = new Map([
      ["convert-pdfa", "not available for very large files yet"],
      ["flatten-forms", "not available for very large files yet"],
    ] as const);

    const html = renderToStaticMarkup(
      <PrepareForFilingWorkspace
        document={streamedDocument}
        pack={pack}
        prepPlan={resolvePrepPlan(pack, mockFacts)}
        extraUnavailableSteps={extraUnavailableSteps}
        courtProfiles={[]}
        selectedCourtProfile={null}
        facts={mockFacts}
        report={preflight(mockFacts, pack)}
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

    // Enable gate: bytes present OR (streamed AND facts loaded) — facts are
    // loaded here, so the primary button must NOT be disabled.
    const buttonIndex = html.indexOf('class="filing-card__primary-button"');
    const primaryButton = html.slice(buttonIndex, html.indexOf(">", buttonIndex));
    expect(primaryButton).not.toContain("disabled");
    // A step the rule disabled renders as a locked row.
    expect(articleContaining(html, "Convert to PDFA")).toContain('data-disabled="true"');
    // The empty state must not claim no document is open.
    expect(html).not.toContain("Open a PDF before preparing a filing copy.");
  });

  it("keeps the streamed run disabled until the facts-based preflight loads", () => {
    const pack = getPack();
    const html = renderToStaticMarkup(
      <PrepareForFilingWorkspace
        document={streamedDocument}
        pack={pack}
        prepPlan={resolvePrepPlan(pack, mockFacts)}
        courtProfiles={[]}
        selectedCourtProfile={null}
        facts={null}
        report={null}
        loadingReport
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

    const buttonIndex = html.indexOf('class="filing-card__primary-button"');
    const primaryButton = html.slice(buttonIndex, html.indexOf(">", buttonIndex));
    expect(primaryButton).toContain("disabled");
  });

  it("does not force a password prompt for owner-restricted (usage_restricted) facts", () => {
    const pack = getPack("federal-cmecf");
    const restrictedFacts = {
      ...mockFacts,
      encryptionState: "usage_restricted" as const,
    };
    const onPrepare = vi.fn();

    render(
      <PrepareForFilingWorkspace
        document={mockDocument}
        pack={pack}
        prepPlan={resolvePrepPlan(pack, restrictedFacts)}
        courtProfiles={[]}
        selectedCourtProfile={null}
        facts={restrictedFacts}
        report={preflight(restrictedFacts, pack)}
        loadingReport={false}
        progress={{ phase: "idle", message: null }}
        result={null}
        impact={null}
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

    click(getButton("Make Filing-Ready"));

    // Owner restrictions decrypt with an empty password in both pipelines —
    // the run starts immediately instead of demanding a password that was
    // never set.
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("PDF password");
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

/** Finds the complete `<article>...</article>` block for the row whose text contains `needle`. */
function rowContaining(html: string, needle: string): string {
  const needleIndex = html.indexOf(needle);
  expect(needleIndex).toBeGreaterThan(-1);
  const articleStart = html.lastIndexOf("<article", needleIndex);
  expect(articleStart).toBeGreaterThan(-1);
  const articleEnd = html.indexOf("</article>", needleIndex);
  expect(articleEnd).toBeGreaterThan(-1);
  return html.slice(articleStart, articleEnd + "</article>".length);
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

function getButtonByLabel(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement => element.getAttribute("aria-label") === label,
  );

  if (!button) {
    throw new Error(`Button not found by label: ${label}`);
  }

  return button;
}

function queryButtonByLabel(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement => element.getAttribute("aria-label") === label,
  ) ?? null;
}

function getCheckbox(label: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const matchingLabel = labels.find((element) => element.textContent?.trim() === label);
  const input = matchingLabel?.querySelector("input[type='checkbox']");

  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Checkbox not found: ${label}`);
  }

  return input;
}

function click(element: HTMLElement) {
  act(() => {
    element.click();
  });
}

const mockDocument: DocumentState = {
  bytes: new Uint8Array([1]),
  source: { kind: "memory", bytes: new Uint8Array([1]) },
  generation: 1,
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
  outline: null,
  outlineStatus: null,
  signatureInvalidationNotice: null,
  error: null,
};

const mockFacts = {
  pages: [],
  fileBytes: 28 * MiB,
  filename: "motion.pdf",
};

// Streamed (large) document: no bytes, no engine handle — the source is a
// range grant and the workspace runs the reduced path-based pipeline.
const streamedDocument: DocumentState = {
  ...mockDocument,
  bytes: null,
  source: {
    kind: "rangeGrant",
    grant: "grant-appendix" as FileGrant,
    sizeBytes: 283 * MiB,
    generation: 1,
  },
  fileName: "appendix.pdf",
  filePath: "grant-appendix",
  fileSizeBytes: 283 * MiB,
  pageCount: 2556,
  hasTextLayer: null,
  textLayerCoverage: null,
};
