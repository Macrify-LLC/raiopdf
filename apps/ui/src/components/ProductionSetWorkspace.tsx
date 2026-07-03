import { useEffect, useMemo, useState } from "react";
import type { OpenedFile } from "../lib/filePort";
import {
  productionHintMessage,
  readProductionLastUsed,
} from "../lib/productionHints";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "../icons";
import "./ProductionSetWorkspace.css";

export interface ProductionSetFile {
  id: string;
  name: string;
  path: string | null;
  bytes: Uint8Array;
  pages: number;
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

export interface ProductionSetWorkspaceProps {
  currentFile: OpenedFile | null;
  currentPageCount: number;
  progress: ProductionSetProgress;
  onAddFile: () => Promise<OpenedFile | null>;
  onRun: (input: ProductionSetRunInput) => Promise<void>;
}

const DESIGNATION_OPTIONS = [
  "",
  "Confidential",
  "Confidential - Attorneys' Eyes Only",
  "Custom",
] as const;

export function ProductionSetWorkspace({
  currentFile,
  currentPageCount,
  progress,
  onAddFile,
  onRun,
}: ProductionSetWorkspaceProps) {
  const [files, setFiles] = useState<ProductionSetFile[]>(() =>
    currentFile ? [fromOpenedFile(currentFile, currentPageCount)] : [],
  );
  const [prefix, setPrefix] = useState("SMITH");
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(6);
  const [outputDir, setOutputDir] = useState("");
  const [includeIndex, setIncludeIndex] = useState(true);
  const [includeFilenameInIndex, setIncludeFilenameInIndex] = useState(true);
  const [combinedPdf, setCombinedPdf] = useState(false);
  const [useVolumeCap, setUseVolumeCap] = useState(false);
  const [volumeSizeMb, setVolumeSizeMb] = useState(25);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const hint = useMemo(() => productionHintMessage(prefix), [prefix]);
  const totalPages = files.reduce((sum, file) => sum + file.pages, 0);
  const lastNumber = start + Math.max(0, totalPages - 1);
  const overflows = Number.isFinite(lastNumber) && lastNumber >= 10 ** digits;
  const canRun = files.length > 0 && outputDir.trim().length > 0 && !overflows && !progress.running;

  useEffect(() => {
    const lastUsed = readProductionLastUsed(prefix);
    if (lastUsed !== null) {
      setStart(lastUsed + 1);
    }
  }, [prefix]);

  async function addFile() {
    const opened = await onAddFile();
    if (!opened) {
      return;
    }
    setFiles((current) => [...current, fromOpenedFile(opened, 0)]);
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
      prefix: prefix.trim(),
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
      <header className="production-workspace__header">
        <div>
          <p className="production-workspace__eyebrow">Legal</p>
          <h2>Production Set Builder</h2>
        </div>
        <button
          type="button"
          className="production-workspace__secondary-button"
          onClick={addFile}
        >
          <PlusIcon size={14} /> Add PDF
        </button>
      </header>

      <div className="production-workspace__section">
        <h3>Production Order</h3>
        <div className="production-workspace__file-list">
          {files.map((file, index) => (
            <div className="production-workspace__file-row" key={file.id}>
              <div>
                <p className="production-workspace__file-name">{file.name}</p>
                <p className="production-workspace__file-meta">
                  {file.pages > 0 ? `${file.pages} page${file.pages === 1 ? "" : "s"}` : "Page count pending"}
                </p>
              </div>
              <label>
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
      </div>

      <div className="production-workspace__grid">
        <label>
          <span>Prefix</span>
          <input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
        </label>
        <label>
          <span>Start</span>
          <input
            type="number"
            min="0"
            value={start}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Digits</span>
          <input
            type="number"
            min="1"
            max="12"
            value={digits}
            onChange={(event) => setDigits(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Package root folder</span>
          <input
            value={outputDir}
            onChange={(event) => setOutputDir(event.target.value)}
            placeholder="/absolute/path/to/empty-folder"
          />
        </label>
      </div>

      {hint ? <p className="production-workspace__status">{hint}</p> : null}
      {overflows ? (
        <p className="production-workspace__status">The last Bates number would exceed the configured digit width.</p>
      ) : null}

      <div className="production-workspace__section">
        <label className="production-workspace__checkbox-row">
          <input
            type="checkbox"
            checked={includeIndex}
            onChange={(event) => setIncludeIndex(event.target.checked)}
          />
          <span>Production index PDF and CSV</span>
        </label>
        <label className="production-workspace__checkbox-row">
          <input
            type="checkbox"
            checked={includeFilenameInIndex}
            onChange={(event) => setIncludeFilenameInIndex(event.target.checked)}
          />
          <span>Filename column in index</span>
        </label>
        <label className="production-workspace__checkbox-row">
          <input
            type="checkbox"
            checked={combinedPdf}
            onChange={(event) => setCombinedPdf(event.target.checked)}
          />
          <span>Combined production PDF</span>
        </label>
        <label className="production-workspace__checkbox-row">
          <input
            type="checkbox"
            checked={useVolumeCap}
            onChange={(event) => setUseVolumeCap(event.target.checked)}
          />
          <span>Volume folders</span>
        </label>
        {useVolumeCap ? (
          <label>
            <span>Volume cap MB</span>
            <input
              type="number"
              min="1"
              value={volumeSizeMb}
              onChange={(event) => setVolumeSizeMb(Number(event.target.value))}
            />
          </label>
        ) : null}
      </div>

      <div className="production-workspace__button-row">
        <button
          type="button"
          className="production-workspace__primary-button"
          disabled={!canRun}
          onClick={() => void run()}
        >
          Build Production
        </button>
        <p className="production-workspace__status">
          {localMessage ?? progress.message ?? `${totalPages} page${totalPages === 1 ? "" : "s"} selected`}
        </p>
      </div>

      {progress.result ? (
        <div className="production-workspace__result">
          <p className="production-workspace__status">
            Package: {progress.result.packageRoot}
          </p>
          <p className="production-workspace__status">
            Index: {progress.result.indexLocation ?? "not written"} · Next number {progress.result.nextNumber}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function fromOpenedFile(file: OpenedFile, pages: number): ProductionSetFile {
  return {
    id: `${file.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    path: file.path,
    bytes: file.bytes,
    pages,
    designation: "",
  };
}

function designationSelectValue(value: string): string {
  return DESIGNATION_OPTIONS.includes(value as typeof DESIGNATION_OPTIONS[number])
    ? value
    : "Custom";
}
