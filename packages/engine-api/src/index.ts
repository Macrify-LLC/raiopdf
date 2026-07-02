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

export type PdfRedactionArea = {
  /** Zero-based page index containing the rectangle to redact. */
  pageIndex: number;
  /** Left edge of the redaction rectangle in PDF user-space points. */
  x: number;
  /** Bottom edge of the redaction rectangle in PDF user-space points. */
  y: number;
  /** Width of the redaction rectangle in PDF user-space points. */
  w: number;
  /** Height of the redaction rectangle in PDF user-space points. */
  h: number;
};

export type PdfRedactTextOptions = {
  /** Literal terms to remove from the PDF content. Terms are not treated as regular expressions. */
  terms: readonly string[];
  /** When true, engines only match terms on word boundaries. Defaults to false. */
  wholeWord?: boolean;
};

export type PdfTextRegion = PdfRedactionArea & {
  /** Text extracted from this area, if the engine can perform region extraction. */
  text: string;
};

export type PdfBatesStampOptions = {
  /** Text prepended before the zero-padded sequential number, for example "ABC". */
  prefix: string;
  /** First Bates number to stamp on page zero. */
  start: number;
  /** Minimum number of digits in the sequential number. */
  digits: number;
  /** Page edge and horizontal alignment for the Bates number. */
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
   * Creates a new document with true area redaction applied to PDF point rectangles.
   *
   * Areas use zero-based `pageIndex` and PDF user-space point coordinates. `x` and
   * `y` are the rectangle's bottom-left corner; `w` and `h` are dimensions in
   * points. Engines must remove or rasterize underlying content, not merely draw
   * opaque boxes. Engines that cannot guarantee true content removal must reject
   * with `PdfEngineError("UNSUPPORTED", ...)`.
   */
  redactAreas(
    document: PdfDocumentHandle,
    areas: readonly PdfRedactionArea[],
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document with literal terms removed from PDF content.
   *
   * `terms` are plain text search strings. `wholeWord` requests word-boundary
   * matching when the backing engine supports it. Engines that cannot guarantee
   * true text removal must reject with `PdfEngineError("UNSUPPORTED", ...)`.
   */
  redactText(
    document: PdfDocumentHandle,
    options: PdfRedactTextOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document with document metadata scrubbed.
   *
   * Implementations remove the PDF Info dictionary and XMP `/Metadata` streams
   * where the backing PDF library exposes them.
   */
  scrubMetadata(document: PdfDocumentHandle): Promise<PdfDocumentHandle>;

  /**
   * Extracts text from rectangular regions for post-redaction verification.
   *
   * This is a best-effort helper. Engines without reliable region text
   * extraction should reject with `PdfEngineError("UNSUPPORTED", ...)`; callers
   * can then verify output with pdf.js in the application layer.
   */
  extractTextRegions(
    document: PdfDocumentHandle,
    areas: readonly PdfRedactionArea[],
  ): Promise<readonly PdfTextRegion[]>;

  /**
   * Creates a new document stamped with sequential Bates numbers on every page.
   *
   * The number format is `${prefix}${number.toString().padStart(digits, "0")}`.
   * Engines should implement this as page-by-page `stampText` operations so
   * placement and font behavior stays aligned with normal stamping.
   */
  batesStamp(
    document: PdfDocumentHandle,
    options: PdfBatesStampOptions,
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
