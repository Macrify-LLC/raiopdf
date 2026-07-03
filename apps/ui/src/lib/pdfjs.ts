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

const pdfjsAssetBaseUrl = `${import.meta.env.BASE_URL}pdfjs/`;

export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const copy = new Uint8Array(bytes);
  return getDocument({
    data: copy,
    cMapUrl: `${pdfjsAssetBaseUrl}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfjsAssetBaseUrl}standard_fonts/`,
    wasmUrl: `${pdfjsAssetBaseUrl}wasm/`,
  }).promise;
}

export function getPdfLoadErrorMessage(error: unknown): string {
  if (error instanceof PasswordException) {
    return "This PDF is encrypted. Encrypted documents are not supported yet.";
  }

  return "This PDF opened, but the preview could not be rendered.";
}
