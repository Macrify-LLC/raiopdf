declare const pdfDocumentHandleBrand: unique symbol;

export type PdfBytes = ArrayBuffer | Uint8Array;

export type PdfDocumentHandle = string & {
  readonly [pdfDocumentHandleBrand]: "PdfDocumentHandle";
};

export type PdfEngineErrorCode =
  | "DOCUMENT_NOT_FOUND"
  /** Operation would create a PDF with no pages. */
  | "EMPTY_RESULT"
  | "EMPTY_INPUT"
  | "INVALID_DOCUMENT"
  | "INVALID_PAGE_INDEX"
  | "UNSUPPORTED_ROTATION";

export class PdfEngineError extends Error {
  readonly code: PdfEngineErrorCode;

  constructor(
    code: PdfEngineErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfEngineError";
    this.code = code;
  }
}

export interface PdfEngine {
  /** Opens a PDF byte buffer and returns an opaque handle for later engine calls. */
  open(bytes: PdfBytes): Promise<PdfDocumentHandle>;

  /** Returns the number of pages in an opened document. */
  pageCount(document: PdfDocumentHandle): Promise<number>;

  /** Creates a new document with pages ordered by the provided zero-based page indexes. */
  reorderPages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfDocumentHandle>;

  /** Creates a new document with the selected zero-based pages rotated by the given degrees. */
  rotatePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
    degrees: number,
  ): Promise<PdfDocumentHandle>;

  /** Creates a new document with the selected zero-based pages removed. */
  deletePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfDocumentHandle>;

  /** Creates a new document by inserting all pages from another document at a zero-based page position. */
  insertPages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    fromOtherDocument: PdfDocumentHandle,
  ): Promise<PdfDocumentHandle>;

  /** Creates a new document by concatenating all pages from the provided documents in order. */
  merge(documents: readonly PdfDocumentHandle[]): Promise<PdfDocumentHandle>;

  /** Serializes an opened document handle to PDF bytes. */
  saveToBytes(document: PdfDocumentHandle): Promise<Uint8Array>;
}
