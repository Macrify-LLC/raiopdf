import { useRef, type ChangeEvent, type MouseEvent, type ReactNode } from "react";
import type { OcrUiState } from "../App";
import type { DocumentState } from "../hooks/useDocument";
import type { DocumentSearchState } from "../hooks/useDocumentSearch";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { CanvasWell } from "./CanvasWell";
import { CommandBar } from "./CommandBar";
import { StatusBar } from "./StatusBar";
import { ThumbnailRail } from "./ThumbnailRail";
import { TitleBar } from "./TitleBar";
import {
  ToolPanel,
  type EditDialogToolId,
  type LegalToolId,
  type OrganizeToolId,
} from "./ToolPanel";
import type {
  RedactionPanelState,
  ScannerPanelState,
} from "./ToolPanel";
import type { PendingRedactionOverlay } from "./CanvasWell";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { EditingState } from "../hooks/useEditing";
import type { SensitiveHit } from "../lib/legalTools";
import { deriveTextLayerStatus } from "../lib/textLayerStatus";
import "./AppShell.css";

export interface AppShellProps {
  document: DocumentState;
  pdfDocument: PDFDocumentProxy | null;
  documentSearch: DocumentSearchState;
  selectedPageIndexes: ReadonlySet<number>;
  onOpenRequested: () => void;
  onFileDropped: (file: File) => void;
  onSave: () => void;
  onPrint: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitZoomResolved: (zoom: number) => void;
  onPageSizeChange: (size: { width: number; height: number }) => void;
  onRenderError: (message: string) => void;
  onThumbnailClick: (pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void;
  onRotateSelected: () => void;
  onDeleteSelected: () => void;
  onMoveSelectedUp: () => void;
  onMoveSelectedDown: () => void;
  ocrState: OcrUiState;
  ocrAvailable: boolean;
  ocrStarting: boolean;
  documentBanner: ReactNode;
  workspace: ReactNode;
  overlay: ReactNode;
  activeLegalTool: string | null;
  activeEditDialogTool: EditDialogToolId | null;
  activeOrganizeTool: string | null;
  onEditDialogToolSelected: (toolId: EditDialogToolId) => void;
  onLegalToolSelected: (toolId: LegalToolId) => void;
  onOrganizeToolSelected: (toolId: OrganizeToolId) => void;
  onMakeSearchable: () => void;
  onForceOcr: () => void;
  redaction: RedactionPanelState;
  scanner: ScannerPanelState;
  pendingRedactions: readonly PendingRedactionOverlay[];
  modeBar: ReactNode;
  editing: EditingState;
  onRedactionAreaCreated: (area: PdfRedactionArea) => void;
  onRedactionAreaRemoved: (id: string) => void;
  onConfirmRedactions: () => void;
  onCancelRedactions: () => void;
  onRunScanner: () => void;
  onMarkScannerHit: (hit: SensitiveHit) => void;
  onOpenAbout: () => void;
  onHelpRequested: (articleId?: string) => void;
}

export function AppShell({
  document,
  pdfDocument,
  documentSearch,
  selectedPageIndexes,
  onOpenRequested,
  onFileDropped,
  onSave,
  onPrint,
  onPreviousPage,
  onNextPage,
  onZoomOut,
  onZoomIn,
  onFitZoomResolved,
  onPageSizeChange,
  onRenderError,
  onThumbnailClick,
  onRotateSelected,
  onDeleteSelected,
  onMoveSelectedUp,
  onMoveSelectedDown,
  ocrState,
  ocrAvailable,
  ocrStarting,
  documentBanner,
  workspace,
  overlay,
  activeLegalTool,
  activeEditDialogTool,
  activeOrganizeTool,
  onEditDialogToolSelected,
  onLegalToolSelected,
  onOrganizeToolSelected,
  onMakeSearchable,
  onForceOcr,
  redaction,
  scanner,
  pendingRedactions,
  modeBar,
  editing,
  onRedactionAreaCreated,
  onRedactionAreaRemoved,
  onConfirmRedactions,
  onCancelRedactions,
  onRunScanner,
  onMarkScannerHit,
  onOpenAbout,
  onHelpRequested,
}: AppShellProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasDocument = Boolean(document.engineHandle && document.bytes);
  const tabs = document.fileName
    ? [
        {
          id: "active-document",
          fileName: document.fileName,
          active: true,
          dirty: document.dirty,
        },
      ]
    : [];

  function requestOpen() {
    onOpenRequested();
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (file) {
      onFileDropped(file);
    }
  }

  return (
    <div className="app-shell">
      <div className="app-shell__accent-bar" aria-hidden="true" />
      <input
        ref={fileInputRef}
        className="app-shell__file-input"
        type="file"
        accept="application/pdf"
        aria-label="Open PDF file"
        onChange={handleFileInputChange}
      />
      <TitleBar tabs={tabs} onOpenAbout={onOpenAbout} />
      <CommandBar
        onOpen={requestOpen}
        onSave={onSave}
        onPrint={onPrint}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onZoomOut={onZoomOut}
        onZoomIn={onZoomIn}
        currentPage={document.currentPage}
        pageCount={document.pageCount}
        zoom={document.zoom}
        hasDocument={hasDocument}
        editTool={editing.tool}
        onEditToolChange={editing.setTool}
        searchValue={documentSearch.query}
        searchResultLabel={documentSearch.resultLabel}
        searchBusy={documentSearch.status === "searching"}
        searchCanNavigate={documentSearch.canNavigate}
        onSearchChange={documentSearch.setQuery}
        onSearchPrevious={documentSearch.goToPrevious}
        onSearchNext={documentSearch.goToNext}
        onSearchClear={documentSearch.clear}
        onHelp={onHelpRequested}
      />
      {documentBanner}
      <div className="app-shell__body">
        <ThumbnailRail
          pdfDocument={pdfDocument}
          pageCount={document.pageCount}
          currentPage={document.currentPage}
          selectedPageIndexes={selectedPageIndexes}
          onPageClick={onThumbnailClick}
          onRotateSelected={onRotateSelected}
          onDeleteSelected={onDeleteSelected}
          onMoveSelectedUp={onMoveSelectedUp}
          onMoveSelectedDown={onMoveSelectedDown}
        />
        <CanvasWell
          workspace={workspace}
          overlay={overlay}
          onOpenRequested={requestOpen}
          onHelpRequested={onHelpRequested}
          onFileDropped={onFileDropped}
          pdfDocument={pdfDocument}
          currentPage={document.currentPage}
          zoom={document.zoom}
          fitWidth={document.fitWidth}
          error={document.error}
          onZoomOut={onZoomOut}
          onZoomIn={onZoomIn}
          onFitZoomResolved={onFitZoomResolved}
          onPageSizeChange={onPageSizeChange}
          onRenderError={onRenderError}
          redactionMode={activeLegalTool === "redact"}
          modeBar={modeBar}
          editing={editing}
          pendingRedactions={pendingRedactions}
          onRedactionAreaCreated={onRedactionAreaCreated}
          onRedactionAreaRemoved={onRedactionAreaRemoved}
          searchResults={documentSearch.results}
          activeSearchResultId={documentSearch.activeMatch?.id ?? null}
        />
        <ToolPanel
          hasDocument={hasDocument}
          ocrState={ocrState}
          ocrAvailable={ocrAvailable}
          ocrStarting={ocrStarting}
          activeEditTool={editing.tool}
          activeEditDialogTool={activeEditDialogTool}
          activeLegalTool={activeLegalTool}
          activeOrganizeTool={activeOrganizeTool}
          onEditToolSelected={editing.setTool}
          onEditDialogToolSelected={onEditDialogToolSelected}
          onLegalToolSelected={onLegalToolSelected}
          onOrganizeToolSelected={onOrganizeToolSelected}
          onMakeSearchable={onMakeSearchable}
          onForceOcr={onForceOcr}
          redaction={redaction}
          scanner={scanner}
          pendingEdits={editing.pendingEdits}
          onRemovePendingEdit={editing.removeEdit}
          onConfirmRedactions={onConfirmRedactions}
          onCancelRedactions={onCancelRedactions}
          onRunScanner={onRunScanner}
          onMarkScannerHit={onMarkScannerHit}
          onHelpRequested={onHelpRequested}
        />
      </div>
      <StatusBar
        currentPage={hasDocument ? document.currentPage : null}
        pageCount={hasDocument ? document.pageCount : null}
        pageSizeInches={hasDocument ? document.pageSizeInches : null}
        fileSizeBytes={hasDocument ? document.fileSizeBytes : null}
        textLayerStatus={hasDocument ? deriveTextLayerStatus(document.textLayerCoverage) : null}
        onFixGarbledText={onForceOcr}
      />
    </div>
  );
}
