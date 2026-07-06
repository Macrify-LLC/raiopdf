import type { EditToolId } from "./edits";

export const STREAMED_SIGNATURE_GATE_MESSAGE =
  "Signatures on very large documents are coming. They currently require flattening, which is not yet available for streamed files.";

export function editToolStreamedGateMessage(
  toolId: EditToolId,
  streamedDocument: boolean,
): string | null {
  if (!streamedDocument || toolId !== "sign") {
    return null;
  }

  return STREAMED_SIGNATURE_GATE_MESSAGE;
}
