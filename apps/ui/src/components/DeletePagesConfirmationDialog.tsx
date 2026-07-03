import { FloatingDialog } from "./FloatingDialog";
import "./DeletePagesConfirmationDialog.css";

export interface DeletePagesConfirmationDialogProps {
  pageCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeletePagesConfirmationDialog({
  pageCount,
  onConfirm,
  onCancel,
}: DeletePagesConfirmationDialogProps) {
  const noun = pageCount === 1 ? "page" : "pages";

  return (
    <FloatingDialog
      title={pageCount === 1 ? "Delete Page" : "Delete Pages"}
      eyebrow="Organize"
      width="sm"
      scrim
      draggable={false}
      onClose={onCancel}
    >
      <div className="delete-pages-confirmation">
        <p>
          Delete {pageCount} {noun}? This can&rsquo;t be undone after save.
        </p>
        <div className="delete-pages-confirmation__actions">
          {/* No autoFocus on the destructive action -- FloatingDialog already
              focuses the dialog shell itself, so a stray Enter press doesn't
              confirm a delete. Cancel gets the safer first-tab-stop instead. */}
          <button
            type="button"
            className="delete-pages-confirmation__secondary-button"
            autoFocus
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="delete-pages-confirmation__danger-button"
            onClick={onConfirm}
          >
            Delete {pageCount === 1 ? "Page" : `${pageCount} Pages`}
          </button>
        </div>
      </div>
    </FloatingDialog>
  );
}
