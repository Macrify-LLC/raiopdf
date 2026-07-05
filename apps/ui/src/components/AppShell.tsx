import { useRef, type ChangeEvent, type MouseEvent, type ReactNode } from "react";
import type { OcrUiState } from "../App";
import type { DocumentState, PageScrollIntent } from "../hooks/useDocument";
import type { DocumentSearchState } from "../hooks/useDocumentSearch";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { CanvasWell } from "./CanvasWell";
import { CommandBar } from "./CommandBar";
import { DocumentNavPanel } from "./DocumentNavPanel";
import { StatusBar } from "./StatusBar";
import { TitleBar, type DocumentTabInfo } from "./TitleBar";
import {
  ToolPanel,
  type EditDialogToolId,
  type LegalToolId,
  type OrganizeToolId,
} from "./ToolPanel";
import type {
  RedactionPanelState,
  ScannerPanelState,
  SidecarStatus,
} from "./ToolPanel";
import type { PendingRedactionOverlay } from "./CanvasWell";
import type {
  PdfCompressOptions,
  PdfOutlineState,
  PdfPageNumbersOptions,
  PdfRedactionArea,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import type { EditingState } from "../hooks/useEditing";
import type { SensitiveHit } from "../lib/legalTools";
import { deriveTextLayerStatus } from "../lib/textLayerStatus";
import "./AppShell.css";

function isOcrDialogPhase(phase: OcrUiState["phase"]): boolean {
  return (
    phase === "confirm" ||
    phase === "starting-engine" ||
    phase === "processing" ||
    phase === "verifying"
  );
}

export interface AppShellProps {
  document: DocumentState;
  tabs: DocumentTabInfo[];
  onTabSelected: (tabId: string) => void;
  onTabCloseRequested: (tabId: string) => void;
  onTabMoveToNewWindowRequested: (tabId: string) => void;
  pdfDocument: PDFDocumentProxy | null;
  documentSearch: DocumentSearchState;
  pageScrollIntent: PageScrollIntent | null;
  onVisiblePageChange: (page: number) => void;
  selectedPageIndexes: ReadonlySet<number>;
  onOpenRequested: () => void;
  onFileDropped: (file: File) => void;
  onSave: () => void;
  onPrint: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onGoToPage: (page: number) => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitZoomResolved: (zoom: number) => void;
  onPageSizeChange: (size: { width: number; height: number }) => void;
  onRenderError: (message: string) => void;
  onThumbnailClick: (pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void;
  onRotateSelected: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onDeleteSelected: () => void;
  onMoveSelectedUp: () => void;
  onMoveSelectedDown: () => void;
  onBookmarkNavigate: (pageIndex: number) => void;
  onOutlineChange: (outline: PdfOutlineState) => Promise<boolean>;
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
  pageCount: number;
  sidecarStatus: SidecarStatus;
  onApplyPageNumbers: (options: PdfPageNumbersOptions) => Promise<boolean>;
  onApplyWatermark: (options: PdfWatermarkOptions) => Promise<boolean>;
  compressAvailable: boolean;
  onCompress: (options: PdfCompressOptions) => Promise<boolean>;
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
  onConnectToAi: () => void;
  onMenuCommand: (command: string) => void;
  printMarkupAnnotations: boolean;
  onPrintMarkupAnnotationsChange: (next: boolean) => void;
  onFlattenMarkupAnnotations: () => void;
  markupAnnotationMessage: string | null;
}

export function AppShell({
  document,
  tabs,
  onTabSelected,
  onTabCloseRequested,
  onTabMoveToNewWindowRequested,
  pdfDocument,
  documentSearch,
  pageScrollIntent,
  onVisiblePageChange,
  selectedPageIndexes,
  onOpenRequested,
  onFileDropped,
  onSave,
  onPrint,
  onPreviousPage,
  onNextPage,
  onGoToPage,
  onZoomOut,
  onZoomIn,
  onFitZoomResolved,
  onPageSizeChange,
  onRenderError,
  onThumbnailClick,
  onRotateSelected,
  onRotateLeft,
  onRotateRight,
  onDeleteSelected,
  onMoveSelectedUp,
  onMoveSelectedDown,
  onBookmarkNavigate,
  onOutlineChange,
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
  pageCount,
  sidecarStatus,
  onApplyPageNumbers,
  onApplyWatermark,
  compressAvailable,
  onCompress,
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
  onConnectToAi,
  onMenuCommand,
  printMarkupAnnotations,
  onPrintMarkupAnnotationsChange,
  onFlattenMarkupAnnotations,
  markupAnnotationMessage,
}: AppShellProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // "Is a document open" is source-based [R1-1]: a streamed document has no
  // engine handle and no bytes but is absolutely open.
  const hasDocument = document.source !== null;
  const streamedDocument = document.source !== null && document.source.kind !== "memory";
  const canUndo = editing.pendingEdits.length > 0;
  const showEngineStartingOverlay = ocrStarting && !isOcrDialogPhase(ocrState.phase);
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
      <TitleBar
        tabs={tabs}
        onTabSelected={onTabSelected}
        onTabCloseRequested={onTabCloseRequested}
        onTabMoveToNewWindowRequested={onTabMoveToNewWindowRequested}
        onOpenAbout={onOpenAbout}
        hasDocument={hasDocument}
        canUndo={canUndo}
        onMenuCommand={onMenuCommand}
      />
      <CommandBar
        onOpen={requestOpen}
        onSave={onSave}
        saveDisabled={streamedDocument}
        onPrint={onPrint}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onGoToPage={onGoToPage}
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
        onPrepareForFiling={() => onLegalToolSelected("prepare-for-filing")}
      />
      <div className="app-shell__document-banner">{documentBanner}</div>
      <div className="app-shell__body">
        <DocumentNavPanel
          pdfDocument={pdfDocument}
          pageCount={document.pageCount}
          currentPage={document.currentPage}
          selectedPageIndexes={selectedPageIndexes}
          outline={document.outline}
          outlineStatus={document.outlineStatus}
          bookmarksDisabled={streamedDocument}
          onPageClick={onThumbnailClick}
          onRotateSelected={onRotateSelected}
          onDeleteSelected={onDeleteSelected}
          onMoveSelectedUp={onMoveSelectedUp}
          onMoveSelectedDown={onMoveSelectedDown}
          onBookmarkNavigate={onBookmarkNavigate}
          onOutlineChange={onOutlineChange}
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
          scrollIntent={pageScrollIntent}
          onVisiblePageChange={onVisiblePageChange}
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
          lazyPageMeasurement={streamedDocument}
          engineStarting={showEngineStartingOverlay}
        />
        <ToolPanel
          hasDocument={hasDocument}
          pageCount={pageCount}
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
          onRotateLeft={onRotateLeft}
          onRotateRight={onRotateRight}
          sidecarStatus={sidecarStatus}
          onApplyPageNumbers={onApplyPageNumbers}
          onApplyWatermark={onApplyWatermark}
          compressAvailable={compressAvailable}
          onCompress={onCompress}
          redaction={redaction}
          scanner={scanner}
          pendingEdits={editing.pendingEdits}
          onRemovePendingEdit={editing.removeEdit}
          onConfirmRedactions={onConfirmRedactions}
          onCancelRedactions={onCancelRedactions}
          onRunScanner={onRunScanner}
          onMarkScannerHit={onMarkScannerHit}
          onHelpRequested={onHelpRequested}
          onConnectToAi={onConnectToAi}
          printMarkupAnnotations={printMarkupAnnotations}
          onPrintMarkupAnnotationsChange={onPrintMarkupAnnotationsChange}
          onFlattenMarkupAnnotations={onFlattenMarkupAnnotations}
          markupAnnotationMessage={markupAnnotationMessage}
        />
      </div>
      <StatusBar
        currentPage={hasDocument ? document.currentPage : null}
        pageCount={hasDocument ? document.pageCount : null}
        pageSizeInches={hasDocument ? document.pageSizeInches : null}
        fileSizeBytes={hasDocument ? document.fileSizeBytes : null}
        textLayerStatus={hasDocument ? deriveTextLayerStatus(document.textLayerCoverage) : null}
        outlineStatus={hasDocument ? document.outlineStatus : null}
        onFixGarbledText={onForceOcr}
      />
    </div>
  );
}
