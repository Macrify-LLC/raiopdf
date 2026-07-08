import { FloatingDialog } from "./FloatingDialog";

export interface ForceOcrConfirmationDialogProps {
  reason: "garbled" | "manual";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ForceOcrConfirmationDialog({
  reason,
  onConfirm,
  onCancel,
}: ForceOcrConfirmationDialogProps) {
  return (
    <FloatingDialog
      title={reason === "garbled" ? "Fix Garbled Text" : "Redo Searchable Text"}
      eyebrow="Searchability"
      width="sm"
      scrim
      draggable={false}
      onClose={onCancel}
    >
      <div className="force-ocr-confirmation">
        <p>
          RaioPDF will rebuild the hidden searchable text for the whole document. The visible pages should not change.
        </p>
        <p>
          Because the whole file is re-rendered, this is slower than ordinary OCR and the PDF may be larger.
        </p>
        <div className="force-ocr-confirmation__actions">
          <button type="button" className="force-ocr-confirmation__secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="force-ocr-confirmation__primary-button" onClick={onConfirm}>
            Redo Searchable Text
          </button>
        </div>
      </div>
    </FloatingDialog>
  );
}
