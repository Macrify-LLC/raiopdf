import {
  GlobalWorkerOptions,
  OPS,
  PasswordException,
  TextLayer,
  getDocument,
  type PDFDataRangeTransport,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { STREAMED_RANGE_CHUNK_SIZE } from "./pdfRangeTransport";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type { PDFDocumentProxy, PDFPageProxy };
export { OPS, PasswordException, TextLayer };

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

/**
 * Streamed open over a range transport [R1-4]. BOTH `disableAutoFetch` and
 * `disableStream` are required together — per pdf.js docs, autoFetch only
 * behaves with streaming off; with either flag missing, pdf.js pulls the
 * whole file in the background and defeats the point of the transport.
 */
export async function loadStreamedPdfDocument(
  transport: PDFDataRangeTransport,
): Promise<PDFDocumentProxy> {
  return getDocument({
    range: transport,
    rangeChunkSize: STREAMED_RANGE_CHUNK_SIZE,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: `${pdfjsAssetBaseUrl}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfjsAssetBaseUrl}standard_fonts/`,
    wasmUrl: `${pdfjsAssetBaseUrl}wasm/`,
  }).promise;
}

export function getPdfLoadErrorMessage(error: unknown): string {
  if (error instanceof PasswordException) {
    return "This PDF is encrypted. Preview is available after removing encryption with the open password.";
  }

  return "This PDF opened, but the preview could not be rendered.";
}
