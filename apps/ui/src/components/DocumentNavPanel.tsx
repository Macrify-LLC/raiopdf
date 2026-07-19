import { useState, type MouseEvent } from "react";
import type { PdfOutlineState } from "@raiopdf/engine-api";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { ChevronRightIcon } from "../icons";
import { BookmarksRail } from "./BookmarksRail";
import { ThumbnailRail } from "./ThumbnailRail";
import "./DocumentNavPanel.css";

export interface DocumentNavPanelProps {
  pdfDocument?: PDFDocumentProxy | null;
  pageCount?: number;
  currentPage?: number;
  selectedPageIndexes?: ReadonlySet<number>;
  outline: PdfOutlineState | null;
  outlineStatus: string | null;
  bookmarksDisabled?: boolean | undefined;
  bookmarksDisabledReason?: string | undefined;
  onPageClick?: ((pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  onRotateSelected?: (() => void) | undefined;
  onDeleteSelected?: (() => void) | undefined;
  onMoveSelectedUp?: (() => void) | undefined;
  onMoveSelectedDown?: (() => void) | undefined;
  onBookmarkNavigate: (pageIndex: number) => void;
  onOutlineChange: (outline: PdfOutlineState) => Promise<boolean>;
}

type DocumentNavTab = "pages" | "bookmarks";

export function DocumentNavPanel({
  pdfDocument = null,
  pageCount = 0,
  currentPage = 1,
  selectedPageIndexes = new Set<number>(),
  outline,
  outlineStatus,
  bookmarksDisabled = false,
  bookmarksDisabledReason,
  onPageClick,
  onRotateSelected,
  onDeleteSelected,
  onMoveSelectedUp,
  onMoveSelectedDown,
  onBookmarkNavigate,
  onOutlineChange,
}: DocumentNavPanelProps) {
  const [activeTab, setActiveTab] = useState<DocumentNavTab>("pages");
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="document-nav-panel document-nav-panel--collapsed" aria-label="Document navigation">
        <button
          type="button"
          className="document-nav-panel__expand"
          aria-label={`Show ${activeTab === "pages" ? "pages" : "bookmarks"}`}
          title={`Show ${activeTab === "pages" ? "pages" : "bookmarks"}`}
          onClick={() => setCollapsed(false)}
        >
          <ChevronRightIcon size={14} />
          <span>{activeTab === "pages" ? "Pages" : "Bookmarks"}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="document-nav-panel" aria-label="Document navigation">
      <div className="document-nav-panel__header">
        <div className="document-nav-panel__tabs" role="tablist" aria-label="Navigation views">
          <button
            type="button"
            role="tab"
            className="document-nav-panel__tab"
            data-active={activeTab === "pages" ? "true" : undefined}
            aria-selected={activeTab === "pages"}
            onClick={() => setActiveTab("pages")}
          >
            Pages
          </button>
          <button
            type="button"
            role="tab"
            className="document-nav-panel__tab"
            data-active={activeTab === "bookmarks" ? "true" : undefined}
            aria-selected={activeTab === "bookmarks"}
            onClick={() => setActiveTab("bookmarks")}
          >
            Bookmarks
          </button>
        </div>
        <button
          type="button"
          className="document-nav-panel__collapse"
          aria-label="Hide navigation"
          title="Hide navigation"
          onClick={() => setCollapsed(true)}
        >
          <ChevronRightIcon size={13} />
        </button>
      </div>

      <div className="document-nav-panel__body">
        {activeTab === "pages" ? (
          <ThumbnailRail
            pdfDocument={pdfDocument}
            pageCount={pageCount}
            currentPage={currentPage}
            selectedPageIndexes={selectedPageIndexes}
            onPageClick={onPageClick}
            onRotateSelected={onRotateSelected}
            onDeleteSelected={onDeleteSelected}
            onMoveSelectedUp={onMoveSelectedUp}
            onMoveSelectedDown={onMoveSelectedDown}
          />
        ) : (
          <BookmarksRail
            outline={outline}
            outlineStatus={outlineStatus}
            pageCount={pageCount}
            currentPage={currentPage}
            disabled={bookmarksDisabled}
            disabledReason={bookmarksDisabledReason}
            onNavigate={onBookmarkNavigate}
            onChange={onOutlineChange}
          />
        )}
      </div>
    </aside>
  );
}
