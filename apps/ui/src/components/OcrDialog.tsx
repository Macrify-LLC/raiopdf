import { FloatingDialog } from "./FloatingDialog";
import { LongProcessLoader, type LongProcessProgress } from "./LongProcessLoader";
import { describeOcrProgress, type OcrProgressEvent } from "../lib/ocrProgress";
import "./OcrDialog.css";

export type OcrDialogRunningPhase = "starting-engine" | "processing" | "verifying";
export type OcrDialogPhase = "confirm" | OcrDialogRunningPhase;

export interface OcrDialogProps {
  phase: OcrDialogPhase;
  pageCount: number;
  progress?: OcrProgressEvent | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const RUNNING_STATUS_LABEL: Record<OcrDialogRunningPhase, string> = {
  "starting-engine": "Getting things ready…",
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
  progress: OcrProgressEvent | null,
): string {
  return progress ? describeOcrProgress(progress) : RUNNING_STATUS_LABEL[phase];
}

function toLongProcessProgress(progress: OcrProgressEvent | null): LongProcessProgress | null {
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
  progress: OcrProgressEvent | null,
): progress is OcrProgressEvent & { total: number } {
  return Boolean(progress && typeof progress.total === "number" && progress.total > 0);
}
