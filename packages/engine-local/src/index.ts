import type {
  PdfBatesStampOptions,
  PdfBinderExhibit,
  PdfBinderOptions,
  PdfBytes,
  PdfAConversionOptions,
  PdfCommentEdit,
  PdfDocumentHandle,
  PdfEdit,
  PdfEditColor,
  PdfEditRect,
  PdfEngine,
  PdfFormFieldValue,
  PdfFormValuesEdit,
  PdfHighlightEdit,
  PdfImageEdit,
  PdfInkEdit,
  PdfNormalizePagesOptions,
  PdfPageSizePoints,
  PdfPageSelection,
  PdfRedactTextOptions,
  PdfRedactionArea,
  PdfSignatureEdit,
  PdfSplitByMaxBytesResult,
  PdfStampPlacement,
  PdfStampTextOptions,
  PdfTextBoxEdit,
  PdfTextRegion,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { scrubPdfMetadataInPlace } from "@raiopdf/engine-pdf-lib";
import {
  degrees as pdfDegrees,
  LineCapStyle,
  PDFArray,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFFont,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  rgb,
  StandardFonts,
} from "pdf-lib";

type StoredDocument = {
  bytes: Uint8Array;
};

type OutlineEntry = {
  pageIndex: number;
  title: string;
};

type PageRotation = 0 | 90 | 180 | 270;

const DEFAULT_FONT_SIZE_PT = 11;
const DEFAULT_MARGIN_IN = 0.5;
const POINTS_PER_INCH = 72;
const DEFAULT_BINDER_PLACEMENT: PdfStampPlacement = {
  edge: "footer",
  align: "right",
};
const STAMP_COLOR = rgb(0.08, 0.08, 0.08);
const EDIT_INK_COLOR = rgb(0x11 / 0xff, 0x11 / 0xff, 0x11 / 0xff);
const HIGHLIGHT_COLOR = rgb(1, 0.9, 0.3);
const DEFAULT_HIGHLIGHT_OPACITY = 0.4;
const DEFAULT_TEXT_BOX_FONT_SIZE_PT = 12;
const TEXT_BOX_LINE_HEIGHT_FACTOR = 1.2;
const DEFAULT_INK_STROKE_WIDTH_PT = 1.5;
const COMMENT_ICON_SIZE_PT = 20;
/** PDF annotation flag bit 3 (value 4): render the annotation when printing. */
const ANNOTATION_FLAG_PRINT = 4;

export class LocalPdfEngine implements PdfEngine {
  private readonly documents = new Map<PdfDocumentHandle, StoredDocument>();
  private nextDocumentId = 1;

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
  ): Promise<PdfDocumentHandle> {
    const source = await this.load(document);
    assertCompletePageSet(pageIndexes, source.getPageCount());

    const output = await PDFDocument.create();
    const copiedPages = await output.copyPages(source, [...pageIndexes]);
    for (const page of copiedPages) {
      output.addPage(page);
    }

    return this.store(await output.save());
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

    return this.store(await output.save());
  }

  async deletePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfDocumentHandle> {
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

    return this.store(await output.save());
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
    const parts: Array<{
      bytes: Uint8Array;
      pageIndexes: number[];
      oversized: boolean;
    }> = [];
    let currentPageIndexes: number[] = [];
    let currentBytes: Uint8Array | null = null;

    for (const pageIndex of source.getPageIndices()) {
      const candidatePageIndexes = [...currentPageIndexes, pageIndex];
      const candidateBytes = await createDocumentBytesForPages(source, candidatePageIndexes);

      if (candidateBytes.byteLength <= maxBytes) {
        currentPageIndexes = candidatePageIndexes;
        currentBytes = candidateBytes;
        continue;
      }

      if (currentPageIndexes.length > 0 && currentBytes) {
        parts.push({
          bytes: currentBytes,
          pageIndexes: currentPageIndexes,
          oversized: false,
        });
        currentPageIndexes = [];
        currentBytes = null;
      }

      const singlePageBytes = await createDocumentBytesForPages(source, [pageIndex]);

      if (singlePageBytes.byteLength > maxBytes) {
        parts.push({
          bytes: singlePageBytes,
          pageIndexes: [pageIndex],
          oversized: true,
        });
        continue;
      }

      currentPageIndexes = [pageIndex];
      currentBytes = singlePageBytes;
    }

    if (currentPageIndexes.length > 0 && currentBytes) {
      parts.push({
        bytes: currentBytes,
        pageIndexes: currentPageIndexes,
        oversized: false,
      });
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

  async insertPages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    fromOtherDocument: PdfDocumentHandle,
  ): Promise<PdfDocumentHandle> {
    const target = await this.load(document);
    const inserted = await this.load(fromOtherDocument);
    const targetPageCount = target.getPageCount();
    assertInsertIndex(insertAtPageIndex, targetPageCount);

    const output = await PDFDocument.create();
    await copyPagesInto(output, target, target.getPageIndices().slice(0, insertAtPageIndex));
    await copyPagesInto(output, inserted, inserted.getPageIndices());
    await copyPagesInto(output, target, target.getPageIndices().slice(insertAtPageIndex));

    return this.store(await output.save());
  }

  async merge(documents: readonly PdfDocumentHandle[]): Promise<PdfDocumentHandle> {
    if (documents.length === 0) {
      throw new PdfEngineError("EMPTY_INPUT", "At least one document is required.");
    }

    const output = await PDFDocument.create();

    for (const document of documents) {
      const source = await this.load(document);
      await copyPagesInto(output, source, source.getPageIndices());
    }

    return this.store(await output.save());
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

  async buildBinder(
    main: PdfDocumentHandle,
    exhibits: readonly PdfBinderExhibit[],
    options: PdfBinderOptions,
  ): Promise<PdfDocumentHandle> {
    const mainPdf = await this.load(main);
    const output = await PDFDocument.create();
    const outlineEntries: OutlineEntry[] = [{ title: "Main document", pageIndex: 0 }];

    await copyPagesInto(output, mainPdf, mainPdf.getPageIndices());

    const mainFirstPage = output.getPage(0);
    const slipSheetSize: [number, number] = [mainFirstPage.getWidth(), mainFirstPage.getHeight()];
    const stampOptions = normalizeBinderStampOptions(options);
    const stampFont = await output.embedFont(StandardFonts.Helvetica);

    for (const exhibit of exhibits) {
      assertNonEmptyText(exhibit.label);

      const exhibitPdf = await this.load(exhibit.doc);
      const sectionStartPageIndex = output.getPageCount();
      outlineEntries.push({ title: exhibit.label, pageIndex: sectionStartPageIndex });

      if (options.slipSheets) {
        const slipSheet = output.addPage(slipSheetSize);
        const fontSize = stampOptions.fontSizePt;
        const textWidth = stampFont.widthOfTextAtSize(exhibit.label, fontSize);
        slipSheet.drawText(exhibit.label, {
          x: (slipSheet.getWidth() - textWidth) / 2,
          y: (slipSheet.getHeight() - fontSize) / 2,
          size: fontSize,
          font: stampFont,
          color: STAMP_COLOR,
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
    }

    addOutline(output, outlineEntries);

    return this.store(await output.save());
  }

  /**
   * Applies add-content edits with pdf-lib.
   *
   * Comments become real `/Annots` `/Text` annotations so they stay live in
   * other viewers. Highlights are drawn as translucent rectangles rather than
   * `/Highlight` annotations: pdf-lib has no highlight-annotation API, and a
   * hand-built one needs QuadPoints plus a multiply-blend appearance stream to
   * render consistently across viewers — drawn rects are the clean, reliable
   * option here and match the product's bake-on-save model. Text boxes, ink,
   * images, and signatures are drawn content. Text, image, and signature
   * placement is rotation-aware: content renders upright to the viewer on
   * pages rotated 90/180/270 degrees, reusing the stamp rotation mapping.
   */
  async applyEdits(
    document: PdfDocumentHandle,
    edits: readonly PdfEdit[],
  ): Promise<PdfDocumentHandle> {
    const output = await this.load(document);
    const pageCount = output.getPageCount();

    for (const edit of edits) {
      assertValidEdit(edit, pageCount);
    }

    let helvetica: PDFFont | null = null;
    const getHelvetica = async (): Promise<PDFFont> => {
      helvetica ??= await output.embedFont(StandardFonts.Helvetica);

      return helvetica;
    };

    for (const edit of edits) {
      await applyEditInPlace(output, edit, getHelvetica);
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
  const textWidth = font.widthOfTextAtSize(options.text, options.fontSizePt);
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const { x, y } = computeStampPosition({
    pageWidth: page.getWidth(),
    pageHeight: page.getHeight(),
    textWidth,
    fontSize: options.fontSizePt,
    marginPt,
    placement: options.placement,
    pageRotation,
  });

  page.drawText(options.text, {
    x,
    y,
    size: options.fontSizePt,
    font,
    color: STAMP_COLOR,
    rotate: pdfDegrees(pageRotation),
  });
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
  getHelvetica: () => Promise<PDFFont>,
): Promise<void> {
  switch (edit.type) {
    case "highlight":
      applyHighlightEdit(pdf, edit);
      return;
    case "textBox":
      applyTextBoxEdit(pdf, edit, await getHelvetica());
      return;
    case "image":
    case "signature":
      await applyImageEdit(pdf, edit);
      return;
    case "ink":
      applyInkEdit(pdf, edit);
      return;
    case "comment":
      applyCommentEdit(pdf, edit);
      return;
    case "formValues":
      applyFormValuesEdit(pdf, edit);
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
  const color = toEditColor(edit.color, HIGHLIGHT_COLOR);
  const opacity = edit.opacity ?? DEFAULT_HIGHLIGHT_OPACITY;

  for (const rect of edit.rects) {
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      color,
      opacity,
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
  const fontSize = edit.fontSizePt ?? DEFAULT_TEXT_BOX_FONT_SIZE_PT;
  const pageRotation = normalizePageRotation(page.getRotation().angle);
  const visualRect = mapPageRectToVisualRect(
    edit.rect,
    page.getWidth(),
    page.getHeight(),
    pageRotation,
  );
  const anchor = mapVisualPointToPagePoint({
    visualX: visualRect.x,
    visualY: visualRect.y + visualRect.h - fontSize,
    pageWidth: page.getWidth(),
    pageHeight: page.getHeight(),
    pageRotation,
  });

  page.drawText(edit.text, {
    x: anchor.x,
    y: anchor.y,
    size: fontSize,
    font,
    color: toEditColor(edit.color, EDIT_INK_COLOR),
    lineHeight: fontSize * TEXT_BOX_LINE_HEIGHT_FACTOR,
    rotate: pdfDegrees(pageRotation),
  });
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

/**
 * Draws each freehand stroke as round-capped line segments. Stroke points are
 * already in user space (the caller maps canvas points, including rotation),
 * so no rotation compensation is applied.
 */
function applyInkEdit(pdf: PDFDocument, edit: PdfInkEdit): void {
  const page = pdf.getPage(edit.pageIndex);
  const thickness = edit.strokeWidthPt ?? DEFAULT_INK_STROKE_WIDTH_PT;
  const color = toEditColor(edit.color, EDIT_INK_COLOR);

  for (const stroke of edit.strokes) {
    for (let pointIndex = 0; pointIndex + 1 < stroke.length; pointIndex += 1) {
      const start = stroke[pointIndex]!;
      const end = stroke[pointIndex + 1]!;

      page.drawLine({
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
        thickness,
        color,
        lineCap: LineCapStyle.Round,
      });
    }
  }
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
  });
  const annotationRef = pdf.context.register(annotation);
  const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

  if (annotations) {
    annotations.push(annotationRef);
    return;
  }

  page.node.set(PDFName.of("Annots"), pdf.context.obj([annotationRef]));
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
    case "textBox":
      assertEditRect(edit.rect);
      assertNonEmptyEditText(edit.text, "Text box");

      if (edit.fontSizePt !== undefined) {
        assertPositiveNumber(edit.fontSizePt, "fontSizePt");
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
    case "comment":
      assertNonEmptyEditText(edit.text, "Comment");
      return;
  }
}

function assertEditRect(rect: PdfEditRect): void {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Edit rectangles require finite coordinates.");
  }

  assertPositiveNumber(rect.w, "w");
  assertPositiveNumber(rect.h, "h");
}

function assertNonEmptyEditText(text: string, editLabel: string): void {
  if (text.length === 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${editLabel} text must not be empty.`);
  }
}

function toEditColor(
  color: PdfEditColor | undefined,
  fallback: ReturnType<typeof rgb>,
): ReturnType<typeof rgb> {
  return color ? rgb(color.r, color.g, color.b) : fallback;
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

function addOutline(pdf: PDFDocument, entries: readonly OutlineEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  const context = pdf.context;
  const outlineRootRef = context.nextRef();
  const itemRefs = entries.map(() => context.nextRef());

  entries.forEach((entry, index) => {
    const item = context.obj({
      Title: PDFString.of(entry.title),
      Parent: outlineRootRef,
      Dest: [pdf.getPage(entry.pageIndex).ref, "Fit"],
      ...(index > 0 ? { Prev: itemRefs[index - 1]! } : {}),
      ...(index < itemRefs.length - 1 ? { Next: itemRefs[index + 1]! } : {}),
    });
    context.assign(itemRefs[index]!, item);
  });

  context.assign(
    outlineRootRef,
    context.obj({
      Type: "Outlines",
      First: itemRefs[0]!,
      Last: itemRefs[itemRefs.length - 1]!,
      Count: entries.length,
    }),
  );

  pdf.catalog.set(PDFName.of("Outlines"), outlineRootRef);
  pdf.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
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
