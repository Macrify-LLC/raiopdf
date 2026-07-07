import { useEffect, useRef, useState } from "react";
import { loadPdfDocument, type PDFDocumentProxy } from "../lib/pdfjs";

export interface PdfMiniThumbProps {
  bytes: Uint8Array | null;
  label: string;
  targetWidth?: number | undefined;
  targetHeight?: number | undefined;
  /**
   * Optional pdf.js proxy already loaded for THIS document (the shared
   * document proxy from the large-PDF plan, Phase 2). When provided, the
   * thumb renders page 1 from it without loading its own copy of the
   * document, and never destroys it -- the caller owns its lifecycle.
   * Without it, behavior is unchanged: load from `bytes`, destroy on cleanup.
   */
  pdfDocument?: PDFDocumentProxy | null;
}

export function PdfMiniThumb({
  bytes,
  label,
  targetWidth = 44,
  targetHeight = 58,
  pdfDocument = null,
}: PdfMiniThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderError, setRenderError] = useState(false);
  const hasSource = Boolean(pdfDocument ?? bytes);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!(pdfDocument ?? bytes) || !canvas) {
      setRenderError(false);
      return;
    }

    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null = null;
    let selfLoadedDocument: PDFDocumentProxy | null = null;

    setRenderError(false);

    const documentPromise: Promise<PDFDocumentProxy> = pdfDocument
      ? Promise.resolve(pdfDocument)
      : loadPdfDocument(bytes as Uint8Array).then((loaded) => {
        selfLoadedDocument = loaded;
        return loaded;
      });

    void documentPromise
      .then(async (pdf) => {
        const page = await pdf.getPage(1);

        if (disposed) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(targetWidth / baseViewport.width, targetHeight / baseViewport.height);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        renderTask = page.render({ canvas, viewport });
        return renderTask.promise;
      })
      .catch((error: unknown) => {
        if (!disposed && !isCancelledRenderError(error)) {
          setRenderError(true);
        }
      });

    return () => {
      disposed = true;
      renderTask?.cancel();
      // Only a document this component loaded itself is destroyed here; an
      // injected proxy belongs to the caller.
      void selfLoadedDocument?.loadingTask.destroy();
    };
  }, [bytes, pdfDocument, targetHeight, targetWidth]);

  return (
    <span
      className="pdf-mini-thumb"
      aria-label={label}
      style={{
        width: `${targetWidth + 4}px`,
        height: `${targetHeight + 4}px`,
      }}
    >
      {hasSource ? (
        <>
          {renderError ? (
            <span className="pdf-mini-thumb__error" role="status">
              Preview unavailable
            </span>
          ) : null}
          <canvas
            ref={canvasRef}
            className="pdf-mini-thumb__canvas"
            aria-hidden="true"
            data-hidden={renderError ? "true" : undefined}
          />
        </>
      ) : null}
    </span>
  );
}

function isCancelledRenderError(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}
