declare const pdfDocumentHandleBrand: unique symbol;

export type PdfBytes = ArrayBuffer | Uint8Array;

export type PdfDocumentHandle = string & {
  readonly [pdfDocumentHandleBrand]: "PdfDocumentHandle";
};

export type PdfPageSelection = readonly number[] | "all" | "first";

export type PdfStampPlacement = {
  edge: "header" | "footer";
  align: "left" | "center" | "right";
};

export type PdfStampTextOptions = {
  text: string;
  pageIndexes: PdfPageSelection;
  placement: PdfStampPlacement;
  fontSizePt?: number;
  marginIn?: number;
};

export type PdfBinderExhibit = {
  doc: PdfDocumentHandle;
  label: string;
};

export type PdfBinderOptions = {
  slipSheets: boolean;
  placement?: PdfStampPlacement;
  stampPages?: PdfPageSelection;
  fontSizePt?: number;
  marginIn?: number;
};

export type PdfPageSizePoints = {
  widthPt: number;
  heightPt: number;
};

export type PdfEngineErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "ENCRYPTED_DOCUMENT"
  /** Operation would create a PDF with no pages. */
  | "EMPTY_RESULT"
  | "EMPTY_INPUT"
  | "INVALID_DOCUMENT"
  | "INVALID_PAGE_INDEX"
  | "UNSUPPORTED"
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

  /**
   * Releases engine-owned resources for an opened document handle.
   *
   * Closing an unknown or already-closed handle is a no-op.
   */
  close(document: PdfDocumentHandle): Promise<void>;

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

  /** Creates a new document with crop boxes inset on the selected zero-based pages. */
  cropPages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
    marginIn: number,
  ): Promise<PdfDocumentHandle>;

  /** Creates a new document with selected zero-based pages resized to the provided point size. */
  resizePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
    pageSize: PdfPageSizePoints,
  ): Promise<PdfDocumentHandle>;

  /** Creates a new document by inserting all pages from another document at a zero-based page position. */
  insertPages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    fromOtherDocument: PdfDocumentHandle,
  ): Promise<PdfDocumentHandle>;

  /** Creates a new document by concatenating all pages from the provided documents in order. */
  merge(documents: readonly PdfDocumentHandle[]): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document with text stamped on selected pages.
   *
   * `pageIndexes` accepts zero-based page indexes, `"all"`, or `"first"`.
   * `placement` maps the stamp to a page edge and horizontal alignment.
   * Defaults are `fontSizePt=11` and `marginIn=0.5`.
   */
  stampText(
    document: PdfDocumentHandle,
    options: PdfStampTextOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Builds an exhibit binder from a main document and labeled exhibits.
   *
   * Output page order is the main document, then each exhibit section. An
   * exhibit section contains an optional centered slip sheet, then the exhibit
   * pages stamped with the exhibit label according to `placement` and
   * `stampPages`. Defaults are footer-right labels on all exhibit pages,
   * `fontSizePt=11`, and `marginIn=0.5`. The binder outline contains
   * "Main document" and one entry per exhibit pointing at each section's first
   * page. Engines without caller-defined outline support may reject this with
   * `PdfEngineError("UNSUPPORTED", ...)`; the local engine is the default
   * binder implementation.
   */
  buildBinder(
    main: PdfDocumentHandle,
    exhibits: readonly PdfBinderExhibit[],
    options: PdfBinderOptions,
  ): Promise<PdfDocumentHandle>;

  /** Serializes an opened document handle to PDF bytes. */
  saveToBytes(document: PdfDocumentHandle): Promise<Uint8Array>;
}
