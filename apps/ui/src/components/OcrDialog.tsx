import { FloatingDialog } from "./FloatingDialog";
import { LongProcessLoader, type LongProcessProgress } from "./LongProcessLoader";
import "./OcrDialog.css";

export type OcrDialogRunningPhase = "starting-engine" | "processing" | "verifying";
export type OcrDialogPhase = "confirm" | OcrDialogRunningPhase;

export interface OcrDialogProps {
  phase: OcrDialogPhase;
  pageCount: number;
  progress?: OcrDialogProgress | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface OcrDialogProgress {
  phase?: string;
  description?: string | null;
  completed: number;
  total?: number | null;
  unit?: string | null;
}

const RUNNING_STATUS_LABEL: Record<OcrDialogRunningPhase, string> = {
  "starting-engine": "Starting the PDF engine…",
  processing: "Making searchable…",
  verifying: "Verifying…",
};

export function OcrDialog({
  phase,
  pageCount,
  progress = null,
  onConfirm,
  onCancel,
}: OcrDialogProps) {
  const isRunning = phase !== "confirm";

  return (
    <FloatingDialog
      title="Make Searchable"
      eyebrow="Searchability"
      width="sm"
      scrim
      onClose={onCancel}
    >
      <div className="ocr-dialog" data-phase={phase}>
        {isRunning ? (
          <LongProcessLoader
            key={phase}
            message={formatOcrRunningMessage(phase, progress)}
            progress={toLongProcessProgress(progress)}
            hideProgressText={hasDeterminateProgress(progress)}
          />
        ) : (
          <div className="ocr-dialog__form">
            <p className="ocr-dialog__copy">{formatPageCountCopy(pageCount)}</p>
            {/*
              v1 ships all-pages only (DECIDED 2026-07-03). This is the seam
              for a future page-range selector -- it slots in here, between
              the page count line and the action row, without changing the
              rest of the flow.
            */}
            <div className="ocr-dialog__range-slot" aria-hidden="true" />
            <div className="ocr-dialog__actions">
              <button type="button" className="ocr-dialog__secondary-button" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="ocr-dialog__primary-button" onClick={onConfirm}>
                Make searchable
              </button>
            </div>
          </div>
        )}
      </div>
    </FloatingDialog>
  );
}

function formatPageCountCopy(pageCount: number): string {
  if (pageCount <= 0) {
    return "This document will be processed.";
  }

  return `All ${pageCount} ${pageCount === 1 ? "page" : "pages"} will be processed.`;
}

function formatOcrRunningMessage(
  phase: OcrDialogRunningPhase,
  progress: OcrDialogProgress | null,
): string {
  if (!progress) {
    return RUNNING_STATUS_LABEL[phase];
  }

  const count = formatOcrProgressCount(progress);
  if (count) {
    return progress.phase === "postprocess"
      ? `Finishing searchable copy: ${count}`
      : `Making searchable: ${count}`;
  }

  if (progress.phase === "postprocess") {
    return progress.description ? `Finishing searchable copy: ${progress.description}` : "Finishing searchable copy…";
  }

  return progress.description ? `Making searchable: ${progress.description}` : "Making searchable…";
}

function toLongProcessProgress(progress: OcrDialogProgress | null): LongProcessProgress | null {
  if (!hasDeterminateProgress(progress)) {
    return null;
  }

  return {
    current: progress.completed,
    total: progress.total,
    unit: progress.unit || "page",
  };
}

function hasDeterminateProgress(
  progress: OcrDialogProgress | null,
): progress is OcrDialogProgress & { total: number } {
  return Boolean(progress && typeof progress.total === "number" && progress.total > 0);
}

function formatOcrProgressCount(progress: OcrDialogProgress): string | null {
  if (!hasDeterminateProgress(progress)) {
    return null;
  }

  const completed = Math.min(Math.max(Math.floor(progress.completed), 0), Math.ceil(progress.total));
  const total = Math.ceil(progress.total);

  if (progress.unit === "%") {
    return `${completed}%`;
  }

  const unit = progress.unit === "page" ? "page" : progress.unit || "step";
  return `${completed} of ${total} ${unit}${total === 1 || unit.endsWith("s") ? "" : "s"}`;
}
