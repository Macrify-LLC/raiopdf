import type { AnnotationSavePlan, EditToolId } from "./edits";

export const STREAMED_SIGNATURE_GATE_MESSAGE =
  "Signing very large documents is coming soon — it isn't available for files this size yet.";
export const STREAMED_FORM_AUTHORING_GATE_MESSAGE =
  "Creating fillable fields isn't available for very large documents yet.";
export const STREAMED_ANNOTATION_UPDATE_GATE_MESSAGE =
  "Editing existing annotations on very large documents is not available yet.";

/**
 * Why a save plan can't run on a streamed (very large) document, or null when
 * it can.
 *
 * The streamed lane only appends: it re-runs the whole file through a
 * file-to-file apply, which has no way to rewrite or drop an annotation that
 * is already in the PDF. So placing new markup — including a fresh exhibit
 * stamp — is fine at any size, while moving, renumbering, or deleting an
 * annotation that came back with the file is not.
 */
export function streamedAnnotationPlanGateMessage(
  plan: Pick<AnnotationSavePlan, "updateEdits" | "deleteAnnotIds">,
): string | null {
  return plan.updateEdits.length > 0 || plan.deleteAnnotIds.length > 0
    ? STREAMED_ANNOTATION_UPDATE_GATE_MESSAGE
    : null;
}

export function editToolStreamedGateMessage(
  toolId: EditToolId,
  streamedDocument: boolean,
): string | null {
  if (!streamedDocument) {
    return null;
  }

  if (toolId === "sign") {
    return STREAMED_SIGNATURE_GATE_MESSAGE;
  }

  if (toolId === "formText" || toolId === "formCheckbox") {
    return STREAMED_FORM_AUTHORING_GATE_MESSAGE;
  }

  return null;
}
