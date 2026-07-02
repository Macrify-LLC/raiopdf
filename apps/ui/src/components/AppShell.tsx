import { useRef, type ChangeEvent, type MouseEvent, type ReactNode } from "react";
import type { OcrUiState } from "../App";
import type { DocumentState } from "../hooks/useDocument";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { CanvasWell } from "./CanvasWell";
import { CommandBar } from "./CommandBar";
import { StatusBar } from "./StatusBar";
import { ThumbnailRail } from "./ThumbnailRail";
import { TitleBar } from "./TitleBar";
import { ToolPanel, type LegalToolId, type OrganizeToolId } from "./ToolPanel";
import type {
  BatesPanelState,
  RedactionPanelState,
  ScannerPanelState,
  ScrubMetadataPanelState,
} from "./ToolPanel";
import type { PendingRedactionOverlay } from "./CanvasWell";
import type { PdfBatesStampOptions, PdfRedactionArea } from "@raiopdf/engine-api";
import type { SensitiveHit } from "../lib/legalTools";
import "./AppShell.css";

export interface AppShellProps {
  document: DocumentState;
  pdfDocument: PDFDocumentProxy | null;
  selectedPageIndexes: ReadonlySet<number>;
  onOpenRequested: () => void;
  onFileDropped: (file: File) => void;
  onSave: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitZoomResolved: (zoom: number) => void;
  onPageSizeChange: (size: { width: number; height: number }) => void;
  onThumbnailClick: (pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void;
  onRotateSelected: () => void;
  onDeleteSelected: () => void;
  onMoveSelectedUp: () => void;
  onMoveSelectedDown: () => void;
  ocrState: OcrUiState;
  ocrAvailable: boolean;
  ocrStarting: boolean;
  workspace: ReactNode;
  activeLegalTool: string | null;
  activeOrganizeTool: string | null;
  onLegalToolSelected: (toolId: LegalToolId) => void;
  onOrganizeToolSelected: (toolId: OrganizeToolId) => void;
  onMakeSearchable: () => void;
  redaction: RedactionPanelState;
  bates: BatesPanelState;
  scanner: ScannerPanelState;
  scrubMetadata: ScrubMetadataPanelState;
  pendingRedactions: readonly PendingRedactionOverlay[];
  redactionModeBar: ReactNode;
  onRedactionAreaCreated: (area: PdfRedactionArea) => void;
  onRedactionAreaRemoved: (id: string) => void;
  onConfirmRedactions: () => void;
  onCancelRedactions: () => void;
  onApplyBates: (options: PdfBatesStampOptions) => Promise<boolean>;
  onRunScanner: () => void;
  onMarkScannerHit: (hit: SensitiveHit) => void;
  onScrubMetadata: () => void;
}

export function AppShell({
  document,
  pdfDocument,
  selectedPageIndexes,
  onOpenRequested,
  onFileDropped,
  onSave,
  onPreviousPage,
  onNextPage,
  onZoomOut,
  onZoomIn,
  onFitZoomResolved,
  onPageSizeChange,
  onThumbnailClick,
  onRotateSelected,
  onDeleteSelected,
  onMoveSelectedUp,
  onMoveSelectedDown,
  ocrState,
  ocrAvailable,
  ocrStarting,
  workspace,
  activeLegalTool,
  activeOrganizeTool,
  onLegalToolSelected,
  onOrganizeToolSelected,
  onMakeSearchable,
  redaction,
  bates,
  scanner,
  scrubMetadata,
  pendingRedactions,
  redactionModeBar,
  onRedactionAreaCreated,
  onRedactionAreaRemoved,
  onConfirmRedactions,
  onCancelRedactions,
  onApplyBates,
  onRunScanner,
  onMarkScannerHit,
  onScrubMetadata,
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
      <TitleBar tabs={tabs} />
      <CommandBar
        onOpen={requestOpen}
        onSave={onSave}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onZoomOut={onZoomOut}
        onZoomIn={onZoomIn}
        currentPage={document.currentPage}
        pageCount={document.pageCount}
        zoom={document.zoom}
        hasDocument={hasDocument}
      />
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
          onOpenRequested={requestOpen}
          onFileDropped={onFileDropped}
          pdfDocument={pdfDocument}
          currentPage={document.currentPage}
          zoom={document.zoom}
          fitWidth={document.fitWidth}
          error={document.error}
          onFitZoomResolved={onFitZoomResolved}
          onPageSizeChange={onPageSizeChange}
          redactionMode={activeLegalTool === "redact"}
          redactionModeBar={redactionModeBar}
          pendingRedactions={pendingRedactions}
          onRedactionAreaCreated={onRedactionAreaCreated}
          onRedactionAreaRemoved={onRedactionAreaRemoved}
        />
        <ToolPanel
          hasDocument={hasDocument}
          ocrState={ocrState}
          ocrAvailable={ocrAvailable}
          ocrStarting={ocrStarting}
          activeLegalTool={activeLegalTool}
          activeOrganizeTool={activeOrganizeTool}
          onLegalToolSelected={onLegalToolSelected}
          onOrganizeToolSelected={onOrganizeToolSelected}
          onMakeSearchable={onMakeSearchable}
          redaction={redaction}
          bates={bates}
          scanner={scanner}
          scrubMetadata={scrubMetadata}
          pageCount={document.pageCount}
          onConfirmRedactions={onConfirmRedactions}
          onCancelRedactions={onCancelRedactions}
          onApplyBates={onApplyBates}
          onRunScanner={onRunScanner}
          onMarkScannerHit={onMarkScannerHit}
          onScrubMetadata={onScrubMetadata}
        />
      </div>
      <StatusBar
        currentPage={hasDocument ? document.currentPage : null}
        pageCount={hasDocument ? document.pageCount : null}
        pageSizeInches={hasDocument ? document.pageSizeInches : null}
        fileSizeBytes={hasDocument ? document.fileSizeBytes : null}
        hasTextLayer={hasDocument ? document.hasTextLayer : null}
      />
    </div>
  );
}
