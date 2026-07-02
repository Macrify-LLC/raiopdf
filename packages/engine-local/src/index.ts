import type {
  PdfBatesStampOptions,
  PdfBinderExhibit,
  PdfBinderOptions,
  PdfBytes,
  PdfDocumentHandle,
  PdfEngine,
  PdfPageSizePoints,
  PdfPageSelection,
  PdfRedactTextOptions,
  PdfRedactionArea,
  PdfStampPlacement,
  PdfStampTextOptions,
  PdfTextRegion,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import {
  degrees as pdfDegrees,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
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
    scrubMetadataInPlace(output);

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

function formatBatesNumber(options: PdfBatesStampOptions, offset: number): string {
  return `${options.prefix}${String(options.start + offset).padStart(options.digits, "0")}`;
}

function scrubMetadataInPlace(pdf: PDFDocument): void {
  const infoRef = pdf.context.trailerInfo.Info;
  if (infoRef instanceof PDFRef) {
    pdf.context.delete(infoRef);
  }
  delete pdf.context.trailerInfo.Info;

  const metadataName = PDFName.of("Metadata");
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) {
      continue;
    }

    const metadataRef = object.get(metadataName);
    if (metadataRef instanceof PDFRef) {
      pdf.context.delete(metadataRef);
    }

    if (object.has(metadataName)) {
      object.delete(metadataName);
      pdf.context.assign(ref, object);
    }
  }
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
