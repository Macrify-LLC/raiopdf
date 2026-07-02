import type {
  PdfBinderExhibit,
  PdfBinderOptions,
  PdfBytes,
  PdfDocumentHandle,
  PdfEngine,
  PdfEngineErrorCode,
  PdfPageSizePoints,
  PdfPageSelection,
  PdfStampPlacement,
  PdfStampTextOptions,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";

type Fetch = typeof globalThis.fetch;

type StoredDocument = {
  bytes: Uint8Array;
  pageCount?: number;
};

export type SidecarPdfEngineOptions = {
  baseUrl: string;
  fetch?: Fetch;
};

export type SidecarPdfEngineInfo = {
  kind: "stirling-pdf";
  baseUrl: string;
  status?: string;
  version?: string;
};

export type SidecarOcrType = "skip-text" | "force-ocr" | "Normal";

export interface SidecarOcrOptions {
  languages?: readonly string[];
  ocrType?: SidecarOcrType;
  deskew?: boolean;
}

type StirlingErrorBody = {
  error?: unknown;
  message?: unknown;
  status?: unknown;
};

const DEFAULT_FONT_SIZE_PT = 11;
const DEFAULT_MARGIN_IN = 0.5;

/**
 * PdfEngine implementation backed by Stirling PDF's current v2 API surface.
 *
 * Verified mappings:
 * - pageCount -> POST /api/v1/analysis/basic-info with multipart fileInput.
 * - reorderPages -> POST /api/v1/general/rearrange-pages with fileInput,
 *   1-based pageNumbers, and customMode=CUSTOM.
 * - rotatePages -> POST /api/v1/general/rotate-pdf with fileInput and angle
 *   when all pages are selected. For partial rotations, the client extracts
 *   pages via /api/v1/general/rearrange-pages, rotates selected one-page PDFs,
 *   then POSTs /api/v1/general/merge-pdfs.
 * - deletePages -> POST /api/v1/general/remove-pages with fileInput and
 *   1-based pageNumbers.
 * - insertPages -> POST /api/v1/general/merge-pdfs, then rearranges the merged
 *   result with /api/v1/general/rearrange-pages when insertion is not an append.
 * - merge -> POST /api/v1/general/merge-pdfs with repeated fileInput parts,
 *   sortType=orderProvided, removeCertSign=true, and generateToc=false.
 * - stampText -> POST /api/v1/misc/add-stamp with stampType=text,
 *   customMargin always present, and position mapped onto Stirling's 1-9
 *   grid: 1 top-left, 2 top-center, 3 top-right, 4 middle-left,
 *   5 middle-center, 6 middle-right, 7 bottom-left, 8 bottom-center,
 *   9 bottom-right. `marginIn` is mapped onto Stirling's small/medium/large
 *   customMargin presets.
 * - buildBinder is intentionally unsupported for this engine because Stirling
 *   exposes generated merge TOCs but not caller-defined exhibit outline titles
 *   and destinations. Use the local engine for contract-complete binders.
 * - ocr -> POST /api/v1/misc/ocr-pdf with repeated languages, ocrType,
 *   ocrRenderType=sandwich, sidecar=false, and deskew.
 */
export class SidecarPdfEngine implements PdfEngine {
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly documents = new Map<PdfDocumentHandle, StoredDocument>();
  private nextDocumentId = 1;

  constructor(options: SidecarPdfEngineOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  static async probe(baseUrl: string, fetchImpl: Fetch = globalThis.fetch): Promise<SidecarPdfEngineInfo | null> {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    try {
      const response = await fetchImpl(`${normalizedBaseUrl}/api/v1/info/status`, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        return null;
      }

      const body = await readJson(response);
      const status = readStringProperty(body, "status");
      const version = readStringProperty(body, "version");

      return {
        kind: "stirling-pdf",
        baseUrl: normalizedBaseUrl,
        ...(status ? { status } : {}),
        ...(version ? { version } : {}),
      };
    } catch {
      return null;
    }
  }

  async open(bytes: PdfBytes): Promise<PdfDocumentHandle> {
    const normalizedBytes = normalizeBytes(bytes);
    const pageCount = await this.fetchPageCount(normalizedBytes);

    return this.store(normalizedBytes, pageCount);
  }

  async close(document: PdfDocumentHandle): Promise<void> {
    this.documents.delete(document);
  }

  async pageCount(document: PdfDocumentHandle): Promise<number> {
    const storedDocument = this.get(document);

    if (storedDocument.pageCount !== undefined) {
      return storedDocument.pageCount;
    }

    const pageCount = await this.fetchPageCount(storedDocument.bytes);

    storedDocument.pageCount = pageCount;
    return pageCount;
  }

  async reorderPages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const sourcePageCount = await this.pageCount(document);
    assertCompletePageSet(pageIndexes, sourcePageCount);

    const bytes = await this.postRearrange(storedDocument.bytes, pageIndexes);

    return this.store(bytes, sourcePageCount);
  }

  async rotatePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
    degrees: number,
  ): Promise<PdfDocumentHandle> {
    assertSupportedRotation(degrees);

    const storedDocument = this.get(document);
    const sourcePageCount = await this.pageCount(document);
    assertPageIndexes(pageIndexes, sourcePageCount);

    if (pageIndexes.length === 0 || normalizeRotation(degrees) === 0) {
      return this.store(storedDocument.bytes, sourcePageCount);
    }

    const selectedPages = new Set(pageIndexes);

    if (selectedPages.size === sourcePageCount) {
      return this.store(
        await this.postRotate(storedDocument.bytes, normalizeRotation(degrees)),
        sourcePageCount,
      );
    }

    const pageBytes: Uint8Array[] = [];

    for (let pageIndex = 0; pageIndex < sourcePageCount; pageIndex += 1) {
      let bytes = await this.postRearrange(storedDocument.bytes, [pageIndex]);

      if (selectedPages.has(pageIndex)) {
        bytes = await this.postRotate(bytes, normalizeRotation(degrees));
      }

      pageBytes.push(bytes);
    }

    return this.store(await this.postMerge(pageBytes), sourcePageCount);
  }

  async deletePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const sourcePageCount = await this.pageCount(document);
    assertPageIndexes(pageIndexes, sourcePageCount);

    const deletedPages = new Set(pageIndexes);
    const outputPageCount = sourcePageCount - deletedPages.size;

    if (outputPageCount === 0) {
      throw new PdfEngineError(
        "EMPTY_RESULT",
        "Delete operations must leave at least one page.",
      );
    }

    if (deletedPages.size === 0) {
      return this.store(storedDocument.bytes, sourcePageCount);
    }

    const formData = createFormData(storedDocument.bytes);
    formData.append("pageNumbers", toOneBasedPageNumbers([...deletedPages]));

    const response = await this.request("/api/v1/general/remove-pages", formData);

    return this.store(await readBytes(response), outputPageCount);
  }

  async cropPages(
    _document: PdfDocumentHandle,
    _pageIndexes: readonly number[],
    _marginIn: number,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Sidecar crop operations are unsupported until the Stirling PDF crop endpoint contract is verified.",
    );
  }

  async resizePages(
    _document: PdfDocumentHandle,
    _pageIndexes: readonly number[],
    _pageSize: PdfPageSizePoints,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Sidecar resize operations are unsupported until the Stirling PDF scale-pages endpoint contract is verified.",
    );
  }

  async insertPages(
    document: PdfDocumentHandle,
    insertAtPageIndex: number,
    fromOtherDocument: PdfDocumentHandle,
  ): Promise<PdfDocumentHandle> {
    const target = this.get(document);
    const inserted = this.get(fromOtherDocument);
    const targetPageCount = await this.pageCount(document);
    const insertedPageCount = await this.pageCount(fromOtherDocument);
    assertInsertIndex(insertAtPageIndex, targetPageCount);

    const mergedBytes = await this.postMerge([target.bytes, inserted.bytes]);
    const outputPageCount = targetPageCount + insertedPageCount;

    if (insertAtPageIndex === targetPageCount) {
      return this.store(mergedBytes, outputPageCount);
    }

    const mergedPageIndexes = [
      ...range(0, insertAtPageIndex),
      ...range(targetPageCount, outputPageCount),
      ...range(insertAtPageIndex, targetPageCount),
    ];

    return this.store(await this.postRearrange(mergedBytes, mergedPageIndexes), outputPageCount);
  }

  async merge(documents: readonly PdfDocumentHandle[]): Promise<PdfDocumentHandle> {
    if (documents.length === 0) {
      throw new PdfEngineError("EMPTY_INPUT", "At least one document is required.");
    }

    const storedDocuments = documents.map((document) => this.get(document));
    const pageCounts = await Promise.all(documents.map((document) => this.pageCount(document)));

    return this.store(
      await this.postMerge(storedDocuments.map((document) => document.bytes)),
      sum(pageCounts),
    );
  }

  async stampText(
    document: PdfDocumentHandle,
    options: PdfStampTextOptions,
  ): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const normalizedOptions = normalizeStampOptions(options);
    assertPageSelection(normalizedOptions.pageIndexes, pageCount);

    const formData = createFormData(storedDocument.bytes);
    formData.append("pageNumbers", toSidecarPageNumbers(normalizedOptions.pageIndexes));
    formData.append("stampType", "text");
    formData.append("stampText", normalizedOptions.text);
    formData.append("fontSize", String(normalizedOptions.fontSizePt));
    formData.append("rotation", "0");
    formData.append("opacity", "1");
    formData.append("position", toSidecarStampPosition(normalizedOptions.placement));
    formData.append("customMargin", toSidecarCustomMargin(normalizedOptions.marginIn));
    formData.append("customColor", "#141414");

    const response = await this.request("/api/v1/misc/add-stamp", formData);

    return this.store(await readBytes(response), pageCount);
  }

  async buildBinder(
    _main: PdfDocumentHandle,
    _exhibits: readonly PdfBinderExhibit[],
    _options: PdfBinderOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Sidecar binder creation is unsupported because Stirling PDF cannot create caller-defined exhibit outline entries.",
    );
  }

  async ocr(
    document: PdfDocumentHandle,
    options: SidecarOcrOptions = {},
  ): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const formData = createFormData(storedDocument.bytes);
    const languages = options.languages?.length ? options.languages : ["eng"];

    for (const language of languages) {
      formData.append("languages", language);
    }

    formData.append("ocrType", options.ocrType ?? "skip-text");
    formData.append("ocrRenderType", "sandwich");
    formData.append("sidecar", "false");
    formData.append("deskew", String(options.deskew ?? false));

    const response = await this.request("/api/v1/misc/ocr-pdf", formData);

    return this.store(await readBytes(response), pageCount);
  }

  async saveToBytes(document: PdfDocumentHandle): Promise<Uint8Array> {
    return new Uint8Array(this.get(document).bytes);
  }

  private get(document: PdfDocumentHandle): StoredDocument {
    const storedDocument = this.documents.get(document);

    if (!storedDocument) {
      throw new PdfEngineError("DOCUMENT_NOT_FOUND", "Document handle was not found.");
    }

    return storedDocument;
  }

  private store(bytes: Uint8Array, pageCount?: number): PdfDocumentHandle {
    const handle = `sidecar-pdf:${this.nextDocumentId}` as PdfDocumentHandle;
    this.nextDocumentId += 1;
    this.documents.set(handle, {
      bytes: new Uint8Array(bytes),
      ...(pageCount !== undefined ? { pageCount } : {}),
    });

    return handle;
  }

  private async fetchPageCount(bytes: Uint8Array): Promise<number> {
    const formData = createFormData(bytes);
    const response = await this.request("/api/v1/analysis/basic-info", formData);
    const body = await readJson(response);
    const pageCount = readPageCount(body);

    if (pageCount === null) {
      throw new PdfEngineError(
        "INVALID_DOCUMENT",
        "Stirling PDF did not return a readable page count.",
      );
    }

    return pageCount;
  }

  private async postRearrange(
    bytes: Uint8Array,
    pageIndexes: readonly number[],
  ): Promise<Uint8Array> {
    const formData = createFormData(bytes);
    formData.append("pageNumbers", toOneBasedPageNumbers(pageIndexes));
    formData.append("customMode", "CUSTOM");

    const response = await this.request("/api/v1/general/rearrange-pages", formData);

    return readBytes(response);
  }

  private async postRotate(bytes: Uint8Array, angle: number): Promise<Uint8Array> {
    const formData = createFormData(bytes);
    formData.append("angle", String(angle));

    const response = await this.request("/api/v1/general/rotate-pdf", formData);

    return readBytes(response);
  }

  private async postMerge(documents: readonly Uint8Array[]): Promise<Uint8Array> {
    const formData = new FormData();

    documents.forEach((bytes, index) => {
      formData.append("fileInput", createPdfBlob(bytes), `document-${index + 1}.pdf`);
    });
    formData.append("sortType", "orderProvided");
    formData.append("removeCertSign", "true");
    formData.append("generateToc", "false");

    const response = await this.request("/api/v1/general/merge-pdfs", formData);

    return readBytes(response);
  }

  private async request(path: string, body: FormData): Promise<Response> {
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        body,
      });
    } catch (error) {
      throw new PdfEngineError("INVALID_DOCUMENT", "Stirling PDF request failed.", {
        cause: error,
      });
    }

    if (!response.ok) {
      await throwResponseError(response);
    }

    return response;
  }
}

export function createSidecarPdfEngine(options: SidecarPdfEngineOptions): PdfEngine {
  return new SidecarPdfEngine(options);
}

function createFormData(bytes: Uint8Array): FormData {
  const formData = new FormData();
  formData.append("fileInput", createPdfBlob(bytes), "document.pdf");

  return formData;
}

function createPdfBlob(bytes: Uint8Array): Blob {
  return new Blob([toArrayBuffer(bytes)], { type: "application/pdf" });
}

function normalizeBytes(bytes: PdfBytes): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return new Uint8Array(bytes);
  }

  return new Uint8Array(bytes.slice(0));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeStampOptions(options: PdfStampTextOptions): Required<PdfStampTextOptions> {
  if (options.text.length === 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Stamp text must not be empty.");
  }

  const fontSizePt = options.fontSizePt ?? DEFAULT_FONT_SIZE_PT;
  const marginIn = options.marginIn ?? DEFAULT_MARGIN_IN;

  if (!Number.isFinite(fontSizePt) || fontSizePt <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "fontSizePt must be a positive number.");
  }

  if (!Number.isFinite(marginIn) || marginIn <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "marginIn must be a positive number.");
  }

  return {
    text: options.text,
    pageIndexes: options.pageIndexes,
    placement: options.placement,
    fontSizePt,
    marginIn,
  };
}

function toSidecarStampPosition(placement: PdfStampPlacement): string {
  const rowOffset = placement.edge === "header" ? 0 : 6;
  const columnOffset = placement.align === "left" ? 1 : placement.align === "center" ? 2 : 3;

  return String(rowOffset + columnOffset);
}

function toSidecarCustomMargin(marginIn: number): string {
  if (marginIn <= 0.25) {
    return "small";
  }

  if (marginIn <= DEFAULT_MARGIN_IN) {
    return "medium";
  }

  return "large";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes);

  return copy.buffer;
}

async function readBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Stirling PDF returned invalid JSON.", {
      cause: error,
    });
  }
}

function readPageCount(body: unknown): number | null {
  const value = findProperty(body, [
    "pageCount",
    "page_count",
    "pages",
    "Pages",
    "Page Count",
    "Number of Pages",
    "numberOfPages",
  ]);

  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function findProperty(body: unknown, propertyNames: readonly string[]): unknown {
  if (!isRecord(body)) {
    return undefined;
  }

  for (const propertyName of propertyNames) {
    if (propertyName in body) {
      return body[propertyName];
    }
  }

  for (const value of Object.values(body)) {
    const nested = findProperty(value, propertyNames);

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function readStringProperty(body: unknown, propertyName: string): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const value = body[propertyName];

  return typeof value === "string" ? value : undefined;
}

async function throwResponseError(response: Response): Promise<never> {
  const errorBody = await readErrorBody(response);
  const message = readErrorMessage(errorBody) ?? response.statusText;
  const code = mapHttpStatusToErrorCode(response.status, message);

  throw new PdfEngineError(code, `Stirling PDF request failed: ${message}`);
}

async function readErrorBody(response: Response): Promise<StirlingErrorBody | null> {
  try {
    const body = await response.json();

    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function readErrorMessage(errorBody: StirlingErrorBody | null): string | null {
  if (!errorBody) {
    return null;
  }

  if (typeof errorBody.message === "string") {
    return errorBody.message;
  }

  if (typeof errorBody.error === "string") {
    return errorBody.error;
  }

  return null;
}

function mapHttpStatusToErrorCode(status: number, message: string): PdfEngineErrorCode {
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes("encrypted") || normalizedMessage.includes("password")) {
    return "ENCRYPTED_DOCUMENT";
  }

  if (normalizedMessage.includes("page")) {
    return "INVALID_PAGE_INDEX";
  }

  // HTTP 404 from the sidecar means a bad endpoint/base URL, not a missing
  // document — DOCUMENT_NOT_FOUND is reserved for local handle lookups.
  return "INVALID_DOCUMENT";
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

function assertPageSelection(selection: PdfPageSelection, pageCount: number): void {
  if (selection === "all" || selection === "first") {
    return;
  }

  assertPageIndexes(selection, pageCount);
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

function toOneBasedPageNumbers(pageIndexes: readonly number[]): string {
  return pageIndexes.map((pageIndex) => String(pageIndex + 1)).join(",");
}

function toSidecarPageNumbers(selection: PdfPageSelection): string {
  if (selection === "all") {
    return "all";
  }

  if (selection === "first") {
    return "1";
  }

  return toOneBasedPageNumbers([...new Set(selection)]);
}

function range(startInclusive: number, endExclusive: number): number[] {
  return Array.from(
    { length: endExclusive - startInclusive },
    (_, index) => startInclusive + index,
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
