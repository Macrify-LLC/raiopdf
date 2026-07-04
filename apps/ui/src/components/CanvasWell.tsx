import { type DragEvent, type ReactNode } from "react";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { DocumentSearchMatch } from "../hooks/useDocumentSearch";
import type { PageScrollIntent } from "../hooks/useDocument";
import { OpenIcon, SunMarkIcon } from "../icons";
import type { EditingState } from "../hooks/useEditing";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { FloatingDialog } from "./FloatingDialog";
import { LoadingSun } from "./LoadingSun";
import { PageList } from "./PageList";
import { SignatureCard } from "./SignatureCard";
import type { PendingRedactionOverlay } from "./PageView";
import "./CanvasWell.css";

export type { PendingRedactionOverlay } from "./PageView";

/** Height reserved for the floating mode bar above the first page. */
const MODE_BAR_INSET = 44;

export interface CanvasWellProps {
  onOpenRequested?: (() => void) | undefined;
  onHelpRequested?: (() => void) | undefined;
  onFileDropped?: ((file: File) => void) | undefined;
  pdfDocument?: PDFDocumentProxy | null;
  currentPage?: number;
  zoom?: number;
  fitWidth?: boolean;
  scrollIntent?: PageScrollIntent | null;
  onVisiblePageChange?: ((page: number) => void) | undefined;
  error?: string | null;
  onZoomIn?: (() => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onFitZoomResolved?: ((zoom: number) => void) | undefined;
  onPageSizeChange?: ((size: { width: number; height: number }) => void) | undefined;
  onRenderError?: ((message: string) => void) | undefined;
  workspace?: ReactNode;
  overlay?: ReactNode;
  redactionMode?: boolean;
  modeBar?: ReactNode;
  pendingRedactions?: readonly PendingRedactionOverlay[];
  onRedactionAreaCreated?: ((area: PdfRedactionArea) => void) | undefined;
  onRedactionAreaRemoved?: ((id: string) => void) | undefined;
  editing?: EditingState | undefined;
  searchResults?: readonly DocumentSearchMatch[];
  activeSearchResultId?: string | null;
  /** Streamed mode: PageList skips the full page-size sweep [R2-1]. */
  lazyPageMeasurement?: boolean;
  /**
   * True while the desktop engine sidecar is booting (`engineBridge.starting`
   * in App.tsx). Only meaningful with a document open -- see the big
   * `canvas-well__engine-starting` overlay below.
   */
  engineStarting?: boolean;
}

/**
 * The document well: empty state, drop target, workspace host, and — when a
 * document is open — the continuous-scroll PageList viewer.
 */
export function CanvasWell({
  onOpenRequested,
  onHelpRequested,
  onFileDropped,
  pdfDocument = null,
  currentPage = 1,
  zoom = 1,
  fitWidth = false,
  scrollIntent = null,
  onVisiblePageChange,
  error = null,
  onZoomIn,
  onZoomOut,
  onFitZoomResolved,
  onPageSizeChange,
  onRenderError,
  workspace = null,
  overlay = null,
  redactionMode = false,
  modeBar = null,
  pendingRedactions = [],
  onRedactionAreaCreated,
  onRedactionAreaRemoved,
  editing,
  searchResults = [],
  activeSearchResultId = null,
  lazyPageMeasurement = false,
  engineStarting = false,
}: CanvasWellProps) {
  const hasDocument = Boolean(pdfDocument);
  const viewerActive = hasDocument && !workspace;
  const showModeBar = Boolean(viewerActive && modeBar);

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find(
      (candidate) =>
        candidate.type === "application/pdf" ||
        candidate.name.toLowerCase().endsWith(".pdf"),
    );

    if (file) {
      onFileDropped?.(file);
    }
  }

  const signatureCardOpen = Boolean(
    editing && editing.tool === "sign" && editing.signatureCardOpen,
  );

  return (
    <section
      className="canvas-well"
      data-mode-bar={showModeBar ? "true" : undefined}
      data-viewer={viewerActive ? "true" : undefined}
      aria-label="Document canvas"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      {showModeBar ? (
        <div className="canvas-well__mode-bar-slot">{modeBar}</div>
      ) : null}
      {viewerActive && engineStarting ? (
        <div className="canvas-well__engine-starting" role="status" aria-live="polite">
          <div className="canvas-well__engine-starting-card">
            {/* LoadingSun sizes itself via `1em` on `.loading-sun` (see
                LoadingSun.css) -- the `size` prop alone won't render at
                60px without an ambient font-size to resolve against, so
                this wrapper sets one explicitly. */}
            <span className="canvas-well__engine-starting-sun">
              <LoadingSun size={60} label="Starting the PDF engine" />
            </span>
            {/* Deliberately a real ellipsis (not "...") so this never
                collides with the OCR panel's own "Starting the PDF
                engine..." status text -- see smoke test coverage on that
                exact string. */}
            <p className="canvas-well__engine-starting-text">Starting the PDF engine…</p>
          </div>
        </div>
      ) : null}
      {viewerActive && signatureCardOpen && editing ? (
        <FloatingDialog
          title="Signature"
          eyebrow="Edit"
          width="sm"
          onClose={() => editing.setSignatureCardOpen(false)}
        >
          <SignatureCard editing={editing} />
        </FloatingDialog>
      ) : null}
      {workspace ? (
        workspace
      ) : hasDocument && pdfDocument ? (
        <>
          {editing?.hasFormFields ? (
            <p className="canvas-well__form-note" role="status">
              This PDF has fillable fields.
            </p>
          ) : null}
          <PageList
            pdfDocument={pdfDocument}
            currentPage={currentPage}
            zoom={zoom}
            fitWidth={fitWidth}
            scrollIntent={scrollIntent}
            topInset={showModeBar ? MODE_BAR_INSET : 0}
            onVisiblePageChange={onVisiblePageChange}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            onFitZoomResolved={onFitZoomResolved}
            onPageSizeChange={onPageSizeChange}
            onRenderError={onRenderError}
            redactionMode={redactionMode}
            pendingRedactions={pendingRedactions}
            onRedactionAreaCreated={onRedactionAreaCreated}
            onRedactionAreaRemoved={onRedactionAreaRemoved}
            editing={editing}
            searchResults={searchResults}
            activeSearchResultId={activeSearchResultId}
            lazyPageMeasurement={lazyPageMeasurement}
          />
          {error ? (
            <p className="canvas-well__message canvas-well__message--floating" role="status">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <div className="canvas-well__empty">
          <span className="canvas-well__mark">
            <SunMarkIcon size={40} className="canvas-well__mark-icon" />
          </span>
          <h2 className="canvas-well__heading">Open a PDF to get started</h2>
          <p className="canvas-well__hint">
            Drag a PDF here, or choose one from this computer.
          </p>
          <button
            type="button"
            className="canvas-well__cta"
            onClick={onOpenRequested}
          >
            <OpenIcon size={16} />
            Open a PDF
          </button>
          <button
            type="button"
            className="canvas-well__help-link"
            onClick={onHelpRequested}
          >
            New here? Open Help
          </button>
          {error ? (
            <p className="canvas-well__message" role="status">
              {error}
            </p>
          ) : null}
        </div>
      )}
      {overlay}
    </section>
  );
}
