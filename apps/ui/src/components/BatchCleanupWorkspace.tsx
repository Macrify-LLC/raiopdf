import { useState } from "react";
import type { JurisdictionPack } from "@raiopdf/rules";
import { tooLargeToAddMessage, type FileAddResult } from "../lib/readFileForAdd";
import { formatBatchFailureReason } from "../lib/userMessages";
import { CheckIcon, HelpIcon, PlusIcon } from "../icons";
import { IconButton } from "./IconButton";
import "./BatchCleanupWorkspace.css";

export type BatchCleanupStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type BatchCleanupOcrMode = "auto-image-only" | "skip-text" | "force-ocr" | "off";

export interface BatchCleanupFile {
  id: string;
  name: string;
  path: string | null;
  status: BatchCleanupStatus;
  reason: string | null;
  ocrDecision?: string | null;
  ocrType?: "skip-text" | "force-ocr" | null;
  facts?: { garbledPages?: number | null } | null;
  signatureInvalidated?: boolean | undefined;
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
    operations?: readonly string[] | undefined;
    ocrDecision?: string | null | undefined;
    ocrType?: "skip-text" | "force-ocr" | null | undefined;
    facts?: { garbledPages?: number | null } | null | undefined;
    signatureInvalidated?: boolean | undefined;
    outputs: readonly string[];
  }[];
}

export interface BatchCleanupProgress {
  running: boolean;
  message: string | null;
  result: BatchCleanupRunResult | null;
}

/**
 * Batch cleanup is path-based end-to-end (the shell resolves grants to real
 * paths), so a queue entry needs only a name and a path/grant — never bytes.
 * Streamed (large) documents therefore queue exactly like small ones.
 */
export interface BatchCleanupSourceFile {
  name: string;
  path: string | null;
}

export interface BatchCleanupWorkspaceProps {
  currentFile: BatchCleanupSourceFile | null;
  /**
   * Why the open document was NOT seeded into the queue (e.g. it has
   * unsaved changes, so its on-disk bytes are stale). Shown as the initial
   * status message so the omission is visible, never silent.
   */
  currentFileNotice?: string | null | undefined;
  packs: readonly JurisdictionPack[];
  progress: BatchCleanupProgress;
  /** Add flow rides the `readFileForAdd` choke point [R7-2]: descriptor adds
   * carry the grant, browser `tooLarge` adds render an honest gate here. */
  onAddFile: () => Promise<FileAddResult | null>;
  onRun: (input: BatchCleanupRunInput) => Promise<void>;
  onHelpRequested?: (() => void) | undefined;
}

const OCR_MODE_HELP: Record<BatchCleanupOcrMode, string> = {
  "auto-image-only": "Run OCR only on PDFs that appear to have no searchable text.",
  "skip-text": "Skip OCR when a PDF already has searchable text.",
  "force-ocr": "Run OCR even when searchable text may already exist.",
  off: "Do not run OCR during batch cleanup.",
};

const STATUS_LABELS: Record<BatchCleanupStatus, string> = {
  pending: "Queued",
  running: "Running",
  done: "Done",
  failed: "Needs attention",
  skipped: "Skipped",
};

const STATUS_HELP: Record<BatchCleanupStatus, string> = {
  pending: "Waiting for batch cleanup to start this file.",
  running: "Batch cleanup is working on this file.",
  done: "This file finished and outputs were written.",
  failed: "This file could not be cleaned up. Review the reason and try again.",
  skipped: "This file was skipped by the selected cleanup rules.",
};

export function BatchCleanupWorkspace({
  currentFile,
  currentFileNotice,
  packs,
  progress,
  onAddFile,
  onRun,
  onHelpRequested,
}: BatchCleanupWorkspaceProps) {
  const [files, setFiles] = useState<BatchCleanupFile[]>(() =>
    currentFile ? [fromSourceFile(currentFile)] : [],
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
  const [localMessage, setLocalMessage] = useState<string | null>(currentFileNotice ?? null);
  const canRun = files.length > 0 && outputDir.trim().length > 0 && !progress.running;

  async function addFile() {
    const result = await onAddFile();
    if (!result) {
      return;
    }

    if (result.kind === "tooLarge") {
      // A browser DOM `File` can never yield a shell grant [R3-2] — honest
      // gate instead of a silently-broken queue entry.
      setLocalMessage(tooLargeToAddMessage(result.name));
      return;
    }

    const source: BatchCleanupSourceFile = result.kind === "bytes"
      ? { name: result.file.name, path: result.file.path }
      : { name: result.descriptor.name, path: result.descriptor.grant };
    setLocalMessage(null);
    setFiles((current) => [...current, fromSourceFile(source)]);
  }

  async function run() {
    setLocalMessage(null);
    if (!canRun) {
      setLocalMessage("Add PDFs and choose an empty package root folder.");
      return;
    }
    if (files.some((file) => !file.path)) {
      setLocalMessage("Open these PDFs from the desktop app (not dragged from a browser) so RaioPDF can find them on disk.");
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
            ocrDecision: fileResult.ocrDecision ?? null,
            ocrType: fileResult.ocrType ?? null,
            facts: fileResult.facts ?? null,
            signatureInvalidated: fileResult.signatureInvalidated,
            outputs: fileResult.outputs,
          }
        : file;
    });
  }

  const visibleFiles = progress.result ? applyResult(progress.result) : files;
  const signatureInvalidatedFiles = visibleFiles.filter((file) => file.signatureInvalidated);

  return (
    <section className="batch-workspace" aria-label="Batch Cleanup">
      {/* The dialog chrome already shows "Legal / Batch Cleanup" -- repeating
          that title here stacked a second heading on the first. This section
          carries what the dialog title doesn't: the queue itself. */}
      <section className="batch-workspace__section" aria-label="Cleanup queue">
        <div className="batch-workspace__header">
          <div>
            <p className="batch-workspace__title">Cleanup queue</p>
            <p className="batch-workspace__subtitle">
              {visibleFiles.length} file{visibleFiles.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="batch-workspace__header-actions">
            {onHelpRequested ? (
              <IconButton
                icon={<HelpIcon size={14} />}
                label="Help: Batch Cleanup"
                onClick={onHelpRequested}
              />
            ) : null}
            <button type="button" className="batch-workspace__secondary-button" onClick={addFile}>
              <PlusIcon size={14} /> Add PDF
            </button>
          </div>
        </div>
        <div className="batch-workspace__file-list" role="list">
          {visibleFiles.length === 0 ? (
            <p className="batch-workspace__empty">Add PDFs to build the cleanup queue.</p>
          ) : null}
          {visibleFiles.map((file) => (
            <div className="batch-workspace__file-row" role="listitem" key={file.id}>
              <div>
                <p className="batch-workspace__file-name">{file.name}</p>
                <p className="batch-workspace__file-meta">
                  {fileMetaParts(file).join(" · ")}
                </p>
              </div>
              <span
                className="batch-workspace__status-chip"
                data-status={file.status}
                title={STATUS_HELP[file.status]}
              >
                {STATUS_LABELS[file.status]}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="batch-workspace__section" aria-label="Cleanup destination">
        <p className="batch-workspace__title">Destination</p>
        <div className="batch-workspace__grid">
          <label title="Use a filing rules pack when cleanup needs filing-size split decisions.">
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
          <label title="Choose an empty folder where RaioPDF can write the cleaned PDFs and reports.">
            <span>Package root folder</span>
            <input
              value={outputDir}
              onChange={(event) => setOutputDir(event.target.value)}
              placeholder="Choose an empty folder..."
            />
          </label>
        </div>
      </section>

      <section className="batch-workspace__section" aria-label="Cleanup operations">
        <p className="batch-workspace__title">Operations</p>
        <label title={OCR_MODE_HELP[ocrMode]}>
          <span>OCR mode</span>
          <select value={ocrMode} onChange={(event) => setOcrMode(event.target.value as BatchCleanupOcrMode)}>
            <option value="auto-image-only">Image-only files</option>
            <option value="skip-text">Skip existing text</option>
            <option value="force-ocr">Force OCR</option>
            <option value="off">Off</option>
          </select>
        </label>
        <div className="batch-workspace__checks">
          <Checkbox label="Compress" title="Reduce file size after cleanup." checked={compress} onChange={setCompress} />
          <Checkbox label="Sanitize active content" title="Remove things that can run or open on their own — embedded scripts, auto-open actions, links, and attachments." checked={sanitize} onChange={setSanitize} />
          <Checkbox label="Scrub metadata" title="Remove document metadata fields without changing page content." checked={scrubMetadata} onChange={setScrubMetadata} />
          <Checkbox label="Repair" title="Try to rebuild PDFs that fail to open cleanly before other steps run." checked={repair} onChange={setRepair} />
          <Checkbox label="Split by size" title="Split outputs into filing-size parts when they exceed the selected cap." checked={splitBySize} onChange={setSplitBySize} />
          <Checkbox label="Standardize page size & orientation" title="Make every page a consistent size and upright before saving." checked={normalizePages} onChange={setNormalizePages} />
        </div>
        {splitBySize ? (
          <label className="batch-workspace__number" title="Maximum size for each split output part.">
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
      </section>

      <div className="batch-workspace__actions">
        <button type="button" className="batch-workspace__primary-button" disabled={!canRun} onClick={run}>
          {progress.running ? "Running..." : "Run Batch"}
        </button>
        {progress.running ? (
          <p className="batch-workspace__status">
            Cancel isn't available yet — let the run finish.
          </p>
        ) : null}
      </div>

      {localMessage || progress.message ? (
        <p className="batch-workspace__status" role="status">{localMessage ?? progress.message}</p>
      ) : null}
      {progress.result ? (
        <section className="batch-workspace__result" aria-label="Batch cleanup result">
          <div className="batch-workspace__result-header">
            <CheckIcon size={15} />
            <div>
              <p className="batch-workspace__result-title">Batch cleanup complete</p>
              <p className="batch-workspace__result-subtitle">
                {formatCount(progress.result.files.length, "file")} processed.
              </p>
            </div>
          </div>
          <div className="batch-workspace__result-parts">
            <div className="batch-workspace__result-part">
              <span className="batch-workspace__result-part-label">Package</span>
              <span className="batch-workspace__result-part-value">{progress.result.packageRoot}</span>
            </div>
            <div className="batch-workspace__result-part">
              <span className="batch-workspace__result-part-label">Report</span>
              <span className="batch-workspace__result-part-value">{progress.result.reportPdf}</span>
            </div>
            <div className="batch-workspace__result-part">
              <span className="batch-workspace__result-part-label">Report data</span>
              <span className="batch-workspace__result-part-value">{progress.result.reportJson}</span>
            </div>
          </div>
          {signatureInvalidatedFiles.length > 0 ? (
            <p className="batch-workspace__signature-summary" role="status">
              {signatureInvalidatedFiles.length} unlocked file{signatureInvalidatedFiles.length === 1 ? "" : "s"} had digital signatures invalidated:{" "}
              {signatureInvalidatedFiles.map((file) => file.name).join(", ")}
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function fileMetaParts(file: BatchCleanupFile): string[] {
  const parts = [file.path ? "Local file" : "Path unavailable"];
  const garbledPages = file.facts?.garbledPages ?? 0;
  const reason = file.reason;

  if (typeof reason === "string" && reason.length > 0) {
    const formattedReason = formatBatchFailureReason(reason);
    if (formattedReason) {
      parts.push(formattedReason);
    }
  }
  if (garbledPages > 0) {
    parts.push(`${formatCount(garbledPages, "garbled page")} detected`);
  }
  const garbledForceOcrDecision = garbledForceOcrDecisionFor(file);
  if (garbledForceOcrDecision) {
    parts.push(`Force OCR: ${garbledForceOcrDecision}`);
  }
  if (file.signatureInvalidated) {
    parts.push("Digital signature invalidated");
  }

  return parts;
}

function garbledForceOcrDecisionFor(file: BatchCleanupFile): string | null {
  if (
    file.ocrDecision?.startsWith("Garbled text layer detected") &&
    (file.ocrType === undefined || file.ocrType === null || file.ocrType === "force-ocr")
  ) {
    return file.ocrDecision;
  }

  return null;
}

function Checkbox({
  label,
  title,
  checked,
  onChange,
}: {
  label: string;
  title: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="batch-workspace__checkbox-row" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function fromSourceFile(file: BatchCleanupSourceFile): BatchCleanupFile {
  return {
    id: `${file.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    path: file.path,
    status: "pending",
    reason: null,
    ocrDecision: null,
    ocrType: null,
    facts: null,
    outputs: [],
  };
}
