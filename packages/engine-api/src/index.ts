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
  /**
   * When true, the engine may rasterize pages to guarantee removed text is not
   * recoverable from PDF content streams. Rasterized output loses searchable and
   * selectable text on affected pages. Engines must reject text redaction when
   * this tradeoff is required for safety and the caller leaves it false or
   * omitted.
   */
  rasterize?: boolean;
};

export type PdfReplaceTextOperation = {
  /** Literal text to find. Must be non-empty. Not a regular expression. */
  find: string;
  /** Literal replacement. Empty string deletes the matched text. */
  replace: string;
};

export type PdfReplaceTextOptions = {
  /** Ordered ops; each replaces every occurrence on the selected pages. */
  operations: readonly PdfReplaceTextOperation[];
  /** Match only on ASCII word boundaries (engine semantics). Defaults to false. */
  wholeWord?: boolean;
  /** Zero-based pages to search, or "all" (default). */
  pageIndexes?: PdfPageSelection;
  /** Required opt-in when the document has signed signature fields. */
  allowSignatureInvalidation?: boolean;
  /** Required opt-in when the document declares PDF/A conformance. */
  allowPdfAIdentificationRemoval?: boolean;
};

export type PdfReplaceTextWarning = {
  code:
    | "COUNTS_UNAVAILABLE"
    | "SIGNATURES_INVALIDATED"
    | "FALLBACK_FONT_POSSIBLE"
    | "PDFA_IDENTIFICATION_REMOVED"
    /** Reserved for engines that do not carry RaioPDF's image-passthrough patch. */
    | "IMAGES_REENCODED"
    | "ATTACHMENTS_REMOVED"
    | "TAGS_REMOVED"
    | "SELECTED_TEXT_LAYOUT_RISK";
  message: string;
};

export type PdfReplaceTextResult = {
  document: PdfDocumentHandle;
  /** Index-aligned per-op counts when the engine reports them; null otherwise. */
  replacedCounts: readonly number[] | null;
  warnings: readonly PdfReplaceTextWarning[];
};

export type PdfTextMapElement = {
  /** Zero-based index in the engine's page text element array. */
  elementIndex: number;
  /** Start offset in the engine-joined page text. */
  start: number;
  /** End offset in the engine-joined page text. */
  end: number;
  /** Text exactly as the engine will rewrite it; no inferred separators are added. */
  text: string;
  /** Best-effort page-space area for selection matching. */
  area: PdfRedactionArea;
};

export type PdfTextMapPage = {
  pageIndex: number;
  /** Engine-joined page text. Adjacent elements are concatenated without inferred spaces. */
  text: string;
  /** Fingerprint over element text and geometry; apply rejects if it changes. */
  sourceFingerprint: string;
  elements: readonly PdfTextMapElement[];
};

export type PdfInspectTextMapOptions = {
  /** Zero-based pages to inspect, or "all" (default). */
  pageIndexes?: PdfPageSelection;
};

export type PdfInspectTextMapResult = {
  /** Fingerprint over the full engine text-editor document. */
  sourceFingerprint: string;
  pages: readonly PdfTextMapPage[];
};

export type PdfSelectedTextTarget = {
  pageIndex: number;
  start: number;
  end: number;
  expectedText: string;
  /** Fingerprint over the full engine text-editor document. */
  sourceDocumentFingerprint: string;
  /** Fingerprint over the selected page's engine text elements. */
  sourceFingerprint: string;
  firstElementIndex: number;
  lastElementIndex: number;
  firstElementOffset: number;
  lastElementOffset: number;
};

export type PdfReplaceSelectedTextOptions = {
  target: PdfSelectedTextTarget;
  /** Replacement text. Empty string deletes the selected span. */
  replacement: string;
  /** Required opt-in when the document has signed signature fields. */
  allowSignatureInvalidation?: boolean;
  /** Required opt-in when the document declares PDF/A conformance. */
  allowPdfAIdentificationRemoval?: boolean;
};

export type PdfReplaceSelectedTextResult = {
  document: PdfDocumentHandle;
  warnings: readonly PdfReplaceTextWarning[];
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

export type PdfCompressOptions = {
  /** Stirling optimize level, 1–9. Higher values may reduce visual quality. */
  quality: number;
  /** Converts color content to grayscale when the backing engine supports it. */
  grayscale?: boolean;
};

export type PdfSanitizeOptions = {
  /** Remove document-level JavaScript actions. Defaults to true. */
  removeJavaScript?: boolean;
  /** Remove embedded file attachments. Defaults to true. */
  removeEmbeddedFiles?: boolean;
  /** Remove external link annotations and URI actions. Defaults to true. */
  removeLinks?: boolean;
};

export type PdfSanitizeRemovedItem = "javascript" | "embedded-files" | "external-links";

export type PdfSanitizeResult = {
  document: PdfDocumentHandle;
  removed: readonly PdfSanitizeRemovedItem[];
};

export type PdfPageNumberFormat = "number" | "page-of-total";

export type PdfPageNumbersOptions = {
  /** Number stamped on the first selected page. */
  startAt: number;
  /** Selected zero-based pages receiving numbers, or all pages. */
  pageIndexes: PdfPageSelection;
  /** `number` renders `1`; `page-of-total` renders `Page 1 of 10`. */
  format: PdfPageNumberFormat;
  placement: PdfStampPlacement;
  fontSizePt?: number;
  marginIn?: number;
};

export type PdfWatermarkOrientation = "diagonal" | "horizontal";

export type PdfWatermarkOptions = {
  text: string;
  pageIndexes: PdfPageSelection;
  orientation: PdfWatermarkOrientation;
  /** Opacity in the 0–1 range. Defaults to 0.18. */
  opacity?: number;
  fontSizePt?: number;
};

export type PdfImagePageFormat = "png" | "jpeg";

export type PdfImagePageInput = {
  bytes: PdfBytes;
  format: PdfImagePageFormat;
};

export type PdfCoverStyle = "minimal" | "labeled" | "bordered";

export const PDF_COVER_STYLES: readonly {
  id: PdfCoverStyle;
  label: string;
  description: string;
}[] = [
  {
    id: "minimal",
    label: "Minimal",
    description: "Centered exhibit label only",
  },
  {
    id: "labeled",
    label: "Labeled",
    description: "Exhibit label with a short description",
  },
  {
    id: "bordered",
    label: "Bordered",
    description: "Exhibit label and description inside a rule",
  },
];

export type PdfBinderExhibit = {
  doc: PdfDocumentHandle;
  label: string;
  description?: string | undefined;
  sourceFileName?: string | undefined;
};

export type PdfBinderIndexOptions = {
  /** Defaults to true. */
  enabled?: boolean | undefined;
  /** Defaults to false because filenames can reveal work-product organization. */
  includeSourceFileName?: boolean | undefined;
};

export type PdfBinderOptions = {
  slipSheets: boolean;
  coverStyle?: PdfCoverStyle | undefined;
  index?: PdfBinderIndexOptions | undefined;
  placement?: PdfStampPlacement | undefined;
  stampPages?: PdfPageSelection | undefined;
  fontSizePt?: number | undefined;
  marginIn?: number | undefined;
};

export type PdfOutlineTarget =
  | {
      kind: "page";
      /** Zero-based destination page index. */
      pageIndex: number;
      /**
       * Present for bookmarks read from an existing PDF. Writers use it to
       * preserve the original destination view mode while remapping the page.
       */
      preserveId?: string | undefined;
    }
  | {
      kind: "named";
      /** The named destination label as stored by the source PDF. */
      name: string;
      /** Resolved zero-based page index when the name points inside this PDF. */
      resolvedPageIndex?: number | undefined;
      preserveId: string;
    }
  | {
      kind: "uri";
      uri: string;
      preserveId: string;
    }
  | {
      kind: "remote";
      preserveId: string;
    }
  | {
      kind: "unsupported";
      reason: string;
      preserveId: string;
    };

export type PdfOutlineItemStyle = {
  bold?: boolean | undefined;
  italic?: boolean | undefined;
};

export type PdfOutlineItem = {
  /**
   * Stable only for the currently opened document snapshot. Newly created
   * items may use caller-generated ids; source ids are used to preserve
   * view-only targets when the outline tree is rewritten.
   */
  id: string;
  title: string;
  target: PdfOutlineTarget;
  expanded?: boolean | undefined;
  style?: PdfOutlineItemStyle | undefined;
  children?: readonly PdfOutlineItem[] | undefined;
};

export type PdfOutlineOpenMode = "default" | "outlines";

export type PdfOutlineState = {
  items: readonly PdfOutlineItem[];
  openMode: PdfOutlineOpenMode;
  revision: string;
};

export type PdfOutlineWriteResult = {
  document: PdfDocumentHandle;
  removedTargets: number;
};

export type PdfInsertPagesOptions = {
  sourceLabel?: string | undefined;
};

export type PdfMergeOptions = {
  labels?: readonly string[] | undefined;
};

export type PdfPageSizePoints = {
  widthPt: number;
  heightPt: number;
};

export type PdfPageSizeInches = {
  w: number;
  h: number;
  in: true;
};

export type PdfPageOrientation = "portrait" | "landscape";

export type PdfNormalizePagesOptions = {
  targetSize: PdfPageSizeInches;
  orientation: "portrait";
};

export type PdfSplitPart = {
  document: PdfDocumentHandle;
  /** Zero-based source page indexes included in this part. */
  pageIndexes: readonly number[];
  byteLength: number;
  /** True when a single source page cannot fit within the requested byte cap. */
  oversized: boolean;
};

export type PdfSplitByMaxBytesResult = {
  parts: readonly PdfSplitPart[];
};

export type PdfAFlavor = "pdfa-1" | "pdfa-2b" | "pdfa-3b";

export type PdfAConversionOptions = {
  flavor: PdfAFlavor;
  strict?: boolean;
};

/** A single point in PDF user-space points (origin bottom-left of the page box). */
export type PdfEditPoint = {
  /** Horizontal offset from the page's left edge in PDF points. */
  x: number;
  /** Vertical offset from the page's bottom edge in PDF points. */
  y: number;
};

/**
 * An axis-aligned rectangle in PDF user-space points.
 *
 * `x`/`y` are the rectangle's bottom-left corner, matching `PdfRedactionArea`.
 * Callers convert canvas/viewport coordinates (including any page `/Rotate`)
 * into user-space points before building edits — the same coordinate contract
 * used by `redactAreas`.
 */
export type PdfEditRect = {
  /** Left edge in PDF user-space points. */
  x: number;
  /** Bottom edge in PDF user-space points. */
  y: number;
  /** Width in PDF points. Must be positive. */
  w: number;
  /** Height in PDF points. Must be positive. */
  h: number;
};

/** An RGB color with each component in the 0–1 range. */
export type PdfEditColor = {
  r: number;
  g: number;
  b: number;
};

export type PdfTextBoxFontFamily = "helvetica" | "times" | "courier";

export type PdfTextBoxAlign = "left" | "center" | "right";

export type PdfTextMeasureFont = {
  widthOfTextAtSize: (text: string, size: number) => number;
};

export type PdfTextBoxWrapOptions = {
  text: string;
  boxWidthPt: number;
  fontSizePt: number;
  font: PdfTextMeasureFont;
};

/**
 * Computes the exact lines a text-box edit should draw for a given font and
 * width. Explicit newlines are hard breaks; long words are split greedily.
 */
export function wrapTextBoxLines(options: PdfTextBoxWrapOptions): string[] {
  const hardLines = options.text.replace(/\r\n/g, "\n").split("\n");
  const lines = hardLines.flatMap((line) => wrapHardLine(line, options));

  return lines.length > 0 ? lines : [""];
}

function wrapHardLine(
  text: string,
  options: Pick<PdfTextBoxWrapOptions, "boxWidthPt" | "fontSizePt" | "font">,
): string[] {
  if (text.length === 0) {
    return [""];
  }

  const maxWidth = Math.max(0, options.boxWidthPt);

  if (fitsText(text, maxWidth, options)) {
    return [text];
  }

  const tokens = text.match(/\s+|\S+/g) ?? [];

  if (tokens.length === 0) {
    return [text];
  }

  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = `${current}${token}`;

    if (fitsText(candidate, maxWidth, options)) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
    }

    if (/^\s+$/.test(token) || fitsText(token, maxWidth, options)) {
      current = token;
      continue;
    }

    const pieces = breakLongWord(token, maxWidth, options);
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? "";
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function breakLongWord(
  word: string,
  maxWidth: number,
  options: Pick<PdfTextBoxWrapOptions, "fontSizePt" | "font">,
): string[] {
  const pieces: string[] = [];
  let current = "";

  for (const char of word) {
    const candidate = `${current}${char}`;

    if (current && fitsText(candidate, maxWidth, options)) {
      current = candidate;
      continue;
    }

    if (!current) {
      current = char;
      continue;
    }

    pieces.push(current);
    current = char;
  }

  if (current) {
    pieces.push(current);
  }

  return pieces.length > 0 ? pieces : [word];
}

function fitsText(
  text: string,
  maxWidth: number,
  options: Pick<PdfTextBoxWrapOptions, "fontSizePt" | "font">,
): boolean {
  return options.font.widthOfTextAtSize(text, options.fontSizePt) <= maxWidth;
}

/** Raster image formats accepted by image-bearing edits. */
export type PdfEditImageFormat = "png" | "jpeg";

/**
 * Translucent text highlight covering one rectangle per highlighted line.
 *
 * Highlights are emitted as live annotations by default. Callers can request
 * baked page content with `markupMode: "baked"` or flatten markup annotations
 * later.
 */
export type PdfHighlightEdit = {
  type: "highlight";
  /** Stable RaioPDF annotation id when updating/importing a live annotation. */
  annotId?: string;
  /** Zero-based page index receiving the highlight. */
  pageIndex: number;
  /** One rectangle per highlighted text line, in PDF user-space points. */
  rects: readonly PdfEditRect[];
  /** Highlight fill color. Defaults to marker yellow. */
  color?: PdfEditColor;
  /** Fill opacity in the 0–1 range. Defaults to 0.4. */
  opacity?: number;
};

/**
 * Text markup drawn from text-line rectangles.
 *
 * Underline and strikethrough are emitted as live annotations by default.
 * Callers can request baked page content with `markupMode: "baked"` or flatten
 * markup annotations later.
 */
export type PdfTextMarkupEdit = {
  type: "underline" | "strikethrough";
  /** Stable RaioPDF annotation id when updating/importing a live annotation. */
  annotId?: string;
  /** Zero-based page index receiving the markup. */
  pageIndex: number;
  /** One rectangle per marked text line, in PDF user-space points. */
  rects: readonly PdfEditRect[];
  /** Markup line color. Defaults to near-black ink. */
  color?: PdfEditColor;
  /** Markup line thickness in points. Defaults to 1. */
  thicknessPt?: number;
};

/**
 * A block of caller-authored text drawn inside a rectangle.
 *
 * Text starts at the visual top-left of `rect` and supports `\n` line breaks.
 * On pages with `/Rotate` 90/180/270 the text is drawn so it reads upright to
 * the viewer; `rect` remains the user-space bounding box of the visual box.
 */
export type PdfTextBoxEdit = {
  type: "textBox";
  /** Stable RaioPDF annotation id when updating/importing a live annotation. */
  annotId?: string;
  /** Zero-based page index receiving the text box. */
  pageIndex: number;
  /** User-space bounding box of the text box. */
  rect: PdfEditRect;
  /** Text content. `\n` produces additional lines. Must not be empty. */
  text: string;
  /** Font size in points. Defaults to 12. */
  fontSizePt?: number;
  /** Ink color. Defaults to near-black (#111111). */
  color?: PdfEditColor;
  /** Optional background fill color behind the text. Omitted/null means transparent. */
  backgroundColor?: PdfEditColor | null;
  /** Background fill opacity in the 0-1 range. Defaults to 1 when a fill is set. */
  backgroundOpacity?: number;
  /** Standard PDF font family. Defaults to Helvetica. */
  fontFamily?: PdfTextBoxFontFamily;
  /** Use the bold face of the selected standard font family. Defaults to false. */
  bold?: boolean;
  /** Use the italic/oblique face of the selected standard font family. Defaults to false. */
  italic?: boolean;
  /** Horizontal alignment for each rendered line. Defaults to left. */
  align?: PdfTextBoxAlign;
};

/**
 * A text callout emitted as one atomic markup edit.
 *
 * The text box renders through the same wrapping, font, color, and alignment
 * rules as `PdfTextBoxEdit`. The leader line is drawn in user-space points from
 * the nearest text-box boundary point to `tip`, optionally with an arrowhead at
 * the tip.
 */
export type PdfCalloutEdit = {
  type: "callout";
  /** Zero-based page index receiving the callout. */
  pageIndex: number;
  /** User-space bounding box of the text box. */
  rect: PdfEditRect;
  /** User-space target point where the leader points. */
  tip: PdfEditPoint;
  /** Text content. `\n` produces additional lines. Must not be empty. */
  text: string;
  /** Font size in points. Defaults to 12. */
  fontSizePt?: number;
  /** Text ink color. Defaults to near-black (#111111). */
  color?: PdfEditColor;
  /** Standard PDF font family. Defaults to Helvetica. */
  fontFamily?: PdfTextBoxFontFamily;
  /** Use the bold face of the selected standard font family. Defaults to false. */
  bold?: boolean;
  /** Use the italic/oblique face of the selected standard font family. Defaults to false. */
  italic?: boolean;
  /** Horizontal alignment for each rendered line. Defaults to left. */
  align?: PdfTextBoxAlign;
  /** Leader stroke color. Defaults to near-black (#111111). */
  strokeColor?: PdfEditColor;
  /** Leader stroke thickness in points. Defaults to 1.5. */
  strokeWidthPt?: number;
  /** Draw an arrowhead at `tip`. Defaults to true. */
  arrowhead?: boolean;
  /** Draw a thin border around the text box. Defaults to true. */
  boxBorder?: boolean;
  /** Optional fill color for the text box. Omitted means transparent. */
  boxFill?: PdfEditColor;
};

/**
 * A raster image drawn inside a rectangle.
 *
 * On rotated pages the image is drawn upright to the viewer; `rect` is the
 * user-space bounding box of the visual placement (its `w`/`h` are user-space
 * extents, so they appear swapped relative to the visual box on 90/270 pages).
 */
export type PdfImageEdit = {
  type: "image";
  /** Zero-based page index receiving the image. */
  pageIndex: number;
  /** User-space bounding box the image is scaled into. */
  rect: PdfEditRect;
  /** Encoded image bytes. */
  bytes: PdfBytes;
  /** Encoding of `bytes`. */
  format: PdfEditImageFormat;
};

/**
 * Freehand ink strokes emitted as live annotations by default.
 *
 * Each stroke is a polyline of user-space points (already rotation-mapped by
 * the caller, like redaction rectangles), so engines draw them verbatim.
 */
export type PdfInkEdit = {
  type: "ink";
  /** Zero-based page index receiving the strokes. */
  pageIndex: number;
  /** Polylines in PDF user-space points. Each stroke needs at least two points. */
  strokes: ReadonlyArray<readonly PdfEditPoint[]>;
  /** Stroke thickness in points. Defaults to 1.5. */
  strokeWidthPt?: number;
  /** Stroke color. Defaults to near-black (#111111). */
  color?: PdfEditColor;
};

export type PdfShapeKind = "rect" | "ellipse" | "line" | "arrow";

/**
 * Geometric shapes emitted as live annotations by default.
 *
 * Shape geometry is orientation-agnostic and drawn verbatim in PDF user-space
 * points, matching highlights and ink. Rectangle and ellipse edits require a
 * positive-dimension bounding rectangle; line and arrow edits require distinct
 * endpoints.
 */
export type PdfShapeEdit =
  | {
      type: "shape";
      /** Zero-based page index receiving the shape. */
      pageIndex: number;
      shape: "rect" | "ellipse";
      /** Positive-dimension user-space bounds. */
      rect: PdfEditRect;
      /** Stroke thickness in points. Defaults to 1.5. */
      strokeWidthPt?: number;
      /** Stroke color. Defaults to near-black (#111111). */
      strokeColor?: PdfEditColor;
      /** Optional fill color. Omitted means stroke-only. */
      fillColor?: PdfEditColor;
    }
  | {
      type: "shape";
      /** Zero-based page index receiving the shape. */
      pageIndex: number;
      shape: "line" | "arrow";
      /** User-space start point. */
      from: PdfEditPoint;
      /** User-space end point. */
      to: PdfEditPoint;
      /** Stroke thickness in points. Defaults to 1.5. */
      strokeWidthPt?: number;
      /** Stroke color. Defaults to near-black (#111111). */
      strokeColor?: PdfEditColor;
    };

export type PdfMarkupMode = "baked" | "annotation";

export type PdfApplyEditsOptions = {
  /**
   * Controls whether supported markup edits are baked into page content or
   * emitted as live PDF annotations with generated appearances.
   *
   * Defaults to `"annotation"` for live, toggleable markup. Baked mode remains
   * available for permanent page marks and is also reachable by flattening
   * RaioPDF-owned markup annotations after annotation-mode saving.
   */
  markupMode?: PdfMarkupMode;
  /**
   * Controls the PDF `/F` Print flag on RaioPDF-owned markup annotations.
   *
   * Defaults to true. Ignored when `markupMode` is `"baked"` and does not
   * change regular sticky-note comments.
   */
  printMarkupAnnotations?: boolean;
};

export type PdfUpdateAnnotationOptions = {
  /**
   * Controls the PDF `/F` Print flag when re-emitting a RaioPDF-owned markup
   * annotation during an update.
   *
   * Defaults to true.
   */
  printMarkupAnnotations?: boolean;
};

/**
 * A sticky-note comment stored as a real PDF `/Text` annotation.
 *
 * Unlike the drawn edit types, comments survive as annotations: they stay
 * deletable and editable in other PDF viewers and are not baked into content.
 * Viewers render their own upright note icon at the anchor point, so no
 * rotation compensation is required.
 */
export type PdfCommentEdit = {
  type: "comment";
  /** Stable RaioPDF annotation id when updating/importing a live annotation. */
  annotId?: string;
  /** Zero-based page index receiving the annotation. */
  pageIndex: number;
  /** Bottom-left anchor of the note icon in PDF user-space points. */
  at: PdfEditPoint;
  /** Note body shown in the comment popup. Must not be empty. */
  text: string;
  /** Optional author recorded on the annotation's `/T` entry. */
  author?: string;
};

/** Value accepted for a single AcroForm field write. */
export type PdfFormFieldValue = string | boolean | readonly string[];

/**
 * Writes values into the document's AcroForm fields.
 *
 * Form fields are document-scoped in PDF, so this is the one edit variant
 * without `pageIndex`/geometry. Strings fill text fields and select radio
 * group or dropdown options; booleans check/uncheck checkboxes; string arrays
 * select option-list (and multi-select dropdown) entries. Unknown field names
 * and mismatched value types reject with `INVALID_DOCUMENT`.
 */
export type PdfFormValuesEdit = {
  type: "formValues";
  /** Field values keyed by fully-qualified AcroForm field name. */
  values: Readonly<Record<string, PdfFormFieldValue>>;
};

/**
 * A signature image placed like `PdfImageEdit`.
 *
 * Kept as a distinct variant so callers can carry signature provenance and
 * apply signature-specific policy (e.g. the flatten-on-save default); engines
 * render it exactly like an image edit. This is a drawn signature picture,
 * not a cryptographic digital signature.
 */
export type PdfSignatureEdit = {
  type: "signature";
  /** Zero-based page index receiving the signature. */
  pageIndex: number;
  /** User-space bounding box the signature is scaled into. */
  rect: PdfEditRect;
  /** Encoded signature image bytes. */
  bytes: PdfBytes;
  /** Encoding of `bytes`. */
  format: PdfEditImageFormat;
};

/**
 * One pending add-content edit to apply to a document.
 *
 * Geometry is always in PDF user-space points with a bottom-left origin —
 * identical to the redaction coordinate contract. Callers perform the
 * canvas→PDF-point mapping (including page `/Rotate` handling); engines must
 * additionally render orientation-sensitive content (text, images,
 * signatures) upright to the viewer on rotated pages.
 */
export type PdfEdit =
  | PdfHighlightEdit
  | PdfTextMarkupEdit
  | PdfTextBoxEdit
  | PdfCalloutEdit
  | PdfImageEdit
  | PdfInkEdit
  | PdfShapeEdit
  | PdfCommentEdit
  | PdfFormValuesEdit
  | PdfSignatureEdit;

export type PdfRaioAnnotationEdit =
  | PdfHighlightEdit
  | PdfTextMarkupEdit
  | PdfTextBoxEdit
  | PdfCommentEdit;

export type PdfRaioAnnotationImport = {
  pageIndex: number;
  annotId: string;
  edit: PdfRaioAnnotationEdit;
};

export type PdfEngineErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "ENCRYPTED_DOCUMENT"
  /** Operation would create a PDF with no pages. */
  | "EMPTY_RESULT"
  | "EMPTY_INPUT"
  | "INVALID_DOCUMENT"
  | "INVALID_PAGE_INDEX"
  | "PASSWORD_REQUIRED"
  | "SIGNED_DOCUMENT"
  | "UNSUPPORTED_ENCRYPTION"
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
  /**
   * Removes PDF encryption/password protection from raw bytes.
   *
   * This operation accepts bytes instead of a document handle because encrypted
   * PDFs often cannot be opened by the normal engine pipeline first. The
   * password is caller-supplied for this invocation only; implementations must
   * not persist it or include it in logs, manifests, or result metadata.
   */
  removeEncryption(bytes: PdfBytes, password: string): Promise<Uint8Array>;

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
  ): Promise<PdfOutlineWriteResult>;

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
  ): Promise<PdfOutlineWriteResult>;

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

  /**
   * Creates a new document with every page rendered into the requested page
   * size and orientation. Content must preserve aspect ratio and may be
   * letterboxed, but never distorted.
   */
  normalizePages(
    document: PdfDocumentHandle,
    options: PdfNormalizePagesOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Splits a document at page boundaries using greedy packing against a byte
   * cap. A source page that cannot fit alone is emitted as its own part with
   * `oversized=true`.
   */
  splitByMaxBytes(
    document: PdfDocumentHandle,
    maxBytes: number,
  ): Promise<PdfSplitByMaxBytesResult>;

  /**
   * Converts a document to the requested PDF/A flavor when the backing engine
   * has a verified conversion pipeline.
   */
  convertToPdfA(
    document: PdfDocumentHandle,
    options: PdfAConversionOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a compressed copy of the document when the backing engine has a
   * verified optimizer. Local pdf-lib implementations should reject with
   * `PdfEngineError("UNSUPPORTED", ...)` because pdf-lib cannot safely
   * downsample or recompress arbitrary page content.
   */
  compress(
    document: PdfDocumentHandle,
    options: PdfCompressOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a sanitized copy of the document by removing active or embedded
   * content such as JavaScript, attachments, and external links. Engines return
   * the removal categories requested and handled by the backend.
   */
  sanitize(
    document: PdfDocumentHandle,
    options?: PdfSanitizeOptions,
  ): Promise<PdfSanitizeResult>;

  /**
   * Attempts to repair a structurally damaged PDF. Sidecar engines may use
   * Ghostscript/qpdf/PDFBox; local engines should reject with UNSUPPORTED
   * because opening the document already requires valid bytes.
   */
  repair(document: PdfDocumentHandle): Promise<PdfDocumentHandle>;

  /** Creates a new document by inserting all pages from another document at a zero-based page position. */
  insertPages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    fromOtherDocument: PdfDocumentHandle,
    options?: PdfInsertPagesOptions,
  ): Promise<PdfOutlineWriteResult>;

  /** Creates a new document by concatenating all pages from the provided documents in order. */
  merge(
    documents: readonly PdfDocumentHandle[],
    options?: PdfMergeOptions,
  ): Promise<PdfOutlineWriteResult>;

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
   * matching when the backing engine supports it. `rasterize` explicitly allows
   * image-based output when that is the only guaranteed removal mode; callers
   * should expect searchable/selectable text to be lost on rasterized pages.
   * Engines that cannot guarantee true text removal must reject with
   * `PdfEngineError("UNSUPPORTED", ...)`.
   */
  redactText(
    document: PdfDocumentHandle,
    options: PdfRedactTextOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document by replacing literal, case-sensitive text in real PDF
   * content streams.
   *
   * Replacement does not reflow paragraphs or retarget individual occurrences:
   * each ordered operation replaces every match on the selected pages. The whole
   * document is regenerated; the bundled engine preserves image streams, while
   * unpatched engines may re-encode them, and pages with replacement glyphs the
   * original font cannot encode may be fully re-laid out. PDFs that space words
   * positionally can defeat multi-word finds because no literal space exists in
   * the content stream. Engines that cannot rewrite content streams must reject
   * with `PdfEngineError("UNSUPPORTED", ...)`.
   */
  replaceText(
    document: PdfDocumentHandle,
    options: PdfReplaceTextOptions,
  ): Promise<PdfReplaceTextResult>;

  /**
   * Extracts the backing engine's editable text map for selected-span editing.
   *
   * The returned text is not pdf.js copy/paste text: elements are joined exactly
   * as the rewrite engine will see them, including the absence of inferred spaces.
   * Callers may use the viewer text layer to capture a selection, but they must
   * resolve it to one of these engine-backed spans before applying an edit.
   */
  inspectTextMap(
    document: PdfDocumentHandle,
    options?: PdfInspectTextMapOptions,
  ): Promise<PdfInspectTextMapResult>;

  /**
   * Replaces one resolved selected text span in real PDF content streams.
   *
   * The target must come from `inspectTextMap` for the same source bytes. Engines
   * must reject if the page fingerprint, selected text, element indexes, or
   * offsets no longer match. Like `replaceText`, the whole PDF may be regenerated
   * and callers must review the returned bytes before applying them.
   */
  replaceSelectedText(
    document: PdfDocumentHandle,
    options: PdfReplaceSelectedTextOptions,
  ): Promise<PdfReplaceSelectedTextResult>;

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
   * Creates a new document with simple page numbers stamped on selected pages.
   * This is intentionally distinct from Bates numbering: numbering can start at
   * any integer and optionally includes the total page count, but has no prefix
   * or fixed digit width.
   */
  pageNumbers(
    document: PdfDocumentHandle,
    options: PdfPageNumbersOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document with a text watermark drawn into selected pages.
   * Local implementations should render the text with page-rotation awareness
   * so diagonal and horizontal marks read upright to the viewer.
   */
  watermark(
    document: PdfDocumentHandle,
    options: PdfWatermarkOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document by inserting raster images as full pages at the
   * provided zero-based page position. Images are embedded as page content, not
   * annotations.
   */
  insertImagePages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    images: readonly PdfImagePageInput[],
  ): Promise<PdfOutlineWriteResult>;

  /** Reads the document's PDF outline/bookmark tree. */
  getOutline(document: PdfDocumentHandle): Promise<PdfOutlineState>;

  /**
   * Rewrites the document outline/bookmark tree.
   *
   * Implementations must preserve source nodes with non-page targets when the
   * caller supplies their original `preserveId`; otherwise the write fails
   * closed instead of silently deleting view-only bookmarks.
   */
  replaceOutline(
    document: PdfDocumentHandle,
    outline: PdfOutlineState,
  ): Promise<PdfOutlineWriteResult>;

  /**
   * Builds an exhibit binder from a main document and labeled exhibits.
   *
   * Output page order is the main document, then a generated exhibit index by
   * default, then each exhibit section. An exhibit section contains an optional
   * centered slip sheet, then the exhibit pages stamped with the exhibit label
   * according to `placement` and `stampPages`. Defaults are footer-right labels
   * on all exhibit pages, `fontSizePt=11`, and `marginIn=0.5`. The binder
   * outline contains "Main document", "Exhibit Index" when enabled, and one
   * entry per exhibit pointing at each section's first page. Engines without
   * caller-defined outline support may reject this with
   * `PdfEngineError("UNSUPPORTED", ...)`; the local engine is the default
   * binder implementation.
   */
  buildBinder(
    main: PdfDocumentHandle,
    exhibits: readonly PdfBinderExhibit[],
    options: PdfBinderOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document with the provided add-content edits applied.
   *
   * Edits are applied in array order against the source document. An empty
   * `edits` array is valid and returns a new handle with unchanged content.
   * Geometry follows the redaction coordinate contract (PDF user-space
   * points, bottom-left origin, caller-mapped from canvas coordinates);
   * engines must render text, image, and signature edits upright to the
   * viewer on pages rotated 90/180/270 degrees. Comments must be written as
   * real `/Annots` entries so they remain live annotations. By default,
   * supported markup edits are emitted as real PDF annotations; currently
   * supported markup edits are ink, geometric shapes, highlights, underlines,
   * strikethroughs, text boxes, and callouts. Callers may request
   * `markupMode: "baked"` to write permanent page content. Other edit types
   * keep their existing path. Engines without an add-content pipeline must
   * reject with `PdfEngineError("UNSUPPORTED", ...)`.
   */
  applyEdits(
    document: PdfDocumentHandle,
    edits: readonly PdfEdit[],
    options?: PdfApplyEditsOptions,
  ): Promise<PdfDocumentHandle>;

  /**
   * Reads RaioPDF-authored live annotations that carry RaioPDF source-edit
   * metadata. Foreign annotations and RaioPDF annotation kinds without a
   * supported Slice 1 source payload are skipped.
   */
  readRaioPdfAnnotations(document: PdfDocumentHandle): Promise<readonly PdfRaioAnnotationImport[]>;

  /**
   * Replaces one RaioPDF-authored live annotation by stable id, refreshing its
   * geometry, appearance stream, and source-edit metadata.
   */
  updateAnnotationById(
    document: PdfDocumentHandle,
    annotId: string,
    edit: PdfRaioAnnotationEdit,
    options?: PdfUpdateAnnotationOptions,
  ): Promise<PdfDocumentHandle>;

  /** Removes one RaioPDF-authored live annotation by stable id. */
  deleteAnnotationById(
    document: PdfDocumentHandle,
    annotId: string,
  ): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document with all AcroForm fields flattened.
   *
   * Field appearances (current values) are drawn into page content and the
   * interactive fields are removed, so values stay visible but are no longer
   * editable. A document without form fields round-trips unchanged. Engines
   * without form support must reject with `PdfEngineError("UNSUPPORTED", ...)`.
   */
  flattenForm(document: PdfDocumentHandle): Promise<PdfDocumentHandle>;

  /**
   * Creates a new document with RaioPDF-owned markup annotations flattened.
   *
   * Only annotations carrying RaioPDF's private annotation marker are touched;
   * third-party annotations and sticky-note comments remain live. Markup
   * appearances are painted into page content before the marked annotations are
   * removed from `/Annots`.
   */
  flattenMarkupAnnotations(document: PdfDocumentHandle): Promise<PdfDocumentHandle>;

  /** Serializes an opened document handle to PDF bytes. */
  saveToBytes(document: PdfDocumentHandle): Promise<Uint8Array>;
}
