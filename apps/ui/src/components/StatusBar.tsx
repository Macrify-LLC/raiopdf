import { useState } from "react";
import { CheckIcon, ChevronRightIcon, OcrSearchIcon, ShieldCheckIcon } from "../icons";
import type { TextLayerStatus } from "../lib/textLayerStatus";
import { TextLayerDetailPanel } from "./TextLayerDetailPanel";
import "./StatusBar.css";

export interface StatusBarProps {
  currentPage?: number | null;
  pageCount?: number | null;
  pageSizeInches?: { width: number; height: number } | null;
  fileSizeBytes?: number | null;
  textLayerStatus?: TextLayerStatus | null;
  outlineStatus?: string | null;
  onFixGarbledText?: (() => void) | undefined;
  /** Opens the Make Searchable (OCR) confirm flow from the image-only chip. */
  onMakeSearchable?: (() => void) | undefined;
}

export function StatusBar({
  currentPage = 0,
  pageCount = 0,
  pageSizeInches = null,
  fileSizeBytes = null,
  textLayerStatus = null,
  outlineStatus = null,
  onFixGarbledText,
  onMakeSearchable,
}: StatusBarProps) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <footer className="status-bar">
      {currentPage && pageCount ? <span>Page {currentPage} of {pageCount}</span> : null}
      {pageSizeInches ? <span>{formatPageSize(pageSizeInches)}</span> : null}
      {fileSizeBytes ? <span>{formatFileSize(fileSizeBytes)}</span> : null}
      {textLayerStatus ? (
        <SearchabilityChip
          status={textLayerStatus}
          onOpenDetail={() => setDetailOpen(true)}
          onMakeSearchable={onMakeSearchable}
        />
      ) : null}
      {outlineStatus ? <span className="status-bar__outline-status">{outlineStatus}</span> : null}
      <span className="status-bar__local">
        <ShieldCheckIcon size={13} checked={false} />
        All processing local — no files leave this computer
      </span>
      {detailOpen && textLayerStatus?.state === "garbled" ? (
        <TextLayerDetailPanel
          garbledPages={textLayerStatus.garbledPages}
          onFixGarbledText={onFixGarbledText}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </footer>
  );
}

function SearchabilityChip({
  status,
  onOpenDetail,
  onMakeSearchable,
}: {
  status: TextLayerStatus;
  onOpenDetail: () => void;
  onMakeSearchable?: (() => void) | undefined;
}) {
  if (status.state === "clean") {
    return (
      <span className="status-bar__search-chip" data-status="clean">
        <CheckIcon size={12} />
        <span className="status-bar__search-chip-label">Searchable — verified</span>
      </span>
    );
  }

  if (status.state === "garbled") {
    const garbledPageCount = status.garbledPages.length;
    const totalPages = status.quality.totalPages;
    const garbledLabel = `The hidden searchable text looks garbled on ${garbledPageCount} of ${totalPages} pages — running Make Searchable again is recommended`;

    return (
      <button
        type="button"
        className="status-bar__search-chip status-bar__search-chip--button"
        data-status="garbled"
        title={garbledLabel}
        aria-haspopup="dialog"
        onClick={onOpenDetail}
      >
        <OcrSearchIcon size={12} />
        <span className="status-bar__search-chip-label">{garbledLabel}</span>
        <ChevronRightIcon size={10} className="status-bar__search-chip-chevron" />
      </button>
    );
  }

  if (status.state === "image_only") {
    const imageOnlyLabel = "No searchable text — run Make Searchable";

    // Same interactive treatment as the garbled chip: the chip that names an
    // action should BE the action, not a dead label next to one.
    if (onMakeSearchable) {
      return (
        <button
          type="button"
          className="status-bar__search-chip status-bar__search-chip--button"
          data-status="image_only"
          title="This document has no searchable text. Open Make Searchable (OCR)."
          onClick={onMakeSearchable}
        >
          <OcrSearchIcon size={12} />
          <span className="status-bar__search-chip-label">{imageOnlyLabel}</span>
          <ChevronRightIcon size={10} className="status-bar__search-chip-chevron" />
        </button>
      );
    }

    return (
      <span className="status-bar__search-chip" data-status="image_only">
        <OcrSearchIcon size={12} />
        <span className="status-bar__search-chip-label">{imageOnlyLabel}</span>
      </span>
    );
  }

  return (
    <span className="status-bar__search-chip" data-status="unknown">
      <OcrSearchIcon size={12} />
      <span className="status-bar__search-chip-label">Searchability not checked</span>
    </span>
  );
}

function formatPageSize(pageSizeInches: { width: number; height: number }): string {
  return `${formatInches(pageSizeInches.width)} x ${formatInches(pageSizeInches.height)} in`;
}

function formatInches(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatFileSize(fileSizeBytes: number): string {
  if (fileSizeBytes < 1_000_000) {
    return `${Math.max(1, Math.round(fileSizeBytes / 1_000))} KB`;
  }

  return `${(fileSizeBytes / 1_000_000).toFixed(1)} MB`;
}
