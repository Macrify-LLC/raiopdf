import type { EditToolId } from "./edits";

export const STREAMED_SIGNATURE_GATE_MESSAGE =
  "Signing very large documents is coming soon — it isn't available for files this size yet.";

export function editToolStreamedGateMessage(
  toolId: EditToolId,
  streamedDocument: boolean,
): string | null {
  if (!streamedDocument || toolId !== "sign") {
    return null;
  }

  return STREAMED_SIGNATURE_GATE_MESSAGE;
}
