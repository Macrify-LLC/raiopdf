import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from "react";
import type { PdfCoverStyle } from "@raiopdf/engine-api";
import { PDFDocument } from "pdf-lib";
import type { ResizePreset } from "../lib/cropResize";
import { isTextEntryTarget } from "../lib/domGuards";
import type { FileGrant, OpenedFile, SavedFile } from "../lib/filePort";
import { pathOpPageCount } from "../lib/pathOps";
import { reorderPagesForDrop } from "../lib/organizePages";
import {
  pickPdfsForAdd,
  readFileForAdd,
  tooLargeToAddMessage,
  wordDocxAddErrorMessage,
  type DocxConversionProgressRow,
  type FileAddInput,
  type PickPdfsForAddOptions,
} from "../lib/readFileForAdd";
import { formatDefaultRange, parsePageRanges } from "../lib/pageRanges";
import { generateCoverPdf } from "../lib/coverPreview";
import type { DocumentState } from "../hooks/useDocument";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CombineExhibitsIcon,
  CropIcon,
  DeleteIcon,
  ExtractIcon,
  HelpIcon,
  ImageIcon,
  InsertIcon,
  PlusIcon,
  RotateIcon,
  SplitIcon,
} from "../icons";
import { SlipSheetIcon } from "../icons/SlipSheetIcon";
import { CoverStylePicker } from "./CoverStylePicker";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FloatingDialog, hasOpenDialogStackEntry } from "./FloatingDialog";
import { IconButton } from "./IconButton";
import "./OrganizeWorkspace.css";

export type OrganizeFlowId = "pages" | "merge" | "insert" | "crop";

/**
 * Grant-based handlers for a streamed (large) current document [item 4]:
 * merge and insert-into-current delegate to the PathOpsEngine, so added
 * files stay on disk as grants — any size — and never materialize in the
 * WebView. Null when the current document is in-memory (byte flows apply)
 * or a browser streamed doc (no shell grants — honest gates stay up).
 */
export interface OrganizeDelegatedOps {
  merge: (addGrants: readonly FileGrant[]) => Promise<boolean>;
  insert: (insertGrant: FileGrant, insertAtPageIndex: number) => Promise<boolean>;
}

/** One added file in a delegated (grant-based) add list. */
interface GrantEntry {
  grant: FileGrant;
  name: string;
  /** Null = not counted yet; rendered honestly, never as 0. */
  pageCount: number | null;
}

const DELEGATED_BROWSER_FILE_MESSAGE =
  "Files dropped from the browser can't be added to a very large document — choose them with the file picker instead.";
const ADD_FILE_ACCEPT = "application/pdf,.pdf";
const WORD_UNAVAILABLE_MESSAGE = "Microsoft Word isn't available. Word documents were not added.";

async function resolveSlipSheetPageSize(
  pdfDocument: PDFDocumentProxy | null,
  insertAtPageIndex: number,
  pageCount: number,
): Promise<[number, number] | undefined> {
  if (!pdfDocument || pageCount < 1) {
    return undefined;
  }

  const pageIndex = Math.min(Math.max(insertAtPageIndex, 0), pageCount - 1);

  try {
    const page = await pdfDocument.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });

    if (viewport.width > 0 && viewport.height > 0) {
      return [viewport.width, viewport.height];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/** Grant-based add path: descriptors only, page count by grant, no bytes. */
async function readGrantEntry(input: FileAddInput): Promise<GrantEntry | null> {
  if (input instanceof File) {
    // A DOM File can never yield a shell grant [R3-2]; the delegated flows
    // require grants, so this add is refused honestly.
    return null;
  }

  return {
    grant: input.grant as FileGrant,
    name: input.name,
    pageCount: await pathOpPageCount(input.grant as FileGrant).catch(() => null),
  };
}

function formatEntryPages(pageCount: number | null): string {
  if (pageCount === null) {
    return "";
  }

  return ` · ${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

export interface OrganizeWorkspaceProps {
  flow: OrganizeFlowId;
  document: DocumentState;
  pdfDocument?: PDFDocumentProxy | null;
  selectedPageIndexes?: ReadonlySet<number>;
  onCancel: () => void;
  onPageSelected?: (pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void;
  onRotateSelected?: () => void;
  onDeleteSelected?: () => void;
  /** Context-menu rotate -- acts on exactly the right-clicked page. */
  onRotatePage?: (pageIndex: number, degrees: number) => void;
  /** Context-menu delete -- acts on exactly the right-clicked page. */
  onDeletePageRequested?: (pageIndex: number) => void;
  onMoveSelectedUp?: () => void;
  onMoveSelectedDown?: () => void;
  onReorderPages?: (pageIndexes: readonly number[], currentPage: number) => Promise<boolean>;
  onMerge: (files: readonly OpenedFile[]) => Promise<boolean>;
  onExtract: (pageIndexes: readonly number[]) => Promise<boolean>;
  onSplit: (pageGroups: readonly (readonly number[])[]) => Promise<SavedFile[] | null>;
  onInsert: (file: OpenedFile, insertAtPageIndex: number) => Promise<boolean>;
  /** Grant-based merge/insert for a streamed current doc; null = byte flows. */
  delegatedOps?: OrganizeDelegatedOps | null;
  onExportPageAsImage?: (pageIndex: number) => Promise<boolean>;
  onCropResize: (
    pageIndexes: readonly number[],
    options: { cropMarginIn: number; resizePreset: ResizePreset },
  ) => Promise<boolean>;
  onHelpRequested?: (() => void) | undefined;
  defaultCoverStyle?: PdfCoverStyle | undefined;
}

export function OrganizeWorkspace({
  flow,
  document,
  pdfDocument = null,
  selectedPageIndexes = new Set<number>(),
  onCancel,
  onPageSelected,
  onRotateSelected,
  onDeleteSelected,
  onRotatePage,
  onDeletePageRequested,
  onMoveSelectedUp,
  onMoveSelectedDown,
  onReorderPages,
  onMerge,
  onExtract,
  onSplit,
  onInsert,
  delegatedOps = null,
  onExportPageAsImage,
  onCropResize,
  onHelpRequested,
  defaultCoverStyle,
}: OrganizeWorkspaceProps) {
  const title = getFlowTitle(flow);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  if (flow === "pages") {
    return (
      <OrganizePagesGrid
        document={document}
        pdfDocument={pdfDocument}
        selectedPageIndexes={selectedPageIndexes}
        onCancel={onCancel}
        onPageSelected={onPageSelected}
        onRotateSelected={onRotateSelected}
        onDeleteSelected={onDeleteSelected}
        onRotatePage={onRotatePage}
        onDeletePageRequested={onDeletePageRequested}
        onMoveSelectedUp={onMoveSelectedUp}
        onMoveSelectedDown={onMoveSelectedDown}
        onReorderPages={onReorderPages}
        onExtract={onExtract}
        onSplit={onSplit}
        onInsert={onInsert}
        delegatedOps={delegatedOps}
        onExportPageAsImage={onExportPageAsImage}
        onHelpRequested={onHelpRequested}
        defaultCoverStyle={defaultCoverStyle}
      />
    );
  }

  return (
    <section className="organize-workspace" aria-label={`${title} workspace`}>
      <div className="organize-card">
        {/* This flow only ever mounts inside a FloatingDialog (see App.tsx),
            which already renders the "Organize" eyebrow, the flow title, and
            the close control -- an inner header here would just duplicate
            it verbatim. */}
        {flow === "merge" ? (
          <MergeFlow document={document} onMerge={onMerge} delegatedMerge={delegatedOps?.merge ?? null} />
        ) : null}
        {flow === "insert" ? (
          <InsertFlow document={document} onInsert={onInsert} delegatedInsert={delegatedOps?.insert ?? null} />
        ) : null}
        {flow === "crop" ? (
          <CropResizeFlow document={document} onCropResize={onCropResize} />
        ) : null}
      </div>
    </section>
  );
}

function OrganizePagesGrid({
  document,
  pdfDocument,
  selectedPageIndexes,
  onCancel,
  onPageSelected,
  onRotateSelected,
  onDeleteSelected,
  onRotatePage,
  onDeletePageRequested,
  onMoveSelectedUp,
  onMoveSelectedDown,
  onReorderPages,
  onExtract,
  onSplit,
  onInsert,
  delegatedOps,
  onExportPageAsImage,
  onHelpRequested,
  defaultCoverStyle = "minimal",
}: {
  document: DocumentState;
  pdfDocument: PDFDocumentProxy | null;
  selectedPageIndexes: ReadonlySet<number>;
  onCancel: () => void;
  onPageSelected?: ((pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  onRotateSelected?: (() => void) | undefined;
  onDeleteSelected?: (() => void) | undefined;
  onRotatePage?: ((pageIndex: number, degrees: number) => void) | undefined;
  onDeletePageRequested?: ((pageIndex: number) => void) | undefined;
  onMoveSelectedUp?: (() => void) | undefined;
  onMoveSelectedDown?: (() => void) | undefined;
  onReorderPages?: ((pageIndexes: readonly number[], currentPage: number) => Promise<boolean>) | undefined;
  onExtract: (pageIndexes: readonly number[]) => Promise<boolean>;
  onSplit: (pageGroups: readonly (readonly number[])[]) => Promise<SavedFile[] | null>;
  onInsert: (file: OpenedFile, insertAtPageIndex: number) => Promise<boolean>;
  delegatedOps: OrganizeDelegatedOps | null;
  onExportPageAsImage?: ((pageIndex: number) => Promise<boolean>) | undefined;
  onHelpRequested?: (() => void) | undefined;
  defaultCoverStyle?: PdfCoverStyle | undefined;
}) {
  const insertInputRef = useRef<HTMLInputElement>(null);
  const [draggingPageIndex, setDraggingPageIndex] = useState<number | null>(null);
  const [dragOverPageIndex, setDragOverPageIndex] = useState<number | null>(null);
  // Which side of the hovered page the drop will land on. Paired with
  // dragOverPageIndex it drives the insertion-line indicator and the reorder
  // math, so "drag a page just after its neighbour" actually moves it (a plain
  // insert-before is a no-op for adjacent forward drags).
  const [dropSide, setDropSide] = useState<"before" | "after">("after");
  const [pageContextMenu, setPageContextMenu] = useState<{ x: number; y: number; pageIndex: number } | null>(null);
  const [reorderPending, setReorderPending] = useState(false);
  // Drop settle: the grid's cells are positional (0..pageCount-1), not keyed
  // by page identity, so a reorder never slides a thumbnail across the grid
  // -- it repaints new content into the cell the drag landed on. Settling
  // that one cell (rather than teleporting straight to full opacity/scale)
  // is the honest, cheap stand-in for a real FLIP-style move animation.
  const [settledPageIndex, setSettledPageIndex] = useState<number | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [slipSheetOpen, setSlipSheetOpen] = useState(false);
  const [slipSheetLabel, setSlipSheetLabel] = useState("Exhibit A");
  const [slipSheetDescription, setSlipSheetDescription] = useState("");
  const [slipSheetStyle, setSlipSheetStyle] = useState<PdfCoverStyle>(defaultCoverStyle);
  const [slipSheetInserting, setSlipSheetInserting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [docxRows, setDocxRows] = useState<readonly DocxConversionProgressRow[]>([]);
  // Stable identity -- FloatingDialog's focus-management effect keys off
  // `onClose`'s reference (see its own module doc), so a fresh inline arrow
  // here would re-run that effect (and re-steal focus to the dialog shell)
  // on every keystroke/selection inside it, including the picker's own
  // roving-focus updates. useCallback keeps the identity stable across the
  // re-renders that Label/Description/CoverStylePicker changes trigger.
  const closeSlipSheetDialog = useCallback(() => {
    setSlipSheetOpen(false);
  }, []);
  const pages = Array.from({ length: document.pageCount }, (_, index) => index);
  const selectedIndexes = [...selectedPageIndexes].sort((left, right) => left - right);
  const selectedCount = selectedIndexes.length;
  const insertAt = selectedIndexes[0] ?? document.currentPage - 1;
  const canMoveUp = selectedIndexes.some((pageIndex) => pageIndex > 0 && !selectedPageIndexes.has(pageIndex - 1));
  const canMoveDown = selectedIndexes.some((pageIndex) => (
    pageIndex < document.pageCount - 1 && !selectedPageIndexes.has(pageIndex + 1)
  ));
  const canInsertSlipSheet = document.source?.kind === "memory";

  // Delete/Backspace removes the selected pages (with confirmation --
  // page deletion is destructive). Ignored while typing into one of this
  // workspace's own inputs (insert-after, split ranges, ...) or while a
  // dialog (e.g. the delete confirmation itself) is already open on top.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      if (
        reorderPending ||
        selectedCount === 0 ||
        isTextEntryTarget(event.target) ||
        hasOpenDialogStackEntry()
      ) {
        return;
      }

      event.preventDefault();
      onDeleteSelected?.();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDeleteSelected, reorderPending, selectedCount]);

  function closePageContextMenu() {
    setPageContextMenu(null);
  }

  function pageContextMenuItems(pageIndex: number): ContextMenuItem[] {
    return [
      {
        label: "Rotate right",
        onSelect: () => onRotatePage?.(pageIndex, 90),
      },
      {
        label: "Rotate left",
        onSelect: () => onRotatePage?.(pageIndex, -90),
      },
      {
        label: "Delete page",
        danger: true,
        onSelect: () => onDeletePageRequested?.(pageIndex),
      },
    ];
  }

  async function extractSelection() {
    if (selectedIndexes.length === 0) {
      setStatus("Select one or more pages before extracting.");
      return;
    }

    setStatus("Extracting selected pages...");
    const extracted = await onExtract(selectedIndexes);
    setStatus(extracted ? "Extracted pages opened as the working document." : "Selected pages could not be extracted.");
  }

  async function insertFromInput(input: FileAddInput) {
    try {
      if (delegatedOps) {
        // Streamed current doc: the insert delegates to the path-based
        // `insert_pages` op — the chosen file rides as a grant, any size.
        const entry = await readGrantEntry(input);

        if (!entry) {
          setStatus(DELEGATED_BROWSER_FILE_MESSAGE);
          return;
        }

        setStatus("Inserting pages...");
        const inserted = await delegatedOps.insert(entry.grant, insertAt);
        setStatus(inserted ? "Inserted pages opened as the working document." : "The selected file could not be inserted.");
        return;
      }

      const result = await readFileForAdd(input);

      if (result.kind !== "bytes") {
        // Inserting into an in-memory document runs through pdf-lib, so
        // above-threshold ADDED files stay gated here (the delegated insert
        // above only applies when the CURRENT document is streamed).
        const name = result.kind === "descriptor" ? result.descriptor.name : result.name;
        setStatus(tooLargeToAddMessage(name));
        return;
      }

      setStatus("Inserting pages...");
      const inserted = await onInsert(result.file, insertAt);
      setStatus(inserted ? "Inserted pages opened as the working document." : "The selected file could not be inserted.");
    } catch {
      setStatus("This PDF could not be opened. Check the file and try again.");
    }
  }

  async function handleInsertFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    await insertFromInput(file);
  }

  async function chooseInsertFile() {
    // Tauri: grant-returning picker (no eager byte read); browser or a shell
    // without pick_pdfs_for_add falls back to the DOM file input.
    setDocxRows([]);
    const picks = await pickPdfsForAdd(docxAddOptions(setStatus, setDocxRows));

    if (picks === null) {
      insertInputRef.current?.click();
      return;
    }

    const pick = picks[0];

    if (pick) {
      await insertFromInput(pick);
    }
  }

  async function insertSlipSheet() {
    const label = slipSheetLabel.trim();

    if (!label || slipSheetInserting) {
      setStatus("Enter a slip sheet label.");
      return;
    }

    setSlipSheetInserting(true);
    setStatus("Inserting slip sheet...");

    try {
      const pageSize = await resolveSlipSheetPageSize(pdfDocument, insertAt, document.pageCount);
      const bytes = await generateCoverPdf({
        label,
        description: slipSheetDescription.trim() || undefined,
        style: slipSheetStyle,
        pageSize,
      });
      const inserted = await onInsert({
        bytes,
        name: `${label}.pdf`,
        path: null,
      }, insertAt);

      setStatus(inserted ? "Inserted slip sheet opened as the working document." : "The slip sheet could not be inserted.");

      if (inserted) {
        setSlipSheetOpen(false);
      }
    } catch {
      setStatus("The slip sheet could not be inserted.");
    } finally {
      setSlipSheetInserting(false);
    }
  }

  async function exportSelectionAsImage() {
    const pageIndex = selectedIndexes[0];

    if (pageIndex === undefined || !onExportPageAsImage) {
      setStatus("Select one page before exporting an image.");
      return;
    }

    setStatus("Exporting page image...");
    const exported = await onExportPageAsImage(pageIndex);
    setStatus(exported ? "Page image saved." : "The page image could not be exported.");
  }

  // Which half of a page cell the pointer is over -> which side the moved
  // page(s) drop on. Horizontal split matches the reading order of the grid;
  // the midpoint counts as "before" so a drop onto a cell's center inserts
  // ahead of it (the intuitive default), and only the right half moves a page
  // past its target -- the move that a plain insert-before could never do.
  function dropSideForPointer(event: DragEvent<HTMLButtonElement>): "before" | "after" {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX <= rect.left + rect.width / 2 ? "before" : "after";
  }

  async function dropOn(targetPageIndex: number, side: "before" | "after") {
    setDragOverPageIndex(null);

    if (reorderPending || draggingPageIndex === null || draggingPageIndex === targetPageIndex) {
      setDraggingPageIndex(null);
      return;
    }

    const selectedSource = selectedPageIndexes.has(draggingPageIndex)
      ? selectedIndexes
      : [draggingPageIndex];
    const nextOrder = reorderPagesForDrop(pages, selectedSource, targetPageIndex, side);
    const nextCurrentPage = nextOrder.indexOf(document.currentPage - 1) + 1;
    // Grid cell the moved content lands in -- the first moved page's new slot.
    const insertIndex = nextOrder.indexOf(selectedSource[0] ?? draggingPageIndex);

    setDraggingPageIndex(null);

    if (!onReorderPages) {
      return;
    }

    setReorderPending(true);

    try {
      const reordered = await onReorderPages(nextOrder, nextCurrentPage);

      if (reordered) {
        // insertIndex is where the moved page(s) actually land in nextOrder
        // -- the grid always renders positions 0..pageCount-1, so that's
        // exactly the cell that will repaint with the moved content.
        setSettledPageIndex(insertIndex);
      }
    } finally {
      setReorderPending(false);
    }
  }

  return (
    <section className="organize-pages" aria-label="Organize Pages workspace">
      <header className="organize-pages__header">
        <div>
          <p className="organize-card__eyebrow">Organize</p>
          <h2>Organize Pages</h2>
          <p className="organize-pages__summary">
            {document.pageCount} {document.pageCount === 1 ? "page" : "pages"} · {selectedCount} selected
          </p>
        </div>
        <div className="organize-pages__header-actions">
          {onHelpRequested ? (
            <IconButton
              icon={<HelpIcon size={14} />}
              label="Help: Organize Pages"
              onClick={onHelpRequested}
            />
          ) : null}
          <button type="button" className="organize-card__ghost" onClick={onCancel}>
            Back to document
          </button>
        </div>
      </header>

      <div className="organize-pages__toolbar" aria-label="Selection actions">
        <button type="button" className="organize-secondary" disabled={selectedCount === 0} onClick={onRotateSelected}>
          <RotateIcon size={15} />
          Rotate
        </button>
        <button type="button" className="organize-secondary" disabled={selectedCount === 0} onClick={onDeleteSelected}>
          <DeleteIcon size={15} />
          Delete
        </button>
        <button type="button" className="organize-secondary" disabled={selectedCount === 0} onClick={extractSelection}>
          <ExtractIcon size={15} />
          Extract
        </button>
        <input
          ref={insertInputRef}
          className="organize-file-input"
          type="file"
          accept={ADD_FILE_ACCEPT}
          aria-label="Insert PDF in Organize Pages"
          onChange={handleInsertFile}
        />
        <button type="button" className="organize-secondary" onClick={() => void chooseInsertFile()}>
          <InsertIcon size={15} />
          Insert from File
        </button>
        <button
          type="button"
          className="organize-secondary"
          onClick={() => setSlipSheetOpen(true)}
          disabled={!canInsertSlipSheet}
          title={canInsertSlipSheet ? "Insert a generated slip sheet at the selected position." : "Not yet available for very large documents."}
        >
          <SlipSheetIcon size={15} />
          Insert Slip Sheet
        </button>
        <button type="button" className="organize-secondary" onClick={() => setSplitOpen(true)}>
          <SplitIcon size={15} />
          Split Document...
        </button>
        <button type="button" className="organize-secondary" disabled={selectedCount !== 1} onClick={exportSelectionAsImage}>
          <ImageIcon size={15} />
          Export page as image...
        </button>
        <span className="organize-pages__toolbar-spacer" aria-hidden="true" />
        <button type="button" className="organize-secondary" disabled={selectedCount === 0 || !canMoveUp} onClick={onMoveSelectedUp}>
          <ArrowUpIcon size={15} />
          Move Up
        </button>
        <button type="button" className="organize-secondary" disabled={selectedCount === 0 || !canMoveDown} onClick={onMoveSelectedDown}>
          <ArrowDownIcon size={15} />
          Move Down
        </button>
      </div>

      <DocxConversionRows rows={docxRows} />
      {status ? <p className="organize-flow__status" role="status">{status}</p> : null}

      {splitOpen ? (
        <div className="organize-pages__split-panel" role="dialog" aria-label="Split document">
          <div className="organize-pages__split-head">
            <p className="organize-card__eyebrow">Split Document</p>
            <button type="button" className="organize-card__ghost" onClick={() => setSplitOpen(false)}>
              Close
            </button>
          </div>
          <SplitFlow document={document} onSplit={onSplit} />
        </div>
      ) : null}

      {slipSheetOpen ? (
        <FloatingDialog
          title="Insert slip sheet"
          eyebrow="Organize"
          width="md"
          onClose={closeSlipSheetDialog}
        >
          <div className="organize-slip-sheet">
            <label className="organize-field">
              <span>Label</span>
              <input
                value={slipSheetLabel}
                onChange={(event) => setSlipSheetLabel(event.currentTarget.value)}
                disabled={slipSheetInserting}
              />
            </label>
            <label className="organize-field">
              <span>Description</span>
              <input
                value={slipSheetDescription}
                onChange={(event) => setSlipSheetDescription(event.currentTarget.value)}
                disabled={slipSheetInserting}
              />
            </label>
            <div className="organize-field organize-slip-sheet__cover">
              <span>Cover style</span>
              <CoverStylePicker
                value={slipSheetStyle}
                onChange={setSlipSheetStyle}
                sampleLabel={slipSheetLabel || "Exhibit A"}
                sampleDescription={slipSheetDescription || "Deposition transcript of Jane Doe"}
                disabled={slipSheetInserting}
              />
            </div>
            <div className="organize-slip-sheet__actions">
              <button
                type="button"
                className="organize-secondary"
                onClick={closeSlipSheetDialog}
                disabled={slipSheetInserting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="organize-primary"
                onClick={() => void insertSlipSheet()}
                disabled={slipSheetInserting || slipSheetLabel.trim().length === 0}
              >
                <SlipSheetIcon size={16} />
                Insert
              </button>
            </div>
          </div>
        </FloatingDialog>
      ) : null}

      <div
        className="organize-pages__grid"
        role="list"
        aria-label="Page grid"
        aria-busy={reorderPending}
        data-busy={reorderPending ? "true" : undefined}
      >
        {pages.map((pageIndex) => {
          const pageNumber = pageIndex + 1;
          const selected = selectedPageIndexes.has(pageIndex);

          return (
            <button
              key={pageIndex}
              type="button"
              className="organize-page"
              data-selected={selected ? "true" : undefined}
              data-current={document.currentPage === pageNumber ? "true" : undefined}
              data-dragging={draggingPageIndex === pageIndex ? "true" : undefined}
              data-drop-target={
                dragOverPageIndex === pageIndex && draggingPageIndex !== null && draggingPageIndex !== pageIndex
                  ? "true"
                  : undefined
              }
              data-drop-side={
                dragOverPageIndex === pageIndex && draggingPageIndex !== null && draggingPageIndex !== pageIndex
                  ? dropSide
                  : undefined
              }
              data-drop-settle={settledPageIndex === pageIndex ? "true" : undefined}
              onAnimationEnd={() => {
                setSettledPageIndex((current) => (current === pageIndex ? null : current));
              }}
              aria-pressed={selected}
              aria-label={`Organize page ${pageNumber}`}
              disabled={reorderPending}
              draggable={!reorderPending}
              onClick={(event) => {
                if (!reorderPending) {
                  onPageSelected?.(pageIndex, event);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setPageContextMenu({ x: event.clientX, y: event.clientY, pageIndex });
              }}
              onDragStart={(event) => {
                if (reorderPending) {
                  event.preventDefault();
                  return;
                }

                setDraggingPageIndex(pageIndex);
                // Without a real drag payload, WebView2 refuses to initiate
                // the drag at all on a <button><canvas> source.
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(pageIndex));

                const thumbCanvas = event.currentTarget.querySelector<HTMLCanvasElement>(
                  ".organize-page__canvas",
                );

                if (thumbCanvas) {
                  event.dataTransfer.setDragImage(
                    thumbCanvas,
                    thumbCanvas.width / 2,
                    thumbCanvas.height / 2,
                  );
                }
              }}
              onDragEnter={(event) => {
                if (!reorderPending && draggingPageIndex !== null) {
                  event.preventDefault();
                  setDragOverPageIndex(pageIndex);
                }
              }}
              onDragOver={(event) => {
                if (reorderPending) {
                  return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = "move";

                if (draggingPageIndex !== null) {
                  setDragOverPageIndex(pageIndex);
                  setDropSide(dropSideForPointer(event));
                }
              }}
              onDragLeave={() => {
                setDragOverPageIndex((current) => (current === pageIndex ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                void dropOn(pageIndex, dropSideForPointer(event));
              }}
              onDragEnd={() => {
                setDraggingPageIndex(null);
                setDragOverPageIndex(null);
              }}
            >
              <span className="organize-page__thumb">
                {pdfDocument ? (
                  <OrganizePageCanvas pdfDocument={pdfDocument} pageNumber={pageNumber} />
                ) : null}
              </span>
              <span className="organize-page__number">Page {pageNumber}</span>
            </button>
          );
        })}
      </div>

      {pageContextMenu ? (
        <ContextMenu
          x={pageContextMenu.x}
          y={pageContextMenu.y}
          items={pageContextMenuItems(pageContextMenu.pageIndex)}
          onClose={closePageContextMenu}
        />
      ) : null}
    </section>
  );
}

const OrganizePageCanvas = memo(function OrganizePageCanvas({
  pdfDocument,
  pageNumber,
}: {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
}) {
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
    }, { rootMargin: "220px" });

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
      const scale = Math.min(120 / baseViewport.width, 156 / baseViewport.height);
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
    <span ref={frameRef} className="organize-page__canvas-frame">
      <canvas ref={canvasRef} className="organize-page__canvas" aria-hidden="true" />
    </span>
  );
});

type MergeEntry =
  | { kind: "bytes"; file: OpenedFile & { pageCount: number } }
  | ({ kind: "grant" } & GrantEntry);

function MergeFlow({
  document,
  onMerge,
  delegatedMerge,
}: {
  document: DocumentState;
  onMerge: (files: readonly OpenedFile[]) => Promise<boolean>;
  delegatedMerge: OrganizeDelegatedOps["merge"] | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<MergeEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [docxRows, setDocxRows] = useState<readonly DocxConversionProgressRow[]>([]);
  const totalFiles = entries.length + (document.source ? 1 : 0);

  async function addPdfInputs(inputs: readonly FileAddInput[]) {
    if (inputs.length === 0) {
      return;
    }

    try {
      if (delegatedMerge) {
        // Streamed current doc: added files ride as grants for the
        // path-based merge — any size, no bytes in the WebView.
        const grantEntries = await Promise.all(inputs.map(readGrantEntry));
        const added = grantEntries.flatMap((entry): MergeEntry[] => (
          entry ? [{ kind: "grant", ...entry }] : []
        ));

        if (added.length > 0) {
          setEntries((current) => [...current, ...added]);
        }

        setStatus(added.length === grantEntries.length ? null : DELEGATED_BROWSER_FILE_MESSAGE);
        return;
      }

      const outcomes = await Promise.all(inputs.map(readOpenedPdfWithCount));
      const added = outcomes.flatMap((outcome): MergeEntry[] => (
        outcome.status === "ok" ? [{ kind: "bytes", file: outcome.file }] : []
      ));
      const rejected = outcomes.flatMap((outcome) => (outcome.status === "tooLarge" ? [outcome.name] : []));

      if (added.length > 0) {
        setEntries((current) => [...current, ...added]);
      }

      setStatus(
        rejected.length === 0
          ? null
          : rejected.length === 1 && rejected[0] !== undefined
            ? tooLargeToAddMessage(rejected[0])
            : `${rejected.length} PDFs are too large to add here.`,
      );
    } catch {
      setStatus("One PDF could not be opened. Check the files and try again.");
    }
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    await addPdfInputs(selectedFiles);
  }

  async function addPdfs() {
    // Tauri: grant-returning picker (no eager byte read); browser or a shell
    // without pick_pdfs_for_add falls back to the DOM file input.
    setDocxRows([]);
    const picks = await pickPdfsForAdd(docxAddOptions(setStatus, setDocxRows));

    if (picks === null) {
      inputRef.current?.click();
      return;
    }

    await addPdfInputs(picks);
  }

  async function merge() {
    if (entries.length === 0) {
      setStatus("Add at least one PDF to merge with the current document.");
      return;
    }

    setStatus(delegatedMerge ? "Merging PDFs..." : "Merging PDFs...");
    const merged = delegatedMerge
      ? await delegatedMerge(entries.flatMap((entry) => (entry.kind === "grant" ? [entry.grant] : [])))
      : await onMerge(entries.flatMap((entry) => (entry.kind === "bytes" ? [entry.file] : [])));
    setStatus(merged ? "Merged PDF opened as the working document." : "The PDFs could not be merged. Check the files and try again.");
  }

  return (
    <div className="organize-flow">
      <p className="organize-flow__copy">The current PDF stays first. Added PDFs follow in the order shown.</p>
      <div className="organize-file-list" role="list">
        <p role="listitem">{document.fileName ?? "Current PDF"} · {document.pageCount} {document.pageCount === 1 ? "page" : "pages"}</p>
        {entries.map((entry) => (
          <p key={`${entry.kind === "bytes" ? entry.file.name : entry.name}-${entry.kind === "bytes" ? entry.file.pageCount : entry.grant}`} role="listitem">
            {entry.kind === "bytes"
              ? `${entry.file.name} · ${entry.file.pageCount} ${entry.file.pageCount === 1 ? "page" : "pages"}`
              : `${entry.name}${formatEntryPages(entry.pageCount)}`}
          </p>
        ))}
      </div>
      <input ref={inputRef} className="organize-file-input" type="file" accept={ADD_FILE_ACCEPT} multiple aria-label="Add PDFs to merge" onChange={handleFiles} />
      <button type="button" className="organize-secondary" onClick={() => void addPdfs()}>
        <PlusIcon size={15} />
        Add PDFs...
      </button>
      <DocxConversionRows rows={docxRows} />
      <ActionStatus message={status} />
      <button type="button" className="organize-primary" onClick={merge} disabled={entries.length === 0}>
        <CombineExhibitsIcon size={16} />
        Merge {totalFiles} Files
      </button>
    </div>
  );
}

function SplitFlow({
  document,
  onSplit,
}: {
  document: DocumentState;
  onSplit: (pageGroups: readonly (readonly number[])[]) => Promise<SavedFile[] | null>;
}) {
  const [range, setRange] = useState(formatDefaultRange(document.pageCount));
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const parsed = useMemo(() => parsePageRanges(range, document.pageCount), [document.pageCount, range]);

  async function split() {
    setTouched(true);

    if (parsed.error) {
      return;
    }

    setStatus("Writing split parts...");
    const saved = await onSplit(parsed.groups);
    setStatus(saved ? `Saved ${saved.length} ${saved.length === 1 ? "part" : "parts"}.` : "The document could not be split. Check the ranges and try again.");
  }

  return (
    <PageRangeFlow
      icon={<SplitIcon size={16} />}
      label="Part ranges"
      hint="Comma-separated ranges become separate parts."
      value={range}
      error={touched ? parsed.error : null}
      buttonText={`Split into ${parsed.groups.length || 0} Parts`}
      status={status}
      onBlur={() => setTouched(true)}
      onChange={setRange}
      onSubmit={split}
    />
  );
}

function InsertFlow({
  document,
  onInsert,
  delegatedInsert,
}: {
  document: DocumentState;
  onInsert: (file: OpenedFile, insertAtPageIndex: number) => Promise<boolean>;
  delegatedInsert: OrganizeDelegatedOps["insert"] | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [entry, setEntry] = useState<MergeEntry | null>(null);
  const [insertAfter, setInsertAfter] = useState(String(document.currentPage));
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [docxRows, setDocxRows] = useState<readonly DocxConversionProgressRow[]>([]);
  const pageNumber = Number(insertAfter);
  const error = getInsertError(insertAfter, document.pageCount);

  async function setFileFromInput(input: FileAddInput) {
    try {
      if (delegatedInsert) {
        // Streamed current doc: the chosen file rides as a grant for the
        // path-based insert — any size.
        const grantEntry = await readGrantEntry(input);

        if (!grantEntry) {
          setStatus(DELEGATED_BROWSER_FILE_MESSAGE);
          return;
        }

        setEntry({ kind: "grant", ...grantEntry });
        setStatus(null);
        return;
      }

      const outcome = await readOpenedPdfWithCount(input);

      if (outcome.status === "tooLarge") {
        setStatus(tooLargeToAddMessage(outcome.name));
        return;
      }

      setEntry({ kind: "bytes", file: outcome.file });
      setStatus(null);
    } catch {
      setStatus("This PDF could not be opened. Check the file and try again.");
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!selectedFile) {
      return;
    }

    await setFileFromInput(selectedFile);
  }

  async function choosePdf() {
    // Tauri: grant-returning picker (no eager byte read); browser or a shell
    // without pick_pdfs_for_add falls back to the DOM file input.
    setDocxRows([]);
    const picks = await pickPdfsForAdd(docxAddOptions(setStatus, setDocxRows));

    if (picks === null) {
      inputRef.current?.click();
      return;
    }

    const pick = picks[0];

    if (pick) {
      await setFileFromInput(pick);
    }
  }

  async function insert() {
    setTouched(true);

    if (!entry) {
      setStatus("Choose a PDF to insert.");
      return;
    }

    if (error) {
      return;
    }

    if (entry.kind === "grant") {
      if (!delegatedInsert) {
        setStatus("The selected file could not be inserted. Check the file and try again.");
        return;
      }

      setStatus("Inserting pages...");
      const inserted = await delegatedInsert(entry.grant, pageNumber);
      setStatus(inserted ? "Inserted pages opened as the working document." : "The selected file could not be inserted. Check the file and try again.");
      return;
    }

    setStatus("Inserting pages...");
    const inserted = await onInsert(entry.file, pageNumber);
    setStatus(inserted ? "Inserted pages opened as the working document." : "The selected file could not be inserted. Check the file and try again.");
  }

  return (
    <div className="organize-flow">
      <input ref={inputRef} className="organize-file-input" type="file" accept={ADD_FILE_ACCEPT} aria-label="Choose PDF to insert" onChange={handleFile} />
      <button type="button" className="organize-secondary" onClick={() => void choosePdf()}>
        <InsertIcon size={15} />
        Choose PDF...
      </button>
      {entry ? (
        <p className="organize-flow__copy">
          {entry.kind === "bytes"
            ? `${entry.file.name} · ${entry.file.pageCount} ${entry.file.pageCount === 1 ? "page" : "pages"}`
            : `${entry.name}${formatEntryPages(entry.pageCount)}`}
        </p>
      ) : null}
      <DocxConversionRows rows={docxRows} />
      <label className="organize-field">
        <span>Insert after page</span>
        <input value={insertAfter} inputMode="numeric" onBlur={() => setTouched(true)} onChange={(event) => setInsertAfter(event.currentTarget.value)} />
        {touched && error ? <span className="organize-field__error">{error}</span> : null}
      </label>
      <ActionStatus message={status} />
      <button type="button" className="organize-primary" onClick={insert} disabled={!entry}>
        <InsertIcon size={16} />
        Insert from File
      </button>
    </div>
  );
}

function CropResizeFlow({
  document,
  onCropResize,
}: {
  document: DocumentState;
  onCropResize: (
    pageIndexes: readonly number[],
    options: { cropMarginIn: number; resizePreset: ResizePreset },
  ) => Promise<boolean>;
}) {
  const [range, setRange] = useState(formatDefaultRange(document.pageCount));
  const [margin, setMargin] = useState("0");
  const [preset, setPreset] = useState<ResizePreset>("original");
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const parsed = useMemo(() => parsePageRanges(range, document.pageCount), [document.pageCount, range]);
  const marginNumber = Number(margin);
  const marginError = Number.isFinite(marginNumber) && marginNumber >= 0 && marginNumber <= 2
    ? null
    : "Use a margin from 0 to 2 inches.";

  async function apply() {
    setTouched(true);

    if (parsed.error || marginError) {
      return;
    }

    setStatus("Applying crop and resize...");
    const resized = await onCropResize(parsed.pageIndexes, {
      cropMarginIn: marginNumber,
      resizePreset: preset,
    });
    setStatus(resized ? "Cropped PDF opened as the working document." : "The pages could not be cropped. Check the range and try again.");
  }

  return (
    <div className="organize-flow">
      <label className="organize-field">
        <span>Pages</span>
        <input value={range} onBlur={() => setTouched(true)} onChange={(event) => setRange(event.currentTarget.value)} />
        {touched && parsed.error ? <span className="organize-field__error">{parsed.error}</span> : null}
      </label>
      <label className="organize-field">
        <span>Crop margin, inches</span>
        <input value={margin} inputMode="decimal" onBlur={() => setTouched(true)} onChange={(event) => setMargin(event.currentTarget.value)} />
        {touched && marginError ? <span className="organize-field__error">{marginError}</span> : null}
      </label>
      <label className="organize-field">
        <span>Resize pages</span>
        <select value={preset} onChange={(event) => setPreset(event.currentTarget.value as ResizePreset)}>
          <option value="original">Keep current size</option>
          <option value="letter">Letter</option>
          <option value="legal">Legal</option>
        </select>
      </label>
      <ActionStatus message={status} />
      <button type="button" className="organize-primary" onClick={apply}>
        <CropIcon size={16} />
        Apply Crop / Resize
      </button>
    </div>
  );
}

function PageRangeFlow({
  icon,
  label,
  hint,
  value,
  error,
  buttonText,
  status,
  onBlur,
  onChange,
  onSubmit,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  value: string;
  error: string | null;
  buttonText: string;
  status: string | null;
  onBlur: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="organize-flow">
      <label className="organize-field">
        <span>{label}</span>
        <input value={value} onBlur={onBlur} onChange={(event) => onChange(event.currentTarget.value)} />
        <span className="organize-field__hint">{hint}</span>
        {error ? <span className="organize-field__error">{error}</span> : null}
      </label>
      <ActionStatus message={status} />
      <button type="button" className="organize-primary" onClick={onSubmit}>
        {icon}
        {buttonText}
      </button>
    </div>
  );
}

function ActionStatus({ message }: { message: string | null }) {
  return message ? <p className="organize-flow__status" role="status">{message}</p> : null;
}

function DocxConversionRows({ rows }: { rows: readonly DocxConversionProgressRow[] }) {
  return rows.length > 0 ? (
    <div className="organize-file-list" role="list" aria-label="Word conversion progress">
      {rows.map((row) => (
        <p key={row.id} role="listitem">
          {row.name} · {row.message}
        </p>
      ))}
    </div>
  ) : null;
}

function docxAddOptions(
  setStatus: (message: string | null) => void,
  setRows: (rows: readonly DocxConversionProgressRow[]) => void,
): PickPdfsForAddOptions {
  return {
    onDocxRowsChange: setRows,
    onWordUnavailable: (message) => setStatus(message || WORD_UNAVAILABLE_MESSAGE),
    onDocxErrors: (errors) => {
      const wordGuidance = wordDocxAddErrorMessage(errors);
      if (wordGuidance) {
        setStatus(wordGuidance);
      } else if (errors.length === 1 && errors[0]) {
        setStatus(`"${errors[0].name}" could not be converted from Word.`);
      } else if (errors.length > 1) {
        setStatus(`${errors.length} Word documents could not be converted.`);
      }
    },
  };
}

type AddPdfOutcome =
  | { status: "ok"; file: OpenedFile & { pageCount: number } }
  | { status: "tooLarge"; name: string };

async function readOpenedPdfWithCount(input: FileAddInput): Promise<AddPdfOutcome> {
  const result = await readFileForAdd(input);

  if (result.kind !== "bytes") {
    // Merge/insert consume full bytes in the in-memory pdf-lib engine, so
    // above-threshold adds (browser gate or Tauri grant descriptor) stay
    // gated until the delegated qpdf pipeline lands (large-PDF plan Phase 3).
    return {
      status: "tooLarge",
      name: result.kind === "descriptor" ? result.descriptor.name : result.name,
    };
  }

  const pdf = await PDFDocument.load(result.file.bytes);

  return {
    status: "ok",
    file: { ...result.file, pageCount: pdf.getPageCount() },
  };
}

function getInsertError(value: string, pageCount: number): string | null {
  const page = Number(value);

  if (!Number.isInteger(page)) {
    return "Use a whole page number.";
  }

  if (page < 0 || page > pageCount) {
    return `Use 0 through ${pageCount}.`;
  }

  return null;
}

function getFlowTitle(flow: OrganizeFlowId): string {
  switch (flow) {
    case "pages":
      return "Organize Pages";
    case "merge":
      return "Merge PDFs";
    case "insert":
      return "Insert from File";
    case "crop":
      return "Crop / Resize";
  }
}
