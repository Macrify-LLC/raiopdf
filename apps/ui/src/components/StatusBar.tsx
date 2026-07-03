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
}

export function StatusBar({
  currentPage = 0,
  pageCount = 0,
  pageSizeInches = null,
  fileSizeBytes = null,
  textLayerStatus = null,
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
        />
      ) : null}
      <span className="status-bar__local">
        <ShieldCheckIcon size={13} checked={false} />
        All processing local — no files leave this computer
      </span>
      {detailOpen && textLayerStatus?.state === "garbled" ? (
        <TextLayerDetailPanel
          garbledPages={textLayerStatus.garbledPages}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </footer>
  );
}

function SearchabilityChip({
  status,
  onOpenDetail,
}: {
  status: TextLayerStatus;
  onOpenDetail: () => void;
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
    const garbledLabel = `Text layer looks garbled on ${garbledPageCount} of ${totalPages} pages — re-OCR recommended`;

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
    return (
      <span className="status-bar__search-chip" data-status="image_only">
        <OcrSearchIcon size={12} />
        <span className="status-bar__search-chip-label">No searchable text — run Make Searchable</span>
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
