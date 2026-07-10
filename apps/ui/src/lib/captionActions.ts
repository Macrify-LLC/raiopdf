import type { PdfCoverPageOptions } from "@raiopdf/engine-api";
import { filePort, type SavedFile } from "./filePort";
import { generateCaptionPdf } from "./captionPreview";

export async function saveCaptionPdf(
  options: PdfCoverPageOptions,
  suggestedName: string,
): Promise<SavedFile | null> {
  const bytes = await generateCaptionPdf(options);
  return filePort.saveFile(bytes, suggestedName, null);
}
