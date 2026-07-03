import { useState } from "react";
import type { JurisdictionPack } from "@raiopdf/rules";
import type { OpenedFile } from "../lib/filePort";
import { PlusIcon } from "../icons";
import "./BatchCleanupWorkspace.css";

export type BatchCleanupStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type BatchCleanupOcrMode = "auto-image-only" | "skip-text" | "force-ocr" | "off";

export interface BatchCleanupFile {
  id: string;
  name: string;
  path: string | null;
  status: BatchCleanupStatus;
  reason: string | null;
  outputs: readonly string[];
}

export interface BatchCleanupRunInput {
  files: readonly BatchCleanupFile[];
  outputDir: string;
  packId: string | null;
  operations: {
    ocrMode: BatchCleanupOcrMode;
    compress: boolean;
    sanitize: boolean;
    scrubMetadata: boolean;
    repair: boolean;
    splitBySize: boolean;
    splitSizeMb: number;
    normalizePages: boolean;
  };
}

export interface BatchCleanupRunResult {
  packageRoot: string;
  reportPdf: string;
  reportJson: string;
  files: readonly {
    sourceFilename: string;
    status: BatchCleanupStatus;
    reason: string | null;
    outputs: readonly string[];
  }[];
}

export interface BatchCleanupProgress {
  running: boolean;
  message: string | null;
  result: BatchCleanupRunResult | null;
}

export interface BatchCleanupWorkspaceProps {
  currentFile: OpenedFile | null;
  packs: readonly JurisdictionPack[];
  progress: BatchCleanupProgress;
  onAddFile: () => Promise<OpenedFile | null>;
  onRun: (input: BatchCleanupRunInput) => Promise<void>;
}

export function BatchCleanupWorkspace({
  currentFile,
  packs,
  progress,
  onAddFile,
  onRun,
}: BatchCleanupWorkspaceProps) {
  const [files, setFiles] = useState<BatchCleanupFile[]>(() =>
    currentFile ? [fromOpenedFile(currentFile)] : [],
  );
  const [packId, setPackId] = useState<string>("");
  const [outputDir, setOutputDir] = useState("");
  const [ocrMode, setOcrMode] = useState<BatchCleanupOcrMode>("auto-image-only");
  const [compress, setCompress] = useState(false);
  const [sanitize, setSanitize] = useState(true);
  const [scrubMetadata, setScrubMetadata] = useState(true);
  const [repair, setRepair] = useState(false);
  const [splitBySize, setSplitBySize] = useState(false);
  const [splitSizeMb, setSplitSizeMb] = useState(25);
  const [normalizePages, setNormalizePages] = useState(false);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const canRun = files.length > 0 && outputDir.trim().length > 0 && !progress.running;

  async function addFile() {
    const opened = await onAddFile();
    if (!opened) {
      return;
    }
    setFiles((current) => [...current, fromOpenedFile(opened)]);
  }

  async function run() {
    setLocalMessage(null);
    if (!canRun) {
      setLocalMessage("Add PDFs and choose an empty package root folder.");
      return;
    }
    if (files.some((file) => !file.path)) {
      setLocalMessage("Batch cleanup needs PDFs opened from local desktop paths.");
      return;
    }

    setFiles((current) => current.map((file) => ({ ...file, status: "pending", reason: null, outputs: [] })));
    await onRun({
      files,
      outputDir: outputDir.trim(),
      packId: packId || null,
      operations: {
        ocrMode,
        compress,
        sanitize,
        scrubMetadata,
        repair,
        splitBySize,
        splitSizeMb,
        normalizePages,
      },
    });
  }

  function applyResult(result: BatchCleanupRunResult | null) {
    if (!result) {
      return files;
    }
    return files.map((file, index) => {
      const fileResult = result.files[index];
      return fileResult
        ? {
            ...file,
            status: fileResult.status,
            reason: fileResult.reason,
            outputs: fileResult.outputs,
          }
        : file;
    });
  }

  const visibleFiles = progress.result ? applyResult(progress.result) : files;

  return (
    <section className="batch-workspace" aria-label="Batch Cleanup">
      <header className="batch-workspace__header">
        <div>
          <p className="batch-workspace__eyebrow">Legal</p>
          <h2>Batch Cleanup</h2>
        </div>
        <button type="button" className="batch-workspace__secondary-button" onClick={addFile}>
          <PlusIcon size={14} /> Add PDF
        </button>
      </header>

      <div className="batch-workspace__file-list">
        {visibleFiles.map((file) => (
          <div className="batch-workspace__file-row" key={file.id}>
            <div>
              <p className="batch-workspace__file-name">{file.name}</p>
              <p className="batch-workspace__file-meta">
                {file.path ? "Local file" : "Path unavailable"}
                {file.reason ? ` · ${file.reason}` : ""}
              </p>
            </div>
            <span className={`batch-workspace__status-chip batch-workspace__status-chip--${file.status}`}>
              {file.status}
            </span>
          </div>
        ))}
      </div>

      <div className="batch-workspace__grid">
        <label>
          <span>Jurisdiction pack</span>
          <select value={packId} onChange={(event) => setPackId(event.target.value)}>
            <option value="">None</option>
            {packs.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.jurisdiction} - {pack.portal}
              </option>
            ))}
          </select>
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

      <div className="batch-workspace__section">
        <label>
          <span>OCR mode</span>
          <select value={ocrMode} onChange={(event) => setOcrMode(event.target.value as BatchCleanupOcrMode)}>
            <option value="auto-image-only">Image-only files</option>
            <option value="skip-text">Skip existing text</option>
            <option value="force-ocr">Force OCR</option>
            <option value="off">Off</option>
          </select>
        </label>
        <div className="batch-workspace__checks">
          <Checkbox label="Compress" checked={compress} onChange={setCompress} />
          <Checkbox label="Sanitize active content" checked={sanitize} onChange={setSanitize} />
          <Checkbox label="Scrub metadata" checked={scrubMetadata} onChange={setScrubMetadata} />
          <Checkbox label="Repair" checked={repair} onChange={setRepair} />
          <Checkbox label="Split by size" checked={splitBySize} onChange={setSplitBySize} />
          <Checkbox label="Normalize pages" checked={normalizePages} onChange={setNormalizePages} />
        </div>
        {splitBySize ? (
          <label className="batch-workspace__number">
            <span>Split cap MB</span>
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={splitSizeMb}
              onChange={(event) => setSplitSizeMb(Number(event.target.value))}
            />
          </label>
        ) : null}
      </div>

      <div className="batch-workspace__actions">
        <button type="button" className="batch-workspace__primary-button" disabled={!canRun} onClick={run}>
          {progress.running ? "Running..." : "Run Batch"}
        </button>
        <button type="button" className="batch-workspace__secondary-button" disabled>
          Cancel
        </button>
      </div>

      {localMessage || progress.message ? (
        <p className="batch-workspace__status">{localMessage ?? progress.message}</p>
      ) : null}
      {progress.result ? (
        <div className="batch-workspace__result">
          <p className="batch-workspace__status">Package: {progress.result.packageRoot}</p>
          <p className="batch-workspace__status">
            Report: {progress.result.reportPdf} · JSON: {progress.result.reportJson}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="batch-workspace__checkbox-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function fromOpenedFile(file: OpenedFile): BatchCleanupFile {
  return {
    id: `${file.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    path: file.path,
    status: "pending",
    reason: null,
    outputs: [],
  };
}
