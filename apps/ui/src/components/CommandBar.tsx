import type { KeyboardEvent, ReactNode } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CommentIcon,
  DrawIcon,
  HighlightIcon,
  ImageIcon,
  MinusIcon,
  OpenIcon,
  PlusIcon,
  PrintIcon,
  SaveIcon,
  SearchIcon,
  SelectTextIcon,
  SignIcon,
  TextBoxIcon,
  UndoIcon,
} from "../icons";
import type { EditToolId } from "../lib/edits";
import { IconButton } from "./IconButton";
import "./CommandBar.css";

const EDIT_TOOLS: ReadonlyArray<{
  id: EditToolId;
  label: string;
  tooltip: string;
  icon: (size: number) => ReactNode;
}> = [
  { id: "select", label: "Select", tooltip: "Select text or return to the normal pointer.", icon: (size) => <SelectTextIcon size={size} /> },
  { id: "highlight", label: "Highlight", tooltip: "Drag over text to create a saved highlight annotation.", icon: (size) => <HighlightIcon size={size} /> },
  { id: "textBox", label: "Text box", tooltip: "Place editable text on the current page before saving.", icon: (size) => <TextBoxIcon size={size} /> },
  { id: "image", label: "Image", tooltip: "Place an image on the current page before saving.", icon: (size) => <ImageIcon size={size} /> },
  { id: "comment", label: "Comment", tooltip: "Add a PDF note annotation on the current page.", icon: (size) => <CommentIcon size={size} /> },
  { id: "draw", label: "Draw", tooltip: "Draw freehand ink that will be saved with the PDF.", icon: (size) => <DrawIcon size={size} /> },
  { id: "sign", label: "Sign", tooltip: "Place a signature image as a visible page edit.", icon: (size) => <SignIcon size={size} /> },
];

export interface CommandBarProps {
  onOpen?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  onPrint?: (() => void) | undefined;
  onPreviousPage?: (() => void) | undefined;
  onNextPage?: (() => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onZoomIn?: (() => void) | undefined;
  currentPage?: number;
  pageCount?: number;
  zoom?: number;
  hasDocument?: boolean;
  editTool?: EditToolId;
  onEditToolChange?: ((tool: EditToolId) => void) | undefined;
  searchValue?: string;
  searchResultLabel?: string;
  searchBusy?: boolean;
  searchCanNavigate?: boolean;
  onSearchChange?: ((value: string) => void) | undefined;
  onSearchPrevious?: (() => void) | undefined;
  onSearchNext?: (() => void) | undefined;
  onSearchClear?: (() => void) | undefined;
}

export function CommandBar({
  onOpen,
  onSave,
  onPrint,
  onPreviousPage,
  onNextPage,
  onZoomOut,
  onZoomIn,
  currentPage = 1,
  pageCount = 0,
  zoom = 1,
  hasDocument = false,
  editTool = "select",
  onEditToolChange,
  searchValue = "",
  searchResultLabel = "",
  searchBusy = false,
  searchCanNavigate = false,
  onSearchChange,
  onSearchPrevious,
  onSearchNext,
  onSearchClear,
}: CommandBarProps) {
  function toggleTool(toolId: EditToolId) {
    // Tools are mutually exclusive toggles; re-clicking the active tool
    // returns to Select, like every other mode toggle in the app.
    onEditToolChange?.(editTool === toolId && toolId !== "select" ? "select" : toolId);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();

      if (event.shiftKey) {
        onSearchPrevious?.();
      } else {
        onSearchNext?.();
      }

      return;
    }

    if (event.key === "Escape") {
      if (!searchValue.trim()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onSearchClear?.();
    }
  }

  return (
    <div className="command-bar">
      <div className="command-bar__group">
        <IconButton icon={<OpenIcon size={17} />} label="Open" onClick={onOpen} />
        <IconButton
          icon={<SaveIcon size={17} />}
          label="Save"
          onClick={onSave}
          disabled={!hasDocument}
        />
        <IconButton
          icon={<PrintIcon size={17} />}
          label="Print"
          onClick={onPrint}
          disabled={!hasDocument}
        />
      </div>

      <span className="command-bar__divider" aria-hidden="true" />

      <div className="command-bar__group">
        <IconButton icon={<UndoIcon size={17} />} label="Undo" disabled />
        {EDIT_TOOLS.map((tool) => (
          <IconButton
            key={tool.id}
            icon={tool.icon(17)}
            label={tool.label}
            tooltip={tool.tooltip}
            active={editTool === tool.id}
            disabled={!hasDocument && tool.id !== "select"}
            onClick={() => toggleTool(tool.id)}
          />
        ))}
      </div>

      <div className="command-bar__center">
        <div className="command-bar__page-nav">
          <IconButton
            icon={<ChevronLeftIcon size={15} />}
            label="Previous page"
            onClick={onPreviousPage}
            disabled={!hasDocument || currentPage <= 1}
          />
          {hasDocument ? (
            <span className="command-bar__page-label">
              Page <b>{currentPage}</b> / {pageCount}
            </span>
          ) : (
            <span className="command-bar__page-label">No document</span>
          )}
          <IconButton
            icon={<ChevronRightIcon size={15} />}
            label="Next page"
            onClick={onNextPage}
            disabled={!hasDocument || currentPage >= pageCount}
          />
        </div>

        <span className="command-bar__divider" aria-hidden="true" />

        <div className="command-bar__zoom">
          <IconButton
            icon={<MinusIcon size={15} />}
            label="Zoom out"
            onClick={onZoomOut}
            disabled={!hasDocument || zoom <= 0.25}
          />
          <span className="command-bar__zoom-label">{Math.round(zoom * 100)}%</span>
          <IconButton
            icon={<PlusIcon size={15} />}
            label="Zoom in"
            onClick={onZoomIn}
            disabled={!hasDocument || zoom >= 4}
          />
        </div>
      </div>

      <div className="command-bar__search" role="search">
        <label className="command-bar__search-field">
          <SearchIcon size={13} />
          <input
            type="search"
            placeholder="Search document"
            aria-label="Search document"
            value={searchValue}
            disabled={!hasDocument}
            onChange={(event) => onSearchChange?.(event.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
          />
        </label>
        {searchResultLabel ? (
          <span className="command-bar__search-count" aria-live="polite">
            {searchResultLabel}
          </span>
        ) : null}
        <div className="command-bar__search-nav" aria-hidden={!searchValue.trim()}>
          <button
            type="button"
            className="command-bar__search-button"
            aria-label="Previous search result"
            title="Previous search result"
            disabled={!hasDocument || !searchCanNavigate || searchBusy}
            onClick={onSearchPrevious}
          >
            <ChevronLeftIcon size={13} />
          </button>
          <button
            type="button"
            className="command-bar__search-button"
            aria-label="Next search result"
            title="Next search result"
            disabled={!hasDocument || !searchCanNavigate || searchBusy}
            onClick={onSearchNext}
          >
            <ChevronRightIcon size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
