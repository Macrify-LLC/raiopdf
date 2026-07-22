import { useRef, type ChangeEvent, type MouseEvent, type ReactNode } from "react";
import type { OcrUiState } from "../App";
import type { DocumentState, PageScrollIntent } from "../hooks/useDocument";
import type { DocumentSearchState } from "../hooks/useDocumentSearch";
import type { TextEditState } from "../hooks/useTextEdit";
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
import type { CapturedTextSelection } from "../lib/selectedTextEdit";
import type { SensitiveHit } from "../lib/legalTools";
import { deriveTextLayerStatus } from "../lib/textLayerStatus";
import { runtimePlatform } from "../lib/runtimePlatform";
import "./AppShell.css";

function isOcrDialogPhase(phase: OcrUiState["phase"]): boolean {
  return (
    phase === "confirm" ||
    phase === "starting-engine" ||
    phase === "processing" ||
    phase === "verifying" ||
    phase === "error"
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
  /** Whether Microsoft Word was detected on this PC (gates the Word-dependent menu items). */
  wordAvailable: boolean;
  ocrStarting: boolean;
  documentBanner: ReactNode;
  workspace: ReactNode;
  overlay: ReactNode;
  processLoader?: ReactNode;
  processLoaderCount?: number;
  longProcessLockoutLabel?: string | null | undefined;
  /** Update indicator (UpdatePill) rendered in the title bar's meta area. */
  updateSlot?: ReactNode;
  activeLegalTool: string | null;
  /** Redaction mode bar's draw/select-text toggle (default "draw"). */
  redactionSelectMode: "draw" | "text";
  activeTextEdit?: boolean;
  activeEditDialogTool: EditDialogToolId | null;
  activeOrganizeTool: string | null;
  onEditDialogToolSelected: (toolId: EditDialogToolId) => void;
  onTextEditSelected?: (() => void) | undefined;
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
  textEdit?: TextEditState | undefined;
  scanner: ScannerPanelState;
  pendingRedactions: readonly PendingRedactionOverlay[];
  modeBar: ReactNode;
  editing: EditingState;
  onReplaceTextInSelection?: ((selection: CapturedTextSelection) => void) | undefined;
  replaceTextInSelectionBlocked?: ((pageIndex: number) => boolean) | undefined;
  onRedactionAreaCreated: (area: PdfRedactionArea) => void;
  onRedactionAreasCreated: (areas: PdfRedactionArea[]) => void;
  onRedactionSelectionRejected: (message: string) => void;
  onRedactionAreaRemoved: (id: string) => void;
  onRunScanner: () => void;
  onMarkScannerHit: (hit: SensitiveHit) => void;
  onMarkAllScannerHits?: (() => void) | undefined;
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
  wordAvailable,
  ocrStarting,
  documentBanner,
  workspace,
  overlay,
  processLoader,
  processLoaderCount = 1,
  longProcessLockoutLabel = null,
  updateSlot,
  activeLegalTool,
  redactionSelectMode,
  activeTextEdit = false,
  activeEditDialogTool,
  activeOrganizeTool,
  onEditDialogToolSelected,
  onTextEditSelected,
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
  textEdit,
  scanner,
  pendingRedactions,
  modeBar,
  editing,
  onReplaceTextInSelection,
  replaceTextInSelectionBlocked,
  onRedactionAreaCreated,
  onRedactionAreasCreated,
  onRedactionSelectionRejected,
  onRedactionAreaRemoved,
  onRunScanner,
  onMarkScannerHit,
  onMarkAllScannerHits,
  onOpenAbout,
  onHelpRequested,
  onConnectToAi,
  onMenuCommand,
  printMarkupAnnotations,
  onPrintMarkupAnnotationsChange,
  onFlattenMarkupAnnotations,
  markupAnnotationMessage,
}: AppShellProps) {
  const platform = runtimePlatform();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // "Is a document open" is source-based [R1-1]: a streamed document has no
  // engine handle and no bytes but is absolutely open.
  const hasDocument = document.source !== null;
  const streamedDocument = document.source !== null && document.source.kind !== "memory";
  // The single undo gate — every undo door (menu, Ctrl+Z, toolbar) consumes
  // this one value so they can't drift apart. Imported annotations are not
  // undo targets (see lastUndoableEditId), so a freshly-opened annotated
  // document starts with Undo disabled.
  const canUndo = hasDocument && editing.lastUndoableEditId !== null;
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
    <div className={`app-shell app-shell--${platform}`}>
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
        platform={platform}
        tabs={tabs}
        onTabSelected={onTabSelected}
        onTabCloseRequested={onTabCloseRequested}
        onTabMoveToNewWindowRequested={onTabMoveToNewWindowRequested}
        onOpenAbout={onOpenAbout}
        hasDocument={hasDocument}
        canUndo={canUndo}
        wordAvailable={wordAvailable}
        onMenuCommand={onMenuCommand}
        updateSlot={updateSlot}
      />
      <CommandBar
        onOpen={requestOpen}
        onSave={onSave}
        // Streamed documents disable Save only while there is nothing to
        // write: with pending annotation overlays (or an otherwise dirty
        // document) the streamed save path commits them via apply_edits —
        // mirror the File → Save menu path instead of hard-disabling.
        saveDisabled={streamedDocument && !document.dirty && !editing.hasUnsavedEdits}
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
        canUndo={canUndo}
        // Same action as Edit > Undo in the menu bar (and Ctrl+Z) — route
        // through the shared menu-command handler so all three doors stay
        // one code path.
        onUndo={() => onMenuCommand("edit:undo")}
        searchValue={documentSearch.query}
        searchResultLabel={documentSearch.resultLabel}
        searchBusy={documentSearch.status === "searching"}
        searchDisabled={activeTextEdit}
        searchDisabledReason="Document search is disabled while Edit Text owns the page highlights."
        searchCanNavigate={documentSearch.canNavigate}
        onSearchChange={documentSearch.setQuery}
        onSearchPrevious={documentSearch.goToPrevious}
        onSearchNext={documentSearch.goToNext}
        onSearchClear={documentSearch.clear}
        onHelp={onHelpRequested}
        onPrepareForFiling={() => onLegalToolSelected("prepare-for-filing")}
        longProcessLockoutLabel={longProcessLockoutLabel}
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
          bookmarksDisabledReason={
            streamedDocument
              ? "This document is very large, so bookmarks are turned off for it."
              : undefined
          }
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
          processLoader={processLoader}
          processLoaderCount={processLoaderCount}
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
          redactionTextSelect={activeLegalTool === "redact" && redactionSelectMode === "text"}
          modeBar={modeBar}
          onFlattenMarkupAnnotations={onFlattenMarkupAnnotations}
          editing={editing}
          onReplaceTextInSelection={onReplaceTextInSelection}
          replaceTextInSelectionBlocked={replaceTextInSelectionBlocked}
          pendingRedactions={pendingRedactions}
          onRedactionAreaCreated={onRedactionAreaCreated}
          onRedactionAreasCreated={onRedactionAreasCreated}
          onRedactionSelectionRejected={onRedactionSelectionRejected}
          onRedactionAreaRemoved={onRedactionAreaRemoved}
          searchResults={activeTextEdit && textEdit ? textEdit.matches : documentSearch.results}
          activeSearchResultId={activeTextEdit && textEdit ? textEdit.activeMatch?.id ?? null : documentSearch.activeMatch?.id ?? null}
          lazyPageMeasurement={streamedDocument}
          engineStarting={showEngineStartingOverlay}
        />
        <ToolPanel
          hasDocument={hasDocument}
          pageCount={pageCount}
          ocrState={ocrState}
          ocrStarting={ocrStarting}
          activeEditTool={editing.tool}
          activeTextEdit={activeTextEdit}
          activeEditDialogTool={activeEditDialogTool}
          activeLegalTool={activeLegalTool}
          activeOrganizeTool={activeOrganizeTool}
          onEditToolSelected={editing.setTool}
          onTextEditSelected={onTextEditSelected}
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
          textEdit={textEdit}
          scanner={scanner}
          pendingEdits={editing.pendingEdits}
          onRemovePendingEdit={editing.removeEdit}
          onRunScanner={onRunScanner}
          onMarkScannerHit={onMarkScannerHit}
          onMarkAllScannerHits={onMarkAllScannerHits}
          onHelpRequested={onHelpRequested}
          onConnectToAi={onConnectToAi}
          printMarkupAnnotations={printMarkupAnnotations}
          onPrintMarkupAnnotationsChange={onPrintMarkupAnnotationsChange}
          onFlattenMarkupAnnotations={onFlattenMarkupAnnotations}
          markupAnnotationMessage={markupAnnotationMessage}
          longProcessLockoutLabel={longProcessLockoutLabel}
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
        onMakeSearchable={onMakeSearchable}
      />
    </div>
  );
}
