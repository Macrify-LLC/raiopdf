import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import {
  areaForTextRange,
  extractPageText,
  extractPageTextForIndexes,
  matchAreaForTextRange,
  type ExtractedPageText,
  type PageTextInput,
} from "./pageTextCache";
import { scoreGarbledPage } from "@raiopdf/rules";
import type { PDFDocumentProxy } from "./pdfjs";

export { extractPageText } from "./pageTextCache";
export type { ExtractedPageText } from "./pageTextCache";

export type LegalScanCategory =
  | "SSN"
  | "Bank / Account"
  | "Credit Card"
  | "Driver License"
  | "Birth Date";
export type LegalScanConfidence = "high" | "lower";

export interface ExtractedTextBox {
  pageIndex: number;
  text: string;
  area: PdfRedactionArea;
}

export interface SensitiveHit {
  id: string;
  category: LegalScanCategory;
  confidence: LegalScanConfidence;
  pageIndex: number;
  excerpt: string;
  area: PdfRedactionArea;
}

export interface PdfMetadataSummary {
  rows: ReadonlyArray<{ label: string; value: string }>;
  removedFields: readonly string[];
}

export type RedactionVerificationStatus = "pass" | "fail" | "skipped";

export interface RedactionVerificationCheck {
  status: RedactionVerificationStatus;
  detail: string;
}

export interface RedactionVerificationResult {
  ok: boolean;
  textLayer: RedactionVerificationCheck;
  rasterizedPages: RedactionVerificationCheck;
  annotations: RedactionVerificationCheck;
  metadata: RedactionVerificationCheck;
}

const TEXT_OPERATOR_BOUNDARY = String.raw`[\s[\]()<>/]`;
const GARBLED_REDACTION_TERM_PREFIX = "__RAIOPDF_GARBLED_REDACTION_PAGE__:";
const TEXT_OPERATOR_PATTERN = new RegExp(
  String.raw`(?:^|${TEXT_OPERATOR_BOUNDARY})` +
  String.raw`(?:BT|ET|Tc|Tw|Tz|TL|Tf|Tr|Ts|Td|TD|Tm|T\*|Tj|TJ|'|")` +
  String.raw`(?=$|${TEXT_OPERATOR_BOUNDARY})`,
);

const SCAN_PATTERNS: ReadonlyArray<{
  category: LegalScanCategory;
  confidence?: LegalScanConfidence;
  regex: RegExp;
}> = [
  { category: "SSN", regex: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g },
  { category: "SSN", confidence: "lower", regex: /\b\d{9}\b/g },
  {
    category: "Bank / Account",
    regex: /\b(?:account|acct|routing|aba)\b[^\n]{0,32}?\b\d{4,17}\b/gi,
  },
  {
    category: "Credit Card",
    regex: /\b(?:\d[ -]?){13,16}\b/g,
  },
  {
    category: "Driver License",
    regex: /\b(?:driver(?:'s)? license|dl)\b[^\n]{0,24}?\b[A-Z0-9-]{5,18}\b/gi,
  },
  {
    category: "Birth Date",
    regex: /\b(?:dob|date of birth)\b[^\n]{0,16}?\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi,
  },
];

export async function extractTextBoxes(
  input: PageTextInput,
  options: { pageIndexes?: readonly number[] } = {},
): Promise<ExtractedTextBox[]> {
  const boxes: ExtractedTextBox[] = [];
  const pages = options.pageIndexes
    ? await extractPageTextForIndexes(input, options.pageIndexes)
    : await extractPageText(input);

  for (const page of pages) {
    for (const span of page.spans) {
      boxes.push({
        pageIndex: page.pageIndex,
        text: page.text.slice(span.start, span.end),
        area: span.area,
      });
    }
  }

  return boxes;
}

export async function findTextRedactionAreas(
  input: PageTextInput,
  query: string,
): Promise<PdfRedactionArea[]> {
  const pages = await extractPageText(input);

  return findTextRedactionAreasInPages(pages, query);
}

type TextRangeAreaFn = (
  page: ExtractedPageText,
  start: number,
  end: number,
) => PdfRedactionArea | null;

function collectQueryAreas(
  pages: readonly ExtractedPageText[],
  query: string,
  areaFn: TextRangeAreaFn,
): PdfRedactionArea[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const queryPattern = new RegExp(
    escapeRegExp(normalizedQuery).replace(/\s+/g, "\\s+"),
    "g",
  );
  const areas: PdfRedactionArea[] = [];

  for (const page of pages) {
    const normalizedPageText = page.text.toLowerCase();
    queryPattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = queryPattern.exec(normalizedPageText)) !== null) {
      const matchedText = match[0] ?? "";

      if (!matchedText) {
        queryPattern.lastIndex += 1;
        continue;
      }

      const area = areaFn(page, match.index, match.index + matchedText.length);

      if (area) {
        areas.push(area);
      }
    }
  }

  return areas;
}

/** Over-inclusive areas covering each match in full — for redacting found text. */
export function findTextRedactionAreasInPages(
  pages: readonly ExtractedPageText[],
  query: string,
): PdfRedactionArea[] {
  return collectQueryAreas(pages, query, areaForTextRange);
}

/** Tight per-word areas for highlighting search matches (display-only). */
export function findTextMatchAreasInPages(
  pages: readonly ExtractedPageText[],
  query: string,
): PdfRedactionArea[] {
  return collectQueryAreas(pages, query, matchAreaForTextRange);
}

export async function scanSensitivePatterns(
  input: PageTextInput,
): Promise<SensitiveHit[]> {
  const pages = await extractPageText(input);
  const hits: SensitiveHit[] = [];

  pages.forEach((page) => {
    for (const pattern of SCAN_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.regex.exec(page.text)) !== null) {
        const matchedText = match[0] ?? "";
        const area = areaForTextRange(page, match.index, match.index + matchedText.length);

        if (!area) {
          continue;
        }

        if (
          pattern.category === "Credit Card" &&
          !looksLikeCreditCard(matchedText)
        ) {
          continue;
        }

        hits.push({
          id: `${page.pageIndex}-${pattern.category}-${match.index}`,
          category: pattern.category,
          confidence: pattern.confidence ?? "high",
          pageIndex: page.pageIndex,
          excerpt: maskExcerpt(page.text, match.index, matchedText.length),
          area,
        });
      }
    }
  });

  return hits;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function verifyRedactionAreasClear(
  bytes: Uint8Array,
  areas: readonly PdfRedactionArea[],
  redactedTerms: readonly string[] = [],
  // Optional pdf.js proxy ALREADY LOADED OVER THESE SAME BYTES (the redaction
  // output). When provided, the text-layer pass reuses it instead of loading
  // its own document; the caller keeps ownership (it is not destroyed here).
  pdfDocument: PDFDocumentProxy | null = null,
): Promise<RedactionVerificationResult> {
  if (areas.length === 0) {
    return redactionVerificationResult({
      textLayer: pass("No redaction areas were marked."),
      rasterizedPages: pass("No redaction pages were marked."),
      annotations: pass("No redaction pages were marked."),
      metadata: pass("Document metadata is scrubbed."),
    });
  }

  const uniqueTerms = uniqueRedactionTerms(redactedTerms);
  const textLayer = await verifyFullDocumentTextLayer(bytes, uniqueTerms, pdfDocument);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const redactedPageIndexes = uniquePageIndexes(areas);

  return redactionVerificationResult({
    textLayer,
    rasterizedPages: verifyRasterizedPages(pdf, redactedPageIndexes),
    annotations: verifyRedactedPageAnnotations(pdf, redactedPageIndexes),
    metadata: verifyDocumentMetadataScrubbed(pdf),
  });
}

export async function collectRedactionAreaTexts(
  input: PageTextInput,
  areas: readonly PdfRedactionArea[],
): Promise<readonly string[]> {
  if (areas.length === 0) {
    return [];
  }

  const pages = await extractPageText(input);
  const redactedPageIndexes = new Set(areas.map((area) => area.pageIndex));
  const garbledMarkers = pages
    .filter((page) => redactedPageIndexes.has(page.pageIndex))
    .filter((page) => scoreGarbledPage(page.text, page.pageIndex) !== null)
    .map((page) => garbledRedactionTerm(page.pageIndex));

  return uniqueRedactionTerms(
    [
      ...pages.flatMap((page) =>
        page.spans.map((span) => ({
          pageIndex: page.pageIndex,
          text: page.text.slice(span.start, span.end),
          area: span.area,
        }))
      )
        .filter((box) => box.text.trim().length > 0)
        .filter((box) => areas.some((area) => areasIntersect(box.area, area)))
        .map((box) => box.text),
      ...garbledMarkers,
    ],
  );
}

export async function readMetadataSummary(
  bytes: Uint8Array,
): Promise<PdfMetadataSummary> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const rows = [
    { label: "Title", value: pdf.getTitle() ?? "" },
    { label: "Author", value: pdf.getAuthor() ?? "" },
    { label: "Creator", value: pdf.getCreator() ?? "" },
    { label: "Producer", value: pdf.getProducer() ?? "" },
    { label: "Created", value: formatPdfDate(pdf.getCreationDate()) },
    { label: "Modified", value: formatPdfDate(pdf.getModificationDate()) },
    { label: "Custom fields", value: "0" },
  ];

  return {
    rows: rows.map((row) => ({
      ...row,
      value: row.value || "Not set",
    })),
    removedFields: rows
      .filter((row) => row.value && row.value !== "0")
      .map((row) => row.label),
  };
}

function maskExcerpt(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 18);
  const end = Math.min(text.length, matchIndex + matchLength + 18);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ..." : "";
  const before = text.slice(start, matchIndex);
  const match = text.slice(matchIndex, matchIndex + matchLength);
  const after = text.slice(matchIndex + matchLength, end);

  return `${prefix}${before}${maskSensitiveText(match)}${after}${suffix}`;
}

function maskSensitiveText(text: string): string {
  const visible = text.match(/[A-Za-z0-9]/g)?.slice(-4).join("") ?? "";
  const masked = text.replace(/[A-Za-z0-9]/g, "•");

  if (!visible) {
    return masked;
  }

  let remainingVisible = visible.length;

  return [...masked].reverse().map((character, index) => {
    const sourceCharacter = [...text].reverse()[index] ?? "";

    if (remainingVisible > 0 && /[A-Za-z0-9]/.test(sourceCharacter)) {
      remainingVisible -= 1;
      return sourceCharacter;
    }

    return character;
  }).reverse().join("");
}

function looksLikeCreditCard(value: string): boolean {
  const digits = value.replace(/\D/g, "");

  if (digits.length < 13 || digits.length > 16) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function areasIntersect(left: PdfRedactionArea, right: PdfRedactionArea): boolean {
  if (left.pageIndex !== right.pageIndex) {
    return false;
  }

  return !(
    left.x + left.w <= right.x ||
    right.x + right.w <= left.x ||
    left.y + left.h <= right.y ||
    right.y + right.h <= left.y
  );
}

async function verifyFullDocumentTextLayer(
  bytes: Uint8Array,
  terms: readonly string[],
  injectedPdfDocument: PDFDocumentProxy | null = null,
): Promise<RedactionVerificationCheck> {
  const garbledRedactionPages = garbledRedactionPagesFromTerms(terms);
  if (garbledRedactionPages.length > 0) {
    return fail(
      `Text layer garbled on redacted page(s) ${formatPageNumbers(garbledRedactionPages)}; redaction cannot be verified from extracted text. Verify manually.`,
    );
  }

  if (terms.length === 0) {
    return skipped("No source text was extractable from the marked redaction areas.");
  }

  try {
    // Injected proxy (already loaded over these bytes) is caller-owned and
    // never destroyed here; a self-loaded fallback document is.
    const pdfDocument = injectedPdfDocument
      ?? await (await import("./pdfjs")).loadPdfDocument(bytes);

    try {
      const pages = await extractPageText({ bytes, pdfDocument });
      const documentText = normalizeSearchText(pages.map((page) => page.text).join("\n"));
      const remainingTerm = terms.find((term) => documentText.includes(normalizeSearchText(term)));

      if (remainingTerm) {
        return fail(`Text layer still contains "${remainingTerm}".`);
      }

      return pass("Text layer verified clean across the full document.");
    } finally {
      if (pdfDocument !== injectedPdfDocument) {
        await pdfDocument.loadingTask.destroy();
      }
    }
  } catch (error) {
    return fail(`Text layer verification could not run: ${errorMessage(error)}`);
  }
}

function verifyRasterizedPages(
  pdf: PDFDocument,
  pageIndexes: readonly number[],
): RedactionVerificationCheck {
  const pagesWithTextOperators = pageIndexes.filter((pageIndex) => {
    return hasTextOperatorsInPage(pdf, pageIndex);
  });

  if (pagesWithTextOperators.length > 0) {
    return fail(`Redacted pages still contain text operators: ${formatPageNumbers(pagesWithTextOperators)}.`);
  }

  return pass("Redacted page images replaced; no text operators remain on redacted pages.");
}

function verifyRedactedPageAnnotations(
  pdf: PDFDocument,
  pageIndexes: readonly number[],
): RedactionVerificationCheck {
  const pagesWithAnnotations = pageIndexes.filter((pageIndex) => {
    const annotations = pdf.getPage(pageIndex).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    return annotations !== undefined && annotations.size() > 0;
  });

  if (pagesWithAnnotations.length > 0) {
    return fail(`Annotations remain on redacted pages: ${formatPageNumbers(pagesWithAnnotations)}.`);
  }

  return pass("Annotations cleaned on redacted pages.");
}

function verifyDocumentMetadataScrubbed(pdf: PDFDocument): RedactionVerificationCheck {
  if (pdf.context.trailerInfo.Info !== undefined || pdf.catalog.has(PDFName.of("Metadata"))) {
    return fail("Document metadata remains after redaction.");
  }

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.has(PDFName.of("Metadata"))) {
      return fail("Nested metadata remains after redaction.");
    }
  }

  return pass("Document metadata scrubbed after redaction.");
}

function hasTextOperatorsInPage(pdf: PDFDocument, pageIndex: number): boolean {
  const page = pdf.getPage(pageIndex).node;
  const visited = new Set<string>();

  return (
    hasTextOperatorsInContentObject(pdf, page.Contents(), visited) ||
    hasTextOperatorsInResources(pdf, page.Resources(), visited)
  );
}

function hasTextOperatorsInContentObject(
  pdf: PDFDocument,
  object: PDFArray | PDFRef | PDFStream | undefined,
  visited: Set<string>,
): boolean {
  if (!object) {
    return false;
  }

  if (object instanceof PDFArray) {
    return object.asArray().some((entry) => {
      const resolved = entry instanceof PDFRef ? pdf.context.lookup(entry) : entry;
      return (
        resolved instanceof PDFStream &&
        hasTextOperatorsInStream(pdf, resolved, visited)
      );
    });
  }

  const resolved = object instanceof PDFRef ? pdf.context.lookup(object) : object;
  return resolved instanceof PDFStream && hasTextOperatorsInStream(pdf, resolved, visited);
}

function hasTextOperatorsInStream(
  pdf: PDFDocument,
  stream: PDFStream,
  visited: Set<string>,
): boolean {
  const ref = pdf.context.getObjectRef(stream);

  if (ref) {
    if (visited.has(ref.tag)) {
      return false;
    }
    visited.add(ref.tag);
  }

  return (
    hasTextOperator(decodePdfStream(stream)) ||
    hasTextOperatorsInResources(
      pdf,
      stream.dict.lookupMaybe(PDFName.Resources, PDFDict),
      visited,
    )
  );
}

function hasTextOperatorsInResources(
  pdf: PDFDocument,
  resources: PDFDict | undefined,
  visited: Set<string>,
): boolean {
  const xObjects = resources?.lookupMaybe(PDFName.XObject, PDFDict);

  if (!xObjects) {
    return false;
  }

  return xObjects.values().some((xObject) => {
    const resolved = xObject instanceof PDFRef ? pdf.context.lookup(xObject) : xObject;

    if (!(resolved instanceof PDFStream) || !isFormXObject(resolved)) {
      return false;
    }

    return hasTextOperatorsInStream(pdf, resolved, visited);
  });
}

function isFormXObject(stream: PDFStream): boolean {
  const subtype = stream.dict.lookupMaybe(PDFName.of("Subtype"), PDFName);

  return subtype?.asString() === "/Form";
}

function decodePdfStream(stream: PDFStream): string {
  if (stream instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }

  return new TextDecoder().decode(stream.getContents());
}

function hasTextOperator(content: string): boolean {
  return TEXT_OPERATOR_PATTERN.test(content);
}

function uniqueRedactionTerms(terms: readonly string[]): readonly string[] {
  return [...new Set(terms.map(normalizeDisplayText).filter(Boolean))];
}

function uniquePageIndexes(areas: readonly PdfRedactionArea[]): readonly number[] {
  return [...new Set(areas.map((area) => area.pageIndex))].sort((a, b) => a - b);
}

function redactionVerificationResult(
  checks: Omit<RedactionVerificationResult, "ok">,
): RedactionVerificationResult {
  return {
    ...checks,
    ok: Object.values(checks).every((check) => check.status !== "fail"),
  };
}

function pass(detail: string): RedactionVerificationCheck {
  return { status: "pass", detail };
}

function fail(detail: string): RedactionVerificationCheck {
  return { status: "fail", detail };
}

function skipped(detail: string): RedactionVerificationCheck {
  return { status: "skipped", detail };
}

function garbledRedactionTerm(pageIndex: number): string {
  return `${GARBLED_REDACTION_TERM_PREFIX}${pageIndex}`;
}

function garbledRedactionPagesFromTerms(terms: readonly string[]): readonly number[] {
  return terms
    .filter((term) => term.startsWith(GARBLED_REDACTION_TERM_PREFIX))
    .map((term) => Number(term.slice(GARBLED_REDACTION_TERM_PREFIX.length)))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeSearchText(text: string): string {
  return normalizeDisplayText(text).toLocaleLowerCase();
}

function formatPageNumbers(pageIndexes: readonly number[]): string {
  return pageIndexes.map((pageIndex) => pageIndex + 1).join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPdfDate(date: Date | undefined): string {
  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(date);
}
