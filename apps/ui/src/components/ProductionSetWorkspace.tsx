import { useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import type { OpenedFile } from "../lib/filePort";
import { useBatesPrefix } from "../hooks/useBatesPrefix";
import { tooLargeToAddMessage, type FileAddResult } from "../lib/readFileForAdd";
import {
  productionHintMessage,
  readProductionLastUsed,
} from "../lib/productionHints";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, HelpIcon, PlusIcon } from "../icons";
import { ErrorReportButton } from "./ErrorReportButton";
import { IconButton } from "./IconButton";
import { PackageRootPathField } from "./PackageRootPathField";
import "./ProductionSetWorkspace.css";

export interface ProductionSetFile {
  id: string;
  name: string;
  path: string | null;
  /**
   * Page count when known; `null` = deferred -- an above-threshold add whose
   * descriptor carried no `page_count(grant)` result (bytes are never loaded
   * for large files, so pdf-lib cannot count them). The production build
   * itself is path-based and does not need the count.
   */
  pages: number | null;
  designation: string;
}

export interface ProductionSetRunInput {
  files: readonly ProductionSetFile[];
  prefix: string;
  start: number;
  digits: number;
  outputDir: string;
  includeIndex: boolean;
  includeFilenameInIndex: boolean;
  combinedPdf: boolean;
  volumeSizeMb: number | null;
}

export interface ProductionSetRunResult {
  packageRoot: string;
  indexLocation: string | null;
  nextNumber: number;
  fileCount: number;
}

export interface ProductionSetProgress {
  running: boolean;
  message: string | null;
  result: ProductionSetRunResult | null;
}

/**
 * Bytes-free descriptor of the currently open document (mirrors
 * `BatchCleanupSourceFile`): a streamed large doc has no `document.bytes`, but
 * it has a name and a path/grant — which is all the path-based production
 * build needs, so it seeds the production order like any small doc.
 */
export interface ProductionSetSourceFile {
  name: string;
  path: string | null;
}

export interface ProductionSetWorkspaceProps {
  currentFile: ProductionSetSourceFile | null;
  /**
   * Why the open document was NOT seeded into the production order (e.g. it
   * has unsaved changes, so its on-disk bytes are stale). Shown as the
   * initial status message so the omission is visible, never silent.
   */
  currentFileNotice?: string | null | undefined;
  currentPageCount: number;
  progress: ProductionSetProgress;
  onAddFile: () => Promise<FileAddResult | null>;
  onRun: (input: ProductionSetRunInput) => Promise<void>;
  /** Opens the finished package root in the system file manager (desktop only). */
  onOpenPackageRoot?: ((path: string) => void) | undefined;
  onHelpRequested?: (() => void) | undefined;
}

const DESIGNATION_OPTIONS = [
  "",
  "Confidential",
  "Confidential - Attorneys' Eyes Only",
  "Custom",
] as const;

export function ProductionSetWorkspace({
  currentFile,
  currentFileNotice,
  currentPageCount,
  progress,
  onAddFile,
  onRun,
  onOpenPackageRoot,
  onHelpRequested,
}: ProductionSetWorkspaceProps) {
  const mountedRef = useRef(true);
  const addFilePendingRef = useRef(false);
  const [files, setFiles] = useState<ProductionSetFile[]>(() =>
    currentFile ? [fromSourceFile(currentFile, currentPageCount)] : [],
  );
  const {
    prefix,
    setPrefix,
    noPrefix,
    setNoPrefix,
    effectivePrefix,
    prefixMissing,
    gateMessage,
  } = useBatesPrefix();
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(6);
  const [outputDir, setOutputDir] = useState("");
  const [includeIndex, setIncludeIndex] = useState(true);
  const [includeFilenameInIndex, setIncludeFilenameInIndex] = useState(true);
  const [combinedPdf, setCombinedPdf] = useState(false);
  const [useVolumeCap, setUseVolumeCap] = useState(false);
  const [volumeSizeMb, setVolumeSizeMb] = useState(25);
  const [addingFile, setAddingFile] = useState(false);
  const [pendingPageCountReads, setPendingPageCountReads] = useState(0);
  const [localMessage, setLocalMessage] = useState<string | null>(currentFileNotice ?? null);
  const hint = useMemo(() => productionHintMessage(effectivePrefix), [effectivePrefix]);
  const totalPages = files.reduce((sum, file) => sum + (file.pages ?? 0), 0);
  const lastNumber = start + Math.max(0, totalPages - 1);
  const overflows = Number.isFinite(lastNumber) && lastNumber >= 10 ** digits;
  const addFileBusy = addingFile || pendingPageCountReads > 0;
  const canRun = files.length > 0 &&
    outputDir.trim().length > 0 &&
    !prefixMissing &&
    !overflows &&
    !addFileBusy &&
    !progress.running;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const lastUsed = readProductionLastUsed(effectivePrefix);
    if (lastUsed !== null) {
      setStart(lastUsed + 1);
    }
  }, [effectivePrefix]);

  async function addFile() {
    if (addFilePendingRef.current) {
      return;
    }

    addFilePendingRef.current = true;
    setAddingFile(true);

    try {
      const result = await onAddFile();
      if (!result || !mountedRef.current) {
        return;
      }

      if (result.kind === "tooLarge") {
        setLocalMessage(tooLargeToAddMessage(result.name));
        return;
      }

      if (result.kind === "descriptor") {
        // Above-threshold add: never load bytes. The page count comes from
        // page_count(grant) when the shell op exists; otherwise it stays
        // deferred (null) -- the path-based production build works either way.
        const { descriptor } = result;
        setFiles((current) => [...current, {
          id: productionSetFileId(descriptor.name),
          name: descriptor.name,
          path: descriptor.grant,
          pages: descriptor.pageCount,
          designation: "",
        }]);
        setLocalMessage(descriptor.pageCount === null
          ? "Added a large PDF; its page count will be determined during the production build."
          : null);
        return;
      }

      const opened = result.file;
      setPendingPageCountReads((current) => current + 1);
      setLocalMessage("Reading page count...");

      try {
        const pages = await readProductionSetPageCount(opened.bytes);
        if (!mountedRef.current) {
          return;
        }
        setFiles((current) => [...current, fromOpenedFile(opened, pages)]);
        setLocalMessage(null);
      } catch {
        if (!mountedRef.current) {
          return;
        }
        setLocalMessage("That PDF's pages could not be counted. Reopen or repair it before building production.");
      } finally {
        if (mountedRef.current) {
          setPendingPageCountReads((current) => Math.max(0, current - 1));
        }
      }
    } finally {
      if (mountedRef.current) {
        setAddingFile(false);
      }
      addFilePendingRef.current = false;
    }
  }

  function moveFile(index: number, delta: -1 | 1) {
    setFiles((current) => {
      const next = [...current];
      const target = index + delta;
      const file = next[index];
      if (!file || target < 0 || target >= next.length) {
        return current;
      }
      next.splice(index, 1);
      next.splice(target, 0, file);
      return next;
    });
  }

  async function run() {
    setLocalMessage(null);
    if (!canRun) {
      setLocalMessage(overflows
        ? "Increase the digit width or lower the start number."
        : "Add files and choose an empty package root folder.");
      return;
    }

    await onRun({
      files,
      prefix: effectivePrefix.trim(),
      start,
      digits,
      outputDir: outputDir.trim(),
      includeIndex,
      includeFilenameInIndex,
      combinedPdf,
      volumeSizeMb: useVolumeCap ? volumeSizeMb : null,
    });
  }

  return (
    <section className="production-workspace" aria-label="Production Set Builder">
      {/* The dialog chrome already shows "Legal / Production Set" -- repeating
          that title here stacked a second heading on the first. This section
          carries the thing the dialog title doesn't: the ordered file list,
          styled the same way as Prepare for Filing's packet order so the two
          "reorder documents, then run" flows read as the same control. */}
      <section className="production-workspace__section" aria-label="Production order">
        <div className="production-workspace__header">
          <div>
            <p className="production-workspace__title">Production order</p>
            <p className="production-workspace__subtitle">
              {files.length} document{files.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="production-workspace__header-actions">
            {onHelpRequested ? (
              <IconButton
                icon={<HelpIcon size={14} />}
                label="Help: Production Set"
                onClick={onHelpRequested}
              />
            ) : null}
            <button
              type="button"
              className="production-workspace__secondary-button"
              onClick={addFile}
              disabled={addFileBusy || progress.running}
              title={addFileBusy ? "Wait for the current PDF page count to finish." : "Add another PDF to the production order."}
            >
              <PlusIcon size={14} /> Add PDF
            </button>
          </div>
        </div>
        <div className="production-workspace__file-list" role="list">
          {files.length === 0 ? (
            <p className="production-workspace__empty">Add PDFs to build the production order.</p>
          ) : null}
          {files.map((file, index) => (
            <div className="production-workspace__file-row" role="listitem" key={file.id}>
              <div className="production-workspace__file-body">
                <span className="production-workspace__file-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <p className="production-workspace__file-name">{file.name}</p>
                  <p className="production-workspace__file-meta" title="Pages counted from the opened PDF.">
                    {file.pages === null
                      ? "page count pending"
                      : `${file.pages} page${file.pages === 1 ? "" : "s"}`}
                  </p>
                </div>
              </div>
              <label
                className="production-workspace__designation"
                title="Optional confidentiality text to include for this source in the production package."
              >
                <span>Designation</span>
                <select
                  value={designationSelectValue(file.designation)}
                  onChange={(event) => {
                    const next = event.target.value === "Custom" ? file.designation : event.target.value;
                    setFiles((current) => current.map((item) => (
                      item.id === file.id ? { ...item, designation: next } : item
                    )));
                  }}
                >
                  {DESIGNATION_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option || "None"}</option>
                  ))}
                </select>
              </label>
              <div className="production-workspace__file-actions">
                <button
                  type="button"
                  className="production-workspace__icon-button"
                  aria-label={`Move ${file.name} up`}
                  disabled={index === 0}
                  onClick={() => moveFile(index, -1)}
                >
                  <ArrowUpIcon size={15} />
                </button>
                <button
                  type="button"
                  className="production-workspace__icon-button"
                  aria-label={`Move ${file.name} down`}
                  disabled={index === files.length - 1}
                  onClick={() => moveFile(index, 1)}
                >
                  <ArrowDownIcon size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="production-workspace__section" aria-label="Bates numbering">
        <p className="production-workspace__title">Bates numbering</p>
        <div className="production-workspace__grid">
          <label title="Letters before the Bates number, for example SMITH000001.">
            <span>Prefix</span>
            <input
              value={prefix}
              placeholder="e.g. SMITH"
              disabled={noPrefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
          </label>
          <label title="First Bates number to use for the first selected page.">
            <span>Start</span>
            <input
              type="number"
              min="0"
              value={start}
              onChange={(event) => setStart(Number(event.target.value))}
            />
          </label>
          <label title="Minimum number of digits to pad after the prefix.">
            <span>Digits</span>
            <input
              type="number"
              min="1"
              max="12"
              value={digits}
              onChange={(event) => setDigits(Number(event.target.value))}
            />
          </label>
          <label title="Choose an empty folder where RaioPDF can write the production package.">
            <span>Package root folder</span>
            <PackageRootPathField
              value={outputDir}
              onChange={setOutputDir}
              disabled={progress.running}
              browseButtonClassName="production-workspace__secondary-button"
            />
          </label>
        </div>
        <label
          className="production-workspace__checkbox-row"
          title="Stamp Bates numbers with no letter prefix — numbers only."
        >
          <input
            type="checkbox"
            checked={noPrefix}
            onChange={(event) => setNoPrefix(event.target.checked)}
          />
          <span>No prefix (numbers only)</span>
        </label>
        {hint ? <p className="production-workspace__status">{hint}</p> : null}
        {overflows ? (
          <p className="production-workspace__status">The last Bates number would exceed the configured digit width.</p>
        ) : null}
        {prefixMissing ? (
          <p className="production-workspace__status">{gateMessage}</p>
        ) : null}
      </section>

      <section className="production-workspace__section" aria-label="Output options">
        <p className="production-workspace__title">Output options</p>
        <div className="production-workspace__checks">
          <label className="production-workspace__checkbox-row" title="Write PDF and CSV indexes listing produced files and Bates ranges.">
            <input
              type="checkbox"
              checked={includeIndex}
              onChange={(event) => setIncludeIndex(event.target.checked)}
            />
            <span>Production index PDF and CSV</span>
          </label>
          <label className="production-workspace__checkbox-row" title="Include each source filename as a column in the production index.">
            <input
              type="checkbox"
              checked={includeFilenameInIndex}
              onChange={(event) => setIncludeFilenameInIndex(event.target.checked)}
            />
            <span>Filename column in index</span>
          </label>
          <label className="production-workspace__checkbox-row" title="Also write one combined produced PDF alongside individual outputs.">
            <input
              type="checkbox"
              checked={combinedPdf}
              onChange={(event) => setCombinedPdf(event.target.checked)}
            />
            <span>Combined production PDF</span>
          </label>
          <label className="production-workspace__checkbox-row" title="Group production outputs into volume folders by size.">
            <input
              type="checkbox"
              checked={useVolumeCap}
              onChange={(event) => setUseVolumeCap(event.target.checked)}
            />
            <span>Volume folders</span>
          </label>
        </div>
        {useVolumeCap ? (
          <label className="production-workspace__number" title="Maximum size for each volume folder before starting the next volume.">
            <span>Volume cap MB</span>
            <input
              type="number"
              min="1"
              value={volumeSizeMb}
              onChange={(event) => setVolumeSizeMb(Number(event.target.value))}
            />
          </label>
        ) : null}
      </section>

      <div className="production-workspace__button-row">
        <button
          type="button"
          className="production-workspace__primary-button"
          disabled={!canRun}
          title={prefixMissing ? gateMessage : undefined}
          onClick={() => void run()}
        >
          Build Production
        </button>
        <p className="production-workspace__status" role="status">
          {localMessage ?? progress.message ?? `${totalPages} page${totalPages === 1 ? "" : "s"} selected`}
        </p>
      </div>

      {/* A finished run carries a `result`; a build that failed leaves a message
          with no result and isn't running — that's the only state that offers an
          email report. Local validation (localMessage) is a user-fixable nudge,
          not a failure, so it doesn't. */}
      {!localMessage && !progress.running && !progress.result && progress.message ? (
        <ErrorReportButton className="production-workspace__report" />
      ) : null}

      {progress.result ? (
        <section className="production-workspace__result" aria-label="Production build result">
          <div className="production-workspace__result-header">
            <CheckIcon size={15} />
            <div>
              <p className="production-workspace__result-title">Production package built</p>
              <p className="production-workspace__result-subtitle">
                {progress.result.fileCount} file{progress.result.fileCount === 1 ? "" : "s"} Bates-stamped and written.
              </p>
            </div>
          </div>
          <div className="production-workspace__result-parts">
            <div className="production-workspace__result-part">
              <span className="production-workspace__result-part-label">Package</span>
              <span className="production-workspace__result-part-value">{progress.result.packageRoot}</span>
            </div>
            <div className="production-workspace__result-part">
              <span className="production-workspace__result-part-label">Index</span>
              <span className="production-workspace__result-part-value">
                {progress.result.indexLocation ?? "not written"}
              </span>
            </div>
            <div className="production-workspace__result-part">
              <span className="production-workspace__result-part-label">Next Bates number</span>
              <span className="production-workspace__result-part-value">{progress.result.nextNumber}</span>
            </div>
          </div>
          {onOpenPackageRoot ? (
            <div className="package-workflow-result-actions">
              <button
                type="button"
                className="production-workspace__secondary-button"
                onClick={() => onOpenPackageRoot(progress.result!.packageRoot)}
              >
                Open folder
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function fromSourceFile(file: ProductionSetSourceFile, pages: number): ProductionSetFile {
  return {
    id: productionSetFileId(file.name),
    name: file.name,
    path: file.path,
    pages,
    designation: "",
  };
}

function fromOpenedFile(file: OpenedFile, pages: number): ProductionSetFile {
  return fromSourceFile({ name: file.name, path: file.path }, pages);
}

function productionSetFileId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function readProductionSetPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
}

function designationSelectValue(value: string): string {
  return DESIGNATION_OPTIONS.includes(value as typeof DESIGNATION_OPTIONS[number])
    ? value
    : "Custom";
}
