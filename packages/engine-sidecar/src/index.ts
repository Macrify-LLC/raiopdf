import type {
  PdfBatesStampOptions,
  PdfBinderExhibit,
  PdfBinderOptions,
  PdfBytes,
  PdfAConversionOptions,
  PdfApplyEditsOptions,
  PdfCompressOptions,
  PdfCoverPageOptions,
  PdfDocumentHandle,
  PdfEdit,
  PdfEngine,
  PdfEngineErrorCode,
  PdfImagePageInput,
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
  PdfReplaceTextWarning,
  PdfReplaceSelectedTextOptions,
  PdfReplaceSelectedTextResult,
  PdfRedactTextOptions,
  PdfRedactionArea,
  PdfSanitizeOptions,
  PdfSanitizeRemovedItem,
  PdfSanitizeResult,
  PdfInspectTextMapOptions,
  PdfInspectTextMapResult,
  PdfTextMapElement,
  PdfTextMapPage,
  PdfSplitByMaxBytesResult,
  PdfStampPlacement,
  PdfStampTextOptions,
  PdfTextRegion,
  PdfUpdateAnnotationOptions,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import { PdfEngineError } from "@raiopdf/engine-api";
import {
  countEmbeddedFiles,
  countPdfPages,
  countSignedSignatureFields,
  createPdfOutlinePageItem,
  mapPdfOutlineItems,
  offsetPdfOutlineItems,
  prefixPdfOutlineItemIds,
  readPdfAIdentificationFromBytes,
  readPdfOutline,
  restoreEmbeddedFiles,
  scrubPdfMetadataBytes,
  stripPdfAIdentificationBytes,
  type PdfAIdentification,
  writePdfOutlineInPlace,
} from "@raiopdf/engine-pdf-lib";
import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
} from "pdf-lib";

type Fetch = typeof globalThis.fetch;

type StoredDocument = {
  bytes: Uint8Array;
  pageCount?: number;
};

type TextEditorDocument = {
  pages?: unknown;
};

type TextEditorPage = {
  height?: unknown;
  pageNumber?: unknown;
  textElements?: unknown;
  width?: unknown;
};

type TextEditorTextElement = {
  height?: unknown;
  text?: unknown;
  textMatrix?: unknown;
  width?: unknown;
  x?: unknown;
  y?: unknown;
};

type TextRewritePreflight = {
  inputBaseFonts: ReadonlySet<string>;
  pdfAIdentification: PdfAIdentification | null;
  sourceAttachmentCount: number;
  warnings: PdfReplaceTextWarning[];
};

type LocalRequestOptions = {
  signal?: AbortSignal;
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
  pageIndexes?: readonly number[];
  jobToken?: string;
  signal?: AbortSignal;
}

export interface SidecarOcrBytesOptions extends SidecarOcrOptions {
  knownPageCount?: number;
}

export type SidecarOcrBytesResult = {
  bytes: Uint8Array;
  pageCount: number;
};

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
 * - pageCount -> local PDF parse first, then POST /api/v1/analysis/basic-info fallback.
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
 * - replaceText -> POST /api/v1/general/edit-text with ordered literal
 *   find/replace operations, wholeWordSearch, and optional 1-based pageNumbers.
 *   Stirling regenerates the whole document, does not reflow text, can miss
 *   multi-word finds when words are spaced positionally, reports counts only in
 *   logs, and may re-lay out whole pages when fallback fonts are needed. The
 *   sidecar preflights encryption/signatures/PDF-A, restores bookmarks and
 *   embedded files, warns for dropped tags, and relies on the bundled patched
 *   engine's image-stream passthrough.
 * - redactAreas -> POST /local/redact-areas (engine-local verified raster redaction)
 *   RaioPDF `{pageIndex,x,y,w,h}` maps to Stirling
 *   `{pageIndex,x1:x,y1:y+h,x2:x+w,y2:y}` because Stirling names y1 as the
 *   top coordinate and y2 as bottom. `style` is sent as
 *   `{color:"#000000",padding:0,convertToImage:true,
 *   strategy:"IMAGE_FINALIZE"}` to avoid overlay-only redaction.
 * - scrubMetadata -> POST /api/v1/misc/update-metadata with deleteAll=true,
 *   followed by engine-local's low-level Info dictionary and XMP metadata
 *   removal on the returned bytes.
 * - compress -> POST /local/compress (engine-local qpdf) with the PDF body as
 *   base64 text. Auth remains a small header for the proxy's preflight path;
 *   large PDF bytes never travel in headers.
 * - sanitize -> POST /api/v1/security/sanitize-pdf with removeJavaScript,
 *   removeEmbeddedFiles, removeLinks, and metadata/font removal disabled.
 * - removeEncryption -> POST /local/decrypt (engine-local qpdf) with the raw PDF
 *   body as base64 text and the password hex-encoded in a loopback query param. Stirling's
 *   /remove-password is lossy (drops the text layer) so it is never used; the
 *   password never touches a command line or document handle.
 * - convertToPdfA -> POST /local/pdfa (engine-local Ghostscript) with the raw PDF
 *   body as base64 text and PDF/A options in loopback query params. Stirling
 *   2.14.0 gates /api/v1/convert/pdf/pdfa behind LibreOffice, which is not
 *   bundled, so the conversion runs on the bundled Ghostscript instead.
 * - repair -> POST /api/v1/misc/repair.
 * - batesStamp -> sequential stampText calls, one page at a time.
 * - buildBinder is intentionally unsupported for this engine because Stirling
 *   exposes generated merge TOCs but not caller-defined exhibit outline titles
 *   and destinations. Use the local engine for contract-complete binders.
 * - buildCoverPage is intentionally unsupported for this engine because case
 *   captions are generated locally without a source document or sidecar upload.
 * - ocr -> POST /local/ocr (engine-local OCRmyPDF) with the raw PDF body
 *   base64-encoded. This avoids the WebView -> auth proxy -> Stirling
 *   multipart upload path, which is fragile for force-OCR on large PDFs.
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
    // Native fetch must not be stored bare: `this.fetchImpl(...)` invokes it
    // with the engine instance as receiver, and Chromium throws
    // "Failed to execute 'fetch' on 'Window': Illegal invocation" -- an
    // instant TypeError indistinguishable from a network failure once
    // wrapped. (Node's fetch doesn't enforce the receiver, which is why unit
    // tests never caught this; only the packaged WebView2/browser did.)
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  static async probe(
    baseUrl: string,
    fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init),
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
    // Decrypt with the engine's bundled qpdf (lossless — it strips /Encrypt but
    // keeps the text layer). Stirling's /remove-password is measurably lossy
    // (drops the text layer) and must NOT be used here. The password travels
    // hex-encoded in a header so qpdf never sees it on a command line.
    try {
      return await readBytes(
        await this.requestLocal("/local/decrypt", normalizeBytes(bytes), {
          password_hex: encodePasswordHex(password),
        }),
      );
    } catch (error) {
      if (error instanceof PdfEngineError) {
        // qpdf refused: an empty password means the file genuinely needs one;
        // a supplied password that failed means it was wrong.
        throw new PdfEngineError(
          password.length === 0 ? "PASSWORD_REQUIRED" : "ENCRYPTED_DOCUMENT",
          password.length === 0
            ? "A PDF password is required to remove encryption."
            : "The PDF password was not accepted.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async open(bytes: PdfBytes): Promise<PdfDocumentHandle> {
    const normalizedBytes = normalizeBytes(bytes);
    const pageCount = await this.countPages(normalizedBytes);

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
  ): Promise<PdfOutlineWriteResult> {
    const storedDocument = this.get(document);
    const sourcePageCount = await this.pageCount(document);
    assertCompletePageSet(pageIndexes, sourcePageCount);

    const bytes = await this.postRearrange(storedDocument.bytes, pageIndexes);
    const outline = await preserveReorderedOutline(storedDocument.bytes, bytes, pageIndexes);

    return {
      document: this.store(outline.bytes, sourcePageCount),
      removedTargets: outline.removedTargets,
    };
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
      const bytes = await this.postRotate(storedDocument.bytes, normalizeRotation(degrees));
      const outline = await preserveSamePageOutline(storedDocument.bytes, bytes);

      return this.store(outline.bytes, sourcePageCount);
    }

    const pageBytes: Uint8Array[] = [];

    for (let pageIndex = 0; pageIndex < sourcePageCount; pageIndex += 1) {
      let bytes = await this.postRearrange(storedDocument.bytes, [pageIndex]);

      if (selectedPages.has(pageIndex)) {
        bytes = await this.postRotate(bytes, normalizeRotation(degrees));
      }

      pageBytes.push(bytes);
    }

    const bytes = await this.postMerge(pageBytes);
    const outline = await preserveSamePageOutline(storedDocument.bytes, bytes);

    return this.store(outline.bytes, sourcePageCount);
  }

  async deletePages(
    document: PdfDocumentHandle,
    pageIndexes: readonly number[],
  ): Promise<PdfOutlineWriteResult> {
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
      return {
        document: this.store(storedDocument.bytes, sourcePageCount),
        removedTargets: 0,
      };
    }

    const formData = createFormData(storedDocument.bytes);
    formData.append("pageNumbers", toOneBasedPageNumbers([...deletedPages]));

    const response = await this.request("/api/v1/general/remove-pages", formData);
    const bytes = await readBytes(response);
    const outline = await preserveDeletedOutline(storedDocument.bytes, bytes, [...deletedPages]);

    return {
      document: this.store(outline.bytes, outputPageCount),
      removedTargets: outline.removedTargets,
    };
  }

  async cropPages(
    _document: PdfDocumentHandle,
    _pageIndexes: readonly number[],
    _marginIn: number,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async resizePages(
    _document: PdfDocumentHandle,
    _pageIndexes: readonly number[],
    _pageSize: PdfPageSizePoints,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async normalizePages(
    _document: PdfDocumentHandle,
    _options: PdfNormalizePagesOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async splitByMaxBytes(
    _document: PdfDocumentHandle,
    _maxBytes: number,
  ): Promise<PdfSplitByMaxBytesResult> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async convertToPdfA(
    document: PdfDocumentHandle,
    options: PdfAConversionOptions,
  ): Promise<PdfDocumentHandle> {
    assertSupportedPdfAFlavor(options.flavor);

    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    // Stirling 2.14.0 gates /api/v1/convert/pdf/pdfa behind the LibreOffice
    // (soffice) dependency group, which RaioPDF doesn't bundle — so that endpoint
    // is always disabled in the payload. Convert with the bundled Ghostscript via
    // the engine's local /local/pdfa interceptor instead: same underlying engine
    // Stirling would use, fully on-device.
    const response = await this.requestLocal(
      "/local/pdfa",
      normalizeBytes(storedDocument.bytes),
      {
        pdfa_level: PDFA_LEVEL_BY_FLAVOR[options.flavor],
        pdfa_strict: String(options.strict ?? false),
      },
    );

    return this.store(await readBytes(response), pageCount);
  }

  async compress(
    document: PdfDocumentHandle,
    options: PdfCompressOptions,
  ): Promise<PdfDocumentHandle> {
    assertCompressOptions(options);

    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    // Byte-mode compression uses the same qpdf-backed local path as streamed
    // documents. The quality/grayscale options are accepted for API stability;
    // image recompression is intentionally not delegated to Stirling's optional
    // ImageMagick-dependent endpoint.
    const response = await this.requestLocal(
      "/local/compress",
      normalizeBytes(storedDocument.bytes),
      {},
    );

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
    options: PdfInsertPagesOptions = {},
  ): Promise<PdfOutlineWriteResult> {
    const target = this.get(document);
    const inserted = this.get(fromOtherDocument);
    const targetPageCount = await this.pageCount(document);
    const insertedPageCount = await this.pageCount(fromOtherDocument);
    assertInsertIndex(insertAtPageIndex, targetPageCount);

    const mergedBytes = await this.postMerge([target.bytes, inserted.bytes]);
    const outputPageCount = targetPageCount + insertedPageCount;
    let bytes = mergedBytes;

    if (insertAtPageIndex === targetPageCount) {
      const outline = await preserveInsertedOutline(
        target.bytes,
        inserted.bytes,
        bytes,
        insertAtPageIndex,
        options.sourceLabel ?? "Inserted document",
      );

      return {
        document: this.store(outline.bytes, outputPageCount),
        removedTargets: outline.removedTargets,
      };
    }

    const mergedPageIndexes = [
      ...range(0, insertAtPageIndex),
      ...range(targetPageCount, outputPageCount),
      ...range(insertAtPageIndex, targetPageCount),
    ];
    bytes = await this.postRearrange(mergedBytes, mergedPageIndexes);
    const outline = await preserveInsertedOutline(
      target.bytes,
      inserted.bytes,
      bytes,
      insertAtPageIndex,
      options.sourceLabel ?? "Inserted document",
    );

    return {
      document: this.store(outline.bytes, outputPageCount),
      removedTargets: outline.removedTargets,
    };
  }

  async merge(
    documents: readonly PdfDocumentHandle[],
    options: PdfMergeOptions = {},
  ): Promise<PdfOutlineWriteResult> {
    if (documents.length === 0) {
      throw new PdfEngineError("EMPTY_INPUT", "At least one document is required.");
    }

    const storedDocuments = documents.map((document) => this.get(document));
    const pageCounts = await Promise.all(documents.map((document) => this.pageCount(document)));

    const bytes = await this.postMerge(storedDocuments.map((document) => document.bytes));
    const outline = await preserveMergedOutline(
      storedDocuments.map((document) => document.bytes),
      bytes,
      options.labels,
    );

    return {
      document: this.store(outline.bytes, sum(pageCounts)),
      removedTargets: outline.removedTargets,
    };
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

    const response = await this.requestLocal(
      "/local/redact-areas",
      JSON.stringify({
        pdfBase64: bytesToBase64(normalizeBytes(storedDocument.bytes)),
        areas,
      }),
    );

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

  async replaceText(
    document: PdfDocumentHandle,
    options: PdfReplaceTextOptions,
  ): Promise<PdfReplaceTextResult> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const pageIndexes = options.pageIndexes ?? "all";
    assertReplaceTextOptions(options);
    assertPageSelection(pageIndexes, pageCount);

    if (Array.isArray(pageIndexes) && pageIndexes.length === 0) {
      return {
        document: this.store(storedDocument.bytes, pageCount),
        replacedCounts: null,
        warnings: [],
      };
    }

    const preflight = await this.prepareTextRewrite(storedDocument, options);

    const formData = createFormData(storedDocument.bytes);
    formData.append("edits", JSON.stringify(options.operations));
    formData.append("wholeWordSearch", String(options.wholeWord ?? false));
    formData.append("pageNumbers", toSidecarPageNumbers(pageIndexes));

    const response = await this.request("/api/v1/general/edit-text", formData);
    const output = await this.finalizeTextRewriteOutput(
      storedDocument.bytes,
      await readBytes(response),
      preflight,
    );

    // Phase 0 confirmed the bundled engine's image-passthrough patch preserves
    // image streams byte-identically; IMAGES_REENCODED is reserved for unpatched
    // engines and is intentionally not emitted here.
    return {
      document: this.store(output.bytes, pageCount),
      replacedCounts: null,
      warnings: [{
        code: "COUNTS_UNAVAILABLE",
        message: "Your text changes were applied. RaioPDF can't confirm exactly how many matches were replaced.",
      }, ...output.warnings],
    };
  }

  async inspectTextMap(
    document: PdfDocumentHandle,
    options: PdfInspectTextMapOptions = {},
  ): Promise<PdfInspectTextMapResult> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const pageIndexes = options.pageIndexes ?? "all";
    assertPageSelection(pageIndexes, pageCount);

    const textEditorDocument = await this.convertPdfToTextEditorJson(storedDocument.bytes);
    const selectedPageIndexes = resolveSelectedPageIndexes(pageIndexes, pageCount);

    return {
      sourceFingerprint: fingerprintTextEditorDocument(textEditorDocument),
      pages: selectedPageIndexes.map((pageIndex) =>
        textEditorPageToTextMapPage(textEditorDocument, pageIndex)),
    };
  }

  async replaceSelectedText(
    document: PdfDocumentHandle,
    options: PdfReplaceSelectedTextOptions,
  ): Promise<PdfReplaceSelectedTextResult> {
    const storedDocument = this.get(document);
    await refuseEncryptedTextRewrite(storedDocument.bytes);
    const pageCount = await this.pageCount(document);
    assertReplaceSelectedTextOptions(options, pageCount);

    const textEditorDocument = await this.convertPdfToTextEditorJson(storedDocument.bytes);
    applySelectedTextReplacement(textEditorDocument, options);
    const preflight = await this.prepareTextRewrite(storedDocument, options);
    const selectedWarnings = selectedTextWarnings(options);

    const response = await this.request(
      "/api/v1/convert/text-editor/pdf",
      createJsonFormData(textEditorDocument),
    );
    const output = await this.finalizeTextRewriteOutput(
      storedDocument.bytes,
      await readBytes(response),
      preflight,
    );

    return {
      document: this.store(output.bytes, pageCount),
      warnings: [...selectedWarnings, ...output.warnings],
    };
  }

  private async prepareTextRewrite(
    storedDocument: StoredDocument,
    options: Pick<
      PdfReplaceTextOptions | PdfReplaceSelectedTextOptions,
      "allowPdfAIdentificationRemoval" | "allowSignatureInvalidation"
    >,
  ): Promise<TextRewritePreflight> {
    await refuseEncryptedTextRewrite(storedDocument.bytes);

    const [
      signedSignatureFields,
      pdfAIdentification,
      hasTaggedStructure,
      sourceAttachmentCount,
      inputBaseFonts,
    ] = await Promise.all([
      countSignedSignatureFields(storedDocument.bytes),
      readPdfAIdentificationFromBytes(storedDocument.bytes).catch(() => null),
      hasTaggedPdfStructure(storedDocument.bytes),
      countEmbeddedFiles(storedDocument.bytes).catch(() => 0),
      readBaseFontNames(storedDocument.bytes),
    ]);

    const warnings: PdfReplaceTextWarning[] = [];

    if (signedSignatureFields > 0) {
      if (options.allowSignatureInvalidation !== true) {
        throw new PdfEngineError(
          "SIGNED_DOCUMENT",
          "Text editing would invalidate existing PDF signatures.",
        );
      }

      warnings.push({
        code: "SIGNATURES_INVALIDATED",
        message: "Text editing rewrote the PDF and invalidated existing signatures.",
      });
    }

    if (pdfAIdentification) {
      if (options.allowPdfAIdentificationRemoval !== true) {
        throw new PdfEngineError(
          "UNSUPPORTED",
          "Text editing removes PDF/A conformance; retry only after allowing the PDF/A identification to be removed.",
        );
      }
    }

    if (hasTaggedStructure) {
      warnings.push({
        code: "TAGS_REMOVED",
        message: "Text editing removed tagged-PDF accessibility structure that cannot be restored faithfully.",
      });
    }

    return {
      inputBaseFonts,
      pdfAIdentification,
      sourceAttachmentCount,
      warnings,
    };
  }

  private async finalizeTextRewriteOutput(
    sourceBytes: Uint8Array,
    initialOutputBytes: Uint8Array,
    preflight: TextRewritePreflight,
  ): Promise<{ bytes: Uint8Array; warnings: PdfReplaceTextWarning[] }> {
    let outputBytes = initialOutputBytes;
    const warnings = [...preflight.warnings];

    const outline = await preserveSamePageOutline(sourceBytes, outputBytes);
    outputBytes = outline.bytes;

    const attachmentRestore = await restoreEmbeddedFiles(sourceBytes, outputBytes)
      .catch((error: unknown) => ({
        bytes: outputBytes,
        sourceEmbeddedFileCount: preflight.sourceAttachmentCount,
        restoredEmbeddedFileCount: 0,
        error,
      }));
    outputBytes = attachmentRestore.bytes;
    if (
      attachmentRestore.sourceEmbeddedFileCount > 0 &&
      attachmentRestore.restoredEmbeddedFileCount < attachmentRestore.sourceEmbeddedFileCount
    ) {
      warnings.push({
        code: "ATTACHMENTS_REMOVED",
        message: "Text editing removed embedded file attachments that could not be fully restored.",
      });
    }

    if (preflight.pdfAIdentification) {
      outputBytes = await stripPdfAIdentificationBytes(outputBytes);
      warnings.push({
        code: "PDFA_IDENTIFICATION_REMOVED",
        message: "Text editing removed the file's PDF/A identification because the regenerated PDF no longer claims conformance.",
      });
    }

    const outputBaseFonts = await readBaseFontNames(outputBytes).catch(() => new Set<string>());
    if (hasNewNotoBaseFont(preflight.inputBaseFonts, outputBaseFonts)) {
      warnings.push({
        code: "FALLBACK_FONT_POSSIBLE",
        message: "Some text used a substitute font, so a few pages may look slightly different. Review them before relying on the file.",
      });
    }

    return {
      bytes: outputBytes,
      warnings,
    };
  }

  private async convertPdfToTextEditorJson(bytes: Uint8Array): Promise<TextEditorDocument> {
    const response = await this.request(
      "/api/v1/convert/pdf/text-editor",
      createFormData(bytes),
    );
    const body = await readJson(response);

    if (!isRecord(body) || !Array.isArray(body.pages)) {
      throw new PdfEngineError(
        "INVALID_DOCUMENT",
        "The text editor engine returned an invalid text map.",
      );
    }

    return body as TextEditorDocument;
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
      "That operation isn't available for this document.",
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
      "That operation isn't available for this document.",
    );
  }

  async buildCoverPage(
    _options: PdfCoverPageOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async pageNumbers(
    _document: PdfDocumentHandle,
    _options: PdfPageNumbersOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async watermark(
    _document: PdfDocumentHandle,
    _options: PdfWatermarkOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async insertImagePages(
    _document: PdfDocumentHandle,
    _insertAtPageIndex: number,
    _images: readonly PdfImagePageInput[],
  ): Promise<PdfOutlineWriteResult> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async getOutline(document: PdfDocumentHandle): Promise<PdfOutlineState> {
    const storedDocument = this.get(document);
    const pdf = await PDFDocument.load(storedDocument.bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });

    return readPdfOutline(pdf);
  }

  async replaceOutline(
    document: PdfDocumentHandle,
    outline: PdfOutlineState,
  ): Promise<PdfOutlineWriteResult> {
    const storedDocument = this.get(document);
    const pdf = await PDFDocument.load(storedDocument.bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
    writePdfOutlineInPlace(pdf, outline, { preserveSource: pdf });

    return {
      document: this.store(new Uint8Array(await pdf.save()), await this.pageCount(document)),
      removedTargets: 0,
    };
  }

  async ocr(
    document: PdfDocumentHandle,
    options: SidecarOcrOptions = {},
  ): Promise<PdfDocumentHandle> {
    const storedDocument = this.get(document);
    const pageCount = await this.pageCount(document);
    const result = await this.ocrBytes(storedDocument.bytes, {
      ...options,
      knownPageCount: pageCount,
    });

    return this.store(result.bytes, result.pageCount);
  }

  async ocrBytes(
    bytes: PdfBytes,
    options: SidecarOcrBytesOptions = {},
  ): Promise<SidecarOcrBytesResult> {
    const normalizedBytes = normalizeBytes(bytes);
    const pageCount = options.knownPageCount ?? (await this.fetchPageCount(normalizedBytes));
    const response = await this.postOcr(normalizedBytes, options);

    return {
      bytes: await readBytes(response),
      pageCount,
    };
  }

  async cancelLocalJob(jobToken: string): Promise<boolean> {
    const response = await this.requestLocal("/local/cancel", "", {
      job_token: jobToken,
    });
    if (response.status === 204) {
      return true;
    }
    const text = await response.text();

    return text.trim() === "true";
  }

  private async postOcr(bytes: Uint8Array, options: SidecarOcrOptions): Promise<Response> {
    const languages = options.languages?.length ? options.languages : ["eng"];
    const pageIndexes = options.pageIndexes?.length
      ? options.pageIndexes.map((pageIndex) => String(pageIndex)).join(",")
      : undefined;

    return this.requestLocal(
      "/local/ocr",
      bytes,
      {
        ocr_type: normalizeSidecarOcrType(options.ocrType),
        languages: languages.join(","),
        deskew: String(options.deskew ?? false),
        ...(pageIndexes ? { page_indexes: pageIndexes } : {}),
        ...(options.jobToken ? { job_token: options.jobToken } : {}),
      },
      options.signal ? { signal: options.signal } : {},
    );
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
    _options?: PdfApplyEditsOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async readRaioPdfAnnotations(
    _document: PdfDocumentHandle,
  ): Promise<readonly PdfRaioAnnotationImport[]> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async updateAnnotationById(
    _document: PdfDocumentHandle,
    _annotId: string,
    _edit: PdfRaioAnnotationEdit,
    _options?: PdfUpdateAnnotationOptions,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
    );
  }

  async deleteAnnotationById(
    _document: PdfDocumentHandle,
    _annotId: string,
  ): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
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
      "That operation isn't available for this document.",
    );
  }

  async flattenMarkupAnnotations(_document: PdfDocumentHandle): Promise<PdfDocumentHandle> {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
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
        "RaioPDF couldn't read this file's page count. It may be corrupt or unsupported.",
      );
    }

    return pageCount;
  }

  private async countPages(bytes: Uint8Array): Promise<number> {
    try {
      return await countPdfPages(bytes);
    } catch {
      return this.fetchPageCount(bytes);
    }
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
      throw new PdfEngineError("INVALID_DOCUMENT", "RaioPDF's PDF engine couldn't complete that. Try reopening the file.", {
        cause: error,
      });
    }

    if (!response.ok) {
      await throwResponseError(response);
    }

    return response;
  }

  /**
   * POST to a local engine-side handler (not Stirling). Auth uses the same
   * small header as proxied calls so Chromium performs the local-network CORS
   * preflight the proxy is built to answer. Operation metadata stays in
   * loopback-only query params, and binary PDFs are base64 text bodies so large
   * PDF bytes never travel in headers.
   */
  private async requestLocal(
    path: string,
    body: Uint8Array | string,
    query: Record<string, string> = {},
    options: LocalRequestOptions = {},
  ): Promise<Response> {
    let response: Response;
    const url = new URL(`${this.baseUrl}${path}`);
    const requestBody = typeof body === "string" ? body : bytesToBase64(body);
    if (typeof body !== "string") {
      url.searchParams.set("body_encoding", "base64");
    }
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    try {
      const init: RequestInit = {
        method: "POST",
        headers: sidecarHeaders(this.authToken),
        body: requestBody,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      response = await this.fetchImpl(url.href, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw new PdfEngineError("PATH_OP_CANCELLED", "Operation cancelled.", {
          cause: error,
        });
      }
      throw new PdfEngineError("INVALID_DOCUMENT", "RaioPDF couldn't complete that operation. Try reopening the file.", {
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

/** Hex-encode a password for the `X-RaioPDF-Password-Hex` header. Empty → "". */
function encodePasswordHex(password: string): string {
  return Array.from(new TextEncoder().encode(password))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError";
}

function normalizeSidecarOcrType(ocrType: SidecarOcrType | undefined): "skip-text" | "force-ocr" {
  return ocrType === "force-ocr" ? "force-ocr" : "skip-text";
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

function createJsonFormData(document: TextEditorDocument): FormData {
  const formData = new FormData();
  formData.append(
    "fileInput",
    new Blob([JSON.stringify(document)], { type: "application/json" }),
    "document.json",
  );

  return formData;
}

function createPdfBlob(bytes: Uint8Array): Blob {
  return new Blob([toArrayBuffer(bytes)], { type: "application/pdf" });
}

function textEditorPageToTextMapPage(
  document: TextEditorDocument,
  pageIndex: number,
): PdfTextMapPage {
  const page = readTextEditorPage(document, pageIndex);
  const rawElements = readTextEditorTextElements(page, pageIndex);
  const elements: PdfTextMapElement[] = [];
  let text = "";

  rawElements.forEach((element, elementIndex) => {
    const elementText = readTextElementText(element);
    const start = text.length;
    text += elementText;
    const end = text.length;

    elements.push({
      elementIndex,
      start,
      end,
      text: elementText,
      area: textElementArea(pageIndex, element),
    });
  });

  return {
    pageIndex,
    text,
    sourceFingerprint: fingerprintTextEditorElements(rawElements),
    elements,
  };
}

function applySelectedTextReplacement(
  document: TextEditorDocument,
  options: PdfReplaceSelectedTextOptions,
): void {
  const { replacement, target } = options;

  if (fingerprintTextEditorDocument(document) !== target.sourceDocumentFingerprint) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "The selected text target is stale; the source document changed before apply.",
    );
  }

  const page = readTextEditorPage(document, target.pageIndex);
  const elements = readTextEditorTextElements(page, target.pageIndex);
  const textMap = textEditorPageToTextMapPage(document, target.pageIndex);

  if (textMap.sourceFingerprint !== target.sourceFingerprint) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "The selected text target is stale; the source text map changed before apply.",
    );
  }

  if (textMap.text.slice(target.start, target.end) !== target.expectedText) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "The selected text target no longer resolves to the expected text.",
    );
  }

  const first = textMap.elements[target.firstElementIndex];
  const last = textMap.elements[target.lastElementIndex];
  if (!first || !last) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "The selected text target references a missing text element.",
    );
  }

  if (
    target.firstElementOffset < 0 ||
    target.firstElementOffset > first.text.length ||
    target.lastElementOffset < 0 ||
    target.lastElementOffset > last.text.length ||
    target.start !== first.start + target.firstElementOffset ||
    target.end !== last.start + target.lastElementOffset
  ) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "The selected text target offsets do not match the engine text map.",
    );
  }

  const firstRaw = elements[target.firstElementIndex];
  const lastRaw = elements[target.lastElementIndex];
  if (!firstRaw || !lastRaw) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      "The selected text target references a missing raw text element.",
    );
  }

  if (target.firstElementIndex === target.lastElementIndex) {
    const sourceText = readTextElementText(firstRaw);
    firstRaw.text = [
      sourceText.slice(0, target.firstElementOffset),
      replacement,
      sourceText.slice(target.lastElementOffset),
    ].join("");
    return;
  }

  const firstText = readTextElementText(firstRaw);
  firstRaw.text = `${firstText.slice(0, target.firstElementOffset)}${replacement}`;
  for (let index = target.firstElementIndex + 1; index < target.lastElementIndex; index += 1) {
    const element = elements[index];
    if (!element) {
      throw new PdfEngineError(
        "INVALID_DOCUMENT",
        "The selected text target references a missing intermediate text element.",
      );
    }
    element.text = "";
  }
  const lastText = readTextElementText(lastRaw);
  lastRaw.text = lastText.slice(target.lastElementOffset);
}

function readTextEditorPage(document: TextEditorDocument, pageIndex: number): TextEditorPage {
  const pages = Array.isArray(document.pages) ? document.pages : [];
  const page = pages[pageIndex];

  if (!isRecord(page)) {
    throw new PdfEngineError(
      "INVALID_PAGE_INDEX",
      `Text map page ${pageIndex} is outside the returned document range.`,
    );
  }

  return page as TextEditorPage;
}

function readTextEditorTextElements(
  page: TextEditorPage,
  pageIndex: number,
): TextEditorTextElement[] {
  if (!Array.isArray(page.textElements)) {
    throw new PdfEngineError(
      "INVALID_DOCUMENT",
      `Text map page ${pageIndex} does not include text elements.`,
    );
  }

  return page.textElements.map((element) => {
    if (!isRecord(element)) {
      throw new PdfEngineError(
        "INVALID_DOCUMENT",
        `Text map page ${pageIndex} includes a malformed text element.`,
      );
    }

    return element as TextEditorTextElement;
  });
}

function readTextElementText(element: TextEditorTextElement): string {
  return typeof element.text === "string" ? element.text : "";
}

async function refuseEncryptedTextRewrite(bytes: Uint8Array): Promise<void> {
  const hasEncryption = await hasEncryptionDictionary(bytes);

  if (hasEncryption) {
    throw new PdfEngineError(
      "ENCRYPTED_DOCUMENT",
      "Text editing refuses encrypted or permissions-protected PDFs because the engine would strip document protection.",
    );
  }
}

function selectedTextWarnings(options: PdfReplaceSelectedTextOptions): PdfReplaceTextWarning[] {
  if (options.target.firstElementIndex === options.target.lastElementIndex) {
    return [];
  }

  return [{
    code: "SELECTED_TEXT_LAYOUT_RISK",
    message: "This selected-text edit spans multiple PDF text runs; review the affected page for spacing or overlap before applying.",
  }];
}

function textElementArea(pageIndex: number, element: TextEditorTextElement): PdfRedactionArea {
  const matrix = readTextMatrix(element);
  const x = finiteNumber(element.x, matrix?.[4] ?? 0);
  const baselineY = finiteNumber(element.y, matrix?.[5] ?? 0);
  const height = Math.max(0, finiteNumber(element.height, Math.abs(matrix?.[3] ?? 0)));

  return {
    pageIndex,
    x,
    y: baselineY,
    w: Math.max(0, finiteNumber(element.width, 0)),
    h: height,
  };
}

function readTextMatrix(element: TextEditorTextElement): readonly number[] | null {
  if (!Array.isArray(element.textMatrix) || element.textMatrix.length < 6) {
    return null;
  }

  const values = element.textMatrix.map(Number);

  return values.every(Number.isFinite) ? values : null;
}

function fingerprintTextEditorDocument(document: TextEditorDocument): string {
  return fnv1a32Hex(stableStringify(document));
}

function fingerprintTextEditorElements(elements: readonly TextEditorTextElement[]): string {
  return fnv1a32Hex(stableStringify(elements));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function resolveSelectedPageIndexes(selection: PdfPageSelection, pageCount: number): number[] {
  if (selection === "all") {
    return range(0, pageCount);
  }

  if (selection === "first") {
    return pageCount > 0 ? [0] : [];
  }

  return [...new Set(selection)];
}

async function preserveReorderedOutline(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
  pageIndexes: readonly number[],
): Promise<{ bytes: Uint8Array; removedTargets: number }> {
  return preserveOutlineIfReadable(outputBytes, async () => {
    const source = await loadPdfForOutline(sourceBytes);
    const output = await loadPdfForOutline(outputBytes);
    const pageMap = new Map(pageIndexes.map((pageIndex, outputIndex) => [pageIndex, outputIndex]));
    const outline = readPdfOutline(source);
    const mapped = mapPdfOutlineItems(outline.items, (pageIndex) => pageMap.get(pageIndex) ?? null);
    writePdfOutlineInPlace(output, { ...outline, items: mapped.items }, { preserveSource: source });

    return {
      bytes: new Uint8Array(await output.save()),
      removedTargets: mapped.removedTargets,
    };
  });
}

async function preserveDeletedOutline(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
  deletedPages: readonly number[],
): Promise<{ bytes: Uint8Array; removedTargets: number }> {
  return preserveOutlineIfReadable(outputBytes, async () => {
    const source = await loadPdfForOutline(sourceBytes);
    const output = await loadPdfForOutline(outputBytes);
    const deleted = new Set(deletedPages);
    let outputIndex = 0;
    const pageMap = new Map<number, number>();

    for (let sourceIndex = 0; sourceIndex < source.getPageCount(); sourceIndex += 1) {
      if (!deleted.has(sourceIndex)) {
        pageMap.set(sourceIndex, outputIndex);
        outputIndex += 1;
      }
    }

    const outline = readPdfOutline(source);
    const mapped = mapPdfOutlineItems(outline.items, (pageIndex) => pageMap.get(pageIndex) ?? null);
    writePdfOutlineInPlace(output, { ...outline, items: mapped.items }, { preserveSource: source });

    return {
      bytes: new Uint8Array(await output.save()),
      removedTargets: mapped.removedTargets,
    };
  });
}

async function preserveSamePageOutline(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
): Promise<{ bytes: Uint8Array; removedTargets: number }> {
  return preserveOutlineIfReadable(outputBytes, async () => {
    const source = await loadPdfForOutline(sourceBytes);
    const output = await loadPdfForOutline(outputBytes);
    const outline = readPdfOutline(source);
    const mapped = mapPdfOutlineItems(outline.items, (pageIndex) => pageIndex);
    writePdfOutlineInPlace(output, { ...outline, items: mapped.items }, { preserveSource: source });

    return {
      bytes: new Uint8Array(await output.save()),
      removedTargets: mapped.removedTargets,
    };
  });
}

async function preserveInsertedOutline(
  targetBytes: Uint8Array,
  insertedBytes: Uint8Array,
  outputBytes: Uint8Array,
  insertAtPageIndex: number,
  sourceLabel: string,
): Promise<{ bytes: Uint8Array; removedTargets: number }> {
  return preserveOutlineIfReadable(outputBytes, async () => {
    const target = await loadPdfForOutline(targetBytes);
    const inserted = await loadPdfForOutline(insertedBytes);
    const output = await loadPdfForOutline(outputBytes);
    const targetOutline = readPdfOutline(target);
    const targetMapped = mapPdfOutlineItems(targetOutline.items, (pageIndex) =>
      pageIndex < insertAtPageIndex ? pageIndex : pageIndex + inserted.getPageCount());
    const insertedOutline = readPdfOutline(inserted);
    const insertedOffset = offsetPdfOutlineItems(insertedOutline.items, insertAtPageIndex);
    const prefixedInserted = prefixPdfOutlineItemIds(insertedOffset.items, "inserted:");
    const insertedParent = prefixedInserted.length > 0
      ? [createPdfOutlinePageItem({
          id: "inserted:root",
          title: sourceLabel,
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
      bytes: new Uint8Array(await output.save()),
      removedTargets: targetMapped.removedTargets + insertedOffset.removedTargets,
    };
  });
}

async function preserveMergedOutline(
  sourceBytes: readonly Uint8Array[],
  outputBytes: Uint8Array,
  labels: readonly string[] | undefined,
): Promise<{ bytes: Uint8Array; removedTargets: number }> {
  return preserveOutlineIfReadable(outputBytes, async () => {
    const output = await loadPdfForOutline(outputBytes);
    const outlineItems: PdfOutlineItem[] = [];
    const preserveSources: Array<{ pdf: PDFDocument; idPrefix?: string | undefined }> = [];
    let pageOffset = 0;
    let removedTargets = 0;

    for (const [index, bytes] of sourceBytes.entries()) {
      const source = await loadPdfForOutline(bytes);
      const prefix = `merged:${index}:`;
      preserveSources.push({ pdf: source, idPrefix: prefix });
      const outline = readPdfOutline(source);
      const mapped = offsetPdfOutlineItems(outline.items, pageOffset);
      removedTargets += mapped.removedTargets;
      const prefixed = prefixPdfOutlineItemIds(mapped.items, prefix);
      if (prefixed.length > 0) {
        outlineItems.push(createPdfOutlinePageItem({
          id: `${prefix}root`,
          title: labels?.[index] ?? `Merged document ${index + 1}`,
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
      bytes: new Uint8Array(await output.save()),
      removedTargets,
    };
  });
}

async function preserveOutlineIfReadable(
  outputBytes: Uint8Array,
  preserve: () => Promise<{ bytes: Uint8Array; removedTargets: number }>,
): Promise<{ bytes: Uint8Array; removedTargets: number }> {
  try {
    return await preserve();
  } catch (error) {
    if (error instanceof PdfOutlineLoadError) {
      return { bytes: outputBytes, removedTargets: 0 };
    }
    throw error;
  }
}

async function loadPdfForOutline(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
  } catch (error) {
    throw new PdfOutlineLoadError(error);
  }
}

class PdfOutlineLoadError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Could not parse PDF bytes for outline preservation.");
    this.name = "PdfOutlineLoadError";
    this.cause = cause;
  }
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

function assertReplaceTextOptions(options: PdfReplaceTextOptions): void {
  if (options.operations.length === 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "At least one text replacement operation is required.");
  }

  for (const operation of options.operations) {
    if (operation.find.length === 0) {
      throw new PdfEngineError("INVALID_DOCUMENT", "Replacement find text must not be empty.");
    }
  }
}

function assertReplaceSelectedTextOptions(
  options: PdfReplaceSelectedTextOptions,
  pageCount: number,
): void {
  const { target } = options;
  assertPageIndexes([target.pageIndex], pageCount);

  if (
    !Number.isInteger(target.start) ||
    !Number.isInteger(target.end) ||
    target.start < 0 ||
    target.end <= target.start
  ) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Selected text target range is invalid.");
  }

  if (
    !Number.isInteger(target.firstElementIndex) ||
    !Number.isInteger(target.lastElementIndex) ||
    target.firstElementIndex < 0 ||
    target.lastElementIndex < target.firstElementIndex
  ) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Selected text target element indexes are invalid.");
  }

  if (
    !Number.isInteger(target.firstElementOffset) ||
    !Number.isInteger(target.lastElementOffset) ||
    target.firstElementOffset < 0 ||
    target.lastElementOffset < 0
  ) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Selected text target element offsets are invalid.");
  }

  if (!target.sourceFingerprint) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Selected text target fingerprint is required.");
  }

  if (!target.sourceDocumentFingerprint) {
    throw new PdfEngineError("INVALID_DOCUMENT", "Selected text target document fingerprint is required.");
  }
}

function assertRasterizedTextRedaction(options: PdfRedactTextOptions): void {
  if (options.rasterize !== true) {
    throw new PdfEngineError(
      "UNSUPPORTED",
      "That operation isn't available for this document.",
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

async function hasEncryptionDictionary(bytes: Uint8Array): Promise<boolean> {
  try {
    const pdf = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });

    return pdf.context.trailerInfo.Encrypt !== undefined || bytesContainAscii(bytes, "/Encrypt");
  } catch {
    return bytesContainAscii(bytes, "/Encrypt");
  }
}

async function hasTaggedPdfStructure(bytes: Uint8Array): Promise<boolean> {
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  const structTreeRoot = pdf.catalog.get(PDFName.of("StructTreeRoot"));

  if (structTreeRoot) {
    return true;
  }

  const markInfo = pdf.catalog.lookupMaybe(PDFName.of("MarkInfo"), PDFDict);
  const marked = markInfo?.lookupMaybe(PDFName.of("Marked"), PDFBool);

  return marked === PDFBool.True || bytesContainAscii(bytes, "/Marked true");
}

async function readBaseFontNames(bytes: Uint8Array): Promise<Set<string>> {
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  const fontNames = new Set<string>();

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) {
      continue;
    }

    const type = object.lookupMaybe(PDFName.of("Type"), PDFName)?.decodeText();
    if (type !== "Font") {
      continue;
    }

    const baseFont = object.lookupMaybe(PDFName.of("BaseFont"), PDFName)?.decodeText();
    if (baseFont) {
      fontNames.add(baseFont);
    }
  }

  return fontNames;
}

function hasNewNotoBaseFont(input: ReadonlySet<string>, output: ReadonlySet<string>): boolean {
  for (const fontName of output) {
    if (fontName.includes("Noto") && !input.has(fontName)) {
      return true;
    }
  }

  return false;
}

function bytesContainAscii(bytes: Uint8Array, text: string): boolean {
  const first = text.charCodeAt(0);
  const limit = bytes.length - text.length;

  outer: for (let index = 0; index <= limit; index += 1) {
    if (bytes[index] !== first) {
      continue;
    }

    for (let offset = 1; offset < text.length; offset += 1) {
      if (bytes[index + offset] !== text.charCodeAt(offset)) {
        continue outer;
      }
    }

    return true;
  }

  return false;
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
    throw new PdfEngineError("INVALID_DOCUMENT", "RaioPDF got an unreadable response while working on this file. Try reopening it.", {
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
  // Read the body once as text so we can surface a reason regardless of the
  // content type. Stirling replies with JSON error bodies, but the local
  // gs/qpdf interceptors reply text/plain (e.g. "ghostscript PDF/A conversion
  // failed (exit status: 1): <reason>"). Parsing JSON only — as we used to —
  // dropped those plain-text reasons and left the caller with a bare
  // "Unprocessable Entity".
  const rawBody = await readResponseText(response);
  const parsedError = parseErrorBody(rawBody);
  const errorBody = parsedError.body;
  const message =
    readErrorMessage(errorBody)
    ?? (parsedError.parsedJson ? null : plainTextErrorMessage(rawBody))
    ?? response.statusText;
  const errorCode = readErrorCode(errorBody);
  if (response.status === 499 || message === "PATH_OP_CANCELLED") {
    throw new PdfEngineError("PATH_OP_CANCELLED", "Operation cancelled.");
  }

  const code = mapHttpStatusToErrorCode(response.status, message, errorCode);
  const detail = errorCode ? `${message} (${errorCode})` : message;

  throw new PdfEngineError(code, `RaioPDF couldn't complete that: ${detail}`);
}

async function readResponseText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

function parseErrorBody(rawBody: string | null): {
  body: StirlingErrorBody | null;
  parsedJson: boolean;
} {
  if (!rawBody) {
    return { body: null, parsedJson: false };
  }

  try {
    const body = JSON.parse(rawBody);

    return { body: isRecord(body) ? body : null, parsedJson: true };
  } catch {
    return { body: null, parsedJson: false };
  }
}

/**
 * A plain-text error body collapsed to a single readable line and capped so a
 * multi-line Ghostscript stderr dump doesn't flood the surfaced error.
 */
function plainTextErrorMessage(rawBody: string | null): string | null {
  if (!rawBody) {
    return null;
  }

  const collapsed = rawBody.replace(/\s+/g, " ").trim();

  if (!collapsed) {
    return null;
  }

  const MAX_LENGTH = 300;

  return collapsed.length > MAX_LENGTH ? `${collapsed.slice(0, MAX_LENGTH)}…` : collapsed;
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

/** PDF/A flavor -> Ghostscript `-dPDFA=` conformance level for `/local/pdfa`. */
const PDFA_LEVEL_BY_FLAVOR: Record<PdfAConversionOptions["flavor"], string> = {
  "pdfa-1": "1",
  "pdfa-2b": "2",
  "pdfa-3b": "3",
};

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
