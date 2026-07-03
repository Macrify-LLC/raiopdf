import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import { PDFDocument } from "pdf-lib";
import type { ResizePreset } from "../lib/cropResize";
import { readBrowserFile, type OpenedFile, type SavedFile } from "../lib/filePort";
import { formatDefaultRange, parsePageRanges } from "../lib/pageRanges";
import type { DocumentState } from "../hooks/useDocument";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CombineExhibitsIcon,
  CropIcon,
  DeleteIcon,
  ExtractIcon,
  InsertIcon,
  PlusIcon,
  RotateIcon,
  SplitIcon,
} from "../icons";
import "./OrganizeWorkspace.css";

export type OrganizeFlowId = "pages" | "merge" | "insert" | "crop";

export interface OrganizeWorkspaceProps {
  flow: OrganizeFlowId;
  document: DocumentState;
  pdfDocument?: PDFDocumentProxy | null;
  selectedPageIndexes?: ReadonlySet<number>;
  onCancel: () => void;
  onPageSelected?: (pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void;
  onRotateSelected?: () => void;
  onDeleteSelected?: () => void;
  onMoveSelectedUp?: () => void;
  onMoveSelectedDown?: () => void;
  onReorderPages?: (pageIndexes: readonly number[], currentPage: number) => Promise<boolean>;
  onMerge: (files: readonly OpenedFile[]) => Promise<boolean>;
  onExtract: (pageIndexes: readonly number[]) => Promise<boolean>;
  onSplit: (pageGroups: readonly (readonly number[])[]) => Promise<SavedFile[] | null>;
  onInsert: (file: OpenedFile, insertAtPageIndex: number) => Promise<boolean>;
  onCropResize: (
    pageIndexes: readonly number[],
    options: { cropMarginIn: number; resizePreset: ResizePreset },
  ) => Promise<boolean>;
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
  onMoveSelectedUp,
  onMoveSelectedDown,
  onReorderPages,
  onMerge,
  onExtract,
  onSplit,
  onInsert,
  onCropResize,
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
        onMoveSelectedUp={onMoveSelectedUp}
        onMoveSelectedDown={onMoveSelectedDown}
        onReorderPages={onReorderPages}
        onExtract={onExtract}
        onSplit={onSplit}
        onInsert={onInsert}
      />
    );
  }

  return (
    <section className="organize-workspace" aria-label={`${title} workspace`}>
      <div className="organize-card">
        <header className="organize-card__header">
          <div>
            <p className="organize-card__eyebrow">Organize</p>
            <h2>{title}</h2>
          </div>
          <button type="button" className="organize-card__ghost" onClick={onCancel}>
            Cancel
          </button>
        </header>

        {flow === "merge" ? (
          <MergeFlow document={document} onMerge={onMerge} />
        ) : null}
        {flow === "insert" ? (
          <InsertFlow document={document} onInsert={onInsert} />
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
  onMoveSelectedUp,
  onMoveSelectedDown,
  onReorderPages,
  onExtract,
  onSplit,
  onInsert,
}: {
  document: DocumentState;
  pdfDocument: PDFDocumentProxy | null;
  selectedPageIndexes: ReadonlySet<number>;
  onCancel: () => void;
  onPageSelected?: ((pageIndex: number, event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  onRotateSelected?: (() => void) | undefined;
  onDeleteSelected?: (() => void) | undefined;
  onMoveSelectedUp?: (() => void) | undefined;
  onMoveSelectedDown?: (() => void) | undefined;
  onReorderPages?: ((pageIndexes: readonly number[], currentPage: number) => Promise<boolean>) | undefined;
  onExtract: (pageIndexes: readonly number[]) => Promise<boolean>;
  onSplit: (pageGroups: readonly (readonly number[])[]) => Promise<SavedFile[] | null>;
  onInsert: (file: OpenedFile, insertAtPageIndex: number) => Promise<boolean>;
}) {
  const insertInputRef = useRef<HTMLInputElement>(null);
  const [draggingPageIndex, setDraggingPageIndex] = useState<number | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const pages = Array.from({ length: document.pageCount }, (_, index) => index);
  const selectedIndexes = [...selectedPageIndexes].sort((left, right) => left - right);
  const selectedCount = selectedIndexes.length;
  const insertAt = selectedIndexes[0] ?? document.currentPage - 1;
  const canMoveUp = selectedIndexes.some((pageIndex) => pageIndex > 0 && !selectedPageIndexes.has(pageIndex - 1));
  const canMoveDown = selectedIndexes.some((pageIndex) => (
    pageIndex < document.pageCount - 1 && !selectedPageIndexes.has(pageIndex + 1)
  ));

  async function extractSelection() {
    if (selectedIndexes.length === 0) {
      setStatus("Select one or more pages before extracting.");
      return;
    }

    setStatus("Extracting selected pages...");
    const extracted = await onExtract(selectedIndexes);
    setStatus(extracted ? "Extracted pages opened as the working document." : "Selected pages could not be extracted.");
  }

  async function handleInsertFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    try {
      const opened = await readBrowserFile(file);
      setStatus("Inserting pages...");
      const inserted = await onInsert(opened, insertAt);
      setStatus(inserted ? "Inserted pages opened as the working document." : "The selected file could not be inserted.");
    } catch {
      setStatus("This PDF could not be opened. Check the file and try again.");
    }
  }

  async function dropOn(targetPageIndex: number) {
    if (draggingPageIndex === null || draggingPageIndex === targetPageIndex) {
      setDraggingPageIndex(null);
      return;
    }

    const selectedSource = selectedPageIndexes.has(draggingPageIndex)
      ? selectedIndexes
      : [draggingPageIndex];
    const moving = new Set(selectedSource);
    const remaining = pages.filter((pageIndex) => !moving.has(pageIndex));
    const targetInRemaining = remaining.indexOf(targetPageIndex);
    const insertIndex = targetInRemaining === -1 ? remaining.length : targetInRemaining;
    const nextOrder = [
      ...remaining.slice(0, insertIndex),
      ...selectedSource,
      ...remaining.slice(insertIndex),
    ];
    const nextCurrentPage = nextOrder.indexOf(document.currentPage - 1) + 1;

    setDraggingPageIndex(null);
    await onReorderPages?.(nextOrder, nextCurrentPage);
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
        <button type="button" className="organize-card__ghost" onClick={onCancel}>
          Back to document
        </button>
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
          accept="application/pdf"
          aria-label="Insert PDF in Organize Pages"
          onChange={handleInsertFile}
        />
        <button type="button" className="organize-secondary" onClick={() => insertInputRef.current?.click()}>
          <InsertIcon size={15} />
          Insert from File
        </button>
        <button type="button" className="organize-secondary" onClick={() => setSplitOpen(true)}>
          <SplitIcon size={15} />
          Split Document...
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

      <div className="organize-pages__grid" role="list" aria-label="Page grid">
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
              aria-pressed={selected}
              aria-label={`Organize page ${pageNumber}`}
              draggable
              onClick={(event) => onPageSelected?.(pageIndex, event)}
              onDragStart={() => setDraggingPageIndex(pageIndex)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => void dropOn(pageIndex)}
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
    </section>
  );
}

function OrganizePageCanvas({
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
}

function MergeFlow({
  document,
  onMerge,
}: {
  document: DocumentState;
  onMerge: (files: readonly OpenedFile[]) => Promise<boolean>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Array<OpenedFile & { pageCount: number }>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const totalFiles = files.length + (document.bytes ? 1 : 0);

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    try {
      const openedFiles = await Promise.all(selectedFiles.map(readOpenedPdfWithCount));
      setFiles((current) => [...current, ...openedFiles]);
      setStatus(null);
    } catch {
      setStatus("One PDF could not be opened. Check the files and try again.");
    }
  }

  async function merge() {
    if (files.length === 0) {
      setStatus("Add at least one PDF to merge with the current document.");
      return;
    }

    setStatus("Merging PDFs...");
    const merged = await onMerge(files);
    setStatus(merged ? "Merged PDF opened as the working document." : "The PDFs could not be merged. Check the files and try again.");
  }

  return (
    <div className="organize-flow">
      <p className="organize-flow__copy">The current PDF stays first. Added PDFs follow in the order shown.</p>
      <div className="organize-file-list" role="list">
        <p role="listitem">{document.fileName ?? "Current PDF"} · {document.pageCount} {document.pageCount === 1 ? "page" : "pages"}</p>
        {files.map((file) => (
          <p key={`${file.name}-${file.pageCount}`} role="listitem">{file.name} · {file.pageCount} {file.pageCount === 1 ? "page" : "pages"}</p>
        ))}
      </div>
      <input ref={inputRef} className="organize-file-input" type="file" accept="application/pdf" multiple aria-label="Add PDFs to merge" onChange={handleFiles} />
      <button type="button" className="organize-secondary" onClick={() => inputRef.current?.click()}>
        <PlusIcon size={15} />
        Add PDFs...
      </button>
      <ActionStatus message={status} />
      <button type="button" className="organize-primary" onClick={merge} disabled={files.length === 0}>
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
}: {
  document: DocumentState;
  onInsert: (file: OpenedFile, insertAtPageIndex: number) => Promise<boolean>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<(OpenedFile & { pageCount: number }) | null>(null);
  const [insertAfter, setInsertAfter] = useState(String(document.currentPage));
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const pageNumber = Number(insertAfter);
  const error = getInsertError(insertAfter, document.pageCount);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!selectedFile) {
      return;
    }

    try {
      setFile(await readOpenedPdfWithCount(selectedFile));
      setStatus(null);
    } catch {
      setStatus("This PDF could not be opened. Check the file and try again.");
    }
  }

  async function insert() {
    setTouched(true);

    if (!file) {
      setStatus("Choose a PDF to insert.");
      return;
    }

    if (error) {
      return;
    }

    setStatus("Inserting pages...");
    const inserted = await onInsert(file, pageNumber);
    setStatus(inserted ? "Inserted pages opened as the working document." : "The selected file could not be inserted. Check the file and try again.");
  }

  return (
    <div className="organize-flow">
      <input ref={inputRef} className="organize-file-input" type="file" accept="application/pdf" aria-label="Choose PDF to insert" onChange={handleFile} />
      <button type="button" className="organize-secondary" onClick={() => inputRef.current?.click()}>
        <InsertIcon size={15} />
        Choose PDF...
      </button>
      {file ? <p className="organize-flow__copy">{file.name} · {file.pageCount} {file.pageCount === 1 ? "page" : "pages"}</p> : null}
      <label className="organize-field">
        <span>Insert after page</span>
        <input value={insertAfter} inputMode="numeric" onBlur={() => setTouched(true)} onChange={(event) => setInsertAfter(event.currentTarget.value)} />
        {touched && error ? <span className="organize-field__error">{error}</span> : null}
      </label>
      <ActionStatus message={status} />
      <button type="button" className="organize-primary" onClick={insert} disabled={!file}>
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

async function readOpenedPdfWithCount(file: File): Promise<OpenedFile & { pageCount: number }> {
  const opened = await readBrowserFile(file);
  const pdf = await PDFDocument.load(opened.bytes);

  return {
    ...opened,
    pageCount: pdf.getPageCount(),
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
