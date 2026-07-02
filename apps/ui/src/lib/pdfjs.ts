import {
  GlobalWorkerOptions,
  PasswordException,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type { PDFDocumentProxy, PDFPageProxy };

export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const copy = new Uint8Array(bytes);
  return getDocument({ data: copy }).promise;
}

export function getPdfLoadErrorMessage(error: unknown): string {
  if (error instanceof PasswordException) {
    return "This PDF is encrypted. Encrypted documents are not supported yet.";
  }

  return "This PDF could not be opened. The file may be corrupt or unsupported.";
}
