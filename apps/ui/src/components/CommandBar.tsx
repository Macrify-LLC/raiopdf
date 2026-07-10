import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  BoltIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HelpIcon,
  MinusIcon,
  OpenIcon,
  PlusIcon,
  PrintIcon,
  SaveIcon,
  SearchIcon,
  ScaleIcon,
  SlipSheetIcon,
  UndoIcon,
} from "../icons";
import { IconButton } from "./IconButton";
import "./CommandBar.css";

export interface CommandBarProps {
  onOpen?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  onPrint?: (() => void) | undefined;
  onPreviousPage?: (() => void) | undefined;
  onNextPage?: (() => void) | undefined;
  onGoToPage?: ((page: number) => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onZoomIn?: (() => void) | undefined;
  currentPage?: number;
  pageCount?: number;
  zoom?: number;
  hasDocument?: boolean;
  /**
   * Streamed (large) documents can't dirty — mutations are gated — so Save
   * has nothing to write and stays disabled while the document is open.
   */
  saveDisabled?: boolean;
  searchValue?: string;
  searchResultLabel?: string;
  searchBusy?: boolean;
  searchDisabled?: boolean;
  searchDisabledReason?: string;
  searchCanNavigate?: boolean;
  onSearchChange?: ((value: string) => void) | undefined;
  onSearchPrevious?: (() => void) | undefined;
  onSearchNext?: (() => void) | undefined;
  onSearchClear?: (() => void) | undefined;
  onHelp?: (() => void) | undefined;
  /**
   * Item 6/7: Prepare for Filing gets a persistent, primary-styled entry
   * point in the main command bar (in addition to the Legal sidebar tool,
   * which stays) whenever a document is open. Both call the same handler --
   * this is just a second door into the identical dialog.
   */
  onPrepareForFiling?: (() => void) | undefined;
  onCaseCaption?: (() => void) | undefined;
  onTableOfAuthorities?: (() => void) | undefined;
  longProcessLockoutLabel?: string | null | undefined;
}

export function CommandBar({
  onOpen,
  onSave,
  onPrint,
  onPreviousPage,
  onNextPage,
  onGoToPage,
  onZoomOut,
  onZoomIn,
  currentPage = 1,
  pageCount = 0,
  zoom = 1,
  hasDocument = false,
  saveDisabled = false,
  searchValue = "",
  searchResultLabel = "",
  searchBusy = false,
  searchDisabled = false,
  searchDisabledReason,
  searchCanNavigate = false,
  onSearchChange,
  onSearchPrevious,
  onSearchNext,
  onSearchClear,
  onHelp,
  onPrepareForFiling,
  onCaseCaption,
  onTableOfAuthorities,
  longProcessLockoutLabel = null,
}: CommandBarProps) {
  const [pageInputValue, setPageInputValue] = useState(String(currentPage));
  const skipNextPageBlurCommitRef = useRef(false);
  const pageInputWidth = `${Math.max(1, String(pageCount).length, pageInputValue.length)}ch`;
  const longProcessLocked = Boolean(longProcessLockoutLabel);

  useEffect(() => {
    setPageInputValue(String(currentPage));
  }, [currentPage]);

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

  function commitPageInput() {
    skipNextPageBlurCommitRef.current = false;
    const value = pageInputValue.trim();

    if (!/^\d+$/.test(value) || pageCount <= 0) {
      setPageInputValue(String(currentPage));
      return;
    }

    const clampedPage = Math.min(Math.max(Number(value), 1), pageCount);
    setPageInputValue(String(clampedPage));

    if (clampedPage === currentPage) {
      return;
    }

    onGoToPage?.(clampedPage);
  }

  function handlePageInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitPageInput();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      skipNextPageBlurCommitRef.current = true;
      setPageInputValue(String(currentPage));
    }
  }

  function handlePageInputBlur() {
    if (skipNextPageBlurCommitRef.current) {
      skipNextPageBlurCommitRef.current = false;
      setPageInputValue(String(currentPage));
      return;
    }

    commitPageInput();
  }

  return (
    <div className="command-bar">
      <div className="command-bar__group">
        <IconButton icon={<OpenIcon size={17} />} label="Open" onClick={onOpen} />
        <IconButton
          icon={<SaveIcon size={17} />}
          label="Save"
          onClick={onSave}
          disabled={!hasDocument || saveDisabled}
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
      </div>

      <div className="command-bar__group command-bar__help-group">
        <IconButton icon={<HelpIcon size={17} />} label="Help" onClick={onHelp} />
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
              Page{" "}
              <input
                className="command-bar__page-input"
                type="text"
                inputMode="numeric"
                aria-label="Go to page"
                value={pageInputValue}
                style={{ width: pageInputWidth }}
                onFocus={(event) => {
                  skipNextPageBlurCommitRef.current = false;
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;

                  if (/^\d*$/.test(nextValue)) {
                    skipNextPageBlurCommitRef.current = false;
                    setPageInputValue(nextValue);
                  }
                }}
                onKeyDown={handlePageInputKeyDown}
                onBlur={handlePageInputBlur}
              />{" "}
              / {pageCount}
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
            title={searchDisabled ? searchDisabledReason : undefined}
            disabled={!hasDocument || searchDisabled}
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

      {/* Always mounted (like Open/Save/Print above), toggled via `disabled`
          rather than conditional rendering -- mounting/unmounting this
          exactly when `hasDocument` flips raced the canvas/edit-layer
          measurements that also fire off that same transition and made
          click-to-place tools (comment pins) miss their target. */}
      <div className="command-bar__filing-lockout">
        <button
          type="button"
          className="command-bar__legal-cta"
          disabled={longProcessLocked}
          title={longProcessLockoutLabel ?? "Create a case caption page"}
          onClick={onCaseCaption}
        >
          <SlipSheetIcon size={14} />
          Caption
        </button>
        <button
          type="button"
          className="command-bar__legal-cta"
          disabled={!hasDocument || longProcessLocked}
          title={longProcessLockoutLabel ?? "Build a Table of Authorities"}
          onClick={onTableOfAuthorities}
        >
          <ScaleIcon size={14} />
          ToA
        </button>
        <button
          type="button"
          className="command-bar__filing-cta"
          disabled={!hasDocument || longProcessLocked}
          title={longProcessLockoutLabel ?? undefined}
          onClick={onPrepareForFiling}
        >
          <BoltIcon variant="outline" size={14} />
          Make Filing Ready
        </button>
        {longProcessLockoutLabel ? (
          <span className="command-bar__lockout-note">{longProcessLockoutLabel}</span>
        ) : null}
      </div>
    </div>
  );
}
