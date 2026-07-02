import { CheckIcon, ShieldCheckIcon } from "../icons";
import "./StatusBar.css";

export interface StatusBarProps {
  currentPage?: number;
  pageCount?: number;
  pageSizeInches?: { width: number; height: number } | null;
  fileSizeBytes?: number | null;
  hasTextLayer?: boolean | null;
}

export function StatusBar({
  currentPage = 0,
  pageCount = 0,
  pageSizeInches = null,
  fileSizeBytes = null,
  hasTextLayer = null,
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span>Page {currentPage} of {pageCount}</span>
      <span>{formatPageSize(pageSizeInches)}</span>
      <span>{formatFileSize(fileSizeBytes)}</span>
      {hasTextLayer ? (
        <span className="status-bar__ok-chip">
          <CheckIcon size={12} />
          Searchable — verified
        </span>
      ) : null}
      <span className="status-bar__local">
        <ShieldCheckIcon size={13} checked={false} />
        All processing local — no files leave this computer
      </span>
    </footer>
  );
}

function formatPageSize(pageSizeInches: { width: number; height: number } | null): string {
  if (!pageSizeInches) {
    return "0 x 0 in";
  }

  return `${formatInches(pageSizeInches.width)} x ${formatInches(pageSizeInches.height)} in`;
}

function formatInches(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatFileSize(fileSizeBytes: number | null): string {
  if (!fileSizeBytes) {
    return "0 KB";
  }

  if (fileSizeBytes < 1_000_000) {
    return `${Math.max(1, Math.round(fileSizeBytes / 1_000))} KB`;
  }

  return `${(fileSizeBytes / 1_000_000).toFixed(1)} MB`;
}
