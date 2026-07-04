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
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("keeps the document banner grid slot mounted when no banner renders", () => {
    const html = renderToStaticMarkup(
      <AppShell
        document={mockDocument}
        pdfDocument={null}
        documentSearch={mockDocumentSearch}
        selectedPageIndexes={new Set()}
        onOpenRequested={() => undefined}
        onFileDropped={() => undefined}
        onSave={() => undefined}
        onPrint={() => undefined}
        onPreviousPage={() => undefined}
        onNextPage={() => undefined}
        onZoomOut={() => undefined}
        onZoomIn={() => undefined}
        onFitZoomResolved={() => undefined}
        onPageSizeChange={() => undefined}
        onRenderError={() => undefined}
        onThumbnailClick={() => undefined}
        onRotateSelected={() => undefined}
        onDeleteSelected={() => undefined}
        onMoveSelectedUp={() => undefined}
        onMoveSelectedDown={() => undefined}
        ocrState={{ phase: "idle", message: null }}
        ocrAvailable={false}
        ocrStarting={false}
        documentBanner={null}
        workspace={null}
        overlay={null}
        activeLegalTool={null}
        activeEditDialogTool={null}
        activeOrganizeTool={null}
        onEditDialogToolSelected={() => undefined}
        onLegalToolSelected={() => undefined}
        onOrganizeToolSelected={() => undefined}
        onMakeSearchable={() => undefined}
        onForceOcr={() => undefined}
        redaction={{ phase: "idle", message: null, pendingCount: 0, available: true }}
        scanner={{ scanning: false, message: null, hits: [] }}
        pendingRedactions={[]}
        modeBar={null}
        editing={mockEditing}
        onRedactionAreaCreated={() => undefined}
        onRedactionAreaRemoved={() => undefined}
        onConfirmRedactions={() => undefined}
        onCancelRedactions={() => undefined}
        onRunScanner={() => undefined}
        onMarkScannerHit={() => undefined}
        onOpenAbout={() => undefined}
        onHelpRequested={() => undefined}
        pageScrollIntent={null}
        onVisiblePageChange={() => undefined}
        onRotateLeft={() => undefined}
        onRotateRight={() => undefined}
        pageCount={0}
        sidecarStatus={{ running: false, message: null, removed: [], beforeBytes: null, afterBytes: null }}
        onApplyPageNumbers={() => Promise.resolve(true)}
        onApplyWatermark={() => Promise.resolve(true)}
        compressAvailable={false}
        onCompress={() => Promise.resolve(true)}
        onConnectToAi={() => undefined}
        onMenuCommand={() => undefined}
        printMarkupAnnotations={true}
        onPrintMarkupAnnotationsChange={() => undefined}
        onFlattenMarkupAnnotations={() => undefined}
        markupAnnotationMessage={null}
      />,
    );

    expect(html).toContain("app-shell__document-banner");
    expect(html.indexOf("app-shell__document-banner")).toBeLessThan(
      html.indexOf("app-shell__body"),
    );
  });
});

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
  signatureInvalidationNotice: null,
  error: null,
};

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
  resetForDocument: noop,
};
