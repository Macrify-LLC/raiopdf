import { FloatingDialog } from "./FloatingDialog";
import { LoadingSun } from "./LoadingSun";
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
  "starting-engine": "Starting the PDF engine…",
  processing: "Making searchable…",
  verifying: "Verifying…",
};

export function OcrDialog({ phase, pageCount, progress = null, onConfirm, onCancel }: OcrDialogProps) {
  const isRunning = phase !== "confirm";
  const progressValue = progress?.total && progress.total > 0
    ? Math.min(Math.max(progress.completed, 0), progress.total)
    : null;

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
          <div className="ocr-dialog__progress" key={phase}>
            <LoadingSun size={30} label="Making the document searchable" />
            <p className="ocr-dialog__status-line" role="status" aria-live="polite">
              {progress ? describeOcrProgress(progress) : RUNNING_STATUS_LABEL[phase]}
            </p>
            {progressValue !== null && progress?.total ? (
              <progress
                className="ocr-dialog__progress-bar"
                value={progressValue}
                max={progress.total}
                aria-label={describeOcrProgress(progress)}
              />
            ) : null}
          </div>
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
