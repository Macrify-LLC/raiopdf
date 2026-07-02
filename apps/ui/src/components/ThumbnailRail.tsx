import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DeleteIcon,
  RotateIcon,
} from "../icons";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { IconButton } from "./IconButton";
import "./ThumbnailRail.css";

export interface ThumbnailRailProps {
  pdfDocument?: PDFDocumentProxy | null;
  pageCount?: number;
  currentPage?: number;
  selectedPageIndexes?: ReadonlySet<number>;
  onPageClick?: ((pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  onRotateSelected?: (() => void) | undefined;
  onDeleteSelected?: (() => void) | undefined;
  onMoveSelectedUp?: (() => void) | undefined;
  onMoveSelectedDown?: (() => void) | undefined;
}

export function ThumbnailRail({
  pdfDocument = null,
  pageCount = 0,
  currentPage = 1,
  selectedPageIndexes = new Set<number>(),
  onPageClick,
  onRotateSelected,
  onDeleteSelected,
  onMoveSelectedUp,
  onMoveSelectedDown,
}: ThumbnailRailProps) {
  const selectedCount = selectedPageIndexes.size;
  const pages = Array.from({ length: pageCount }, (_, index) => index);
  const canMoveUp = pages.some((pageIndex) => {
    return selectedPageIndexes.has(pageIndex) && pageIndex > 0 && !selectedPageIndexes.has(pageIndex - 1);
  });
  const canMoveDown = pages.some((pageIndex) => {
    return (
      selectedPageIndexes.has(pageIndex) &&
      pageIndex < pageCount - 1 &&
      !selectedPageIndexes.has(pageIndex + 1)
    );
  });

  return (
    <nav className="thumbnail-rail" aria-label="Page thumbnails">
      {pdfDocument ? (
        <div className="thumbnail-rail__actions" aria-label="Selected page actions">
          <IconButton
            icon={<RotateIcon size={15} />}
            label="Rotate selected pages"
            onClick={onRotateSelected}
            disabled={selectedCount === 0}
          />
          <IconButton
            icon={<ArrowUpIcon size={15} />}
            label="Move selected pages up"
            onClick={onMoveSelectedUp}
            disabled={selectedCount === 0 || !canMoveUp}
          />
          <IconButton
            icon={<ArrowDownIcon size={15} />}
            label="Move selected pages down"
            onClick={onMoveSelectedDown}
            disabled={selectedCount === 0 || !canMoveDown}
          />
          <IconButton
            icon={<DeleteIcon size={15} />}
            label="Delete selected pages"
            onClick={onDeleteSelected}
            disabled={selectedCount === 0}
          />
        </div>
      ) : null}

      {pages.map((pageIndex) => {
        const pageNumber = pageIndex + 1;
        const isActive = pageNumber === currentPage;
        const isSelected = selectedPageIndexes.has(pageIndex);

        return (
          <button
            key={pageIndex}
            type="button"
            className="thumbnail"
            data-active={isActive ? "true" : undefined}
            data-selected={isSelected ? "true" : undefined}
            aria-current={isActive ? "true" : undefined}
            aria-pressed={isSelected}
            aria-label={`Page ${pageNumber}`}
            onClick={(event) => onPageClick?.(pageIndex, event)}
          >
            <span className="thumbnail__page">
              {pdfDocument ? (
                <ThumbnailCanvas pdfDocument={pdfDocument} pageNumber={pageNumber} />
              ) : null}
            </span>
            <span className="thumbnail__number">{pageNumber}</span>
          </button>
        );
      })}
    </nav>
  );
}

interface ThumbnailCanvasProps {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
}

function ThumbnailCanvas({ pdfDocument, pageNumber }: ThumbnailCanvasProps) {
  const frameRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;

    if (!frame) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsVisible(true);
      }
    }, { rootMargin: "160px" });

    observer.observe(frame);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!isVisible || !canvas) {
      return;
    }

    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<typeof pdfDocument.getPage>>["render"]> | null = null;

    void pdfDocument.getPage(pageNumber).then((page) => {
      if (cancelled) {
        return;
      }

      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(88 / baseViewport.width, 114 / baseViewport.height);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      renderTask = page.render({ canvas, viewport });
      void renderTask.promise.catch((error: unknown) => {
        if (error instanceof Error && error.name !== "RenderingCancelledException") {
          console.error(error);
        }
      });
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [isVisible, pageNumber, pdfDocument]);

  return (
    <span ref={frameRef} className="thumbnail__canvas-frame">
      <canvas ref={canvasRef} className="thumbnail__canvas" aria-hidden="true" />
    </span>
  );
}
