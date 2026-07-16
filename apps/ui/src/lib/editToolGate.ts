import type { EditToolId } from "./edits";

export const STREAMED_SIGNATURE_GATE_MESSAGE =
  "Signing very large documents is coming soon — it isn't available for files this size yet.";
export const STREAMED_FORM_AUTHORING_GATE_MESSAGE =
  "Creating fillable fields isn't available for very large documents yet.";

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
