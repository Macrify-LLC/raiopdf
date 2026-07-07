import type {
  PdfBatesStampOptions,
  PdfBinderExhibit,
  PdfBinderOptions,
  PdfBytes,
  PdfAConversionOptions,
  PdfApplyEditsOptions,
  PdfCalloutEdit,
  PdfCommentEdit,
  PdfCompressOptions,
  PdfDocumentHandle,
  PdfEdit,
  PdfEditColor,
  PdfEditPoint,
  PdfEditRect,
  PdfEngine,
  PdfFormFieldValue,
  PdfFormValuesEdit,
  PdfHighlightEdit,
  PdfImagePageInput,
  PdfImageEdit,
  PdfInkEdit,
  PdfInsertPagesOptions,
  PdfMergeOptions,
  PdfNormalizePagesOptions,
  PdfOutlineItem,
  PdfOutlineState,
  PdfOutlineWriteResult,
  PdfPageSizePoints,
  PdfPageNumbersOptions,
  PdfPageSelection,
  PdfRaioAnnotationEdit,
  PdfRaioAnnotationImport,
  PdfReplaceTextOptions,
  PdfReplaceTextResult,
  PdfReplaceSelectedTextOptions,
  PdfReplaceSelectedTextResult,
  PdfRedactTextOptions,
  PdfRedactionArea,
  PdfSanitizeOptions,
  PdfSanitizeResult,
  PdfInspectTextMapOptions,
  PdfInspectTextMapResult,
  PdfShapeEdit,
  PdfSignatureEdit,
  PdfSplitByMaxBytesResult,
  PdfStampPlacement,
  PdfStampTextOptions,
  PdfTextBoxAlign,
  PdfTextBoxEdit,
  PdfTextBoxFontFamily,
  PdfTextMarkupEdit,
  PdfUpdateAnnotationOptions,
  PdfTextRegion,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import { PdfEngineError, wrapTextBoxLines } from "@raiopdf/engine-api";
import {
  createPdfOutlinePageItem,
  mapPdfOutlineItems,
  offsetPdfOutlineItems,
  prefixPdfOutlineItemIds,
  readPdfOutline,
  scrubPdfMetadataInPlace,
  writePdfOutlineInPlace,
} from "@raiopdf/engine-pdf-lib";
import {
  degrees as pdfDegrees,
  LineCapStyle,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFHexString,
  PDFFont,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  rgb,
  StandardFonts,
} from "pdf-lib";
import {
  createAnnotationAppearanceTarget,
  createPageDrawTarget,
  drawAnnotationAppearanceOnPage,
  type AnnotationAppearanceTarget,
  type DrawColor,
  type DrawTarget,
} from "./drawTarget";
import { drawCoverPage } from "./coverStyles";
import { fitTextToWidth, sanitizeIndexTextForFont } from "./textFit";

export {
  createAnnotationAppearanceTarget,
  createPageDrawTarget,
  drawAnnotationAppearanceOnPage,
} from "./drawTarget";
export { drawCoverPage, type CoverDrawFonts, type CoverDrawInput } from "./coverStyles";
export type { PdfCoverStyle } from "@raiopdf/engine-api";
export { fitTextToWidth, sanitizeIndexTextForFont } from "./textFit";

type StoredDocument = {
  bytes: Uint8Array;
};

type PageRotation = 0 | 90 | 180 | 270;
type MarkupMode = NonNullable<PdfApplyEditsOptions["markupMode"]>;
type MarkupAnnotationOptions = {
  print: boolean;
};

type TextBoxFontKey = `${PdfTextBoxFontFamily}:${"regular" | "bold" | "italic" | "boldItalic"}`;

type TextRenderableEdit = PdfTextBoxEdit | PdfCalloutEdit;

type TextBoxFontResolver = (edit: TextRenderableEdit) => Promise<PDFFont>;

export type ExhibitBinderIndexExhibit = {
  label: string;
  pageCount: number;
  description?: string | undefined;
  sourceFileName?: string | undefined;
};

export type ExhibitIndexEntry = ExhibitBinderIndexExhibit & {
  binderPageStart: number;
  binderPageEnd: number;
  pageRange: string;
  descriptionGeneratedFromSourceFileName?: boolean | undefined;
};

export type ExhibitIndexLayoutInput = {
  pageSize: readonly [number, number];
  mainPageCount: number;
  exhibits: readonly ExhibitBinderIndexExhibit[];
  slipSheets: boolean;
  includeSourceFileName?: boolean | undefined;
  maxIterations?: number | undefined;
};

export type ExhibitIndexLayoutResult = {
  bytes: Uint8Array;
  pageCount: number;
  entries: readonly ExhibitIndexEntry[];
  iterations: number;
};

export type RaioPdfMarkupAnnotation = {
  readonly dict: PDFDict;
  readonly ref: PDFRef | undefined;
  readonly subtype: string;
};

const DEFAULT_FONT_SIZE_PT = 11;
const DEFAULT_MARGIN_IN = 0.5;
const POINTS_PER_INCH = 72;
const DEFAULT_BINDER_PLACEMENT: PdfStampPlacement = {
  edge: "footer",
  align: "right",
};
const DEFAULT_BINDER_INDEX_ENABLED = true;
const DEFAULT_BINDER_INDEX_SOURCE_FILENAME = false;
const EXHIBIT_INDEX_MAX_ITERATIONS = 5;
const STAMP_COLOR = rgb(0.08, 0.08, 0.08);
const EDIT_INK_COLOR = rgb(0x11 / 0xff, 0x11 / 0xff, 0x11 / 0xff);
const HIGHLIGHT_COLOR = rgb(1, 0.9, 0.3);
const DEFAULT_HIGHLIGHT_OPACITY = 0.4;
const DEFAULT_TEXT_MARKUP_THICKNESS_PT = 1;
const AP_STROKE_CLIP_SAFETY_MARGIN_PT = 0.25;
const DEFAULT_TEXT_BOX_FONT_SIZE_PT = 12;
const DEFAULT_WATERMARK_FONT_SIZE_PT = 48;
const DEFAULT_WATERMARK_OPACITY = 0.18;
const TEXT_BOX_LINE_HEIGHT_FACTOR = 1.2;
const DEFAULT_INK_STROKE_WIDTH_PT = 1.5;
const DEFAULT_SHAPE_STROKE_WIDTH_PT = 1.5;
const DEFAULT_CALLOUT_STROKE_WIDTH_PT = DEFAULT_SHAPE_STROKE_WIDTH_PT;
const DEFAULT_CALLOUT_BOX_BORDER_WIDTH_PT = 0.75;
const ARROW_HEAD_MIN_PT = 8;
const ARROW_HEAD_MAX_PT = 32;
const COMMENT_ICON_SIZE_PT = 20;
const EDIT_INK_COLOR_COMPONENTS = [0x11 / 0xff, 0x11 / 0xff, 0x11 / 0xff] as const;
const HIGHLIGHT_COLOR_COMPONENTS = [1, 0.9, 0.3] as const;
/** PDF annotation flag bit 2 (value 2): do not display or print the annotation. */
const ANNOTATION_FLAG_HIDDEN = 2;
/** PDF annotation flag bit 3 (value 4): render the annotation when printing. */
const ANNOTATION_FLAG_PRINT = 4;
const RAIOPDF_ANNOTATION_MARKER = PDFName.of("RaioPDF");
const RAIOPDF_ANNOTATION_MARKER_VERSION = 2;
const RAIOPDF_MARKUP_ANNOTATION_SUBTYPES = new Set([
  "Circle",
  "FreeText",
  "Highlight",
  "Ink",
  "Line",
  "PolyLine",
  "Polygon",
  "Square",
  "Squiggly",
  "StrikeOut",
  "Underline",
]);
const RAIO_ROUNDTRIP_SUBTYPE_BY_KIND = {
  highlight: "Highlight",
  underline: "Underline",
  strikethrough: "StrikeOut",
  textBox: "FreeText",
  comment: "Text",
} satisfies Record<PdfRaioAnnotationEdit["type"], string>;
const TEXT_BOX_STANDARD_FONTS: Record<TextBoxFontKey, StandardFonts> = {
  "helvetica:regular": StandardFonts.Helvetica,
  "helvetica:bold": StandardFonts.HelveticaBold,
  "helvetica:italic": StandardFonts.HelveticaOblique,
  "helvetica:boldItalic": StandardFonts.HelveticaBoldOblique,
  "times:regular": StandardFonts.TimesRoman,
  "times:bold": StandardFonts.TimesRomanBold,
  "times:italic": StandardFonts.TimesRomanItalic,
  "times:boldItalic": StandardFonts.TimesRomanBoldItalic,
  "courier:regular": StandardFonts.Courier,
  "courier:bold": StandardFonts.CourierBold,
  "courier:italic": StandardFonts.CourierOblique,
  "courier:boldItalic": StandardFonts.CourierBoldOblique,
};

export class LocalPdfEngine implements PdfEngine {
  private readonly documents = new Map<PdfDocumentHandle, StoredDocument>();
  private nextDocumentId = 1;

  async removeEncryption(_bytes: PdfBytes, _password: string): Promise<Uint8Array> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "The local pdf-lib engine cannot remove PDF encryption; use the sidecar engine.",
    );
  }

  async open(bytes: PdfBytes): Promise<PdfDocumentHandle> {
    const normalizedBytes = normalizeBytes(bytes);
    await loadPdf(normalizedBytes);

    return this.store(normalizedBytes);
  }

  async close(document: PdfDocumentHandle): Promise<void> {
    this.documents.delete(document);
  }

  async pageCount(document: PdfDocumentHandle): Promise<number> {
    const pdf = await this.load(document);

    return pdf.getPageCount();
  }

  async reorderPages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfOutlineWriteResult> {
    const source = await this.load(document);
    assertCompletePageSet(pageIndexes, source.getPageCount());

    const output = await PDFDocument.create();
    const copiedPages = await output.copyPages(source, [...pageIndexes]);
    for (const page of copiedPages) {
      output.addPage(page);
    }

    const pageMap = new Map(pageIndexes.map((pageIndex, outputIndex) => [pageIndex, outputIndex]));
    const outline = readPdfOutline(source);
    const mapped = mapPdfOutlineItems(outline.items, (pageIndex) => pageMap.get(pageIndex) ?? null);
    writePdfOutlineInPlace(output, { ...outline, items: mapped.items }, { preserveSource: source });

    return {
      document: this.store(await output.save()),
      removedTargets: mapped.removedTargets,
    };
  }

  async rotatePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
    degrees: number,
  ): Promise<PdfDocumentHandle> {
    assertSupportedRotation(degrees);

    const source = await this.load(document);
    const pageCount = source.getPageCount();
    assertPageIndexes(pageIndexes, pageCount);

    const selectedPages = new Set(pageIndexes);
    const output = await PDFDocument.create();
    const copiedPages = await output.copyPages(source, source.getPageIndices());

    copiedPages.forEach((page, pageIndex) => {
      if (selectedPages.has(pageIndex)) {
        const currentAngle = page.getRotation().angle;
        page.setRotation(pdfDegrees(normalizeRotation(currentAngle + degrees)));
      }

      output.addPage(page);
    });

    const outline = readPdfOutline(source);
    writePdfOutlineInPlace(output, outline, { preserveSource: source });

    return this.store(await output.save());
  }

  async deletePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfOutlineWriteResult> {
    const source = await this.load(document);
    const pageCount = source.getPageCount();
    assertPageIndexes(pageIndexes, pageCount);

    const deletedPages = new Set(pageIndexes);
    const keptPageIndexes = source
      .getPageIndices()
      .filter((pageIndex) => !deletedPages.has(pageIndex));

    if (keptPageIndexes.length === 0) {
      throw new PdfEngineError(
        "EMPTY_RESULT",
        "Delete operations must leave at least one page.",
      );
    }

    const output = await PDFDocument.create();
    const copiedPages = await output.copyPages(source, keptPageIndexes);
    for (const page of copiedPages) {
      output.addPage(page);
    }

    const pageMap = new Map(keptPageIndexes.map((pageIndex, outputIndex) => [pageIndex, outputIndex]));
    const outline = readPdfOutline(source);
    const mapped = mapPdfOutlineItems(outline.items, (pageIndex) => pageMap.get(pageIndex) ?? null);
    writePdfOutlineInPlace(output, { ...outline, items: mapped.items }, { preserveSource: source });

    return {
      document: this.store(await output.save()),
      removedTargets: mapped.removedTargets,
    };
  }

  async cropPages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
    marginIn: number,
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    const pageCount = output.getPageCount();
    assertPageIndexes(pageIndexes, pageCount);
    assertNonNegativeNumber(marginIn, "marginIn");

    const selectedPages = new Set(pageIndexes);
    const cropMarginPt = marginIn * POINTS_PER_INCH;

    output.getPages().forEach((page, pageIndex) => {
      if (!selectedPages.has(pageIndex)) {
        return;
      }

      const width = page.getWidth();
      const height = page.getHeight();
      const maxMargin = Math.min(width, height) / 2 - 1;
      const margin = Math.min(cropMarginPt, Math.max(maxMargin, 0));
      page.setCropBox(margin, margin, width - margin * 2, height - margin * 2);
    });

    return this.store(await output.save());
  }

  async resizePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
    pageSize: PdfPageSizePoints,
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    assertPageIndexes(pageIndexes, output.getPageCount());
    assertPositiveNumber(pageSize.widthPt, "widthPt");
    assertPositiveNumber(pageSize.heightPt, "heightPt");

    const selectedPages = new Set(pageIndexes);

    output.getPages().forEach((page, pageIndex) => {
      if (selectedPages.has(pageIndex)) {
        page.setSize(pageSize.widthPt, pageSize.heightPt);
      }
    });

    return this.store(await output.save());
  }

  async normalizePages(
    document: PdfDocumentHandle,
    options: PdfNormalizePagesOptions,
  ): Promise<PdfDocumentHandle> {
    assertPositiveNumber(options.targetSize.w, "targetSize.w");
    assertPositiveNumber(options.targetSize.h, "targetSize.h");

    if (options.orientation !== "portrait") {
      throw new PdfEngineError("INVALID_DOCUMENT", "Only portrait normalization is supported.");
    }

    const source = await this.load(document);
    flattenMarkupAnnotationsInPlace(source);
    const output = await PDFDocument.create();
    const targetWidth = Math.min(options.targetSize.w, options.targetSize.h) * POINTS_PER_INCH;
    const targetHeight = Math.max(options.targetSize.w, options.targetSize.h) * POINTS_PER_INCH;

    for (const sourcePage of source.getPages()) {
      const targetPage = output.addPage([targetWidth, targetHeight]);

      if (!sourcePage.node.Contents()) {
        continue;
      }

      const embeddedPage = await output.embedPage(sourcePage);
      const drawOptions = computeNormalizeDrawOptions({
        sourceWidth: sourcePage.getWidth(),
        sourceHeight: sourcePage.getHeight(),
        sourceRotation: normalizePageRotation(sourcePage.getRotation().angle),
        targetWidth,
        targetHeight,
      });

      targetPage.drawPage(embeddedPage, {
        x: drawOptions.x,
        y: drawOptions.y,
        width: drawOptions.width,
        height: drawOptions.height,
        rotate: pdfDegrees(drawOptions.rotate),
      });
    }

    return this.store(await output.save());
  }

  async splitByMaxBytes(
    document: PdfDocumentHandle,
    maxBytes: number,
  ): Promise<PdfSplitByMaxBytesResult> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new PdfEngineError("INVALID_DOCUMENT", "maxBytes must be a positive integer.");
    }

    const source = await this.load(document);
    const pageIndices = source.getPageIndices();
    const parts: Array<{
      bytes: Uint8Array;
      pageIndexes: number[];
      oversized: boolean;
    }> = [];
    let start = 0;
    let previousPartPageCount = 1;

    while (start < pageIndices.length) {
      const part = await packSplitPart(
        source,
        pageIndices,
        start,
        maxBytes,
        previousPartPageCount,
      );
      parts.push(part);
      previousPartPageCount = Math.max(1, part.pageIndexes.length);
      start += part.pageIndexes.length;
    }

    return {
      parts: parts.map((part) => {
        const partDocument = this.store(part.bytes);

        return {
          document: partDocument,
          pageIndexes: part.pageIndexes,
          byteLength: part.bytes.byteLength,
          oversized: part.oversized,
        };
      }),
    };
  }

  async convertToPdfA(
    _document: PdfDocumentHandle,
    options: PdfAConversionOptions,
  ): Promise<PdfDocumentHandle> {
    assertSupportedPdfAFlavor(options.flavor);

    throw new PdfEngineError(
      "UNSUPPORTED",
      "PDF/A conversion requires the desktop sidecar engine; the local pdf-lib engine cannot produce PDF/A output.",
    );
  }

  async compress(
    _document: PdfDocumentHandle,
    _options: PdfCompressOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "PDF compression requires the desktop sidecar engine; the local pdf-lib engine cannot downsample arbitrary PDF content.",
    );
  }

  async sanitize(
    _document: PdfDocumentHandle,
    _options: PdfSanitizeOptions = {},
  ): Promise<PdfSanitizeResult> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "PDF sanitizing requires the desktop sidecar engine; the local pdf-lib engine cannot remove active document content safely.",
    );
  }

  async repair(_document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "PDF repair requires the desktop sidecar engine; the local pdf-lib engine only opens already-readable PDFs.",
    );
  }

  async replaceText(
    _document: PdfDocumentHandle,
    _options: PdfReplaceTextOptions,
  ): Promise<PdfReplaceTextResult> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "PDF text replacement requires the desktop sidecar engine; the local pdf-lib engine cannot re-encode arbitrary glyph runs.",
    );
  }

  async inspectTextMap(
    _document: PdfDocumentHandle,
    _options: PdfInspectTextMapOptions = {},
  ): Promise<PdfInspectTextMapResult> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "PDF text-map inspection requires the desktop sidecar engine; the local pdf-lib engine cannot read rewrite-safe glyph runs.",
    );
  }

  async replaceSelectedText(
    _document: PdfDocumentHandle,
    _options: PdfReplaceSelectedTextOptions,
  ): Promise<PdfReplaceSelectedTextResult> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Selected PDF text replacement requires the desktop sidecar engine; the local pdf-lib engine cannot re-encode arbitrary glyph runs.",
    );
  }

  async insertPages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    fromOtherDocument: PdfDocumentHandle,
    options: PdfInsertPagesOptions = {},
  ): Promise<PdfOutlineWriteResult> {
    const target = await this.load(document);
    const inserted = await this.load(fromOtherDocument);
    const targetPageCount = target.getPageCount();
    assertInsertIndex(insertAtPageIndex, targetPageCount);

    const output = await PDFDocument.create();
    await copyPagesInto(output, target, target.getPageIndices().slice(0, insertAtPageIndex));
    await copyPagesInto(output, inserted, inserted.getPageIndices());
    await copyPagesInto(output, target, target.getPageIndices().slice(insertAtPageIndex));

    const targetOutline = readPdfOutline(target);
    const targetMapped = mapPdfOutlineItems(targetOutline.items, (pageIndex) =>
      pageIndex < insertAtPageIndex ? pageIndex : pageIndex + inserted.getPageCount());
    const insertedOutline = readPdfOutline(inserted);
    const insertedOffset = offsetPdfOutlineItems(insertedOutline.items, insertAtPageIndex);
    const prefixedInserted = prefixPdfOutlineItemIds(insertedOffset.items, "inserted:");
    const insertedParent = prefixedInserted.length > 0
      ? [createPdfOutlinePageItem({
          id: "inserted:root",
          title: options.sourceLabel ?? "Inserted document",
          pageIndex: insertAtPageIndex,
          expanded: true,
          children: prefixedInserted,
        })]
      : [];
    writePdfOutlineInPlace(output, {
      ...targetOutline,
      items: [
        ...targetMapped.items,
        ...insertedParent,
      ],
    }, {
      preserveSources: [
        { pdf: target },
        { pdf: inserted, idPrefix: "inserted:" },
      ],
    });

    return {
      document: this.store(await output.save()),
      removedTargets: targetMapped.removedTargets + insertedOffset.removedTargets,
    };
  }

  async merge(
    documents: readonly PdfDocumentHandle[],
    options: PdfMergeOptions = {},
  ): Promise<PdfOutlineWriteResult> {
    if (documents.length === 0) {
      throw new PdfEngineError("EMPTY_INPUT", "At least one document is required.");
    }

    const output = await PDFDocument.create();
    const outlineItems: PdfOutlineItem[] = [];
    const preserveSources: Array<{ pdf: PDFDocument; idPrefix?: string | undefined }> = [];
    let pageOffset = 0;
    let removedTargets = 0;

    for (const [index, document] of documents.entries()) {
      const source = await this.load(document);
      await copyPagesInto(output, source, source.getPageIndices());

      const prefix = `merged:${index}:`;
      preserveSources.push({ pdf: source, idPrefix: prefix });
      const outline = readPdfOutline(source);
      const mapped = offsetPdfOutlineItems(outline.items, pageOffset);
      const prefixed = prefixPdfOutlineItemIds(mapped.items, prefix);
      removedTargets += mapped.removedTargets;
      if (prefixed.length > 0) {
        outlineItems.push(createPdfOutlinePageItem({
          id: `${prefix}root`,
          title: options.labels?.[index] ?? `Merged document ${index + 1}`,
          pageIndex: pageOffset,
          expanded: true,
          children: prefixed,
        }));
      }
      pageOffset += source.getPageCount();
    }

    writePdfOutlineInPlace(output, {
      items: outlineItems,
      openMode: "default",
      revision: "merged",
    }, { preserveSources });

    return {
      document: this.store(await output.save()),
      removedTargets,
    };
  }

  async stampText(
    document: PdfDocumentHandle,
    options: PdfStampTextOptions,
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    await stampTextInPlace(output, options);

    return this.store(await output.save());
  }

  /**
   * The local pdf-lib backend cannot guarantee true content removal for arbitrary
   * rectangles. Drawing black boxes would leave text/images extractable, so area
   * redaction is reserved for the desktop sidecar engine.
   */
  async redactAreas(
    _document: PdfDocumentHandle,
    _areas: readonly PdfRedactionArea[],
  ): Promise<PdfDocumentHandle> {
    throw unsupportedTrueRedaction();
  }

  /**
   * The local pdf-lib backend has no safe content-stream text removal pipeline.
   * Returning overlay-only output would be a security bug, so term redaction is
   * reserved for the desktop sidecar engine.
   */
  async redactText(
    _document: PdfDocumentHandle,
    _options: PdfRedactTextOptions,
  ): Promise<PdfDocumentHandle> {
    throw unsupportedTrueRedaction();
  }

  async scrubMetadata(document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    scrubPdfMetadataInPlace(output);

    return this.store(await output.save());
  }

  async extractTextRegions(
    _document: PdfDocumentHandle,
    _areas: readonly PdfRedactionArea[],
  ): Promise<readonly PdfTextRegion[]> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Region text extraction is unavailable in the local engine; verify redaction output with pdf.js.",
    );
  }

  async batesStamp(
    document: PdfDocumentHandle,
    options: PdfBatesStampOptions,
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    const normalizedOptions = normalizeBatesOptions(options);
    const pageCount = output.getPageCount();
    assertBatesFitsPageCount(normalizedOptions, pageCount);

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const stampOptions: PdfStampTextOptions = {
        text: formatBatesNumber(normalizedOptions, pageIndex),
        pageIndexes: [pageIndex],
        placement: normalizedOptions.placement,
      };

      if (normalizedOptions.fontSizePt !== undefined) {
        stampOptions.fontSizePt = normalizedOptions.fontSizePt;
      }

      if (normalizedOptions.marginIn !== undefined) {
        stampOptions.marginIn = normalizedOptions.marginIn;
      }

      await stampTextInPlace(output, stampOptions);
    }

    return this.store(await output.save());
  }

  async pageNumbers(
    document: PdfDocumentHandle,
    options: PdfPageNumbersOptions,
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    const normalizedOptions = normalizePageNumbersOptions(options);
    const pageCount = output.getPageCount();
    const pageIndexes = resolvePageSelection(normalizedOptions.pageIndexes, pageCount);

    for (const [offset, pageIndex] of pageIndexes.entries()) {
      const pageNumber = normalizedOptions.startAt + offset;
      await stampTextInPlace(output, {
        text: normalizedOptions.format === "page-of-total"
          ? `Page ${pageNumber} of ${pageCount}`
          : String(pageNumber),
        pageIndexes: [pageIndex],
        placement: normalizedOptions.placement,
        fontSizePt: normalizedOptions.fontSizePt,
        marginIn: normalizedOptions.marginIn,
      });
    }

    return this.store(await output.save());
  }

  async watermark(
    document: PdfDocumentHandle,
    options: PdfWatermarkOptions,
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    const normalizedOptions = normalizeWatermarkOptions(options);
    const pageIndexes = resolvePageSelection(normalizedOptions.pageIndexes, output.getPageCount());
    const font = await output.embedFont(StandardFonts.HelveticaBold);

    for (const pageIndex of pageIndexes) {
      drawWatermarkText(output.getPage(pageIndex), font, normalizedOptions);
    }

    return this.store(await output.save());
  }

  async insertImagePages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    images: readonly PdfImagePageInput[],
  ): Promise<PdfOutlineWriteResult> {
    if (images.length === 0) {
      throw new PdfEngineError("EMPTY_INPUT", "At least one image is required.");
    }

    const source = await this.load(document);
    const sourcePageCount = source.getPageCount();
    assertInsertIndex(insertAtPageIndex, sourcePageCount);

    const output = await PDFDocument.create();
    await copyPagesInto(output, source, source.getPageIndices().slice(0, insertAtPageIndex));

    for (const imageInput of images) {
      const image = await embedImagePage(output, imageInput);
      const page = output.addPage([image.width, image.height]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
    }

    await copyPagesInto(output, source, source.getPageIndices().slice(insertAtPageIndex));

    const outline = readPdfOutline(source);
    const mapped = mapPdfOutlineItems(outline.items, (pageIndex) =>
      pageIndex < insertAtPageIndex ? pageIndex : pageIndex + images.length);
    writePdfOutlineInPlace(output, { ...outline, items: mapped.items }, { preserveSource: source });

    return {
      document: this.store(await output.save()),
      removedTargets: mapped.removedTargets,
    };
  }

  async getOutline(document: PdfDocumentHandle): Promise<PdfOutlineState> {
    return readPdfOutline(await this.load(document));
  }

  async replaceOutline(
    document: PdfDocumentHandle,
    outline: PdfOutlineState,
  ): Promise<PdfOutlineWriteResult> {
    const output = await this.load(document);
    writePdfOutlineInPlace(output, outline, { preserveSource: output });

    return {
      document: this.store(await output.save()),
      removedTargets: 0,
    };
  }

  async buildBinder(
    main: PdfDocumentHandle,
    exhibits: readonly PdfBinderExhibit[],
    options: PdfBinderOptions,
  ): Promise<PdfDocumentHandle> {
    const mainPdf = await this.load(main);
    const loadedExhibits: Array<PdfBinderExhibit & { pdf: PDFDocument }> = [];
    for (const exhibit of exhibits) {
      assertNonEmptyText(exhibit.label);
      loadedExhibits.push({
        ...exhibit,
        pdf: await this.load(exhibit.doc),
      });
    }

    const output = await PDFDocument.create();
    const outputOutlineItems: PdfOutlineItem[] = [];
    const preserveSources: Array<{ pdf: PDFDocument; idPrefix?: string | undefined }> = [
      { pdf: mainPdf, idPrefix: "main:" },
    ];
    const indexOptions = normalizeBinderIndexOptions(options);

    await copyPagesInto(output, mainPdf, mainPdf.getPageIndices());
    const mainOutline = prefixPdfOutlineItemIds(readPdfOutline(mainPdf).items, "main:");
    outputOutlineItems.push(createPdfOutlinePageItem({
      id: "binder:main",
      title: "Main document",
      pageIndex: 0,
      expanded: true,
      children: mainOutline,
    }));

    const mainFirstPage = output.getPage(0);
    const slipSheetSize: [number, number] = [mainFirstPage.getWidth(), mainFirstPage.getHeight()];
    const stampOptions = normalizeBinderStampOptions(options);
    const coverStyle = options.coverStyle ?? "minimal";
    const stampFont = await output.embedFont(StandardFonts.Helvetica);
    const stampBoldFont = coverStyle === "minimal"
      ? stampFont
      : await output.embedFont(StandardFonts.HelveticaBold);

    if (indexOptions.enabled) {
      const indexLayout = await createStableExhibitIndex({
        pageSize: slipSheetSize,
        mainPageCount: mainPdf.getPageCount(),
        slipSheets: options.slipSheets,
        includeSourceFileName: indexOptions.includeSourceFileName,
        exhibits: loadedExhibits.map((exhibit) => ({
          label: exhibit.label,
          pageCount: exhibit.pdf.getPageCount(),
          description: exhibit.description,
          sourceFileName: exhibit.sourceFileName,
        })),
      });
      const indexPdf = await loadPdf(indexLayout.bytes);

      outputOutlineItems.push(createPdfOutlinePageItem({
        id: "binder:index",
        title: "Exhibit Index",
        pageIndex: output.getPageCount(),
      }));
      await copyPagesInto(output, indexPdf, indexPdf.getPageIndices());
    }

    for (const [exhibitIndex, exhibit] of loadedExhibits.entries()) {
      const exhibitPdf = exhibit.pdf;
      const sectionStartPageIndex = output.getPageCount();

      if (options.slipSheets) {
        const slipSheet = output.addPage(slipSheetSize);
        drawCoverPage(slipSheet, { regular: stampFont, bold: stampBoldFont }, {
          label: exhibit.label,
          description: exhibit.description,
          style: coverStyle,
        });
      }

      const exhibitPageStartIndex = output.getPageCount();
      const copiedPages = await output.copyPages(exhibitPdf, exhibitPdf.getPageIndices());
      const selectedExhibitPages = new Set(
        resolvePageSelection(stampOptions.pageIndexes, exhibitPdf.getPageCount()),
      );

      copiedPages.forEach((page, pageIndex) => {
        output.addPage(page);

        if (selectedExhibitPages.has(pageIndex)) {
          drawStampText(output.getPage(exhibitPageStartIndex + pageIndex), stampFont, {
            ...stampOptions,
            text: exhibit.label,
          });
        }
      });

      const prefix = `exhibit:${exhibitIndex}:`;
      preserveSources.push({ pdf: exhibitPdf, idPrefix: prefix });
      const mappedExhibitOutline = offsetPdfOutlineItems(
        readPdfOutline(exhibitPdf).items,
        exhibitPageStartIndex,
      );
      outputOutlineItems.push(createPdfOutlinePageItem({
        id: `${prefix}root`,
        title: exhibit.label,
        pageIndex: sectionStartPageIndex,
        expanded: true,
        children: prefixPdfOutlineItemIds(mappedExhibitOutline.items, prefix),
      }));
    }

    writePdfOutlineInPlace(output, {
      items: outputOutlineItems,
      openMode: "outlines",
      revision: "binder",
    }, { preserveSources });

    return this.store(await output.save());
  }

  /**
   * Applies add-content edits with pdf-lib.
   *
   * Comments become real `/Annots` `/Text` annotations so they stay live in
   * other viewers. Supported markup edits default to RaioPDF-owned annotations
   * with appearance streams; callers can still request baked page content with
   * `markupMode: "baked"`. Images and signatures are drawn content. Text,
   * image, and signature placement is rotation-aware: content renders upright
   * to the viewer on pages rotated 90/180/270 degrees, reusing the stamp
   * rotation mapping.
   */
  async applyEdits(
    document: PdfDocumentHandle,
    edits: readonly PdfEdit[],
    options: PdfApplyEditsOptions = {},
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    const pageCount = output.getPageCount();
    const markupMode = options.markupMode ?? "annotation";
    const markupAnnotationOptions: MarkupAnnotationOptions = {
      print: options.printMarkupAnnotations ?? true,
    };

    for (const edit of edits) {
      assertValidEdit(edit, pageCount);
    }

    const textBoxFonts = new Map<TextBoxFontKey, PDFFont>();
    const resolveTextBoxFont: TextBoxFontResolver = async (edit) => {
      const key = textBoxFontKey(edit);
      let font = textBoxFonts.get(key);

      if (!font) {
        font = await output.embedFont(TEXT_BOX_STANDARD_FONTS[key]);
        textBoxFonts.set(key, font);
      }

      return font;
    };

    for (const edit of edits) {
      await applyEditInPlace(output, edit, resolveTextBoxFont, markupMode, markupAnnotationOptions);
    }

    return this.store(await output.save());
  }

  async readRaioPdfAnnotations(
    document: PdfDocumentHandle,
  ): Promise<readonly PdfRaioAnnotationImport[]> {
    const pdf = await this.load(document);

    return readRaioPdfAnnotationImports(pdf);
  }

  async updateAnnotationById(
    document: PdfDocumentHandle,
    annotId: string,
    edit: PdfRaioAnnotationEdit,
    options: PdfUpdateAnnotationOptions = {},
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);

    assertValidAnnotationId(annotId);
    assertValidEdit(edit, output.getPageCount());

    // Slice 1 can remove+re-emit self-contained kinds, but this moves the
    // annotation to the end of /Annots and drops references like Popup/IRT.
    // Later threaded/foreign annotation slices need true in-place mutation.
    if (!removeAnnotationByIdInPlace(output, annotId)) {
      throw new PdfEngineError("INVALID_DOCUMENT", `RaioPDF annotation "${annotId}" was not found.`);
    }

    const textBoxFonts = new Map<TextBoxFontKey, PDFFont>();
    const resolveTextBoxFont: TextBoxFontResolver = async (textEdit) => {
      const key = textBoxFontKey(textEdit);
      let font = textBoxFonts.get(key);

      if (!font) {
        font = await output.embedFont(TEXT_BOX_STANDARD_FONTS[key]);
        textBoxFonts.set(key, font);
      }

      return font;
    };

    await applyRaioAnnotationEditInPlace(output, { ...edit, annotId }, resolveTextBoxFont, {
      print: options.printMarkupAnnotations ?? true,
    });

    return this.store(await output.save());
  }

  async deleteAnnotationById(
    document: PdfDocumentHandle,
    annotId: string,
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);

    assertValidAnnotationId(annotId);

    if (!removeAnnotationByIdInPlace(output, annotId)) {
      throw new PdfEngineError("INVALID_DOCUMENT", `RaioPDF annotation "${annotId}" was not found.`);
    }

    return this.store(await output.save());
  }

  /**
   * Flattens AcroForm fields with pdf-lib's `form.flatten()`: current field
   * appearances are painted into page content and the interactive fields are
   * removed. A document without form fields round-trips unchanged.
   */
  async flattenForm(document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    const form = output.getForm();

    if (form.getFields().length > 0) {
      try {
        form.flatten();
      } catch (error) {
        throw new PdfEngineError("INVALID_DOCUMENT", "Form fields could not be flattened.", {
          cause: error,
        });
      }
    }

    return this.store(await output.save());
  }

  async flattenMarkupAnnotations(document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    const output = await this.load(document);

    flattenMarkupAnnotationsInPlace(output);

    return this.store(await output.save());
  }

  async saveToBytes(document: PdfDocumentHandle): Promise<Uint8Array> {
    return new Uint8Array(this.get(document).bytes);
  }

  private async load(document: PdfDocumentHandle): Promise<PDFDocument> {
    return loadPdf(this.get(document).bytes);
  }

  private get(document: PdfDocumentHandle): StoredDocument {
    const storedDocument = this.documents.get(document);

    if (!storedDocument) {
      throw new PdfEngineError("DOCUMENT_NOT_FOUND", "Document handle was not found.");
    }

    return storedDocument;
  }

  private store(bytes: Uint8Array): PdfDocumentHandle {
    const handle = `local-pdf:${this.nextDocumentId}` as PdfDocumentHandle;
    this.nextDocumentId += 1;
    this.documents.set(handle, { bytes: new Uint8Array(bytes) });

    return handle;
  }
}

export function createLocalPdfEngine(): PdfEngine {
  return new LocalPdfEngine();
}

function createRaioPdfAnnotationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;

  if (randomUUID) {
    return randomUUID.call(globalThis.crypto);
  }

  return `raiopdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function stampRaioPdfAnnotation(
  annotation: PDFDict,
  sourceEdit?: PdfRaioAnnotationEdit,
  annotId = sourceEdit?.annotId ?? createRaioPdfAnnotationId(),
): string {
  annotation.set(
    RAIOPDF_ANNOTATION_MARKER,
    annotation.context.obj({
      Version: RAIOPDF_ANNOTATION_MARKER_VERSION,
      Kind: PDFName.of("Markup"),
      Id: PDFString.of(annotId),
      ...(sourceEdit ? { SourceEdit: PDFString.of(JSON.stringify(sourceEdit)) } : {}),
    }),
  );
  annotation.set(PDFName.of("NM"), PDFString.of(annotId));

  return annotId;
}

export function readRaioPdfMarkupAnnotations(
  page: ReturnType<PDFDocument["getPage"]>,
): RaioPdfMarkupAnnotation[] {
  return readAnnotationEntries(page).filter((entry) => isRaioPdfMarkupAnnotation(entry.dict));
}

/**
 * Builds a viewer-only copy whose re-importable RaioPDF annotations are hidden
 * from pdf.js canvas rendering. The source bytes are not mutated; the engine
 * should keep using the original annotations for update/delete/save.
 */
export async function hideRaioPdfImportedAnnotationsForDisplay(
  bytes: PdfBytes,
): Promise<Uint8Array> {
  const normalizedBytes = normalizeBytes(bytes);
  const pdf = await loadPdf(normalizedBytes);
  let changed = false;

  pdf.getPages().forEach((page, pageIndex) => {
    for (const entry of readAnnotationEntries(page)) {
      if (!readRaioPdfAnnotationImport(entry.dict, pageIndex)) {
        continue;
      }

      const flags = entry.dict.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0;
      const hiddenFlags = flags | ANNOTATION_FLAG_HIDDEN;

      if (hiddenFlags !== flags) {
        entry.dict.set(PDFName.of("F"), PDFNumber.of(hiddenFlags));
        changed = true;
      }
    }
  });

  return changed ? pdf.save() : normalizedBytes;
}

function readRaioPdfAnnotationImports(pdf: PDFDocument): PdfRaioAnnotationImport[] {
  const imports: PdfRaioAnnotationImport[] = [];

  pdf.getPages().forEach((page, pageIndex) => {
    for (const entry of readAnnotationEntries(page)) {
      const imported = readRaioPdfAnnotationImport(entry.dict, pageIndex);

      if (imported) {
        imports.push(imported);
      }
    }
  });

  return imports;
}

function readRaioPdfAnnotationImport(
  annotation: PDFDict,
  pageIndex: number,
): PdfRaioAnnotationImport | null {
  const marker = annotation.lookupMaybe(RAIOPDF_ANNOTATION_MARKER, PDFDict);
  const version = marker?.lookupMaybe(PDFName.of("Version"), PDFNumber)?.asNumber();

  if (!marker || version !== RAIOPDF_ANNOTATION_MARKER_VERSION) {
    return null;
  }

  const kind = readPdfTextObject(marker.get(PDFName.of("Kind")));
  const subtype = readAnnotationSubtype(annotation);

  if (
    kind !== "Markup" ||
    !subtype ||
    !Object.values(RAIO_ROUNDTRIP_SUBTYPE_BY_KIND).includes(subtype)
  ) {
    return null;
  }

  const annotId = readAnnotationId(annotation);
  const sourceEditText = readPdfText(
    marker.lookupMaybe(PDFName.of("SourceEdit"), PDFString, PDFHexString),
  );

  if (!annotId || !sourceEditText) {
    return null;
  }

  const edit = parseRaioPdfSourceEdit(sourceEditText);

  if (!edit || RAIO_ROUNDTRIP_SUBTYPE_BY_KIND[edit.type] !== subtype) {
    return null;
  }

  return {
    pageIndex,
    annotId,
    edit: { ...edit, pageIndex, annotId },
  };
}

function parseRaioPdfSourceEdit(sourceEditText: string): PdfRaioAnnotationEdit | null {
  try {
    const parsed = JSON.parse(sourceEditText) as unknown;

    if (!isRaioAnnotationEdit(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function flattenMarkupAnnotationsInPlace(pdf: PDFDocument): void {
  for (const page of pdf.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

    if (!annotations) {
      continue;
    }

    for (let index = annotations.size() - 1; index >= 0; index -= 1) {
      const entry = readAnnotationEntryAt(page, annotations, index);

      if (!entry || !isRaioPdfMarkupAnnotation(entry.dict)) {
        continue;
      }

      if (drawAnnotationAppearanceOnPage(page, entry.dict)) {
        annotations.remove(index);
      }
    }

    if (annotations.size() === 0) {
      page.node.delete(PDFName.of("Annots"));
    }
  }
}

function readAnnotationEntries(page: ReturnType<PDFDocument["getPage"]>): RaioPdfMarkupAnnotation[] {
  const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

  if (!annotations) {
    return [];
  }

  const entries: RaioPdfMarkupAnnotation[] = [];

  for (let index = 0; index < annotations.size(); index += 1) {
    const entry = readAnnotationEntryAt(page, annotations, index);

    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function readAnnotationEntryAt(
  page: ReturnType<PDFDocument["getPage"]>,
  annotations: PDFArray,
  index: number,
): RaioPdfMarkupAnnotation | undefined {
  const object = annotations.get(index);
  const dict = object instanceof PDFRef ? page.doc.context.lookupMaybe(object, PDFDict) : object;

  if (!(dict instanceof PDFDict)) {
    return undefined;
  }

  const subtype = readAnnotationSubtype(dict);

  if (!subtype) {
    return undefined;
  }

  return {
    dict,
    ref: object instanceof PDFRef ? object : undefined,
    subtype,
  };
}

function isRaioPdfMarkupAnnotation(annotation: PDFDict): boolean {
  const marker = annotation.lookupMaybe(RAIOPDF_ANNOTATION_MARKER, PDFDict);
  const version = marker?.lookupMaybe(PDFName.of("Version"), PDFNumber)?.asNumber();
  const kind = marker ? readPdfTextObject(marker.get(PDFName.of("Kind"))) : undefined;
  const subtype = readAnnotationSubtype(annotation);

  return (
    (version === 1 || version === RAIOPDF_ANNOTATION_MARKER_VERSION) &&
    kind === "Markup" &&
    subtype !== undefined &&
    RAIOPDF_MARKUP_ANNOTATION_SUBTYPES.has(subtype)
  );
}

function removeAnnotationByIdInPlace(pdf: PDFDocument, annotId: string): boolean {
  let removed = false;

  for (const page of pdf.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

    if (!annotations) {
      continue;
    }

    for (let index = annotations.size() - 1; index >= 0; index -= 1) {
      const entry = readAnnotationEntryAt(page, annotations, index);

      if (!entry || readAnnotationId(entry.dict) !== annotId) {
        continue;
      }

      annotations.remove(index);
      removed = true;
    }

    if (annotations.size() === 0) {
      page.node.delete(PDFName.of("Annots"));
    }
  }

  return removed;
}

function readAnnotationId(annotation: PDFDict): string | null {
  const marker = annotation.lookupMaybe(RAIOPDF_ANNOTATION_MARKER, PDFDict);
  const markerId = readPdfText(marker?.lookupMaybe(PDFName.of("Id"), PDFString, PDFHexString));
  const nm = readPdfText(annotation.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString));

  return markerId || nm || null;
}

function readPdfText(
  value: PDFName | PDFString | PDFHexString | undefined,
): string | undefined {
  return value?.decodeText();
}

function readPdfTextObject(value: unknown): string | undefined {
  if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }

  return undefined;
}

function isRaioAnnotationEdit(value: unknown): value is PdfRaioAnnotationEdit {
  if (!value || typeof value !== "object") {
    return false;
  }

  const edit = value as Record<string, unknown>;

  switch (edit.type) {
    case "highlight":
      return typeof edit.pageIndex === "number" && Array.isArray(edit.rects);
    case "underline":
    case "strikethrough":
      return typeof edit.pageIndex === "number" && Array.isArray(edit.rects);
    case "textBox":
      return typeof edit.pageIndex === "number" &&
        isEditRectLike(edit.rect) &&
        typeof edit.text === "string";
    case "comment":
      return typeof edit.pageIndex === "number" &&
        isEditPointLike(edit.at) &&
        typeof edit.text === "string";
    default:
      return false;
  }
}

function isEditRectLike(value: unknown): value is PdfEditRect {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as PdfEditRect).x === "number" &&
      typeof (value as PdfEditRect).y === "number" &&
      typeof (value as PdfEditRect).w === "number" &&
      typeof (value as PdfEditRect).h === "number",
  );
}

function isEditPointLike(value: unknown): value is PdfEditPoint {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as PdfEditPoint).x === "number" &&
      typeof (value as PdfEditPoint).y === "number",
  );
}

function readAnnotationSubtype(annotation: PDFDict): string | undefined {
  return annotation.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
}

export function defaultExhibitDescription(
  sourceFileName: string | undefined,
  fallback: string,
): string {
  if (!sourceFileName) {
    return fallback;
  }

  const fileName = sourceFileName.split(/[\\/]/).pop() ?? sourceFileName;
  const withoutExtension = fileName.replace(/\.[^.]+$/u, "").trim();

  return withoutExtension || fallback;
}

export function planExhibitIndexEntries(options: {
  mainPageCount: number;
  indexPageCount: number;
  slipSheets: boolean;
  exhibits: readonly ExhibitBinderIndexExhibit[];
}): ExhibitIndexEntry[] {
  assertNonNegativeInteger(options.mainPageCount, "mainPageCount");
  assertNonNegativeInteger(options.indexPageCount, "indexPageCount");

  let nextBinderPage = options.mainPageCount + options.indexPageCount + 1;

  return options.exhibits.map((exhibit) => {
    assertNonEmptyText(exhibit.label);
    assertNonNegativeInteger(exhibit.pageCount, "pageCount");

    const sectionPageCount = exhibit.pageCount + (options.slipSheets ? 1 : 0);
    const binderPageStart = nextBinderPage;
    const binderPageEnd = binderPageStart + sectionPageCount - 1;
    nextBinderPage = binderPageEnd + 1;

    const explicitDescription = exhibit.description?.trim();
    const descriptionGeneratedFromSourceFileName =
      (!explicitDescription || explicitDescription.length === 0) && Boolean(exhibit.sourceFileName);
    const description = explicitDescription ||
      defaultExhibitDescription(exhibit.sourceFileName, exhibit.label);

    return {
      label: exhibit.label,
      pageCount: exhibit.pageCount,
      description,
      descriptionGeneratedFromSourceFileName,
      sourceFileName: exhibit.sourceFileName,
      binderPageStart,
      binderPageEnd,
      pageRange: formatBinderPageRange(binderPageStart, binderPageEnd),
    };
  });
}

export async function createStableExhibitIndex(
  input: ExhibitIndexLayoutInput,
): Promise<ExhibitIndexLayoutResult> {
  const maxIterations = input.maxIterations ?? EXHIBIT_INDEX_MAX_ITERATIONS;

  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "maxIterations must be a positive integer.");
  }

  let indexPageCount = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const entries = planExhibitIndexEntries({
      mainPageCount: input.mainPageCount,
      indexPageCount,
      slipSheets: input.slipSheets,
      exhibits: input.exhibits,
    });
    const rendered = await renderExhibitIndex({
      pageSize: input.pageSize,
      entries,
      includeSourceFileName: input.includeSourceFileName ?? DEFAULT_BINDER_INDEX_SOURCE_FILENAME,
    });

    if (rendered.pageCount === indexPageCount) {
      return {
        bytes: rendered.bytes,
        pageCount: rendered.pageCount,
        entries,
        iterations: iteration,
      };
    }

    indexPageCount = rendered.pageCount;
  }

  throw new PdfEngineError(
    "INVALID_DOCUMENT",
    `Exhibit index pagination did not stabilize within ${maxIterations} iterations.`,
  );
}

async function copyPagesInto(
  output: PDFDocument,
  source: PDFDocument,
  pageIndexes: readonly number[],
): Promise<void> {
  const copiedPages = await output.copyPages(source, [...pageIndexes]);
  for (const page of copiedPages) {
    output.addPage(page);
  }
}

interface SplitPart {
  bytes: Uint8Array;
  pageIndexes: number[];
  oversized: boolean;
}

/**
 * Packs the largest page prefix starting at `start` whose serialized document
 * fits `maxBytes`.
 *
 * The previous implementation re-serialized the growing part for every
 * candidate page, making splitByMaxBytes O(n^2) in page count. This version
 * serializes O(log n) probe documents per part instead: probe a candidate
 * prefix, estimate the marginal per-page cost from the two most recent
 * fitting probes, jump close to the cap, and binary-search the boundary only
 * when a probe overshoots. Serialized size is treated as monotone in page
 * count (adding a page never shrinks the document) -- the same assumption the
 * old greedy page-by-page scan relied on, so the resulting parts (including
 * the single-page `oversized` behavior) are unchanged.
 */
async function packSplitPart(
  source: PDFDocument,
  pageIndices: readonly number[],
  start: number,
  maxBytes: number,
  initialGuess: number,
): Promise<SplitPart> {
  const remaining = pageIndices.length - start;
  const pagesFor = (count: number): number[] => pageIndices.slice(start, start + count);

  let fit: { count: number; bytes: Uint8Array } | null = null;
  let previousFit: { count: number; byteLength: number } | null = null;
  let overflowCount: number | null = null;
  let candidate = clampSplitCandidate(initialGuess, 1, remaining);

  for (;;) {
    const bytes = await createDocumentBytesForPages(source, pagesFor(candidate));

    if (bytes.byteLength > maxBytes) {
      if (candidate === 1) {
        // A lone page that exceeds the cap ships as its own oversized part,
        // exactly like the old per-page scan did.
        return { bytes, pageIndexes: pagesFor(1), oversized: true };
      }

      overflowCount = candidate;
    } else {
      previousFit = fit ? { count: fit.count, byteLength: fit.bytes.byteLength } : null;
      fit = { count: candidate, bytes };

      if (candidate === remaining) {
        break;
      }
    }

    if (fit && overflowCount !== null && fit.count + 1 >= overflowCount) {
      // Boundary confirmed: `fit.count` pages fit, one more page does not.
      break;
    }

    if (fit === null) {
      // Every probe so far overshot; halve toward the single-page floor.
      candidate = clampSplitCandidate(Math.floor(candidate / 2), 1, remaining);
    } else if (overflowCount !== null) {
      // Overshoot recorded: binary-search the boundary in (fit, overflow).
      candidate = Math.floor((fit.count + overflowCount) / 2);
    } else {
      candidate = nextSplitGrowthCandidate(fit, previousFit, maxBytes, remaining);
    }
  }

  if (!fit) {
    // Unreachable: every exit path above either returns or records a fit.
    throw new PdfEngineError("INVALID_DOCUMENT", "Split packing failed to find a fitting part.");
  }

  return { bytes: fit.bytes, pageIndexes: pagesFor(fit.count), oversized: false };
}

function nextSplitGrowthCandidate(
  fit: { count: number; bytes: Uint8Array },
  previousFit: { count: number; byteLength: number } | null,
  maxBytes: number,
  remaining: number,
): number {
  const fitLength = fit.bytes.byteLength;
  // Marginal per-page cost from the last two fitting probes when available;
  // otherwise the (conservative) average, which includes document overhead.
  const marginalPerPage = previousFit && fit.count > previousFit.count
    ? (fitLength - previousFit.byteLength) / (fit.count - previousFit.count)
    : fitLength / fit.count;
  const safePerPage = Math.max(1, marginalPerPage);
  // Aim ~10% short of the cap so a slightly-low estimate lands on another
  // fitting probe (refining the estimate) rather than an overshoot.
  const estimatedAdditional = Math.floor(((maxBytes - fitLength) / safePerPage) * 0.9);

  return clampSplitCandidate(fit.count + estimatedAdditional, fit.count + 1, remaining);
}

function clampSplitCandidate(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function createDocumentBytesForPages(
  source: PDFDocument,
  pageIndexes: readonly number[],
): Promise<Uint8Array> {
  if (pageIndexes.length === 0) {
    throw new PdfEngineError("EMPTY_RESULT", "Split parts must contain at least one page.");
  }

  const output = await PDFDocument.create();
  await copyPagesInto(output, source, pageIndexes);

  return output.save();
}

function computeNormalizeDrawOptions(options: {
  sourceWidth: number;
  sourceHeight: number;
  sourceRotation: PageRotation;
  targetWidth: number;
  targetHeight: number;
}): { x: number; y: number; width: number; height: number; rotate: PageRotation } {
  const visualWidth = isSidewaysRotation(options.sourceRotation)
    ? options.sourceHeight
    : options.sourceWidth;
  const visualHeight = isSidewaysRotation(options.sourceRotation)
    ? options.sourceWidth
    : options.sourceHeight;
  const layoutRotation = visualWidth > visualHeight ? 90 : 0;
  const rotate = normalizePageRotation(360 - options.sourceRotation + layoutRotation);
  const normalizedVisualWidth = layoutRotation === 90 ? visualHeight : visualWidth;
  const normalizedVisualHeight = layoutRotation === 90 ? visualWidth : visualHeight;
  const scale = Math.min(
    options.targetWidth / normalizedVisualWidth,
    options.targetHeight / normalizedVisualHeight,
  );
  const width = options.sourceWidth * scale;
  const height = options.sourceHeight * scale;
  const bounds = rotatedRectBounds(width, height, rotate);
  const left = (options.targetWidth - bounds.width) / 2;
  const bottom = (options.targetHeight - bounds.height) / 2;

  return {
    x: left - bounds.minX,
    y: bottom - bounds.minY,
    width,
    height,
    rotate,
  };
}

function rotatedRectBounds(
  width: number,
  height: number,
  rotation: PageRotation,
): { minX: number; minY: number; width: number; height: number } {
  const corners = [
    rotatePoint(0, 0, rotation),
    rotatePoint(width, 0, rotation),
    rotatePoint(0, height, rotation),
    rotatePoint(width, height, rotation),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return {
    minX,
    minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

function rotatePoint(x: number, y: number, rotation: PageRotation): { x: number; y: number } {
  switch (rotation) {
    case 0:
      return { x, y };
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
  }
}

async function stampTextInPlace(
  pdf: PDFDocument,
  options: PdfStampTextOptions,
): Promise<void> {
  const normalizedOptions = normalizeStampOptions(options);
  const pageIndexes = resolvePageSelection(normalizedOptions.pageIndexes, pdf.getPageCount());
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const pageIndex of pageIndexes) {
    drawStampText(pdf.getPage(pageIndex), font, normalizedOptions);
  }
}

function drawStampText(
  page: ReturnType<PDFDocument["getPage"]>,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  options: Required<PdfStampTextOptions>,
): void {
  const marginPt = options.marginIn * POINTS_PER_INCH;
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const visualWidth = isSidewaysRotation(pageRotation) ? page.getHeight() : page.getWidth();
  const maxTextWidth = visualWidth - (2 * marginPt);
  const fontSizePt = fitFontSizeToWidth(
    font.widthOfTextAtSize(options.text, options.fontSizePt),
    options.fontSizePt,
    maxTextWidth,
  );
  const textWidth = font.widthOfTextAtSize(options.text, fontSizePt);
  const { x, y } = computeStampPosition({
    pageWidth: page.getWidth(),
    pageHeight: page.getHeight(),
    textWidth,
    fontSize: fontSizePt,
    marginPt,
    placement: options.placement,
    pageRotation,
  });

  page.drawText(options.text, {
    x,
    y,
    size: fontSizePt,
    font,
    color: STAMP_COLOR,
    rotate: pdfDegrees(pageRotation),
  });
}

function drawWatermarkText(
  page: ReturnType<PDFDocument["getPage"]>,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  options: Required<PdfWatermarkOptions>,
): void {
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const visualWidth = isSidewaysRotation(pageRotation) ? page.getHeight() : page.getWidth();
  const visualHeight = isSidewaysRotation(pageRotation) ? page.getWidth() : page.getHeight();
  const relativeRotation = options.orientation === "diagonal" ? 45 : 0;
  const baseTextWidth = font.widthOfTextAtSize(options.text, options.fontSizePt);
  const baseBounds = rotatedTextBounds(baseTextWidth, options.fontSizePt, relativeRotation);
  const fitScale = Math.min(
    1,
    visualWidth / baseBounds.width,
    visualHeight / baseBounds.height,
  );
  const fontSizePt = options.fontSizePt * fitScale;
  const textWidth = font.widthOfTextAtSize(options.text, fontSizePt);
  const bounds = rotatedTextBounds(textWidth, fontSizePt, relativeRotation);
  const anchor = mapVisualPointToPagePoint({
    visualX: (visualWidth - bounds.width) / 2 - bounds.minX,
    visualY: (visualHeight - bounds.height) / 2 - bounds.minY,
    pageWidth: page.getWidth(),
    pageHeight: page.getHeight(),
    pageRotation,
  });
  const rotation = normalizeRotation(pageRotation + relativeRotation);

  page.drawText(options.text, {
    x: anchor.x,
    y: anchor.y,
    size: fontSizePt,
    font,
    color: rgb(0.35, 0.35, 0.35),
    opacity: options.opacity,
    rotate: pdfDegrees(rotation),
  });
}

function fitFontSizeToWidth(textWidth: number, fontSize: number, maxTextWidth: number): number {
  if (maxTextWidth <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Stamp margin leaves no room for text.");
  }

  if (textWidth <= maxTextWidth) {
    return fontSize;
  }

  return fontSize * (maxTextWidth / textWidth);
}

function rotatedTextBounds(
  textWidth: number,
  fontSize: number,
  rotation: number,
): { minX: number; minY: number; width: number; height: number } {
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = [
    { x: 0, y: 0 },
    { x: textWidth * cos, y: textWidth * sin },
    { x: -fontSize * sin, y: fontSize * cos },
    {
      x: textWidth * cos - fontSize * sin,
      y: textWidth * sin + fontSize * cos,
    },
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function computeStampPosition(options: {
  pageWidth: number;
  pageHeight: number;
  textWidth: number;
  fontSize: number;
  marginPt: number;
  placement: PdfStampPlacement;
  pageRotation: PageRotation;
}): { x: number; y: number } {
  const visualWidth = isSidewaysRotation(options.pageRotation)
    ? options.pageHeight
    : options.pageWidth;
  const visualHeight = isSidewaysRotation(options.pageRotation)
    ? options.pageWidth
    : options.pageHeight;
  const visualX = computeStampX(
    visualWidth,
    options.textWidth,
    options.marginPt,
    options.placement.align,
  );
  const visualY =
    options.placement.edge === "header"
      ? visualHeight - options.marginPt - options.fontSize
      : options.marginPt;

  return mapVisualPointToPagePoint({
    visualX,
    visualY,
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    pageRotation: options.pageRotation,
  });
}

function isSidewaysRotation(pageRotation: PageRotation): boolean {
  return pageRotation === 90 || pageRotation === 270;
}

function mapVisualPointToPagePoint(options: {
  visualX: number;
  visualY: number;
  pageWidth: number;
  pageHeight: number;
  pageRotation: PageRotation;
}): { x: number; y: number } {
  switch (options.pageRotation) {
    case 0:
      return { x: options.visualX, y: options.visualY };
    case 90:
      return { x: options.pageWidth - options.visualY, y: options.visualX };
    case 180:
      return { x: options.pageWidth - options.visualX, y: options.pageHeight - options.visualY };
    case 270:
      return { x: options.visualY, y: options.pageHeight - options.visualX };
  }
}

/**
 * Inverse of `mapVisualPointToPagePoint`: maps a PDF user-space point into
 * the upright "visual" space a viewer sees after applying the page rotation.
 */
function mapPagePointToVisualPoint(options: {
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
  pageRotation: PageRotation;
}): { x: number; y: number } {
  switch (options.pageRotation) {
    case 0:
      return { x: options.pageX, y: options.pageY };
    case 90:
      return { x: options.pageY, y: options.pageWidth - options.pageX };
    case 180:
      return { x: options.pageWidth - options.pageX, y: options.pageHeight - options.pageY };
    case 270:
      return { x: options.pageHeight - options.pageY, y: options.pageX };
  }
}

/**
 * Maps a user-space edit rectangle to its axis-aligned bounding box in visual
 * space. On sideways pages the width/height swap; on 0-degree pages this is
 * the identity.
 */
function mapPageRectToVisualRect(
  rect: PdfEditRect,
  pageWidth: number,
  pageHeight: number,
  pageRotation: PageRotation,
): PdfEditRect {
  const corners = [
    { pageX: rect.x, pageY: rect.y },
    { pageX: rect.x + rect.w, pageY: rect.y },
    { pageX: rect.x, pageY: rect.y + rect.h },
    { pageX: rect.x + rect.w, pageY: rect.y + rect.h },
  ].map((corner) =>
    mapPagePointToVisualPoint({ ...corner, pageWidth, pageHeight, pageRotation }),
  );
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY,
  };
}

async function applyEditInPlace(
  pdf: PDFDocument,
  edit: PdfEdit,
  resolveTextBoxFont: TextBoxFontResolver,
  markupMode: MarkupMode,
  markupAnnotationOptions: MarkupAnnotationOptions,
): Promise<void> {
  switch (edit.type) {
    case "highlight":
      if (markupMode === "annotation") {
        applyHighlightAnnotationEdit(pdf, edit, markupAnnotationOptions);
      } else {
        applyHighlightEdit(pdf, edit);
      }
      return;
    case "underline":
    case "strikethrough":
      if (markupMode === "annotation") {
        applyTextMarkupAnnotationEdit(pdf, edit, markupAnnotationOptions);
      } else {
        applyTextMarkupEdit(pdf, edit);
      }
      return;
    case "textBox":
      if (markupMode === "annotation") {
        applyTextBoxAnnotationEdit(pdf, edit, await resolveTextBoxFont(edit), markupAnnotationOptions);
      } else {
        applyTextBoxEdit(pdf, edit, await resolveTextBoxFont(edit));
      }
      return;
    case "callout":
      if (markupMode === "annotation") {
        applyCalloutAnnotationEdit(pdf, edit, await resolveTextBoxFont(edit), markupAnnotationOptions);
      } else {
        applyCalloutEdit(pdf, edit, await resolveTextBoxFont(edit));
      }
      return;
    case "image":
    case "signature":
      await applyImageEdit(pdf, edit);
      return;
    case "ink":
      if (markupMode === "annotation") {
        applyInkAnnotationEdit(pdf, edit, markupAnnotationOptions);
      } else {
        applyInkEdit(pdf, edit);
      }
      return;
    case "shape":
      if (markupMode === "annotation") {
        applyShapeAnnotationEdit(pdf, edit, markupAnnotationOptions);
      } else {
        applyShapeEdit(pdf, edit);
      }
      return;
    case "comment":
      applyCommentEdit(pdf, edit);
      return;
    case "formValues":
      applyFormValuesEdit(pdf, edit);
      return;
  }
}

async function applyRaioAnnotationEditInPlace(
  pdf: PDFDocument,
  edit: PdfRaioAnnotationEdit,
  resolveTextBoxFont: TextBoxFontResolver,
  markupAnnotationOptions: MarkupAnnotationOptions,
): Promise<void> {
  switch (edit.type) {
    case "highlight":
      applyHighlightAnnotationEdit(pdf, edit, markupAnnotationOptions);
      return;
    case "underline":
    case "strikethrough":
      applyTextMarkupAnnotationEdit(pdf, edit, markupAnnotationOptions);
      return;
    case "textBox":
      applyTextBoxAnnotationEdit(
        pdf,
        edit,
        await resolveTextBoxFont(edit),
        markupAnnotationOptions,
      );
      return;
    case "comment":
      applyCommentEdit(pdf, edit);
      return;
  }
}

/**
 * Draws translucent rectangles for each highlighted line. Rectangles are
 * orientation-agnostic, so user-space coordinates are drawn verbatim with no
 * rotation compensation.
 */
function applyHighlightEdit(pdf: PDFDocument, edit: PdfHighlightEdit): void {
  const page = pdf.getPage(edit.pageIndex);
  const target = createPageDrawTarget(page);
  const color = toEditColor(edit.color, HIGHLIGHT_COLOR);
  const opacity = edit.opacity ?? DEFAULT_HIGHLIGHT_OPACITY;

  for (const rect of edit.rects) {
    target.drawRectangle({ rect, fillColor: color, fillAlpha: opacity });
  }
}

/**
 * Draws text markup using the same line rectangles highlight receives. Rects
 * are orientation-agnostic user-space coordinates and are drawn verbatim.
 */
function applyTextMarkupEdit(pdf: PDFDocument, edit: PdfTextMarkupEdit): void {
  const page = pdf.getPage(edit.pageIndex);
  const target = createPageDrawTarget(page);
  const color = toEditColor(edit.color, EDIT_INK_COLOR);
  const thickness = edit.thicknessPt ?? DEFAULT_TEXT_MARKUP_THICKNESS_PT;

  for (const rect of edit.rects) {
    const y = edit.type === "underline" ? rect.y : rect.y + rect.h * 0.5;

    target.drawLine({
      from: { x: rect.x, y },
      to: { x: rect.x + rect.w, y },
      strokeWidthPt: thickness,
      strokeColor: color,
    });
  }
}

/**
 * Draws the text block starting at the visual top-left of the edit rectangle,
 * rotated with the page so it reads upright to the viewer. The first baseline
 * sits one font-size below the rectangle's visual top edge.
 */
function applyTextBoxEdit(pdf: PDFDocument, edit: PdfTextBoxEdit, font: PDFFont): void {
  const page = pdf.getPage(edit.pageIndex);

  drawTextBoxText(pdf, edit, font, createPageDrawTarget(page));
}

function applyCalloutEdit(pdf: PDFDocument, edit: PdfCalloutEdit, font: PDFFont): void {
  const page = pdf.getPage(edit.pageIndex);
  const target = createPageDrawTarget(page);
  const thickness = edit.strokeWidthPt ?? DEFAULT_CALLOUT_STROKE_WIDTH_PT;
  const strokeColor = toEditColor(edit.strokeColor, EDIT_INK_COLOR);
  const anchor = computeCalloutLeaderAnchor(edit.rect, edit.tip);

  target.drawLine({
    from: anchor,
    to: edit.tip,
    strokeWidthPt: thickness,
    strokeColor,
  });

  if (edit.arrowhead ?? true) {
    drawArrowHead(target, anchor, edit.tip, thickness, strokeColor);
  }

  if (edit.boxFill || edit.boxBorder !== false) {
    target.drawRectangle({
      rect: edit.rect,
      ...(edit.boxFill ? { fillColor: toEditColor(edit.boxFill, EDIT_INK_COLOR) } : {}),
      ...(edit.boxBorder !== false
        ? {
            strokeColor,
            strokeWidthPt: DEFAULT_CALLOUT_BOX_BORDER_WIDTH_PT,
          }
        : {}),
    });
  }

  drawTextBoxText(pdf, edit, font, target);
}

function drawTextBoxText(
  pdf: PDFDocument,
  edit: TextRenderableEdit,
  font: PDFFont,
  target: DrawTarget,
): void {
  const page = pdf.getPage(edit.pageIndex);
  const fontSize = edit.fontSizePt ?? DEFAULT_TEXT_BOX_FONT_SIZE_PT;
  const lineHeight = fontSize * TEXT_BOX_LINE_HEIGHT_FACTOR;
  const align = edit.align ?? "left";
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const visualRect = mapPageRectToVisualRect(
    edit.rect,
    page.getWidth(),
    page.getHeight(),
    pageRotation,
  );
  const lines = wrapTextBoxLines({
    text: edit.text,
    boxWidthPt: visualRect.w,
    fontSizePt: fontSize,
    font,
  });

  if (edit.type === "textBox" && edit.backgroundColor) {
    target.drawRectangle({
      rect: edit.rect,
      fillColor: toEditColor(edit.backgroundColor, EDIT_INK_COLOR),
      fillAlpha: edit.backgroundOpacity ?? 1,
    });
  }

  lines.forEach((line, lineIndex) => {
    const lineWidth = font.widthOfTextAtSize(line, fontSize);
    const anchor = mapVisualPointToPagePoint({
      visualX: visualRect.x + computeTextBoxAlignOffset(visualRect.w, lineWidth, align),
      visualY: visualRect.y + visualRect.h - fontSize - lineIndex * lineHeight,
      pageWidth: page.getWidth(),
      pageHeight: page.getHeight(),
      pageRotation,
    });

    target.drawText({
      text: line,
      at: anchor,
      fontSizePt: fontSize,
      font,
      color: toEditColor(edit.color, EDIT_INK_COLOR),
      rotateDegrees: pageRotation,
    });
  });
}

function computeTextBoxTextRect(
  page: ReturnType<PDFDocument["getPage"]>,
  edit: TextRenderableEdit,
  font: PDFFont,
): PdfEditRect {
  const fontSize = edit.fontSizePt ?? DEFAULT_TEXT_BOX_FONT_SIZE_PT;
  const lineHeight = fontSize * TEXT_BOX_LINE_HEIGHT_FACTOR;
  const align = edit.align ?? "left";
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const visualRect = mapPageRectToVisualRect(
    edit.rect,
    page.getWidth(),
    page.getHeight(),
    pageRotation,
  );
  const lines = wrapTextBoxLines({
    text: edit.text,
    boxWidthPt: visualRect.w,
    fontSizePt: fontSize,
    font,
  });
  const lineBounds = lines.map((line, lineIndex) => {
    const lineWidth = font.widthOfTextAtSize(line, fontSize);
    const x = visualRect.x + computeTextBoxAlignOffset(visualRect.w, lineWidth, align);
    const y = visualRect.y + visualRect.h - fontSize - lineIndex * lineHeight;

    return { x, y, w: lineWidth, h: fontSize };
  });
  const visualTextRect = unionRects(lineBounds);
  const pageCorners = [
    { visualX: visualTextRect.x, visualY: visualTextRect.y },
    { visualX: visualTextRect.x + visualTextRect.w, visualY: visualTextRect.y },
    { visualX: visualTextRect.x, visualY: visualTextRect.y + visualTextRect.h },
    { visualX: visualTextRect.x + visualTextRect.w, visualY: visualTextRect.y + visualTextRect.h },
  ].map((corner) =>
    mapVisualPointToPagePoint({
      ...corner,
      pageWidth: page.getWidth(),
      pageHeight: page.getHeight(),
      pageRotation,
    }),
  );

  return boundingRectForPoints(pageCorners, 0);
}

function computeCalloutLeaderAnchor(rect: PdfEditRect, tip: PdfEditPoint): PdfEditPoint {
  const minX = rect.x;
  const maxX = rect.x + rect.w;
  const minY = rect.y;
  const maxY = rect.y + rect.h;
  const clampedX = clamp(tip.x, minX, maxX);
  const clampedY = clamp(tip.y, minY, maxY);

  if (tip.x < minX || tip.x > maxX || tip.y < minY || tip.y > maxY) {
    return { x: clampedX, y: clampedY };
  }

  const distances = [
    { edge: "left", value: tip.x - minX },
    { edge: "right", value: maxX - tip.x },
    { edge: "bottom", value: tip.y - minY },
    { edge: "top", value: maxY - tip.y },
  ] as const;
  const nearest = distances.reduce((best, candidate) =>
    candidate.value < best.value ? candidate : best,
  );

  switch (nearest.edge) {
    case "left":
      return { x: minX, y: tip.y };
    case "right":
      return { x: maxX, y: tip.y };
    case "bottom":
      return { x: tip.x, y: minY };
    case "top":
      return { x: tip.x, y: maxY };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Draws an image or signature scaled into the edit rectangle. The image is
 * anchored at the visual bottom-left of the rectangle and rotated with the
 * page so it appears upright to the viewer.
 */
async function applyImageEdit(
  pdf: PDFDocument,
  edit: PdfImageEdit | PdfSignatureEdit,
): Promise<void> {
  const page = pdf.getPage(edit.pageIndex);
  const image = await embedEditImage(pdf, edit);
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const visualRect = mapPageRectToVisualRect(
    edit.rect,
    page.getWidth(),
    page.getHeight(),
    pageRotation,
  );
  const anchor = mapVisualPointToPagePoint({
    visualX: visualRect.x,
    visualY: visualRect.y,
    pageWidth: page.getWidth(),
    pageHeight: page.getHeight(),
    pageRotation,
  });

  page.drawImage(image, {
    x: anchor.x,
    y: anchor.y,
    width: visualRect.w,
    height: visualRect.h,
    rotate: pdfDegrees(pageRotation),
  });
}

async function embedEditImage(
  pdf: PDFDocument,
  edit: PdfImageEdit | PdfSignatureEdit,
): Promise<Awaited<ReturnType<PDFDocument["embedPng"]>>> {
  try {
    return edit.format === "png" ? await pdf.embedPng(edit.bytes) : await pdf.embedJpg(edit.bytes);
  } catch (error) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      `Edit image bytes could not be decoded as ${edit.format}.`,
      { cause: error },
    );
  }
}

async function embedImagePage(
  pdf: PDFDocument,
  image: PdfImagePageInput,
): Promise<Awaited<ReturnType<PDFDocument["embedPng"]>>> {
  try {
    return image.format === "png"
      ? await pdf.embedPng(image.bytes)
      : await pdf.embedJpg(image.bytes);
  } catch (error) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      `Image page bytes could not be decoded as ${image.format}.`,
      { cause: error },
    );
  }
}

/**
 * Draws each freehand stroke as round-capped line segments. Stroke points are
 * already in user space (the caller maps canvas points, including rotation),
 * so no rotation compensation is applied.
 */
function applyInkEdit(pdf: PDFDocument, edit: PdfInkEdit): void {
  const page = pdf.getPage(edit.pageIndex);
  const target = createPageDrawTarget(page);
  const thickness = edit.strokeWidthPt ?? DEFAULT_INK_STROKE_WIDTH_PT;
  const color = toEditColor(edit.color, EDIT_INK_COLOR);

  for (const stroke of edit.strokes) {
    target.drawPolyline(stroke, {
      strokeWidthPt: thickness,
      strokeColor: color,
      lineCap: LineCapStyle.Round,
    });
  }
}

/**
 * Draws geometric shapes verbatim in user space. Shapes are page marks like
 * highlights and ink, so rotated pages receive no visual-rect remapping.
 */
function applyShapeEdit(pdf: PDFDocument, edit: PdfShapeEdit): void {
  const page = pdf.getPage(edit.pageIndex);
  const target = createPageDrawTarget(page);
  const thickness = edit.strokeWidthPt ?? DEFAULT_SHAPE_STROKE_WIDTH_PT;
  const strokeColor = toEditColor(edit.strokeColor, EDIT_INK_COLOR);

  switch (edit.shape) {
    case "rect":
      target.drawRectangle({
        rect: edit.rect,
        strokeColor,
        strokeWidthPt: thickness,
        ...(edit.fillColor ? { fillColor: toEditColor(edit.fillColor, EDIT_INK_COLOR) } : {}),
      });
      return;
    case "ellipse":
      target.drawEllipse({
        rect: edit.rect,
        strokeColor,
        strokeWidthPt: thickness,
        ...(edit.fillColor ? { fillColor: toEditColor(edit.fillColor, EDIT_INK_COLOR) } : {}),
      });
      return;
    case "line":
      target.drawLine({
        from: edit.from,
        to: edit.to,
        strokeWidthPt: thickness,
        strokeColor,
      });
      return;
    case "arrow":
      target.drawLine({
        from: edit.from,
        to: edit.to,
        strokeWidthPt: thickness,
        strokeColor,
      });
      drawArrowHead(target, edit.from, edit.to, thickness, strokeColor);
      return;
  }
}

function applyInkAnnotationEdit(
  pdf: PDFDocument,
  edit: PdfInkEdit,
  options: MarkupAnnotationOptions,
): void {
  const page = pdf.getPage(edit.pageIndex);
  const thickness = edit.strokeWidthPt ?? DEFAULT_INK_STROKE_WIDTH_PT;
  const strokeColor = toEditColor(edit.color, EDIT_INK_COLOR);
  const rect = boundingRectForPoints(
    edit.strokes.flatMap((stroke) => [...stroke]),
    0,
  );
  const appearanceTarget = createAnnotationAppearanceTarget(
    pdf,
    rect,
    normalizePageRotation(page.getRotation().angle),
    { marginPt: appearanceStrokeMargin(thickness) },
  );

  for (const stroke of edit.strokes) {
    appearanceTarget.drawPolyline(stroke, {
      strokeWidthPt: thickness,
      strokeColor,
      lineCap: LineCapStyle.Round,
    });
  }

  addMarkupAnnotation(page, options, {
    Subtype: "Ink",
    Rect: rectToPdfArray(appearanceTarget.annotationRect),
    InkList: edit.strokes.map((stroke) => stroke.flatMap((point) => [point.x, point.y])),
    C: colorToPdfArray(edit.color),
    BS: { W: thickness, S: "S" },
    AP: { N: appearanceTarget.finish() },
  });
}

function applyShapeAnnotationEdit(
  pdf: PDFDocument,
  edit: PdfShapeEdit,
  options: MarkupAnnotationOptions,
): void {
  const page = pdf.getPage(edit.pageIndex);
  const thickness = edit.strokeWidthPt ?? DEFAULT_SHAPE_STROKE_WIDTH_PT;
  const strokeColor = toEditColor(edit.strokeColor, EDIT_INK_COLOR);
  const pageRotation = normalizePageRotation(page.getRotation().angle);

  switch (edit.shape) {
    case "rect": {
      const appearanceTarget = createAnnotationAppearanceTarget(pdf, edit.rect, pageRotation, {
        marginPt: appearanceStrokeMargin(thickness),
      });

      appearanceTarget.drawRectangle({
        rect: edit.rect,
        strokeColor,
        strokeWidthPt: thickness,
        ...(edit.fillColor ? { fillColor: toEditColor(edit.fillColor, EDIT_INK_COLOR) } : {}),
      });

      addMarkupAnnotation(page, options, {
        Subtype: "Square",
        Rect: rectToPdfArray(appearanceTarget.annotationRect),
        C: colorToPdfArray(edit.strokeColor),
        ...(edit.fillColor ? { IC: colorToPdfArray(edit.fillColor) } : {}),
        BS: { W: thickness, S: "S" },
        AP: { N: appearanceTarget.finish() },
      });
      return;
    }
    case "ellipse": {
      const appearanceTarget = createAnnotationAppearanceTarget(pdf, edit.rect, pageRotation, {
        marginPt: appearanceStrokeMargin(thickness),
      });

      appearanceTarget.drawEllipse({
        rect: edit.rect,
        strokeColor,
        strokeWidthPt: thickness,
        ...(edit.fillColor ? { fillColor: toEditColor(edit.fillColor, EDIT_INK_COLOR) } : {}),
      });

      addMarkupAnnotation(page, options, {
        Subtype: "Circle",
        Rect: rectToPdfArray(appearanceTarget.annotationRect),
        C: colorToPdfArray(edit.strokeColor),
        ...(edit.fillColor ? { IC: colorToPdfArray(edit.fillColor) } : {}),
        BS: { W: thickness, S: "S" },
        AP: { N: appearanceTarget.finish() },
      });
      return;
    }
    case "line":
    case "arrow": {
      const boundsPoints =
        edit.shape === "arrow"
          ? [edit.from, ...computeArrowHeadPoints(edit.from, edit.to, thickness)]
          : [edit.from, edit.to];
      const rect = boundingRectForPoints(boundsPoints, 0);
      const appearanceTarget = createAnnotationAppearanceTarget(pdf, rect, pageRotation, {
        marginPt: appearanceStrokeMargin(thickness),
      });

      appearanceTarget.drawLine({
        from: edit.from,
        to: edit.to,
        strokeWidthPt: thickness,
        strokeColor,
      });

      if (edit.shape === "arrow") {
        drawArrowHead(appearanceTarget, edit.from, edit.to, thickness, strokeColor);
      }

      addMarkupAnnotation(page, options, {
        Subtype: "Line",
        Rect: rectToPdfArray(appearanceTarget.annotationRect),
        L: [edit.from.x, edit.from.y, edit.to.x, edit.to.y],
        C: colorToPdfArray(edit.strokeColor),
        BS: { W: thickness, S: "S" },
        ...(edit.shape === "arrow" ? { LE: ["None", "ClosedArrow"] } : {}),
        AP: { N: appearanceTarget.finish() },
      });
      return;
    }
  }
}

function applyHighlightAnnotationEdit(
  pdf: PDFDocument,
  edit: PdfHighlightEdit,
  options: MarkupAnnotationOptions,
): void {
  const page = pdf.getPage(edit.pageIndex);
  const rect = unionRects(edit.rects);
  const color = toEditColor(edit.color, HIGHLIGHT_COLOR);
  const opacity = edit.opacity ?? DEFAULT_HIGHLIGHT_OPACITY;
  const appearanceTarget = createAnnotationAppearanceTarget(
    pdf,
    rect,
    normalizePageRotation(page.getRotation().angle),
  );

  for (const lineRect of edit.rects) {
    appearanceTarget.drawRectangle({ rect: lineRect, fillColor: color, fillAlpha: opacity });
  }

  addMarkupAnnotation(page, options, {
    Subtype: "Highlight",
    Rect: rectToPdfArray(rect),
    QuadPoints: rectsToQuadPoints(edit.rects),
    C: colorToPdfArray(edit.color, HIGHLIGHT_COLOR_COMPONENTS),
    AP: { N: appearanceTarget.finish() },
  }, edit);
}

function applyTextMarkupAnnotationEdit(
  pdf: PDFDocument,
  edit: PdfTextMarkupEdit,
  options: MarkupAnnotationOptions,
): void {
  const page = pdf.getPage(edit.pageIndex);
  const rect = unionRects(edit.rects);
  const color = toEditColor(edit.color, EDIT_INK_COLOR);
  const thickness = edit.thicknessPt ?? DEFAULT_TEXT_MARKUP_THICKNESS_PT;
  const appearanceTarget = createAnnotationAppearanceTarget(
    pdf,
    rect,
    normalizePageRotation(page.getRotation().angle),
    { marginPt: appearanceStrokeMargin(thickness) },
  );

  for (const lineRect of edit.rects) {
    const y = edit.type === "underline" ? lineRect.y : lineRect.y + lineRect.h * 0.5;

    appearanceTarget.drawLine({
      from: { x: lineRect.x, y },
      to: { x: lineRect.x + lineRect.w, y },
      strokeWidthPt: thickness,
      strokeColor: color,
    });
  }

  addMarkupAnnotation(page, options, {
    Subtype: edit.type === "underline" ? "Underline" : "StrikeOut",
    Rect: rectToPdfArray(appearanceTarget.annotationRect),
    QuadPoints: rectsToQuadPoints(edit.rects),
    C: colorToPdfArray(edit.color, EDIT_INK_COLOR_COMPONENTS),
    AP: { N: appearanceTarget.finish() },
  }, edit);
}

function applyTextBoxAnnotationEdit(
  pdf: PDFDocument,
  edit: PdfTextBoxEdit,
  font: PDFFont,
  options: MarkupAnnotationOptions,
): void {
  const page = pdf.getPage(edit.pageIndex);
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const fontSize = edit.fontSizePt ?? DEFAULT_TEXT_BOX_FONT_SIZE_PT;
  const rect = unionRects([edit.rect, computeTextBoxTextRect(page, edit, font)]);
  const appearanceTarget = createAnnotationAppearanceTarget(pdf, rect, pageRotation);

  drawTextBoxText(pdf, edit, font, appearanceTarget);

  addMarkupAnnotation(page, options, {
    Subtype: "FreeText",
    Rect: rectToPdfArray(appearanceTarget.annotationRect),
    Contents: PDFString.of(edit.text),
    DA: PDFString.of(defaultAppearanceString(appearanceTarget, font, fontSize, edit.color)),
    Q: textAlignToPdfQ(edit.align),
    AP: { N: appearanceTarget.finish() },
    C: colorToPdfArray(edit.color),
  }, edit);
}

function applyCalloutAnnotationEdit(
  pdf: PDFDocument,
  edit: PdfCalloutEdit,
  font: PDFFont,
  options: MarkupAnnotationOptions,
): void {
  const page = pdf.getPage(edit.pageIndex);
  const thickness = edit.strokeWidthPt ?? DEFAULT_CALLOUT_STROKE_WIDTH_PT;
  const strokeColor = toEditColor(edit.strokeColor, EDIT_INK_COLOR);
  const fontSize = edit.fontSizePt ?? DEFAULT_TEXT_BOX_FONT_SIZE_PT;
  const anchor = computeCalloutLeaderAnchor(edit.rect, edit.tip);
  const boundsPoints =
    edit.arrowhead ?? true
      ? [anchor, ...computeArrowHeadPoints(anchor, edit.tip, thickness)]
      : [anchor, edit.tip];
  const rect = unionRects([
    edit.rect,
    computeTextBoxTextRect(page, edit, font),
    boundingRectForPoints(boundsPoints, 0),
  ]);
  const appearanceTarget = createAnnotationAppearanceTarget(
    pdf,
    rect,
    normalizePageRotation(page.getRotation().angle),
    { marginPt: appearanceStrokeMargin(thickness) },
  );

  appearanceTarget.drawLine({
    from: anchor,
    to: edit.tip,
    strokeWidthPt: thickness,
    strokeColor,
  });

  if (edit.arrowhead ?? true) {
    drawArrowHead(appearanceTarget, anchor, edit.tip, thickness, strokeColor);
  }

  if (edit.boxFill || edit.boxBorder !== false) {
    appearanceTarget.drawRectangle({
      rect: edit.rect,
      ...(edit.boxFill ? { fillColor: toEditColor(edit.boxFill, EDIT_INK_COLOR) } : {}),
      ...(edit.boxBorder !== false
        ? {
            strokeColor,
            strokeWidthPt: DEFAULT_CALLOUT_BOX_BORDER_WIDTH_PT,
          }
        : {}),
    });
  }

  drawTextBoxText(pdf, edit, font, appearanceTarget);

  const outer = appearanceTarget.annotationRect;
  const inner = edit.rect;
  const rd = [
    Math.max(0, inner.x - outer.x),
    Math.max(0, outer.y + outer.h - (inner.y + inner.h)),
    Math.max(0, outer.x + outer.w - (inner.x + inner.w)),
    Math.max(0, inner.y - outer.y),
  ];

  addMarkupAnnotation(page, options, {
    Subtype: "FreeText",
    IT: PDFName.of("FreeTextCallout"),
    Rect: rectToPdfArray(appearanceTarget.annotationRect),
    RD: rd,
    Contents: PDFString.of(edit.text),
    DA: PDFString.of(defaultAppearanceString(appearanceTarget, font, fontSize, edit.color)),
    Q: textAlignToPdfQ(edit.align),
    CL: [anchor.x, anchor.y, edit.tip.x, edit.tip.y],
    C: colorToPdfArray(edit.color),
    BS: { W: thickness, S: "S" },
    ...(edit.arrowhead ?? true ? { LE: PDFName.of("ClosedArrow") } : {}),
    AP: { N: appearanceTarget.finish() },
  });
}

function textAlignToPdfQ(align: PdfTextBoxAlign | undefined): number {
  switch (align) {
    case "center":
      return 1;
    case "right":
      return 2;
    case "left":
    case undefined:
      return 0;
  }
}

function defaultAppearanceString(
  appearanceTarget: AnnotationAppearanceTarget,
  font: PDFFont,
  fontSize: number,
  color: PdfEditColor | undefined,
): string {
  const fontName = appearanceTarget.fontResourceName(font).toString();
  const [r, g, b] = colorToPdfArray(color, EDIT_INK_COLOR_COMPONENTS);

  return `${fontName} ${formatPdfNumber(fontSize)} Tf ${formatPdfNumber(r!)} ${formatPdfNumber(g!)} ${formatPdfNumber(b!)} rg`;
}

function formatPdfNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function addMarkupAnnotation(
  page: ReturnType<PDFDocument["getPage"]>,
  options: MarkupAnnotationOptions,
  values: Record<string, unknown>,
  sourceEdit?: PdfRaioAnnotationEdit,
): void {
  const annotation = page.doc.context.obj({
    Type: "Annot",
    F: options.print ? ANNOTATION_FLAG_PRINT : 0,
    ...values,
  }) as PDFDict;

  stampRaioPdfAnnotation(annotation, sourceEdit);
  addAnnotationToPage(page, annotation);
}

function addAnnotationToPage(page: ReturnType<PDFDocument["getPage"]>, annotation: PDFDict): void {
  const annotationRef = page.doc.context.register(annotation);
  const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

  if (annotations) {
    annotations.push(annotationRef);
    return;
  }

  page.node.set(PDFName.of("Annots"), page.doc.context.obj([annotationRef]));
}

function rectToPdfArray(rect: PdfEditRect): number[] {
  return [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
}

function rectsToQuadPoints(rects: readonly PdfEditRect[]): number[] {
  return rects.flatMap((rect) => [
    // ISO 32000 describes text-markup quads counterclockwise, but Acrobat,
    // Preview, iText, and common viewers use this Z-order for compatibility.
    rect.x,
    rect.y + rect.h,
    rect.x + rect.w,
    rect.y + rect.h,
    rect.x,
    rect.y,
    rect.x + rect.w,
    rect.y,
  ]);
}

function colorToPdfArray(
  color: PdfEditColor | undefined,
  fallback: readonly [number, number, number] = EDIT_INK_COLOR_COMPONENTS,
): number[] {
  return color ? [color.r, color.g, color.b] : [...fallback];
}

function appearanceStrokeMargin(strokeWidthPt: number): number {
  return strokeWidthPt / 2 + AP_STROKE_CLIP_SAFETY_MARGIN_PT;
}

function boundingRectForPoints(points: readonly PdfEditPoint[], padding: number): PdfEditRect {
  let minX = points[0]?.x ?? Infinity;
  let minY = points[0]?.y ?? Infinity;
  let maxX = points[0]?.x ?? -Infinity;
  let maxY = points[0]?.y ?? -Infinity;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return {
    x: minX - padding,
    y: minY - padding,
    w: maxX - minX + padding * 2,
    h: maxY - minY + padding * 2,
  };
}

function unionRects(rects: readonly PdfEditRect[]): PdfEditRect {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

function drawArrowHead(
  target: DrawTarget,
  from: PdfEditPoint,
  to: PdfEditPoint,
  thickness: number,
  color: DrawColor,
): void {
  const [tip, left, right] = computeArrowHeadPoints(from, to, thickness);

  target.drawFilledPolygon({ points: [tip, left, right], fillColor: color });
}

function computeArrowHeadPoints(
  from: PdfEditPoint,
  to: PdfEditPoint,
  thickness: number,
): readonly [PdfEditPoint, PdfEditPoint, PdfEditPoint] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.min(ARROW_HEAD_MAX_PT, Math.max(ARROW_HEAD_MIN_PT, thickness * 7));
  const halfWidth = length * 0.45;
  const baseCenter = {
    x: to.x - Math.cos(angle) * length,
    y: to.y - Math.sin(angle) * length,
  };
  const normal = {
    x: -Math.sin(angle),
    y: Math.cos(angle),
  };
  const left = {
    x: baseCenter.x + normal.x * halfWidth,
    y: baseCenter.y + normal.y * halfWidth,
  };
  const right = {
    x: baseCenter.x - normal.x * halfWidth,
    y: baseCenter.y - normal.y * halfWidth,
  };

  return [to, left, right];
}

/**
 * Adds a `/Text` (sticky note) annotation to the page's `/Annots` array.
 * Viewers render their own upright note icon, so the anchor is written in
 * user space with no rotation compensation.
 */
function applyCommentEdit(pdf: PDFDocument, edit: PdfCommentEdit): void {
  const page = pdf.getPage(edit.pageIndex);
  const annotation = pdf.context.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [
      edit.at.x,
      edit.at.y,
      edit.at.x + COMMENT_ICON_SIZE_PT,
      edit.at.y + COMMENT_ICON_SIZE_PT,
    ],
    Contents: PDFString.of(edit.text),
    Name: "Comment",
    F: ANNOTATION_FLAG_PRINT,
    Open: false,
    ...(edit.author !== undefined ? { T: PDFString.of(edit.author) } : {}),
  }) as PDFDict;

  stampRaioPdfAnnotation(annotation, edit);
  addAnnotationToPage(page, annotation);
}

function applyFormValuesEdit(pdf: PDFDocument, edit: PdfFormValuesEdit): void {
  const form = pdf.getForm();

  for (const [fieldName, value] of Object.entries(edit.values)) {
    const field = form.getFieldMaybe(fieldName);

    if (!field) {
      throw new PdfEngineError(
        "INVALID_DOCUMENT",
        `Form field "${fieldName}" was not found in the document.`,
      );
    }

    try {
      setFormFieldValue(field, fieldName, value);
    } catch (error) {
      if (error instanceof PdfEngineError) {
        throw error;
      }

      throw new PdfEngineError(
        "INVALID_DOCUMENT",
        `Form field "${fieldName}" rejected the provided value.`,
        { cause: error },
      );
    }
  }
}

function setFormFieldValue(field: PDFField, fieldName: string, value: PdfFormFieldValue): void {
  if (field instanceof PDFTextField) {
    if (typeof value !== "string") {
      throw formValueTypeMismatch(fieldName, "a string");
    }

    field.setText(value);
    return;
  }

  if (field instanceof PDFCheckBox) {
    if (typeof value !== "boolean") {
      throw formValueTypeMismatch(fieldName, "a boolean");
    }

    if (value) {
      field.check();
    } else {
      field.uncheck();
    }
    return;
  }

  if (field instanceof PDFRadioGroup) {
    if (typeof value !== "string") {
      throw formValueTypeMismatch(fieldName, "a string option name");
    }

    field.select(value);
    return;
  }

  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    if (typeof value === "boolean") {
      throw formValueTypeMismatch(fieldName, "a string or string array of option names");
    }

    field.select(typeof value === "string" ? value : [...value]);
    return;
  }

  throw new PdfEngineError(
    "INVALID_DOCUMENT",
    `Form field "${fieldName}" has a field type that does not accept value writes.`,
  );
}

function formValueTypeMismatch(fieldName: string, expected: string): PdfEngineError {
  return new PdfEngineError(
    "INVALID_DOCUMENT",
    `Form field "${fieldName}" requires ${expected}.`,
  );
}

function assertValidEdit(edit: PdfEdit, pageCount: number): void {
  if (edit.type === "formValues") {
    return;
  }

  assertPageIndexes([edit.pageIndex], pageCount);

  switch (edit.type) {
    case "highlight":
      if (edit.rects.length === 0) {
        throw new PdfEngineError(
          "INVALID_DOCUMENT",
          "Highlight edits require at least one rectangle.",
        );
      }

      for (const rect of edit.rects) {
        assertEditRect(rect);
      }

      if (
        edit.opacity !== undefined &&
        (!Number.isFinite(edit.opacity) || edit.opacity < 0 || edit.opacity > 1)
      ) {
        throw new PdfEngineError(
          "INVALID_DOCUMENT",
          "Highlight opacity must be between 0 and 1.",
        );
      }
      return;
    case "underline":
    case "strikethrough":
      assertValidTextMarkupEdit(edit);
      return;
    case "textBox":
      assertValidTextRenderableEdit(edit, "Text box");
      if (edit.backgroundColor) {
        assertEditColor(edit.backgroundColor, "Text box background color");
      }
      if (
        edit.backgroundOpacity !== undefined &&
        (!Number.isFinite(edit.backgroundOpacity) ||
          edit.backgroundOpacity < 0 ||
          edit.backgroundOpacity > 1)
      ) {
        throw new PdfEngineError(
          "INVALID_DOCUMENT",
          "Text box background opacity must be between 0 and 1.",
        );
      }
      return;
    case "callout":
      assertValidTextRenderableEdit(edit, "Callout");
      assertEditPoint(edit.tip, "Callout tip");

      if (edit.strokeWidthPt !== undefined) {
        assertPositiveNumber(edit.strokeWidthPt, "strokeWidthPt");
      }
      if (edit.strokeColor !== undefined) {
        assertEditColor(edit.strokeColor, "Callout stroke color");
      }
      if (edit.boxFill !== undefined) {
        assertEditColor(edit.boxFill, "Callout box fill");
      }
      return;
    case "image":
    case "signature":
      assertEditRect(edit.rect);
      return;
    case "ink":
      if (edit.strokes.length === 0) {
        throw new PdfEngineError("INVALID_DOCUMENT", "Ink edits require at least one stroke.");
      }

      for (const stroke of edit.strokes) {
        if (stroke.length < 2) {
          throw new PdfEngineError(
            "INVALID_DOCUMENT",
            "Ink strokes require at least two points.",
          );
        }
      }

      if (edit.strokeWidthPt !== undefined) {
        assertPositiveNumber(edit.strokeWidthPt, "strokeWidthPt");
      }
      return;
    case "shape":
      assertValidShapeEdit(edit);
      return;
    case "comment":
      assertNonEmptyEditText(edit.text, "Comment");
      return;
  }
}

function assertValidAnnotationId(annotId: string): void {
  if (annotId.trim().length === 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Annotation id must not be empty.");
  }
}

function assertValidTextRenderableEdit(edit: TextRenderableEdit, label: string): void {
  assertEditRect(edit.rect);
  assertNonEmptyEditText(edit.text, label);

  if (edit.fontSizePt !== undefined) {
    assertPositiveNumber(edit.fontSizePt, "fontSizePt");
  }
  if (edit.color !== undefined) {
    assertEditColor(edit.color, `${label} color`);
  }
  if (
    edit.fontFamily !== undefined &&
    !["helvetica", "times", "courier"].includes(edit.fontFamily)
  ) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      `${label} fontFamily must be helvetica, times, or courier.`,
    );
  }
  if (edit.align !== undefined && !["left", "center", "right"].includes(edit.align)) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      `${label} align must be left, center, or right.`,
    );
  }
}

function assertValidShapeEdit(edit: PdfShapeEdit): void {
  if (!["rect", "ellipse", "line", "arrow"].includes(edit.shape)) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "Shape edits require rect, ellipse, line, or arrow.",
    );
  }

  if (edit.strokeWidthPt !== undefined) {
    assertPositiveNumber(edit.strokeWidthPt, "strokeWidthPt");
  }

  if (edit.strokeColor !== undefined) {
    assertEditColor(edit.strokeColor, "Shape stroke color");
  }

  if (edit.shape === "rect" || edit.shape === "ellipse") {
    assertEditRect(edit.rect);

    if (edit.fillColor !== undefined) {
      assertEditColor(edit.fillColor, "Shape fill color");
    }

    return;
  }

  if (edit.shape !== "line" && edit.shape !== "arrow") {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "Shape edits require rect, ellipse, line, or arrow.",
    );
  }

  assertEditPoint(edit.from, "Shape from");
  assertEditPoint(edit.to, "Shape to");

  if (edit.from.x === edit.to.x && edit.from.y === edit.to.y) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "Line and arrow shape edits require distinct endpoints.",
    );
  }
}

function assertValidTextMarkupEdit(edit: PdfTextMarkupEdit): void {
  if (edit.rects.length === 0) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      `${formatTextMarkupLabel(edit.type)} edits require at least one rectangle.`,
    );
  }

  for (const rect of edit.rects) {
    assertEditRect(rect);
  }

  if (edit.thicknessPt !== undefined) {
    assertPositiveNumber(edit.thicknessPt, "thicknessPt");
  }

  if (edit.color !== undefined) {
    assertEditColor(edit.color, "Text markup color");
  }
}

function formatTextMarkupLabel(type: PdfTextMarkupEdit["type"]): string {
  return type === "underline" ? "Underline" : "Strikethrough";
}

function assertEditRect(rect: PdfEditRect): void {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Edit rectangles require finite coordinates.");
  }

  assertPositiveNumber(rect.w, "w");
  assertPositiveNumber(rect.h, "h");
}

function assertEditPoint(point: PdfEditPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${label} point requires finite coordinates.`);
  }
}

function assertNonEmptyEditText(text: string, editLabel: string): void {
  if (text.length === 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${editLabel} text must not be empty.`);
  }
}

function assertEditColor(color: PdfEditColor, label: string): void {
  for (const [channel, value] of Object.entries(color)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new PdfEngineError(
        "INVALID_DOCUMENT",
        `${label} ${channel} channel must be between 0 and 1.`,
      );
    }
  }
}

function toEditColor(
  color: PdfEditColor | undefined,
  fallback: ReturnType<typeof rgb>,
): ReturnType<typeof rgb> {
  return color ? rgb(color.r, color.g, color.b) : fallback;
}

function textBoxFontKey(edit: TextRenderableEdit): TextBoxFontKey {
  const family = edit.fontFamily ?? "helvetica";

  if (edit.bold && edit.italic) {
    return `${family}:boldItalic`;
  }

  if (edit.bold) {
    return `${family}:bold`;
  }

  if (edit.italic) {
    return `${family}:italic`;
  }

  return `${family}:regular`;
}

function computeTextBoxAlignOffset(
  boxWidth: number,
  lineWidth: number,
  align: PdfTextBoxAlign,
): number {
  if (align === "center") {
    return (boxWidth - lineWidth) / 2;
  }

  if (align === "right") {
    return boxWidth - lineWidth;
  }

  return 0;
}

function computeStampX(
  pageWidth: number,
  textWidth: number,
  marginPt: number,
  align: PdfStampPlacement["align"],
): number {
  if (align === "left") {
    return marginPt;
  }

  if (align === "center") {
    return (pageWidth - textWidth) / 2;
  }

  return pageWidth - marginPt - textWidth;
}

async function renderExhibitIndex(options: {
  pageSize: readonly [number, number];
  entries: readonly ExhibitIndexEntry[];
  includeSourceFileName: boolean;
}): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const [pageWidth, pageHeight] = options.pageSize;
  assertPositiveNumber(pageWidth, "index page width");
  assertPositiveNumber(pageHeight, "index page height");

  const pdf = await PDFDocument.create();
  const bodyFont = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = Math.min(54, Math.max(24, pageWidth * 0.075));
  const titleSize = 16;
  const headerSize = 8;
  const bodySize = 8.5;
  const rowHeight = 18;
  const titleY = pageHeight - margin - titleSize;
  const headerY = titleY - 30;
  const firstRowY = headerY - 20;
  const usableRowHeight = Math.max(rowHeight, firstRowY - margin);
  const rowsPerPage = Math.max(1, Math.floor(usableRowHeight / rowHeight));
  const pageCount = Math.max(1, Math.ceil(options.entries.length / rowsPerPage));

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = pdf.addPage([pageWidth, pageHeight]);
    const columns = computeExhibitIndexColumns({
      pageWidth,
      margin,
      includeSourceFileName: options.includeSourceFileName,
    });

    page.drawText("Exhibit Index", {
      x: margin,
      y: titleY,
      size: titleSize,
      font: boldFont,
      color: STAMP_COLOR,
    });

    if (pageCount > 1) {
      const pageLabel = `${pageIndex + 1} of ${pageCount}`;
      page.drawText(pageLabel, {
        x: pageWidth - margin - bodyFont.widthOfTextAtSize(pageLabel, headerSize),
        y: titleY + 2,
        size: headerSize,
        font: bodyFont,
        color: STAMP_COLOR,
      });
    }

    drawIndexHeader(page, boldFont, columns, headerY, headerSize);

    const start = pageIndex * rowsPerPage;
    const rows = options.entries.slice(start, start + rowsPerPage);

    rows.forEach((entry, rowIndex) => {
      drawIndexRow(
        page,
        bodyFont,
        entry,
        columns,
        firstRowY - (rowIndex * rowHeight),
        bodySize,
        options.includeSourceFileName,
      );
    });
  }

  return {
    bytes: new Uint8Array(await pdf.save()),
    pageCount,
  };
}

function computeExhibitIndexColumns(options: {
  pageWidth: number;
  margin: number;
  includeSourceFileName: boolean;
}): {
  labelX: number;
  labelWidth: number;
  descriptionX: number;
  descriptionWidth: number;
  pageCountX: number;
  pageCountWidth: number;
  pageRangeX: number;
  pageRangeWidth: number;
  sourceFileNameX?: number | undefined;
  sourceFileNameWidth?: number | undefined;
} {
  const contentWidth = options.pageWidth - (2 * options.margin);
  const gap = 10;
  const labelWidth = Math.min(88, contentWidth * 0.2);
  const pageCountWidth = 54;
  const pageRangeWidth = 76;
  const sourceFileNameWidth = options.includeSourceFileName ? Math.min(120, contentWidth * 0.22) : 0;
  const fixedWidth = labelWidth + pageCountWidth + pageRangeWidth + sourceFileNameWidth +
    (gap * (options.includeSourceFileName ? 4 : 3));
  const descriptionWidth = Math.max(60, contentWidth - fixedWidth);
  const labelX = options.margin;
  const descriptionX = labelX + labelWidth + gap;
  const sourceFileNameX = options.includeSourceFileName
    ? descriptionX + descriptionWidth + gap
    : undefined;
  const pageCountX = options.includeSourceFileName && sourceFileNameX !== undefined
    ? sourceFileNameX + sourceFileNameWidth + gap
    : descriptionX + descriptionWidth + gap;
  const pageRangeX = pageCountX + pageCountWidth + gap;

  return {
    labelX,
    labelWidth,
    descriptionX,
    descriptionWidth,
    pageCountX,
    pageCountWidth,
    pageRangeX,
    pageRangeWidth,
    sourceFileNameX,
    sourceFileNameWidth: options.includeSourceFileName ? sourceFileNameWidth : undefined,
  };
}

function drawIndexHeader(
  page: ReturnType<PDFDocument["getPage"]>,
  font: PDFFont,
  columns: ReturnType<typeof computeExhibitIndexColumns>,
  y: number,
  fontSize: number,
): void {
  page.drawText("Exhibit", { x: columns.labelX, y, size: fontSize, font, color: STAMP_COLOR });
  page.drawText("Description", {
    x: columns.descriptionX,
    y,
    size: fontSize,
    font,
    color: STAMP_COLOR,
  });

  if (columns.sourceFileNameX !== undefined) {
    page.drawText("Source file", {
      x: columns.sourceFileNameX,
      y,
      size: fontSize,
      font,
      color: STAMP_COLOR,
    });
  }

  drawRightAlignedText(page, font, "Pages", columns.pageCountX, columns.pageCountWidth, y, fontSize);
  drawRightAlignedText(
    page,
    font,
    "Binder pages",
    columns.pageRangeX,
    columns.pageRangeWidth,
    y,
    fontSize,
  );
  page.drawLine({
    start: { x: columns.labelX, y: y - 6 },
    end: { x: columns.pageRangeX + columns.pageRangeWidth, y: y - 6 },
    thickness: 0.5,
    color: STAMP_COLOR,
  });
}

function drawIndexRow(
  page: ReturnType<PDFDocument["getPage"]>,
  font: PDFFont,
  entry: ExhibitIndexEntry,
  columns: ReturnType<typeof computeExhibitIndexColumns>,
  y: number,
  fontSize: number,
  includeSourceFileName: boolean,
): void {
  const label = sanitizeIndexTextForFont(font, entry.label);

  page.drawText(fitTextToWidth(font, label, fontSize, columns.labelWidth), {
    x: columns.labelX,
    y,
    size: fontSize,
    font,
    color: STAMP_COLOR,
  });
  page.drawText(
    fitTextToWidth(
      font,
      displayIndexDescription(font, entry),
      fontSize,
      columns.descriptionWidth,
    ),
    {
      x: columns.descriptionX,
      y,
      size: fontSize,
      font,
      color: STAMP_COLOR,
    },
  );

  if (
    includeSourceFileName &&
    columns.sourceFileNameX !== undefined &&
    columns.sourceFileNameWidth !== undefined
  ) {
    const sourceFileName = sanitizeIndexTextForFont(font, entry.sourceFileName ?? "");

    page.drawText(
      fitTextToWidth(font, sourceFileName, fontSize, columns.sourceFileNameWidth),
      {
        x: columns.sourceFileNameX,
        y,
        size: fontSize,
        font,
        color: STAMP_COLOR,
      },
    );
  }

  drawRightAlignedText(
    page,
    font,
    String(entry.pageCount),
    columns.pageCountX,
    columns.pageCountWidth,
    y,
    fontSize,
  );
  drawRightAlignedText(
    page,
    font,
    entry.pageRange,
    columns.pageRangeX,
    columns.pageRangeWidth,
    y,
    fontSize,
  );
}

function displayIndexDescription(font: PDFFont, entry: ExhibitIndexEntry): string {
  const rawDescription = entry.description ?? defaultExhibitDescription(entry.sourceFileName, entry.label);
  const description = sanitizeIndexTextForFont(font, rawDescription);

  if (description.length > 0 || entry.descriptionGeneratedFromSourceFileName !== true) {
    return description;
  }

  return sanitizeIndexTextForFont(font, entry.label);
}

function drawRightAlignedText(
  page: ReturnType<PDFDocument["getPage"]>,
  font: PDFFont,
  text: string,
  x: number,
  width: number,
  y: number,
  fontSize: number,
): void {
  const fitted = fitTextToWidth(font, text, fontSize, width);
  page.drawText(fitted, {
    x: x + width - font.widthOfTextAtSize(fitted, fontSize),
    y,
    size: fontSize,
    font,
    color: STAMP_COLOR,
  });
}

function formatBinderPageRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function normalizeBinderIndexOptions(
  options: PdfBinderOptions,
): { enabled: boolean; includeSourceFileName: boolean } {
  return {
    enabled: options.index?.enabled ?? DEFAULT_BINDER_INDEX_ENABLED,
    includeSourceFileName: options.index?.includeSourceFileName ??
      DEFAULT_BINDER_INDEX_SOURCE_FILENAME,
  };
}

function normalizeBinderStampOptions(
  options: PdfBinderOptions,
): Required<PdfStampTextOptions> {
  const stampOptions: PdfStampTextOptions = {
    text: "binder-label",
    pageIndexes: options.stampPages ?? "all",
    placement: options.placement ?? DEFAULT_BINDER_PLACEMENT,
  };

  if (options.fontSizePt !== undefined) {
    stampOptions.fontSizePt = options.fontSizePt;
  }

  if (options.marginIn !== undefined) {
    stampOptions.marginIn = options.marginIn;
  }

  return normalizeStampOptions(stampOptions);
}

function normalizeStampOptions(options: PdfStampTextOptions): Required<PdfStampTextOptions> {
  assertNonEmptyText(options.text);

  const fontSizePt = options.fontSizePt ?? DEFAULT_FONT_SIZE_PT;
  const marginIn = options.marginIn ?? DEFAULT_MARGIN_IN;
  assertPositiveNumber(fontSizePt, "fontSizePt");
  assertPositiveNumber(marginIn, "marginIn");

  return {
    text: options.text,
    pageIndexes: options.pageIndexes,
    placement: options.placement,
    fontSizePt,
    marginIn,
  };
}

function normalizeBatesOptions(options: PdfBatesStampOptions): PdfBatesStampOptions {
  if (!Number.isInteger(options.start) || options.start < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Bates start must be a non-negative integer.");
  }

  if (!Number.isInteger(options.digits) || options.digits <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Bates digits must be a positive integer.");
  }

  if (options.fontSizePt !== undefined) {
    assertPositiveNumber(options.fontSizePt, "fontSizePt");
  }

  if (options.marginIn !== undefined) {
    assertPositiveNumber(options.marginIn, "marginIn");
  }

  return options;
}

function normalizePageNumbersOptions(
  options: PdfPageNumbersOptions,
): Required<PdfPageNumbersOptions> {
  if (!Number.isInteger(options.startAt) || options.startAt < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Page numbering start must be a non-negative integer.");
  }

  const fontSizePt = options.fontSizePt ?? DEFAULT_FONT_SIZE_PT;
  const marginIn = options.marginIn ?? DEFAULT_MARGIN_IN;
  assertPositiveNumber(fontSizePt, "fontSizePt");
  assertPositiveNumber(marginIn, "marginIn");

  return {
    startAt: options.startAt,
    pageIndexes: options.pageIndexes,
    format: options.format,
    placement: options.placement,
    fontSizePt,
    marginIn,
  };
}

function normalizeWatermarkOptions(options: PdfWatermarkOptions): Required<PdfWatermarkOptions> {
  assertNonEmptyText(options.text);

  const fontSizePt = options.fontSizePt ?? DEFAULT_WATERMARK_FONT_SIZE_PT;
  const opacity = options.opacity ?? DEFAULT_WATERMARK_OPACITY;
  assertPositiveNumber(fontSizePt, "fontSizePt");

  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Watermark opacity must be between 0 and 1.");
  }

  return {
    text: options.text,
    pageIndexes: options.pageIndexes,
    orientation: options.orientation,
    opacity,
    fontSizePt,
  };
}

function assertBatesFitsPageCount(options: PdfBatesStampOptions, pageCount: number): void {
  const lastNumber = options.start + pageCount - 1;
  if (lastNumber >= 10 ** options.digits) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "Bates numbers exceed the configured digit width.",
    );
  }
}

function formatBatesNumber(options: PdfBatesStampOptions, offset: number): string {
  return `${options.prefix}${String(options.start + offset).padStart(options.digits, "0")}`;
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    if (isEncryptedPdfError(error)) {
      throw new PdfEngineError("ENCRYPTED_DOCUMENT", "Encrypted PDFs are not supported.", {
        cause: error,
      });
    }

    throw new PdfEngineError("INVALID_DOCUMENT", "PDF bytes could not be read.", {
      cause: error,
    });
  }
}

function isEncryptedPdfError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return message.includes("encrypted") || message.includes("password");
}

function normalizeBytes(bytes: PdfBytes): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return new Uint8Array(bytes);
  }

  return new Uint8Array(bytes.slice(0));
}

function assertCompletePageSet(pageIndexes: readonly number[], pageCount: number): void {
  assertPageIndexes(pageIndexes, pageCount);

  if (pageIndexes.length !== pageCount || new Set(pageIndexes).size !== pageCount) {
    throw new PdfEngineError(
      "INVALID_PAGE_INDEX",
      "Reorder operations must include each page exactly once.",
    );
  }
}

function assertPageIndexes(pageIndexes: readonly number[], pageCount: number): void {
  for (const pageIndex of pageIndexes) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
      throw new PdfEngineError(
        "INVALID_PAGE_INDEX",
        `Page index ${pageIndex} is outside the document range.`,
      );
    }
  }
}

function resolvePageSelection(selection: PdfPageSelection, pageCount: number): number[] {
  if (selection === "all") {
    return range(0, pageCount);
  }

  if (selection === "first") {
    return pageCount === 0 ? [] : [0];
  }

  assertPageIndexes(selection, pageCount);

  return [...new Set(selection)];
}

function assertNonEmptyText(text: string): void {
  if (text.length === 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Stamp text must not be empty.");
  }
}

function unsupportedTrueRedaction(): PdfEngineError {
  return new PdfEngineError(
    "UNSUPPORTED",
    "True redaction requires the desktop engine; the local engine cannot safely remove underlying PDF content.",
  );
}

function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${fieldName} must be a positive number.`);
  }
}

function assertNonNegativeNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${fieldName} must not be negative.`);
  }
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${fieldName} must be a non-negative integer.`);
  }
}

function assertInsertIndex(insertAtPageIndex: number, pageCount: number): void {
  if (
    !Number.isInteger(insertAtPageIndex) ||
    insertAtPageIndex < 0 ||
    insertAtPageIndex > pageCount
  ) {
    throw new PdfEngineError(
      "INVALID_PAGE_INDEX",
      `Insert index ${insertAtPageIndex} is outside the document range.`,
    );
  }
}

function assertSupportedRotation(degrees: number): void {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) {
    throw new PdfEngineError(
      "UNSUPPORTED_ROTATION",
      "Page rotations must use whole 90-degree increments.",
    );
  }
}

function assertSupportedPdfAFlavor(flavor: PdfAConversionOptions["flavor"]): void {
  if (flavor !== "pdfa-1" && flavor !== "pdfa-2b" && flavor !== "pdfa-3b") {
    throw new PdfEngineError("INVALID_DOCUMENT", "Unsupported PDF/A flavor.");
  }
}

function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function normalizePageRotation(degrees: number): PageRotation {
  const rotation = normalizeRotation(degrees);

  if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) {
    return rotation;
  }

  throw new PdfEngineError(
    "UNSUPPORTED_ROTATION",
    "Page rotations must use whole 90-degree increments.",
  );
}

function range(startInclusive: number, endExclusive: number): number[] {
  return Array.from(
    { length: endExclusive - startInclusive },
    (_, index) => startInclusive + index,
  );
}
