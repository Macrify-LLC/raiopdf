// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// pdfjs-dist's canvas module touches DOMMatrix at import time; jsdom has no
// implementation and this static-markup test never renders a page, so a
// bare stub is enough. Hoisted so it lands before the module graph loads.
vi.hoisted(() => {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= class DOMMatrixStub {};
});
import type { DocumentState } from "../hooks/useDocument";
import type { DocumentSearchState } from "../hooks/useDocumentSearch";
import type { EditingState } from "../hooks/useEditing";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { AppShell, type AppShellProps } from "./AppShell";

describe("AppShell", () => {
  it("keeps the document banner grid slot mounted when no banner renders", () => {
    const html = renderToStaticMarkup(<AppShell {...appShellProps()} />);

    expect(html).toContain("app-shell__document-banner");
    expect(html.indexOf("app-shell__document-banner")).toBeLessThan(
      html.indexOf("app-shell__body"),
    );
  });

  it("shows the canvas engine-starting overlay outside OCR dialog phases", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          pdfDocument: mockPdfDocument,
          ocrStarting: true,
          ocrState: { phase: "idle", message: null },
        })}
      />,
    );

    expect(html).toContain("canvas-well__engine-starting");
    expect(html).toContain("Getting things ready");
  });

  it("suppresses the canvas engine-starting overlay while the OCR dialog is running", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          pdfDocument: mockPdfDocument,
          ocrStarting: true,
          ocrState: { phase: "processing", message: "Making searchable..." },
        })}
      />,
    );

    expect(html).not.toContain("canvas-well__engine-starting");
  });

  it("renders annotation actions in select mode when pending annotations exist", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          pdfDocument: mockPdfDocument,
          modeBar: null,
          editing: {
            ...mockEditing,
            tool: "select",
            pendingEdits: [
              {
                kind: "textBox",
                id: "draft-text",
                pageIndex: 0,
                rect: { x: 10, y: 10, w: 100, h: 40 },
                text: "Draft",
                fontSizePt: 12,
                status: "draft",
              },
              {
                kind: "textBox",
                id: "pinned-text",
                pageIndex: 0,
                rect: { x: 20, y: 20, w: 100, h: 40 },
                text: "Pinned",
                fontSizePt: 12,
                status: "applied",
              },
            ],
            draftEditCount: 1,
            appliedEditCount: 1,
          },
        })}
      />,
    );

    expect(html).toContain("Pin all (1)");
    expect(html).toContain("Unpin all");
    expect(html).toContain("Make markup permanent");
  });

  it("renders the floating markup toolbar for an active viewer", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          pdfDocument: mockPdfDocument,
          workspace: null,
        })}
      />,
    );

    expect(html).toContain("canvas-well__markup-rail-slot");
    expect(html).toContain('aria-label="Markup tools"');
  });

  it("hides the floating markup toolbar without a pdf document", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          pdfDocument: null,
          workspace: null,
        })}
      />,
    );

    expect(html).not.toContain("canvas-well__markup-rail-slot");
    expect(html).not.toContain('aria-label="Markup tools"');
  });

  it("hides the floating markup toolbar while a workspace owns the canvas", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          pdfDocument: mockPdfDocument,
          workspace: <div>Workspace</div>,
        })}
      />,
    );

    expect(html).not.toContain("canvas-well__markup-rail-slot");
    expect(html).not.toContain('aria-label="Markup tools"');
  });

  it("renders interactive document tabs with close labels", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          tabs: [
            { id: "tab-1", fileName: "alpha.pdf", active: true, dirty: true },
            { id: "tab-2", fileName: "beta.pdf", active: false, dirty: false },
          ],
        })}
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Close alpha.pdf"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("beta.pdf");
  });

  it("disables toolbar Save for a clean streamed document", () => {
    const html = renderToStaticMarkup(
      <AppShell {...appShellProps({ document: streamedDocumentState })} />,
    );

    expect(saveButtonMarkup(html)).toContain("disabled");
  });

  it("keeps toolbar Save enabled for a streamed document with pending annotation overlays", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: streamedDocumentState,
          editing: { ...mockEditing, hasUnsavedEdits: true },
        })}
      />,
    );

    expect(saveButtonMarkup(html)).not.toContain("disabled");
  });

  it("keeps toolbar Save enabled for a dirty streamed document", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({ document: { ...streamedDocumentState, dirty: true } })}
      />,
    );

    expect(saveButtonMarkup(html)).not.toContain("disabled");
  });

  it("renders the long-process lockout note", () => {
    const html = renderToStaticMarkup(
      <AppShell
        {...appShellProps({
          document: openDocument,
          longProcessLockoutLabel: "Paused while OCR runs",
        })}
      />,
    );

    expect(html).toContain("Paused while OCR runs");
    expect(html).toContain("command-bar__lockout-note");
    expect(html).toContain("tool-panel__lockout-note");
  });
});

function saveButtonMarkup(html: string): string {
  const match = html.match(/<button[^>]*aria-label="Save"[^>]*>/);
  expect(match).not.toBeNull();
  return match![0];
}

function appShellProps(overrides: Partial<AppShellProps> = {}): AppShellProps {
  return {
    document: mockDocument,
    tabs: [],
    onTabSelected: () => undefined,
    onTabCloseRequested: () => undefined,
    onTabMoveToNewWindowRequested: () => undefined,
    pdfDocument: null,
    documentSearch: mockDocumentSearch,
    selectedPageIndexes: new Set(),
    onOpenRequested: () => undefined,
    onFileDropped: () => undefined,
    onSave: () => undefined,
    onPrint: () => undefined,
    onPreviousPage: () => undefined,
    onNextPage: () => undefined,
    onGoToPage: () => undefined,
    onZoomOut: () => undefined,
    onZoomIn: () => undefined,
    onFitZoomResolved: () => undefined,
    onPageSizeChange: () => undefined,
    onRenderError: () => undefined,
    onThumbnailClick: () => undefined,
    onRotateSelected: () => undefined,
    onDeleteSelected: () => undefined,
    onMoveSelectedUp: () => undefined,
    onMoveSelectedDown: () => undefined,
    onBookmarkNavigate: () => undefined,
    onOutlineChange: () => Promise.resolve(true),
    ocrState: { phase: "idle", message: null },
    ocrAvailable: false,
    wordAvailable: true,
    ocrStarting: false,
    documentBanner: null,
    workspace: null,
    overlay: null,
    activeLegalTool: null,
    activeEditDialogTool: null,
    activeOrganizeTool: null,
    onEditDialogToolSelected: () => undefined,
    onLegalToolSelected: () => undefined,
    onOrganizeToolSelected: () => undefined,
    onMakeSearchable: () => undefined,
    onForceOcr: () => undefined,
    redaction: { phase: "idle", message: null, pendingCount: 0, available: true },
    scanner: { scanning: false, message: null, hits: [] },
    pendingRedactions: [],
    modeBar: null,
    editing: mockEditing,
    onRedactionAreaCreated: () => undefined,
    onRedactionAreaRemoved: () => undefined,
    onConfirmRedactions: () => undefined,
    onCancelRedactions: () => undefined,
    onRunScanner: () => undefined,
    onMarkScannerHit: () => undefined,
    onOpenAbout: () => undefined,
    onHelpRequested: () => undefined,
    pageScrollIntent: null,
    onVisiblePageChange: () => undefined,
    onRotateLeft: () => undefined,
    onRotateRight: () => undefined,
    pageCount: 0,
    sidecarStatus: {
      running: false,
      message: null,
      removed: [],
      beforeBytes: null,
      afterBytes: null,
    },
    onApplyPageNumbers: () => Promise.resolve(true),
    onApplyWatermark: () => Promise.resolve(true),
    compressAvailable: false,
    onCompress: () => Promise.resolve(true),
    onConnectToAi: () => undefined,
    onMenuCommand: () => undefined,
    printMarkupAnnotations: true,
    onPrintMarkupAnnotationsChange: () => undefined,
    onFlattenMarkupAnnotations: () => undefined,
    markupAnnotationMessage: null,
    ...overrides,
  };
}

const mockDocument: DocumentState = {
  bytes: null,
  source: null,
  generation: 0,
  engineHandle: null,
  pageCount: 0,
  currentPage: 1,
  zoom: 1,
  dirty: false,
  fitWidth: true,
  fileName: null,
  filePath: null,
  fileSizeBytes: null,
  hasTextLayer: null,
  textLayerCoverage: null,
  pageSizeInches: null,
  outline: null,
  outlineStatus: null,
  signatureInvalidationNotice: null,
  error: null,
};

const openDocument: DocumentState = {
  ...mockDocument,
  bytes: new Uint8Array([37, 80, 68, 70]),
  source: { kind: "memory", bytes: new Uint8Array([37, 80, 68, 70]) },
  pageCount: 1,
  fileName: "test.pdf",
};

const streamedDocumentState: DocumentState = {
  ...mockDocument,
  source: {
    kind: "rangeFile",
    file: new File([new Uint8Array([37, 80, 68, 70])], "big.pdf"),
    sizeBytes: 4,
    generation: 1,
  },
  generation: 1,
  pageCount: 12,
  fileName: "big.pdf",
  fileSizeBytes: 4,
};

const mockPdfDocument = {
  numPages: 1,
  getPage: vi.fn(),
} as unknown as PDFDocumentProxy;

const mockDocumentSearch: DocumentSearchState = {
  query: "",
  results: [],
  activeIndex: null,
  activeMatch: null,
  status: "idle",
  resultLabel: "",
  warning: null,
  canNavigate: false,
  progress: null,
  setQuery: vi.fn(),
  clear: vi.fn(),
  cancel: vi.fn(),
  goToNext: vi.fn(),
  goToPrevious: vi.fn(),
};

const noop = () => undefined;

const mockEditing: EditingState = {
  tool: "select",
  setTool: noop,
  pendingEdits: [],
  addEdit: noop,
  updateEdit: noop,
  removeEdit: noop,
  clearPending: noop,
  clearPendingEdits: noop,
  draftEditCount: 0,
  appliedEditCount: 0,
  applyPending: noop,
  unapplyPending: noop,
  setEditStatus: noop,
  loadImportedAnnotations: noop,
  armedImage: null,
  handleImageFile: noop,
  disarmImage: noop,
  armedSignature: null,
  signatureCardOpen: false,
  setSignatureCardOpen: noop,
  savedSignatures: [],
  saveSignature: () => false,
  deleteSavedSignature: noop,
  armSignatureFromDataUrl: async () => false,
  disarmSignature: noop,
  flattenOnSave: true,
  setFlattenOnSave: noop,
  hasFormFields: false,
  formValues: {},
  setFormValue: noop,
  highlightStyle: {},
  updateHighlightStyle: noop,
  textBoxStyle: {},
  updateTextBoxStyle: noop,
  inkStyle: { strokeWidthPt: 1.5 },
  updateInkStyle: noop,
  selectedEditId: null,
  setSelectedEditId: noop,
  textMarkupStyles: {
    underline: {},
    strikethrough: {},
  },
  updateTextMarkupStyle: noop,
  shapeStyles: {
    shapeRect: { strokeWidthPt: 1.5, fillColor: null },
    shapeEllipse: { strokeWidthPt: 1.5, fillColor: null },
    shapeLine: { strokeWidthPt: 1.5 },
    shapeArrow: { strokeWidthPt: 1.5 },
  },
  updateShapeStyle: noop,
  calloutStyle: { strokeWidthPt: 1.5 },
  updateCalloutStyle: noop,
  message: null,
  setMessage: noop,
  collectEdits: () => null,
  collectAnnotationSavePlan: () => null,
  collectMarkupAnnotationSavePlan: () => ({
    appendEdits: [],
    updateEdits: [],
    deleteAnnotIds: [],
    hasSignatureEdit: false,
  }),
  hasUnsavedEdits: false,
  resetForDocument: noop,
  captureDocumentState: () => ({
    pendingEdits: [],
    importedAnnotIds: new Set<string>(),
    formValues: {},
  }),
  restoreDocumentState: noop,
};
