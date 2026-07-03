import { useEffect, useRef, useState } from "react";
import { loadPdfDocument } from "../lib/pdfjs";

export interface PdfMiniThumbProps {
  bytes: Uint8Array | null;
  label: string;
}

export function PdfMiniThumb({ bytes, label }: PdfMiniThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!bytes || !canvas) {
      setRenderError(false);
      return;
    }

    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfDocument>>["getPage"]>>["render"]> | null = null;
    let loadedDocument: Awaited<ReturnType<typeof loadPdfDocument>> | null = null;

    setRenderError(false);

    void loadPdfDocument(bytes)
      .then(async (pdf) => {
        loadedDocument = pdf;
        const page = await pdf.getPage(1);

        if (disposed) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(44 / baseViewport.width, 58 / baseViewport.height);
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
      void loadedDocument?.loadingTask.destroy();
    };
  }, [bytes]);

  return (
    <span className="pdf-mini-thumb" aria-label={label}>
      {bytes ? (
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
