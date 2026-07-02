import type {
  PdfBytes,
  PdfDocumentHandle,
  PdfEngine,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import { degrees as pdfDegrees, PDFDocument } from "pdf-lib";

type StoredDocument = {
  bytes: Uint8Array;
};

export class LocalPdfEngine implements PdfEngine {
  private readonly documents = new Map<PdfDocumentHandle, StoredDocument>();
  private nextDocumentId = 1;

  async open(bytes: PdfBytes): Promise<PdfDocumentHandle> {
    const normalizedBytes = normalizeBytes(bytes);
    await loadPdf(normalizedBytes);

    return this.store(normalizedBytes);
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

    const output = await PDFDocument.create();
    const copiedPages = await output.copyPages(source, keptPageIndexes);
    for (const page of copiedPages) {
      output.addPage(page);
    }

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

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    throw new PdfEngineError("INVALID_DOCUMENT", "PDF bytes could not be read.", {
      cause: error,
    });
  }
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
