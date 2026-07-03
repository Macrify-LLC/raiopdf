import type {
  PdfBatesStampOptions,
  PdfBinderExhibit,
  PdfBinderOptions,
  PdfBytes,
  PdfAConversionOptions,
  PdfCompressOptions,
  PdfDocumentHandle,
  PdfEdit,
  PdfEngine,
  PdfEngineErrorCode,
  PdfImagePageInput,
  PdfNormalizePagesOptions,
  PdfPageSizePoints,
  PdfPageNumbersOptions,
  PdfPageSelection,
  PdfRedactTextOptions,
  PdfRedactionArea,
  PdfSanitizeOptions,
  PdfSanitizeRemovedItem,
  PdfSanitizeResult,
  PdfSplitByMaxBytesResult,
  PdfStampPlacement,
  PdfStampTextOptions,
  PdfTextRegion,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import {
  readPdfAIdentificationFromBytes,
  scrubPdfMetadataBytes,
  type PdfAIdentification,
} from "@raiopdf/engine-pdf-lib";

type Fetch = typeof globalThis.fetch;

type StoredDocument = {
  bytes: Uint8Array;
  pageCount?: number;
};

export type SidecarPdfEngineOptions = {
  authToken?: string;
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
  detail?: unknown;
  error?: unknown;
  errorCode?: unknown;
  message?: unknown;
  status?: unknown;
  title?: unknown;
};

const DEFAULT_FONT_SIZE_PT = 11;
const DEFAULT_MARGIN_IN = 0.5;
const SLASH_CHAR_CODE = "/".charCodeAt(0);

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
 * - redactText -> POST /api/v1/security/auto-redact only when callers pass
 *   rasterize=true. Stirling's auto-redact can fall back to overlay-only output
 *   unless convertPDFToImage=true; rasterization is the guaranteed removal mode
 *   but returns image-based pages without searchable/selectable text.
 * - redactAreas -> POST /api/v1/security/redact-execute with imageBoxes JSON.
 *   RaioPDF `{pageIndex,x,y,w,h}` maps to Stirling
 *   `{pageIndex,x1:x,y1:y+h,x2:x+w,y2:y}` because Stirling names y1 as the
 *   top coordinate and y2 as bottom. `style` is sent as
 *   `{color:"#000000",padding:0,convertToImage:true,
 *   strategy:"IMAGE_FINALIZE"}` to avoid overlay-only redaction.
 * - scrubMetadata -> POST /api/v1/misc/update-metadata with deleteAll=true,
 *   followed by engine-local's low-level Info dictionary and XMP metadata
 *   removal on the returned bytes.
 * - compress -> POST /api/v1/misc/compress-pdf with optimizeLevel,
 *   grayscale, and linearize=false.
 * - sanitize -> POST /api/v1/security/sanitize-pdf with removeJavaScript,
 *   removeEmbeddedFiles, removeLinks, and metadata/font removal disabled.
 * - removeEncryption -> POST /api/v1/security/remove-password with fileInput
 *   and password. Passwords are multipart-only and never stored in document
 *   handles or response metadata.
 * - repair -> POST /api/v1/misc/repair.
 * - batesStamp -> sequential stampText calls, one page at a time.
 * - buildBinder is intentionally unsupported for this engine because Stirling
 *   exposes generated merge TOCs but not caller-defined exhibit outline titles
 *   and destinations. Use the local engine for contract-complete binders.
 * - ocr -> POST /api/v1/misc/ocr-pdf with repeated languages, ocrType,
 *   ocrRenderType=sandwich, sidecar=false, and deskew.
 */
export class SidecarPdfEngine implements PdfEngine {
  private readonly authToken: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly documents = new Map<PdfDocumentHandle, StoredDocument>();
  private nextDocumentId = 1;

  constructor(options: SidecarPdfEngineOptions) {
    this.authToken = options.authToken;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  static async probe(
    baseUrl: string,
    fetchImpl: Fetch = globalThis.fetch,
    authToken?: string,
  ): Promise<SidecarPdfEngineInfo | null> {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    try {
      const response = await fetchImpl(`${normalizedBaseUrl}/api/v1/info/status`, {
        method: "GET",
        headers: sidecarHeaders(authToken, {
          accept: "application/json",
        }),
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

  async removeEncryption(bytes: PdfBytes, password: string): Promise<Uint8Array> {
    const formData = createFormData(normalizeBytes(bytes));
    formData.append("password", password);

    try {
      return await readBytes(await this.request("/api/v1/security/remove-password", formData));
    } catch (error) {
      if (error instanceof PdfEngineError && error.code === "PASSWORD_REQUIRED") {
        if (password.length === 0) {
          throw new PdfEngineError(
            "PASSWORD_REQUIRED",
            "A PDF password is required to remove encryption.",
            { cause: error },
          );
        }

        throw new PdfEngineError(
          "ENCRYPTED_DOCUMENT",
          "The PDF password was not accepted.",
          { cause: error },
        );
      }

      if (error instanceof PdfEngineError && error.code === "ENCRYPTED_DOCUMENT") {
        throw new PdfEngineError(
          "ENCRYPTED_DOCUMENT",
          "The PDF password was not accepted.",
          { cause: error },
        );
      }

      throw error;
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

  async normalizePages(
    _document: PdfDocumentHandle,
    _options: PdfNormalizePagesOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Sidecar page normalization is unsupported until the Stirling PDF scale-pages endpoint contract is verified.",
    );
  }

  async splitByMaxBytes(
    _document: PdfDocumentHandle,
    _maxBytes: number,
  ): Promise<PdfSplitByMaxBytesResult> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Sidecar byte-capped splitting is unsupported; use the local engine for deterministic page-boundary packing.",
    );
  }

  async convertToPdfA(
    document: PdfDocumentHandle,
    options: PdfAConversionOptions,
  ): Promise<PdfDocumentHandle> {
    assertSupportedPdfAFlavor(options.flavor);

    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const formData = createFormData(storedDocument.bytes);
    formData.append("outputFormat", options.flavor);
    formData.append("strict", String(options.strict ?? false));

    const response = await this.request("/api/v1/convert/pdf/pdfa", formData);

    return this.store(await readBytes(response), pageCount);
  }

  async compress(
    document: PdfDocumentHandle,
    options: PdfCompressOptions,
  ): Promise<PdfDocumentHandle> {
    assertCompressOptions(options);

    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const formData = createFormData(storedDocument.bytes);
    formData.append("optimizeLevel", String(options.quality));
    formData.append("grayscale", String(options.grayscale ?? false));
    formData.append("linearize", "false");

    const response = await this.request("/api/v1/misc/compress-pdf", formData);

    return this.store(await readBytes(response), pageCount);
  }

  async sanitize(
    document: PdfDocumentHandle,
    options: PdfSanitizeOptions = {},
  ): Promise<PdfSanitizeResult> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const normalizedOptions = normalizeSanitizeOptions(options);
    const formData = createFormData(storedDocument.bytes);
    formData.append("removeJavaScript", String(normalizedOptions.removeJavaScript));
    formData.append("removeEmbeddedFiles", String(normalizedOptions.removeEmbeddedFiles));
    formData.append("removeLinks", String(normalizedOptions.removeLinks));
    formData.append("removeMetadata", "false");
    formData.append("removeXMPMetadata", "false");
    formData.append("removeFonts", "false");

    const response = await this.request("/api/v1/security/sanitize-pdf", formData);

    return {
      document: this.store(await readBytes(response), pageCount),
      removed: getSanitizeRemovedItems(normalizedOptions),
    };
  }

  async repair(document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const bytes = await this.repairBytes(storedDocument.bytes);

    return this.store(bytes, pageCount);
  }

  async repairBytes(bytes: PdfBytes): Promise<Uint8Array> {
    const response = await this.request("/api/v1/misc/repair", createFormData(normalizeBytes(bytes)));

    return readBytes(response);
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

  async redactAreas(
    document: PdfDocumentHandle,
    areas: readonly PdfRedactionArea[],
  ): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    assertRedactionAreas(areas, pageCount);

    if (areas.length === 0) {
      return this.store(storedDocument.bytes, pageCount);
    }

    const formData = createFormData(storedDocument.bytes);
    formData.append("imageBoxes", JSON.stringify(areas.map(toSidecarImageBox)));
    formData.append(
      "style",
      JSON.stringify({
        color: "#000000",
        padding: 0,
        convertToImage: true,
        strategy: "IMAGE_FINALIZE",
      }),
    );

    const response = await this.request("/api/v1/security/redact-execute", formData);

    return this.store(await scrubReturnedMetadata(await readBytes(response)), pageCount);
  }

  async redactText(
    document: PdfDocumentHandle,
    options: PdfRedactTextOptions,
  ): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    assertRedactTextOptions(options);
    assertRasterizedTextRedaction(options);

    const formData = createFormData(storedDocument.bytes);
    formData.append("listOfText", options.terms.join("\n"));
    formData.append("useRegex", "false");
    formData.append("wholeWordSearch", String(options.wholeWord ?? false));
    formData.append("redactColor", "#000000");
    formData.append("customPadding", "0");
    formData.append("convertPDFToImage", "true");

    const response = await this.request("/api/v1/security/auto-redact", formData);

    return this.store(await scrubReturnedMetadata(await readBytes(response)), pageCount);
  }

  async scrubMetadata(document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const formData = createFormData(storedDocument.bytes);
    formData.append("deleteAll", "true");

    // Capture the PDF/A identification from the INPUT — Stirling's deleteAll pass may
    // strip the XMP packet before the post-scrub ever sees it. Florida's ePortal
    // conformity check fails a PDF/A file whose identification metadata was scrubbed,
    // so the claim (and only the claim) is restored during the post-scrub. The local
    // read overlaps the sidecar round trip.
    const [identification, response] = await Promise.all([
      readPdfAIdentificationFromBytes(storedDocument.bytes).catch(() => null),
      this.request("/api/v1/misc/update-metadata", formData),
    ]);

    return this.store(
      await scrubReturnedMetadata(await readBytes(response), identification ?? false),
      pageCount,
    );
  }

  async extractTextRegions(
    _document: PdfDocumentHandle,
    _areas: readonly PdfRedactionArea[],
  ): Promise<readonly PdfTextRegion[]> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Region text extraction is unavailable in the sidecar engine; verify redaction output with pdf.js.",
    );
  }

  async batesStamp(
    document: PdfDocumentHandle,
    options: PdfBatesStampOptions,
  ): Promise<PdfDocumentHandle> {
    const pageCount = await this.pageCount(document);
    const normalizedOptions = normalizeBatesOptions(options);
    assertBatesFitsPageCount(normalizedOptions, pageCount);
    let stampedDocument = document;

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

      stampedDocument = await this.stampText(stampedDocument, stampOptions);
    }

    return stampedDocument;
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

  async pageNumbers(
    _document: PdfDocumentHandle,
    _options: PdfPageNumbersOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Simple page numbering is handled by the local pdf-lib engine for deterministic page-by-page stamping.",
    );
  }

  async watermark(
    _document: PdfDocumentHandle,
    _options: PdfWatermarkOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Watermarking is handled by the local pdf-lib engine so text placement stays rotation-aware.",
    );
  }

  async insertImagePages(
    _document: PdfDocumentHandle,
    _insertAtPageIndex: number,
    _images: readonly PdfImagePageInput[],
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Image-page insertion is handled by the local pdf-lib engine.",
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

  /**
   * Add-content editing is intentionally unsupported on the sidecar engine.
   *
   * The client-side pdf-lib engine (`@raiopdf/engine-local`) is the canonical
   * `applyEdits` implementation: edits are composed from in-app overlay state,
   * and a Stirling PDF round-trip would add network latency and multipart
   * plumbing without adding any capability pdf-lib lacks.
   */
  async applyEdits(
    _document: PdfDocumentHandle,
    _edits: readonly PdfEdit[],
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Add-content edits are applied by the local pdf-lib engine; the sidecar round-trip adds nothing.",
    );
  }

  /**
   * Form flattening is intentionally unsupported on the sidecar engine for the
   * same reason as `applyEdits`: pdf-lib's `form.flatten()` in the local
   * engine is the canonical implementation, and the server round-trip adds
   * nothing.
   */
  async flattenForm(_document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Form flattening is handled by the local pdf-lib engine; the sidecar round-trip adds nothing.",
    );
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
        headers: sidecarHeaders(this.authToken),
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

function sidecarHeaders(
  authToken: string | undefined,
  headers: Record<string, string> = {},
): Record<string, string> {
  if (!authToken) {
    return headers;
  }

  return {
    ...headers,
    "X-RaioPDF-Auth": authToken,
  };
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
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }

  return baseUrl.slice(0, end);
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

function assertCompressOptions(options: PdfCompressOptions): void {
  if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 9) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "Compression quality must be an integer from 1 through 9.",
    );
  }
}

function normalizeSanitizeOptions(
  options: PdfSanitizeOptions,
): Required<PdfSanitizeOptions> {
  return {
    removeJavaScript: options.removeJavaScript ?? true,
    removeEmbeddedFiles: options.removeEmbeddedFiles ?? true,
    removeLinks: options.removeLinks ?? true,
  };
}

function getSanitizeRemovedItems(
  options: Required<PdfSanitizeOptions>,
): PdfSanitizeRemovedItem[] {
  const removed: PdfSanitizeRemovedItem[] = [];

  if (options.removeJavaScript) {
    removed.push("javascript");
  }

  if (options.removeEmbeddedFiles) {
    removed.push("embedded-files");
  }

  if (options.removeLinks) {
    removed.push("external-links");
  }

  return removed;
}

function normalizeBatesOptions(options: PdfBatesStampOptions): PdfBatesStampOptions {
  if (!Number.isInteger(options.start) || options.start < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Bates start must be a non-negative integer.");
  }

  if (!Number.isInteger(options.digits) || options.digits <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Bates digits must be a positive integer.");
  }

  if (options.fontSizePt !== undefined && (!Number.isFinite(options.fontSizePt) || options.fontSizePt <= 0)) {
    throw new PdfEngineError("INVALID_DOCUMENT", "fontSizePt must be a positive number.");
  }

  if (options.marginIn !== undefined && (!Number.isFinite(options.marginIn) || options.marginIn <= 0)) {
    throw new PdfEngineError("INVALID_DOCUMENT", "marginIn must be a positive number.");
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

function assertRedactTextOptions(options: PdfRedactTextOptions): void {
  const hasTerm = options.terms.some((term) => term.trim().length > 0);

  if (!hasTerm) {
    throw new PdfEngineError("INVALID_DOCUMENT", "At least one redaction term is required.");
  }
}

function assertRasterizedTextRedaction(options: PdfRedactTextOptions): void {
  if (options.rasterize !== true) {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "Sidecar text redaction requires rasterize=true so Stirling removes recoverable text by converting pages to images.",
    );
  }
}

function assertRedactionAreas(areas: readonly PdfRedactionArea[], pageCount: number): void {
  assertPageIndexes(areas.map((area) => area.pageIndex), pageCount);

  for (const area of areas) {
    assertNonNegativeFinite(area.x, "x");
    assertNonNegativeFinite(area.y, "y");
    assertPositiveFinite(area.w, "w");
    assertPositiveFinite(area.h, "h");
  }
}

function assertNonNegativeFinite(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${fieldName} must be a non-negative number.`);
  }
}

function assertPositiveFinite(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${fieldName} must be a positive number.`);
  }
}

function toSidecarImageBox(area: PdfRedactionArea): {
  pageIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  return {
    pageIndex: area.pageIndex,
    x1: area.x,
    y1: area.y + area.h,
    x2: area.x + area.w,
    y2: area.y,
  };
}

// Defaults to a maximal scrub: redaction outputs are rasterized rewrites, so any
// PDF/A conformance the input claimed no longer holds and is deliberately dropped.
// The scrubMetadata path passes the identification it captured from input bytes.
async function scrubReturnedMetadata(
  bytes: Uint8Array,
  preservePdfAIdentification: boolean | PdfAIdentification = false,
): Promise<Uint8Array> {
  try {
    return await scrubPdfMetadataBytes(bytes, { preservePdfAIdentification });
  } catch (error) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "Metadata scrub returned PDF bytes that could not be post-processed.",
      { cause: error },
    );
  }
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
  const errorCode = readErrorCode(errorBody);
  const code = mapHttpStatusToErrorCode(response.status, message, errorCode);
  const detail = errorCode ? `${message} (${errorCode})` : message;

  throw new PdfEngineError(code, `Stirling PDF request failed: ${detail}`);
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

  if (typeof errorBody.detail === "string") {
    return errorBody.detail;
  }

  if (typeof errorBody.message === "string") {
    return errorBody.message;
  }

  if (typeof errorBody.error === "string") {
    return errorBody.error;
  }

  if (typeof errorBody.title === "string") {
    return errorBody.title;
  }

  return null;
}

function readErrorCode(errorBody: StirlingErrorBody | null): string | null {
  return typeof errorBody?.errorCode === "string" ? errorBody.errorCode : null;
}

function mapHttpStatusToErrorCode(
  status: number,
  message: string,
  errorCode: string | null,
): PdfEngineErrorCode {
  const normalizedMessage = message.toLowerCase();
  const normalizedErrorCode = errorCode?.toLowerCase() ?? "";

  if (normalizedErrorCode === "e004") {
    return "PASSWORD_REQUIRED";
  }

  if (
    normalizedMessage.includes("unsupported encryption") ||
    normalizedMessage.includes("unsupported security") ||
    normalizedMessage.includes("unsupported protection")
  ) {
    return "UNSUPPORTED_ENCRYPTION";
  }

  if (normalizedMessage.includes("encrypted") || normalizedMessage.includes("password")) {
    return "ENCRYPTED_DOCUMENT";
  }

  if (
    status === 403 ||
    normalizedErrorCode.includes("disabled") ||
    (normalizedMessage.includes("endpoint") && normalizedMessage.includes("disabled"))
  ) {
    return "UNSUPPORTED";
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

function assertSupportedPdfAFlavor(flavor: PdfAConversionOptions["flavor"]): void {
  if (flavor !== "pdfa-1" && flavor !== "pdfa-2b" && flavor !== "pdfa-3b") {
    throw new PdfEngineError("INVALID_DOCUMENT", "Unsupported PDF/A flavor.");
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
