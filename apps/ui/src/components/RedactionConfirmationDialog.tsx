import { FloatingDialog } from "./FloatingDialog";
import "./RedactionConfirmationDialog.css";

export interface RedactionConfirmationDialogProps {
  areaCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  onHelp: () => void;
}

export function RedactionConfirmationDialog({
  areaCount,
  onConfirm,
  onCancel,
  onHelp,
}: RedactionConfirmationDialogProps) {
  const noun = areaCount === 1 ? "area" : "areas";

  return (
    <FloatingDialog
      title="Apply Redactions"
      eyebrow="Redact"
      width="sm"
      scrim
      draggable={false}
      onClose={onCancel}
    >
      <div className="redaction-confirmation">
        <p className="redaction-confirmation__summary">
          Permanently remove content under {areaCount} marked {noun}?
        </p>
        <p>
          RaioPDF checks source text, redacted page images, annotations, and metadata. Your open
          file on disk remains untouched until you save a new copy.
        </p>
        <button type="button" className="redaction-confirmation__help" onClick={onHelp}>
          Learn about secure redaction
        </button>
        <div className="redaction-confirmation__actions">
          <button
            type="button"
            className="redaction-confirmation__secondary-button"
            autoFocus
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="redaction-confirmation__danger-button"
            onClick={onConfirm}
          >
            Apply Redactions
          </button>
        </div>
      </div>
    </FloatingDialog>
  );
}
