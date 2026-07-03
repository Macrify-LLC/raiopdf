import { FloatingDialog } from "./FloatingDialog";
import { LoadingSun } from "./LoadingSun";
import "./OcrDialog.css";

export type OcrDialogRunningPhase = "starting-engine" | "processing" | "verifying";
export type OcrDialogPhase = "confirm" | OcrDialogRunningPhase;

export interface OcrDialogProps {
  phase: OcrDialogPhase;
  pageCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

const RUNNING_STATUS_LABEL: Record<OcrDialogRunningPhase, string> = {
  "starting-engine": "Starting the PDF engine…",
  processing: "Making searchable…",
  verifying: "Verifying…",
};

export function OcrDialog({ phase, pageCount, onConfirm, onCancel }: OcrDialogProps) {
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
          <div className="ocr-dialog__progress">
            <LoadingSun size={30} label="Making the document searchable" />
            <p className="ocr-dialog__status-line" role="status" aria-live="polite">
              {RUNNING_STATUS_LABEL[phase]}
            </p>
          </div>
        ) : (
          <>
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
          </>
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
